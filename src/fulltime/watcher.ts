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
import { getPickByFixtureId, updateFulltimeNotified, updateOutcome } from '../reports/picks-store';
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
const START_DELAY_MS   = 85 * 60 * 1000;
const RECOVERY_WINDOW_MS = START_DELAY_MS + (MAX_ATTEMPTS - 1) * POLL_INTERVAL_MS;

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
  if (outcome === 'win') return '✅💸🔥';
  if (outcome === 'loss') return '🚨💔❌';
  return '↩️⚖️';
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
  const header =
    outcome === 'win'
      ? '✅💸 <b>Τελικό Ταμείο</b>'
      : outcome === 'loss'
      ? '🚨💔 <b>Χαμένο Tip</b>'
      : '↩️ <b>Επιστροφή Πονταρίσματος</b>';
  const resultLabel =
    outcome === 'win' ? 'ΤΟ TIP ΠΛΗΡΩΣΕ' :
    outcome === 'loss' ? 'ΤΟ TIP ΧΑΘΗΚΕ' :
    'PUSH — ΕΠΙΣΤΡΟΦΗ';

  return (
    `${header}\n\n` +
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
  const currentPick = getPickByFixtureId(pick.fixtureId) ?? pick;
  const live = await fetchLiveStatus(currentPick.fixtureId);
  if (!live) return false;

  if (!isFullTime(live.status)) {
    logger.info(`[fulltime] ${currentPick.homeTeam} vs ${currentPick.awayTeam} — status: "${live.status}" (not FT yet)`);
    return false;
  }

  const { homeScore, awayScore } = live;
  const outcome =
    homeScore !== null && awayScore !== null
      ? determineOutcome(currentPick.bestBettingMarket, currentPick.finalPick, homeScore, awayScore)
      : 'loss';

  logger.info(
    `[fulltime] 🔔 FT detected: ${currentPick.homeTeam} vs ${currentPick.awayTeam} ` +
    `(${homeScore ?? '?'}–${awayScore ?? '?'}) → ${outcome}`
  );

  const stats = await fetchEventStats(currentPick.fixtureId);
  const lineup = await fetchEventLineup(currentPick.fixtureId);
  const narrative = await generateFulltimeNarrative(currentPick, homeScore, awayScore, outcome, stats, lineup);
  const message = formatFulltimeMessage(currentPick, homeScore, awayScore, outcome, stats, narrative);
  const fullTimeMessageId = await sendToGroup(message, {
    replyToMessageId: currentPick.halfTimeMessageId ?? currentPick.tipMessageId ?? undefined,
  });

  // Persist outcome to picks-log
  const scoreStr =
    homeScore !== null && awayScore !== null ? `${homeScore}-${awayScore}` : '?-?';
  updateOutcome(currentPick.fixtureId, outcome === 'push' ? 'void' : outcome, scoreStr);
  updateFulltimeNotified(currentPick.fixtureId, fullTimeMessageId);

  logger.info(`[fulltime] update sent for ${currentPick.homeTeam} vs ${currentPick.awayTeam} (${outcome})`);
  return true;
}

/** Polls until FT is confirmed, giving up after MAX_ATTEMPTS */
async function pollForFulltime(pick: PickRecord, deadlineMs: number): Promise<void> {
  let attempts = 0;

  while (attempts < MAX_ATTEMPTS && Date.now() <= deadlineMs) {
    attempts++;

    try {
      const done = await attemptFulltimeNotification(pick);
      if (done) return;
    } catch (err) {
      logger.warn(`[fulltime] poll attempt ${attempts} failed for ${pick.fixtureId}: ${String(err)}`);
    }

    if (attempts < MAX_ATTEMPTS) {
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remainingMs)));
    }
  }

  logger.warn(
    `[fulltime] gave up waiting for FT on ${pick.homeTeam} vs ${pick.awayTeam} after ${attempts} attempt(s)`
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
  const startDelayMs = kickoffMs + START_DELAY_MS - Date.now();
  const deadlineMs = kickoffMs + RECOVERY_WINDOW_MS;

  if (startDelayMs < 0) {
    logger.info(`[fulltime] ${pick.homeTeam} vs ${pick.awayTeam}: kickoff already past, starting FT poll now`);
    void pollForFulltime(pick, deadlineMs);
    return;
  }

  const startMin = Math.round(startDelayMs / 60_000);
  logger.info(`[fulltime] ${pick.homeTeam} vs ${pick.awayTeam}: FT poll scheduled in ~${startMin} min`);

  setTimeout(() => {
    void pollForFulltime(pick, deadlineMs);
  }, startDelayMs);
}

export function recoverFulltimeWatch(pick: PickRecord): boolean {
  if (pick.fullTimeNotifiedAt || !pick.kickoffAt) {
    return false;
  }

  const kickoffMs = new Date(pick.kickoffAt).getTime();
  if (!Number.isFinite(kickoffMs)) {
    return false;
  }

  if (Date.now() > kickoffMs + RECOVERY_WINDOW_MS) {
    return false;
  }

  scheduleFulltimeWatch(pick, kickoffMs);
  return true;
}
