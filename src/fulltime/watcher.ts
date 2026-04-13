// ─────────────────────────────────────────────────────────────────────────────
// fulltime/watcher.ts
//
// Schedules a per-fixture full-time poll window via setTimeout — no cron.
// When a pick is published, scheduleFulltimeWatch() is called once.
// It waits until kickoff + 85 min, then polls every 10 min for up to 2 hours
// until TheSportsDB reports "FT" / "AET" / "Pen". Fires at most once per fixture.
// ─────────────────────────────────────────────────────────────────────────────

import { logger } from '../utils/logger';
import { sendToGroup } from '../bot/telegram';
import { updateFulltimeNotified, updateOutcome } from '../reports/picks-store';
import {
  fetchLiveStatus,
  fetchEventStats,
  fetchEventLineup,
  isFullTime,
  determineOutcome,
} from './stats-fetcher';
import { generateFulltimeNarrative } from './narrator';
import type { PickRecord } from '../types';

const POLL_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes between polls
const MAX_ATTEMPTS     = 12;             // up to 120 minutes of polling after start delay

/** Stats shown inline in the FT Telegram message */
function keyStats(stats: Array<{ strStat: string; intHome: string; intAway: string }>): string {
  const want = [
    'Shots on Goal',
    'Ball Possession',
    'expected_goals',
    'Corner Kicks',
    'Yellow Cards',
    // Basketball keys
    'Rebounds',
    'Assists',
    'Field Goals %',
  ];
  const labelMap: Record<string, string> = { 'expected_goals': 'xG' };
  const lines: string[] = [];
  for (const name of want) {
    const s = stats.find(x => x.strStat.toLowerCase() === name.toLowerCase());
    if (s) lines.push(`${labelMap[s.strStat] ?? s.strStat}: ${s.intHome}–${s.intAway}`);
  }
  return lines.join(' | ');
}

function outcomeEmoji(outcome: 'win' | 'loss' | 'push'): string {
  if (outcome === 'win')  return '✅';
  if (outcome === 'loss') return '❌';
  return '↩️';
}

/** Formats the Telegram full-time update message (HTML) */
function formatFulltimeMessage(
  pick: PickRecord,
  homeScore: number | null,
  awayScore: number | null,
  outcome: 'win' | 'loss' | 'push',
  stats: Array<{ strStat: string; intHome: string; intAway: string }>,
  narrative: string
): string {
  const scoreDisplay =
    homeScore !== null && awayScore !== null
      ? `${homeScore}–${awayScore}`
      : '?–?';

  const statsLine = keyStats(stats);
  const emoji     = outcomeEmoji(outcome);
  const resultLabel =
    outcome === 'win'  ? 'ΒΓΗΚΕ ΤΟ ΤΙΡ' :
    outcome === 'loss' ? 'ΔΕΝ ΒΓΗΚΕ ΤΟ ΤΙΡ' :
                         'PUSH — ΕΠΙΣΤΡΟΦΗ';

  return (
    `🏁 <b>Τελικό Αποτέλεσμα</b>\n\n` +
    `🏟️ <b>${pick.homeTeam} vs ${pick.awayTeam}</b>\n` +
    `🏆 ${pick.league}\n` +
    `⚽ Τελικό σκορ: <b>${scoreDisplay}</b>\n` +
    `🎯 Πρόταση: <b>${pick.finalPick}</b>\n` +
    `${emoji} <b>${resultLabel}</b>\n\n` +
    `<i>${narrative}</i>\n` +
    (statsLine ? `\n📊 ${statsLine}` : '')
  );
}

/** Attempts one FT check; returns true if FT was detected and notification sent */
async function attemptFulltimeNotification(pick: PickRecord): Promise<boolean> {
  const live = await fetchLiveStatus(pick.fixtureId);
  if (!live) return false;

  if (!isFullTime(live.status)) {
    logger.info(`[fulltime] ${pick.homeTeam} vs ${pick.awayTeam} — status: "${live.status}" (not FT yet)`);
    return false;
  }

  const { homeScore, awayScore } = live;
  const outcome =
    homeScore !== null && awayScore !== null
      ? determineOutcome(pick.bestBettingMarket, pick.finalPick, homeScore, awayScore)
      : 'loss';

  logger.info(
    `[fulltime] 🔔 FT detected: ${pick.homeTeam} vs ${pick.awayTeam} ` +
    `(${homeScore ?? '?'}–${awayScore ?? '?'}) → ${outcome}`
  );

  const stats   = await fetchEventStats(pick.fixtureId);
  const lineup  = await fetchEventLineup(pick.fixtureId);
  const narrative = await generateFulltimeNarrative(pick, homeScore, awayScore, outcome, stats, lineup);
  const message   = formatFulltimeMessage(pick, homeScore, awayScore, outcome, stats, narrative);

  await sendToGroup(message);

  // Persist outcome to picks-log
  const scoreStr =
    homeScore !== null && awayScore !== null ? `${homeScore}-${awayScore}` : '?-?';
  updateOutcome(pick.fixtureId, outcome === 'push' ? 'void' : outcome, scoreStr);
  updateFulltimeNotified(pick.fixtureId);

  logger.info(`[fulltime] update sent for ${pick.homeTeam} vs ${pick.awayTeam} (${outcome})`);
  return true;
}

/** Polls until FT is confirmed, giving up after MAX_ATTEMPTS */
async function pollForFulltime(pick: PickRecord): Promise<void> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const done = await attemptFulltimeNotification(pick);
      if (done) return;
    } catch (err) {
      logger.warn(`[fulltime] poll attempt ${attempt} failed for ${pick.fixtureId}: ${String(err)}`);
    }
    if (attempt < MAX_ATTEMPTS) {
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }
  logger.warn(
    `[fulltime] gave up waiting for FT on ${pick.homeTeam} vs ${pick.awayTeam} after ${MAX_ATTEMPTS} attempts`
  );
}

/**
 * Schedules the full-time watch for a single match.
 * Called once per pick, right after the tip is published.
 *
 * @param pick       The published pick record
 * @param kickoffMs  Unix timestamp (ms) of the match kickoff
 */
export function scheduleFulltimeWatch(pick: PickRecord, kickoffMs: number): void {
  // Start polling 85 min after kickoff (covers standard 90-min matches)
  const startDelayMs = kickoffMs + 85 * 60 * 1000 - Date.now();

  if (startDelayMs < 0) {
    logger.info(`[fulltime] ${pick.homeTeam} vs ${pick.awayTeam}: kickoff already past, starting FT poll now`);
    void pollForFulltime(pick);
    return;
  }

  const startMin = Math.round(startDelayMs / 60_000);
  logger.info(`[fulltime] ${pick.homeTeam} vs ${pick.awayTeam}: FT poll scheduled in ~${startMin} min`);

  setTimeout(() => {
    void pollForFulltime(pick);
  }, startDelayMs);
}
