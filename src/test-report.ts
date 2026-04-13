// ─────────────────────────────────────────────────────────────────────────────
// test-report.ts
//
// Test script for weekly/monthly reports.
//
// Loads existing posted picks from data/posted.json + checkpoint analysis files,
// injects them into picks-log.json, assigns random outcomes with random scores,
// then runs the full weekly report pipeline (narrative → Telegram).
//
// Usage:
//   npm run test-report
//   npm run test-report 2026-04-16    (date whose posted picks to use)
// ─────────────────────────────────────────────────────────────────────────────

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { logger } from './utils/logger';
import { addPick, getAllPicks, updateOutcome } from './reports/picks-store';
import { resolveOutcome, formatScore } from './reports/result-resolver';
import { generateNarrative } from './reports/report-generator';
import { formatWeeklyReport } from './reports/report-formatter';
import { sendAndPinInGroup } from './bot/telegram';
import type { PickRecord, BettingAnalysis } from './types';

const CHECKPOINT_BASE = path.resolve('./data/checkpoints');
const POSTED_PATH = path.resolve('./data/posted.json');

function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function isBasketballLeague(league: string): boolean {
  return (
    league.toLowerCase().includes('euroleague') ||
    league.toLowerCase().includes('nba') ||
    league.toLowerCase().includes('basketball') ||
    league.toLowerCase().includes('euroliga')
  );
}

function winningScore(market: string, finalPick: string, league: string): { home: number; away: number } {
  const bball = isBasketballLeague(league);
  const lineMatch = /(\d+(?:\.\d+)?)/.exec(finalPick);
  const line = lineMatch ? parseFloat(lineMatch[1]!) : null;

  switch (market) {
    case 'h2h/home': {
      const home = bball ? rand(85, 105) : rand(1, 4);
      const away = bball ? rand(65, home - 1) : rand(0, home - 1);
      return { home, away };
    }
    case 'h2h/draw': {
      const s = bball ? rand(85, 100) : rand(0, 3);
      return { home: s, away: s };
    }
    case 'h2h/away': {
      const away = bball ? rand(85, 105) : rand(1, 4);
      const home = bball ? rand(65, away - 1) : rand(0, away - 1);
      return { home, away };
    }
    case 'totals/over': {
      const base = line ?? (bball ? 170 : 2.5);
      if (bball) {
        const half = Math.ceil(base / 2);
        return { home: half + rand(1, 10), away: half + rand(0, 5) };
      }
      return { home: rand(2, 4), away: rand(1, 3) };
    }
    case 'totals/under': {
      const base = line ?? (bball ? 170 : 2.5);
      if (bball) {
        const half = Math.floor(base / 2);
        return { home: rand(Math.max(half - 15, 60), half - 2), away: rand(Math.max(half - 15, 55), half - 2) };
      }
      return { home: rand(0, 1), away: rand(0, 1) };
    }
    case 'btts/yes':
      return { home: rand(1, 3), away: rand(1, 3) };
    case 'btts/no':
      return { home: rand(1, 4), away: 0 };
    default:
      return { home: rand(1, 3), away: rand(0, 2) };
  }
}

function losingScore(market: string, finalPick: string, league: string): { home: number; away: number } {
  const bball = isBasketballLeague(league);
  const lineMatch = /(\d+(?:\.\d+)?)/.exec(finalPick);
  const line = lineMatch ? parseFloat(lineMatch[1]!) : null;

  switch (market) {
    case 'h2h/home': {
      const away = bball ? rand(85, 105) : rand(1, 4);
      const home = bball ? rand(65, away - 1) : rand(0, away - 1);
      return { home, away };
    }
    case 'h2h/draw':
      return { home: rand(1, 4), away: rand(0, 2) };
    case 'h2h/away': {
      const home = bball ? rand(85, 105) : rand(1, 4);
      const away = bball ? rand(65, home - 1) : rand(0, home - 1);
      return { home, away };
    }
    case 'totals/over': {
      const base = line ?? (bball ? 170 : 2.5);
      if (bball) {
        const half = Math.floor(base / 2);
        return { home: rand(Math.max(half - 10, 60), half - 1), away: rand(Math.max(half - 10, 55), half - 1) };
      }
      return { home: rand(0, 1), away: 0 };
    }
    case 'totals/under': {
      const base = line ?? (bball ? 170 : 2.5);
      if (bball) {
        const half = Math.ceil(base / 2);
        return { home: half + rand(1, 10), away: half + rand(0, 5) };
      }
      return { home: rand(2, 4), away: rand(1, 3) };
    }
    case 'btts/yes':
      return { home: rand(1, 3), away: 0 };
    case 'btts/no':
      return { home: rand(1, 3), away: rand(1, 3) };
    default:
      return { home: rand(0, 2), away: rand(0, 2) };
  }
}

function seedPicksFromCheckpoints(targetDate: string): void {
  let posted: Record<string, Record<string, string>> = {};
  if (fs.existsSync(POSTED_PATH)) {
    posted = JSON.parse(fs.readFileSync(POSTED_PATH, 'utf-8')) as typeof posted;
  }

  const datePosted = posted[targetDate];
  if (!datePosted || Object.keys(datePosted).length === 0) {
    logger.warn(`[test-report] no posted picks found for ${targetDate}`);
    return;
  }

  const fixturesFile = path.join(CHECKPOINT_BASE, targetDate, 'fixtures.json');
  if (!fs.existsSync(fixturesFile)) {
    logger.warn(`[test-report] fixtures checkpoint not found for ${targetDate}`);
    return;
  }
  const { fixtures } = JSON.parse(fs.readFileSync(fixturesFile, 'utf-8')) as {
    fixtures: Array<{ id: string; league: string; homeTeam: string; awayTeam: string }>;
  };
  const fixtureMap = Object.fromEntries(fixtures.map(f => [f.id, f]));
  const existingIds = new Set(getAllPicks().map(p => p.fixtureId));

  for (const [fixtureId] of Object.entries(datePosted)) {
    if (existingIds.has(fixtureId)) {
      logger.info(`[test-report] ${fixtureId} already in picks-log — skipping`);
      continue;
    }

    const analysisFile = path.join(CHECKPOINT_BASE, targetDate, 'analysis', `${fixtureId}.json`);
    if (!fs.existsSync(analysisFile)) {
      logger.warn(`[test-report] no analysis checkpoint for ${fixtureId} — skipping`);
      continue;
    }

    const { analysis } = JSON.parse(fs.readFileSync(analysisFile, 'utf-8')) as {
      analysis: BettingAnalysis;
    };

    const fixture = fixtureMap[fixtureId];
    if (!fixture) {
      logger.warn(`[test-report] fixture metadata missing for ${fixtureId}`);
      continue;
    }

    const record: PickRecord = {
      fixtureId,
      date: targetDate,
      league: fixture.league,
      homeTeam: fixture.homeTeam,
      awayTeam: fixture.awayTeam,
      postedAt: new Date(`${targetDate}T08:00:00Z`).toISOString(),
      finalPick: analysis.finalPick,
      bestBettingMarket: analysis.bestBettingMarket,
      confidence: analysis.confidence,
      outcome: null,
      actualScore: null,
      resolvedAt: null,
      halfTimeNotifiedAt: null,
      fullTimeNotifiedAt: null,
    };

    addPick(record);
    logger.info(
      `[test-report] seeded: ${fixture.homeTeam} vs ${fixture.awayTeam} — "${analysis.finalPick}" [${analysis.bestBettingMarket}]`
    );
  }
}

function assignRandomOutcomes(targetDate: string): void {
  const picks = getAllPicks().filter(p => p.date === targetDate && p.outcome === null);
  if (picks.length === 0) {
    logger.info('[test-report] no pending picks to assign outcomes to');
    return;
  }

  logger.info(`[test-report] assigning random outcomes to ${picks.length} pick(s) (~60% win rate)`);

  for (const pick of picks) {
    const shouldWin = Math.random() < 0.6;
    const scores = shouldWin
      ? winningScore(pick.bestBettingMarket, pick.finalPick, pick.league)
      : losingScore(pick.bestBettingMarket, pick.finalPick, pick.league);

    const outcome = resolveOutcome(pick.bestBettingMarket, pick.finalPick, scores.home, scores.away);
    const scoreStr = formatScore(scores.home, scores.away);

    updateOutcome(pick.fixtureId, outcome, scoreStr);
    logger.info(
      `  ${pick.homeTeam} vs ${pick.awayTeam} | pick: "${pick.finalPick}" | score: ${scoreStr} | ${outcome.toUpperCase()}`
    );
  }
}

async function main(): Promise<void> {
  const targetDate = process.argv[2] ?? '2026-04-16';

  logger.info('');
  logger.info('═══════════════════════════════════════════════════════════════');
  logger.info('TEST REPORT RUNNER');
  logger.info('═══════════════════════════════════════════════════════════════');
  logger.info(`Target date for picks: ${targetDate}`);
  logger.info('');

  logger.info('[test-report] seeding picks from checkpoints...');
  seedPicksFromCheckpoints(targetDate);

  logger.info('[test-report] assigning random outcomes...');
  assignRandomOutcomes(targetDate);

  const picks = getAllPicks().filter(p => p.date === targetDate);
  if (picks.length === 0) {
    logger.warn('[test-report] no picks to report — exiting');
    process.exit(0);
  }

  logger.info('[test-report] generating AI narrative...');
  const narrative = await generateNarrative(picks, `εβδομάδα ${targetDate}`);

  logger.info('[test-report] formatting and sending report to Telegram...');
  const message = formatWeeklyReport(picks, targetDate, targetDate, narrative);
  await sendAndPinInGroup(message);

  logger.info('');
  logger.info('═══════════════════════════════════════════════════════════════');
  logger.info('TEST REPORT COMPLETE — check Telegram for the report message');
  logger.info('═══════════════════════════════════════════════════════════════');
  logger.info('');

  process.exit(0);
}

main().catch(err => {
  logger.error(`[test-report] fatal: ${String(err)}`);
  process.exit(1);
});
