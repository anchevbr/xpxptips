// ─────────────────────────────────────────────────────────────────────────────
// test-halftime.ts
//
// Test script for the halftime live update feature.
//
// Loads one pick from existing checkpoint analysis files, generates random
// realistic halftime stats and score, calls GPT for the narrative, formats
// the message and sends it to Telegram — no real live-data poll needed.
//
// Usage:
//   npm run test-halftime
//   npm run test-halftime 2026-04-16    (date to pick fixtures from)
// ─────────────────────────────────────────────────────────────────────────────

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';
import { generateHalftimeNarrative } from '../halftime/narrator';
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

// ─── Random halftime score ────────────────────────────────────────────────────

function randomHalftimeScore(market: string, league: string): { home: number; away: number } {
  const bball = isBasketball(league);

  if (bball) {
    // Basketball: typical first half scores 40–60 each side
    return { home: rand(38, 62), away: rand(38, 62) };
  }

  // Football: typical HT scores 0–2 each
  switch (market) {
    case 'h2h/home':
      return { home: rand(1, 2), away: rand(0, 1) };
    case 'h2h/away':
      return { home: rand(0, 1), away: rand(1, 2) };
    case 'h2h/draw':
      return { home: rand(0, 1), away: rand(0, 1) };
    case 'totals/over':
      return { home: rand(1, 2), away: rand(1, 2) };
    case 'totals/under':
      return { home: rand(0, 1), away: rand(0, 1) };
    default:
      return { home: rand(0, 1), away: rand(0, 1) };
  }
}

// ─── Random halftime stats ────────────────────────────────────────────────────

interface FakeStat { strStat: string; intHome: string; intAway: string }

function randomFootballStats(): FakeStat[] {
  const homePoss = rand(38, 65);
  return [
    { strStat: 'Shots on Goal',      intHome: String(rand(2, 8)),       intAway: String(rand(1, 6)) },
    { strStat: 'Shots off Goal',     intHome: String(rand(1, 5)),       intAway: String(rand(1, 4)) },
    { strStat: 'Total Shots',        intHome: String(rand(5, 14)),      intAway: String(rand(3, 10)) },
    { strStat: 'Ball Possession',    intHome: String(homePoss),         intAway: String(100 - homePoss) },
    { strStat: 'Corner Kicks',       intHome: String(rand(1, 6)),       intAway: String(rand(0, 4)) },
    { strStat: 'Fouls',              intHome: String(rand(3, 9)),       intAway: String(rand(3, 9)) },
    { strStat: 'Yellow Cards',       intHome: String(rand(0, 2)),       intAway: String(rand(0, 2)) },
    { strStat: 'Offsides',           intHome: String(rand(0, 3)),       intAway: String(rand(0, 3)) },
    { strStat: 'Goalkeeper Saves',   intHome: String(rand(1, 4)),       intAway: String(rand(1, 5)) },
    { strStat: 'expected_goals',     intHome: String(rand(0, 2)),       intAway: String(rand(0, 2)) },
  ];
}

function randomBasketballStats(): FakeStat[] {
  return [
    { strStat: 'Field Goals %',      intHome: String(rand(40, 58)),     intAway: String(rand(38, 55)) },
    { strStat: '3 Points %',         intHome: String(rand(28, 45)),     intAway: String(rand(25, 43)) },
    { strStat: 'Free Throws %',      intHome: String(rand(65, 90)),     intAway: String(rand(60, 88)) },
    { strStat: 'Rebounds',           intHome: String(rand(15, 28)),     intAway: String(rand(14, 26)) },
    { strStat: 'Assists',            intHome: String(rand(6, 14)),      intAway: String(rand(5, 13)) },
    { strStat: 'Turnovers',          intHome: String(rand(3, 10)),      intAway: String(rand(3, 10)) },
    { strStat: 'Steals',             intHome: String(rand(2, 7)),       intAway: String(rand(2, 7)) },
    { strStat: 'Blocks',             intHome: String(rand(1, 5)),       intAway: String(rand(1, 5)) },
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

function formatHalftimeMessage(
  pick: PickRecord,
  homeScore: number,
  awayScore: number,
  stats: FakeStat[],
  narrative: string
): string {
  const statsLine = keyStats(stats);
  return (
    `⏱️ <b>Ενημέρωση Ημιχρόνου</b>\n\n` +
    `🏟️ <b>${pick.homeTeam} vs ${pick.awayTeam}</b>\n` +
    `🏆 ${pick.league}\n` +
    `⚽ Σκορ: <b>${homeScore}–${awayScore}</b> (HT)\n` +
    `🎯 Πρόταση: <b>${pick.finalPick}</b>\n\n` +
    `<i>${narrative}</i>\n` +
    (statsLine ? `\n📊 ${statsLine}` : '')
  );
}

// ─── Scenario scores ──────────────────────────────────────────────────────────

type Scenario = 'win' | 'loss' | 'withdraw';

/**
 * Returns a deterministic HT score that clearly represents each scenario
 * for the given market/sport, so GPT can reason correctly about the tip status.
 */
function scenarioScore(
  scenario: Scenario,
  market: string,
  league: string
): { home: number; away: number } {
  const bball = isBasketball(league);

  if (bball) {
    const lineMatch = /(\d+(?:\.\d+)?)/.exec(market === 'totals/over' || market === 'totals/under' ? market : '');
    const line = lineMatch ? parseFloat(lineMatch[1]!) : 170;
    const halfLine = Math.round(line / 2);

    switch (scenario) {
      case 'win':
        // Clearly on track: totals/over → low HT, totals/under → high HT
        return market === 'totals/over'
          ? { home: halfLine - 15, away: halfLine - 12 }
          : { home: halfLine + 8,  away: halfLine + 6  };
      case 'loss':
        // At risk but not dead
        return market === 'totals/over'
          ? { home: halfLine - 5,  away: halfLine - 4  }
          : { home: halfLine + 2,  away: halfLine + 1  };
      case 'withdraw':
        // Already lost or mathematically impossible
        return market === 'totals/over'
          ? { home: halfLine - 2,  away: halfLine - 2  } // needs 6 pts in 2nd half — nearly impossible
          : { home: halfLine + 12, away: halfLine + 10 }; // already way over → give up
    }
  }

  // Football
  switch (market) {
    case 'h2h/home':
      return scenario === 'win'      ? { home: 2, away: 0 }
           : scenario === 'loss'     ? { home: 0, away: 1 }
           :                           { home: 0, away: 3 };  // withdraw: 0-3 at HT
    case 'h2h/away':
      return scenario === 'win'      ? { home: 0, away: 2 }
           : scenario === 'loss'     ? { home: 1, away: 0 }
           :                           { home: 3, away: 0 };
    case 'h2h/draw':
      return scenario === 'win'      ? { home: 1, away: 1 }
           : scenario === 'loss'     ? { home: 1, away: 0 }
           :                           { home: 3, away: 0 };  // 3-0 at HT, draw impossible
    case 'totals/over':
      return scenario === 'win'      ? { home: 2, away: 2 }  // 4 goals at HT, over is done
           : scenario === 'loss'     ? { home: 1, away: 0 }  // need 2 more in 2nd half
           :                           { home: 0, away: 0 }; // 0-0 at HT, over 2.5 needs 3 in 2nd — almost impossible
    case 'totals/under':
    default:
      return scenario === 'win'      ? { home: 0, away: 0 }  // 0-0 at HT, under 2.5 well on track
           : scenario === 'loss'     ? { home: 1, away: 1 }  // 2 goals, need 0 more — risky
           :                           { home: 2, away: 1 }; // 3 goals at HT = already lost (under 2.5)
  }
}

// ─── Single scenario runner ───────────────────────────────────────────────────

async function runScenario(pick: PickRecord, scenario: Scenario): Promise<void> {
  const bball = isBasketball(pick.league);
  const { home, away } = scenarioScore(scenario, pick.bestBettingMarket, pick.league);
  const stats = bball ? randomBasketballStats() : randomFootballStats();

  const label = scenario === 'win' ? '🟢 WIN' : scenario === 'loss' ? '🟡 LOSS' : '🔴 WITHDRAW';
  logger.info(`[test-halftime] ── Scenario: ${label} — HT ${home}–${away}`);
  logger.info(`[test-halftime] generating AI narrative...`);

  const narrative = await generateHalftimeNarrative(pick, home, away, stats, []);
  const message   = formatHalftimeMessage(pick, home, away, stats, narrative);

  await sendToGroup(message);
  logger.info(`[test-halftime] sent.`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const targetDate = process.argv[2] ?? new Date().toISOString().slice(0, 10);
  const sportFilter = (process.argv[3] ?? '').toLowerCase();

  logger.info('');
  logger.info('═══════════════════════════════════════════════════════════════');
  logger.info('TEST HALFTIME RUNNER — 3 SCENARIOS');
  logger.info('═══════════════════════════════════════════════════════════════');
  logger.info(`Target date: ${targetDate}`);
  logger.info('');

  const pick = await loadTestPick(targetDate, sportFilter || undefined, 'test-halftime');
  if (!pick) process.exit(1);

  logger.info(`[test-halftime] fixture: ${pick.homeTeam} vs ${pick.awayTeam} (${pick.league})`);
  logger.info(`[test-halftime] pick: "${pick.finalPick}" [${pick.bestBettingMarket}]`);
  logger.info('');

  for (const scenario of ['win', 'loss', 'withdraw'] as Scenario[]) {
    await runScenario(pick, scenario);
    logger.info('');
  }

  logger.info('═══════════════════════════════════════════════════════════════');
  logger.info('ALL 3 SCENARIOS SENT — check Telegram');
  logger.info('═══════════════════════════════════════════════════════════════');
  logger.info('');
}

main().catch(err => {
  logger.error(`[test-halftime] fatal: ${String(err)}`);
  process.exit(1);
});
