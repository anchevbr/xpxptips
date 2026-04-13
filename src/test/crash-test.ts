/**
 * crash-test.ts
 *
 * Two-phase crash test to verify checkpoint/restart recovery end-to-end.
 *
 * Phase 1  — fetches real fixtures, saves checkpoint, then intentionally
 *             exits with code 1 (simulates a server crash/restart).
 *
 * Phase 2  — detects the existing checkpoint, loads fixtures from disk,
 *             skips any already-checkpointed analysis, and
 *             runs/posts only what is missing — as if recovering from crash.
 *
 * Usage:
 *   Phase 1:  npx ts-node src/test/crash-test.ts
 *   Phase 2:  npx ts-node src/test/crash-test.ts
 *   (the script auto-detects which phase to run based on checkpoint presence)
 *
 * Env overrides (all optional):
 *   TEST_DATE    target date     (default: 2026-04-16)
 *   TEST_LEAGUES comma-separated (default: "Europa League,EuroLeague")
 */

import 'dotenv/config';
import path from 'path';
import fs from 'fs';
import { logger } from '../utils/logger';
import { fetchTodayFixtures } from '../sports/fixtures';
import { saveFixtures, loadFixtures } from '../utils/checkpoint';
import { runFullAnalysisPipeline } from '../ai-analysis';
import { publishSingleResult } from '../bot/publisher';
import { alreadyPosted } from '../scheduler/dedup';
import { config } from '../config';

// ── Config ────────────────────────────────────────────────────────────────────

const DATE = process.env['TEST_DATE'] ?? '2026-04-16';
// Two different leagues — football + basketball
process.env['TEST_LEAGUES'] = process.env['TEST_LEAGUES'] ?? 'Europa League,EuroLeague';

const CHECKPOINT_BASE = path.resolve('./data/checkpoints');

function checkpointExists(): boolean {
  const f = path.join(CHECKPOINT_BASE, DATE, 'fixtures.json');
  return fs.existsSync(f);
}

// ── Phase 1 ───────────────────────────────────────────────────────────────────

async function phase1(): Promise<void> {
  logger.info('');
  logger.info('╔══════════════════════════════════════════════════════╗');
  logger.info('║  CRASH TEST — PHASE 1: fetch  →  save  →  CRASH     ║');
  logger.info('╚══════════════════════════════════════════════════════╝');
  logger.info('');

  const fixtures = await fetchTodayFixtures(DATE);

  if (fixtures.length === 0) {
    logger.error('[crash-test] no fixtures returned — cannot continue crash test');
    process.exit(1);
  }

  saveFixtures(DATE, fixtures);

  logger.info('');
  logger.info(`[crash-test] ✓ ${fixtures.length} fixture(s) written to checkpoint`);
  for (const f of fixtures) {
    logger.info(`  • [${f.league}] ${f.homeTeam} vs ${f.awayTeam} — ${f.date}`);
  }

  logger.info('');
  logger.info('[crash-test] ══ SIMULATING SERVER CRASH (exit 1) ══════');
  logger.info('[crash-test] Re-run this script to enter Phase 2 (recovery)');
  logger.info('');
  process.exit(1); // intentional crash
}

// ── Phase 2 ───────────────────────────────────────────────────────────────────

async function phase2(): Promise<void> {
  logger.info('');
  logger.info('╔══════════════════════════════════════════════════════╗');
  logger.info('║  CRASH TEST — PHASE 2: recover  →  analyze  →  post ║');
  logger.info('╚══════════════════════════════════════════════════════╝');
  logger.info('');

  const fixtures = loadFixtures(DATE);
  if (!fixtures || fixtures.length === 0) {
    logger.error('[crash-test] no checkpoint found — run Phase 1 first');
    process.exit(1);
  }

  logger.info(`[crash-test] ✓ loaded ${fixtures.length} fixture(s) from checkpoint (no HTTP call made)`);
  for (const f of fixtures) {
    logger.info(`  • [${f.league}] ${f.homeTeam} vs ${f.awayTeam}`);
  }
  logger.info('');

  for (const fixture of fixtures) {
    if (!config.analysis.forceAnalysis && alreadyPosted(fixture.id, DATE)) {
      logger.info(`[crash-test] ${fixture.id} already posted — skipping`);
      continue;
    }

    logger.info(`[crash-test] ── processing: ${fixture.homeTeam} vs ${fixture.awayTeam}`);

    try {
      // runFullAnalysisPipeline internally checks checkpoints for expert analysis
      const results = await runFullAnalysisPipeline([fixture], DATE);

      if (results.length > 0) {
        await publishSingleResult(results[0], DATE);
        logger.info(`[crash-test] ✓ posted tip for ${fixture.homeTeam} vs ${fixture.awayTeam}`);
      } else {
        logger.info(`[crash-test] ✗ no approved pick for ${fixture.homeTeam} vs ${fixture.awayTeam}`);
      }
    } catch (err) {
      logger.error(`[crash-test] failed for ${fixture.id}: ${String(err)}`);
    }
  }

  logger.info('');
  logger.info('╔══════════════════════════════════════════════════════╗');
  logger.info('║  CRASH TEST COMPLETE                                 ║');
  logger.info('╚══════════════════════════════════════════════════════╝');
}

// ── Entry point ───────────────────────────────────────────────────────────────

(async () => {
  if (checkpointExists()) {
    await phase2();
  } else {
    await phase1();
  }
})().catch((err) => {
  logger.error(`[crash-test] fatal: ${String(err)}`);
  process.exit(1);
});
