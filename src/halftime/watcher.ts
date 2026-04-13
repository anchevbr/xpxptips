// ─────────────────────────────────────────────────────────────────────────────
// halftime/watcher.ts
//
// Schedules a per-fixture halftime poll window via setTimeout — no cron.
// When a pick is published, scheduleHalftimeWatch() is called once.
// It waits until kickoff + 40 min, then polls every 2 min for up to 20 min
// until TheSportsDB reports "HT". Fires at most once per fixture.
// ─────────────────────────────────────────────────────────────────────────────

import { logger } from '../utils/logger';
import { sendToGroup } from '../bot/telegram';
import { updateHalftimeNotified } from '../reports/picks-store';
import { fetchLiveStatus, fetchEventStats, fetchEventLineup, isHalftime } from './stats-fetcher';
import { generateHalftimeNarrative } from './narrator';
import type { PickRecord } from '../types';

const POLL_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes between each poll attempt
const MAX_ATTEMPTS     = 6;              // up to 60 minutes of polling

/** Picks the most relevant stats to show inline in the Telegram message */
function keyStats(stats: Array<{ strStat: string; intHome: string; intAway: string }>): string {
  const want = [
    'Shots on Goal',
    'Ball Possession',
    'expected_goals',
    'Corner Kicks',
    'Yellow Cards',
  ];
  const lines: string[] = [];
  const labelMap: Record<string, string> = { 'expected_goals': 'xG' };
  for (const name of want) {
    const s = stats.find(x => x.strStat.toLowerCase() === name.toLowerCase());
    if (s) lines.push(`${labelMap[s.strStat] ?? s.strStat}: ${s.intHome}–${s.intAway}`);
  }
  return lines.join(' | ');
}

/** Formats the Telegram halftime update message (HTML) */
function formatHalftimeMessage(
  pick: PickRecord,
  homeScore: number | null,
  awayScore: number | null,
  stats: Array<{ strStat: string; intHome: string; intAway: string }>,
  narrative: string
): string {
  const scoreDisplay =
    homeScore !== null && awayScore !== null
      ? `${homeScore}–${awayScore}`
      : '?–?';

  const statsLine = keyStats(stats);

  return (
    `⏱️ <b>Ενημέρωση Ημιχρόνου</b>\n\n` +
    `🏟️ <b>${pick.homeTeam} vs ${pick.awayTeam}</b>\n` +
    `🏆 ${pick.league}\n` +
    `⚽ Σκορ: <b>${scoreDisplay}</b> (HT)\n` +
    `🎯 Πρόταση: <b>${pick.finalPick}</b>\n\n` +
    `<i>${narrative}</i>\n` +
    (statsLine ? `\n📊 ${statsLine}` : '')
  );
}

/** Attempts one HT check; returns true if HT was detected and notification sent */
async function attemptHalftimeNotification(pick: PickRecord): Promise<boolean> {
  const live = await fetchLiveStatus(pick.fixtureId);
  if (!live) return false;

  if (!isHalftime(live.status)) {
    logger.info(`[halftime] ${pick.homeTeam} vs ${pick.awayTeam} — status: "${live.status}" (not HT yet)`);
    return false;
  }

  logger.info(
    `[halftime] 🔔 HT detected: ${pick.homeTeam} vs ${pick.awayTeam} ` +
    `(${live.homeScore ?? '?'}–${live.awayScore ?? '?'})`
  );

  const stats = await fetchEventStats(pick.fixtureId);
  const lineup = await fetchEventLineup(pick.fixtureId);
  const narrative = await generateHalftimeNarrative(pick, live.homeScore, live.awayScore, stats, lineup);
  const message = formatHalftimeMessage(pick, live.homeScore, live.awayScore, stats, narrative);

  await sendToGroup(message);
  updateHalftimeNotified(pick.fixtureId);

  logger.info(`[halftime] update sent for ${pick.homeTeam} vs ${pick.awayTeam}`);
  return true;
}

/** Polls until HT is confirmed, giving up after MAX_ATTEMPTS */
async function pollForHalftime(pick: PickRecord): Promise<void> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const done = await attemptHalftimeNotification(pick);
      if (done) return;
    } catch (err) {
      logger.warn(`[halftime] poll attempt ${attempt} failed for ${pick.fixtureId}: ${String(err)}`);
    }
    if (attempt < MAX_ATTEMPTS) {
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }
  logger.warn(`[halftime] gave up waiting for HT on ${pick.homeTeam} vs ${pick.awayTeam} after ${MAX_ATTEMPTS} attempts`);
}

/**
 * Schedules the halftime watch for a single match.
 * Called once per pickup, right after the tip is published.
 *
 * @param pick       The published pick record
 * @param kickoffMs  Unix timestamp (ms) of the match kickoff
 */
export function scheduleHalftimeWatch(pick: PickRecord, kickoffMs: number): void {
  // Start polling 40 min after kickoff (gives time for first half to reach ~HT)
  const startDelayMs = kickoffMs + 40 * 60 * 1000 - Date.now();

  if (startDelayMs < 0) {
    // Kickoff already passed (e.g. test mode or late start) — begin immediately
    logger.info(`[halftime] ${pick.homeTeam} vs ${pick.awayTeam}: kickoff already past, starting HT poll now`);
    void pollForHalftime(pick);
    return;
  }

  const startMin = Math.round(startDelayMs / 60_000);
  logger.info(`[halftime] ${pick.homeTeam} vs ${pick.awayTeam}: HT poll scheduled in ~${startMin} min`);

  setTimeout(() => {
    void pollForHalftime(pick);
  }, startDelayMs);
}
