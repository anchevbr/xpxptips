// ─────────────────────────────────────────────────────────────────────────────
// test-fulltime.ts
//
// Test script for the full-time result notification feature.
//
// Loads one pick from existing checkpoint analysis files, generates a fake
// final score, calls GPT for the narrative, formats the message and sends
// it to Telegram — no real live-data poll needed.
//
// Runs win/loss plus push only when the selected market can actually push.
//
// Usage:
//   npm run test-fulltime
//   npm run test-fulltime 2026-04-16
//   npm run test-fulltime 2026-04-16 football
//   npm run test-fulltime 2026-04-16 basketball
// ─────────────────────────────────────────────────────────────────────────────

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';
import { generateFulltimeNarrative } from '../fulltime/narrator';
import { determineOutcome } from '../fulltime/stats-fetcher';
import { sendToGroup } from '../bot/telegram';
import { loadTestPick } from './load-test-pick';
import type { PickRecord } from '../types';

const CHECKPOINT_BASE = path.resolve('./data/checkpoints');

function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function isBasketball(league: string): boolean {
  return (
    league.toLowerCase().includes('euroleague') ||
    league.toLowerCase().includes('nba') ||
    league.toLowerCase().includes('basketball') ||
    league.toLowerCase().includes('euroliga')
  );
}

// ─── Random full-time stats ───────────────────────────────────────────────────

interface FakeStat { strStat: string; intHome: string; intAway: string }

function randomFootballStats(): FakeStat[] {
  const homePoss = rand(38, 65);
  return [
    { strStat: 'Shots on Goal',    intHome: String(rand(3, 10)),  intAway: String(rand(2, 8)) },
    { strStat: 'Shots off Goal',   intHome: String(rand(2, 7)),   intAway: String(rand(1, 6)) },
    { strStat: 'Total Shots',      intHome: String(rand(8, 20)),  intAway: String(rand(5, 16)) },
    { strStat: 'Ball Possession',  intHome: String(homePoss),     intAway: String(100 - homePoss) },
    { strStat: 'Corner Kicks',     intHome: String(rand(2, 9)),   intAway: String(rand(1, 7)) },
    { strStat: 'Fouls',            intHome: String(rand(6, 16)),  intAway: String(rand(5, 15)) },
    { strStat: 'Yellow Cards',     intHome: String(rand(0, 3)),   intAway: String(rand(0, 3)) },
    { strStat: 'Offsides',         intHome: String(rand(0, 5)),   intAway: String(rand(0, 4)) },
    { strStat: 'Goalkeeper Saves', intHome: String(rand(2, 6)),   intAway: String(rand(2, 8)) },
    { strStat: 'expected_goals',   intHome: `${rand(0, 2)}.${rand(0, 9)}`, intAway: `${rand(0, 1)}.${rand(0, 9)}` },
  ];
}

function randomBasketballStats(): FakeStat[] {
  return [
    { strStat: 'Field Goals %',  intHome: String(rand(40, 58)),  intAway: String(rand(38, 55)) },
    { strStat: '3 Points %',     intHome: String(rand(28, 45)),  intAway: String(rand(25, 43)) },
    { strStat: 'Free Throws %',  intHome: String(rand(65, 90)),  intAway: String(rand(60, 88)) },
    { strStat: 'Rebounds',       intHome: String(rand(30, 50)),  intAway: String(rand(28, 48)) },
    { strStat: 'Assists',        intHome: String(rand(12, 28)),  intAway: String(rand(10, 26)) },
    { strStat: 'Turnovers',      intHome: String(rand(6, 18)),   intAway: String(rand(6, 18)) },
    { strStat: 'Steals',         intHome: String(rand(4, 12)),   intAway: String(rand(4, 12)) },
    { strStat: 'Blocks',         intHome: String(rand(2, 8)),    intAway: String(rand(2, 8)) },
  ];
}

// ─── Format message (mirrors watcher.ts) ─────────────────────────────────────

function keyStats(stats: FakeStat[]): string {
  const want = ['Shots on Goal', 'Ball Possession', 'expected_goals', 'Corner Kicks',
                'Yellow Cards', 'Rebounds', 'Assists', 'Field Goals %'];
  const labelMap: Record<string, string> = { 'expected_goals': 'xG' };
  const lines: string[] = [];
  for (const name of want) {
    const s = stats.find(x => x.strStat.toLowerCase() === name.toLowerCase());
    if (s) lines.push(`${labelMap[s.strStat] ?? s.strStat}: ${s.intHome}–${s.intAway}`);
  }
  return lines.join(' | ');
}

function formatFulltimeMessage(
  pick: PickRecord,
  homeScore: number,
  awayScore: number,
  outcome: 'win' | 'loss' | 'push',
  stats: FakeStat[],
  narrative: string
): string {
  const statsLine  = keyStats(stats);
  const emoji      = outcome === 'win' ? '✅' : outcome === 'loss' ? '❌' : '↩️';
  const resultLabel =
    outcome === 'win' ? 'ΒΓΗΚΕ ΤΟ ΤΙΡ' :
    outcome === 'loss' ? 'ΔΕΝ ΒΓΗΚΕ ΤΟ ΤΙΡ' :
    'PUSH — ΕΠΙΣΤΡΟΦΗ';

  return (
    `🏁 <b>Τελικό Αποτέλεσμα</b>\n\n` +
    `🏟️ <b>${pick.homeTeam} vs ${pick.awayTeam}</b>\n` +
    `🏆 ${pick.league}\n` +
    `⚽ Τελικό σκορ: <b>${homeScore}–${awayScore}</b>\n` +
    `🎯 Πρόταση: <b>${pick.finalPick}</b>\n` +
    `${emoji} <b>${resultLabel}</b>\n\n` +
    `<i>${narrative}</i>\n` +
    (statsLine ? `\n📊 ${statsLine}` : '')
  );
}

// ─── Scenario scores ──────────────────────────────────────────────────────────

type Scenario = 'win' | 'loss' | 'push';

function extractLine(finalPick: string): number | null {
  const match = /(\d+(?:\.\d+)?)/.exec(finalPick);
  return match ? parseFloat(match[1]!) : null;
}

function supportsPush(market: string, finalPick: string): boolean {
  if (market !== 'totals/over' && market !== 'totals/under') return false;
  const line = extractLine(finalPick);
  if (line === null) return false;
  return Number.isInteger(line);
}

function scenarioScore(
  scenario: Scenario,
  market: string,
  finalPick: string,
  league: string
): { home: number; away: number } {
  const bball = isBasketball(league);
  const line = extractLine(finalPick);

  if (bball) {
    const targetTotal = line ?? 170;
    const halfLine = Math.round(targetTotal / 2);
    switch (scenario) {
      case 'win':
        return market === 'totals/over'
          ? { home: halfLine + 15, away: halfLine + 10 } // high scoring total → over wins
          : { home: halfLine - 10, away: halfLine - 12 }; // low total → under wins
      case 'loss':
        return market === 'totals/over'
          ? { home: halfLine - 12, away: halfLine - 8  } // not enough scoring
          : { home: halfLine + 8,  away: halfLine + 10 }; // too many points
      case 'push':
        return { home: halfLine, away: targetTotal - halfLine }; // exact total line
    }
  }

  // Football
  switch (market) {
    case 'h2h/home':
      return scenario === 'win' ? { home: 2, away: 0 }
           : scenario === 'loss' ? { home: 0, away: 2 }
           : { home: 1, away: 1 }; // draw = loss for h2h/home
    case 'h2h/away':
      return scenario === 'win' ? { home: 0, away: 2 }
           : scenario === 'loss' ? { home: 2, away: 0 }
           : { home: 1, away: 1 };
    case 'h2h/draw':
      return scenario === 'win' ? { home: 1, away: 1 }
           : scenario === 'loss' ? { home: 2, away: 0 }
           : { home: 0, away: 0 }; // 0-0 also a win; use win=1-1
    case 'totals/over':
      return scenario === 'win'  ? { home: 2, away: 2 } // 4 goals
           : scenario === 'loss' ? { home: 1, away: 0 } // 1 goal
           : line !== null ? { home: Math.floor(line / 2), away: Math.ceil(line / 2) } : { home: 1, away: 1 };
    case 'totals/under':
    default:
      return scenario === 'win'  ? { home: 1, away: 1 } // 2 goals < 2.5
           : scenario === 'loss' ? { home: 2, away: 1 } // 3 goals > 2.5
           : line !== null ? { home: Math.floor(line / 2), away: Math.ceil(line / 2) } : { home: 1, away: 2 };
  }
}

// ─── Single scenario runner ───────────────────────────────────────────────────

async function runScenario(pick: PickRecord, scenario: Scenario): Promise<void> {
  const bball = isBasketball(pick.league);
  const { home, away } = scenarioScore(scenario, pick.bestBettingMarket, pick.finalPick, pick.league);
  const stats = bball ? randomBasketballStats() : randomFootballStats();

  // Verify the score actually produces the expected outcome
  const actualOutcome = determineOutcome(pick.bestBettingMarket, pick.finalPick, home, away);
  logger.info(
    `[test-fulltime] SCENARIO ${scenario.toUpperCase()}: ` +
    `${pick.homeTeam} vs ${pick.awayTeam} — market: ${pick.bestBettingMarket}, ` +
    `pick: "${pick.finalPick}", score: ${home}–${away}, outcome: ${actualOutcome}`
  );

  const narrative = await generateFulltimeNarrative(pick, home, away, actualOutcome, stats, []);
  const message   = formatFulltimeMessage(pick, home, away, actualOutcome, stats, narrative);

  logger.info(`[test-fulltime] sending scenario ${scenario} message to Telegram...`);
  await sendToGroup(message);
  logger.info(`[test-fulltime] ✓ scenario ${scenario} sent`);

  // Brief pause between scenarios to avoid rate limits
  await new Promise(resolve => setTimeout(resolve, 3_000));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args        = process.argv.slice(2);
  const targetDate  = args[0] ?? new Date().toISOString().slice(0, 10);
  const sportFilter = args[1];

  logger.info(`[test-fulltime] loading pick — date: ${targetDate}, sport: ${sportFilter ?? 'any'}`);

  const pick = await loadTestPick(targetDate, sportFilter, 'test-fulltime');
  if (!pick) {
    logger.error('[test-fulltime] no pick loaded — aborting');
    process.exit(1);
  }

  logger.info(`[test-fulltime] using: ${pick.homeTeam} vs ${pick.awayTeam} | ${pick.finalPick} (${pick.bestBettingMarket})`);

  const scenarios: Scenario[] = ['win', 'loss'];
  if (supportsPush(pick.bestBettingMarket, pick.finalPick)) {
    scenarios.push('push');
  } else {
    logger.info(
      `[test-fulltime] push scenario not supported for ${pick.bestBettingMarket} / "${pick.finalPick}" — running win/loss only`
    );
  }

  for (const scenario of scenarios) {
    logger.info(`\n${'─'.repeat(60)}`);
    logger.info(`[test-fulltime] ↓ Running scenario: ${scenario.toUpperCase()}`);
    await runScenario(pick, scenario);
  }

  logger.info(`\n[test-fulltime] ✅ ${scenarios.length} scenario(s) sent`);
}

main().catch(err => {
  logger.error(`[test-fulltime] fatal: ${String(err)}`);
  process.exit(1);
});
