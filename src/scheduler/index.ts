import cron from 'node-cron';
import { config } from '../config';
import { logger } from '../utils/logger';
import { fetchTodayFixtures } from '../sports/fixtures';
import { runFullAnalysisPipeline } from '../ai-analysis';
import { publishSingleResult } from '../bot/publisher';
import { alreadyPosted } from './dedup';
import { tomorrowUtc, todayUtc, formatAthensDateTimeCompact } from '../utils/date';
import { withRetry } from '../utils/retry';
import { saveFixtures, loadFixtures } from '../utils/checkpoint';
import { runWeeklyReport, runMonthlyReport, isFirstMondayOfMonth } from '../reports';
import type { Fixture } from '../types';

type FixtureRunContext = {
  index?: number;
  total?: number;
};

function fixtureRunLabel(fixture: Fixture, context?: FixtureRunContext): string {
  const ordinal =
    typeof context?.index === 'number' && typeof context?.total === 'number'
      ? ` ${context.index}/${context.total}`
      : '';
  return `FIXTURE${ordinal} | ${fixture.homeTeam} vs ${fixture.awayTeam} | ${fixture.league}`;
}

function logFixtureBlockStart(fixture: Fixture, date: string, context?: FixtureRunContext): void {
  const label = fixtureRunLabel(fixture, context);
  logger.info('');
  logger.info('───────────────────────────────────────────────────────────────');
  logger.info(`[scheduler] ${label}`);
  logger.info(`[scheduler] date=${date} | fixtureId=${fixture.id}`);
  logger.info('───────────────────────────────────────────────────────────────');
}

function logFixtureBlockEnd(fixture: Fixture, outcome: string, context?: FixtureRunContext): void {
  const label = fixtureRunLabel(fixture, context);
  logger.info(`[scheduler] ${label} | outcome=${outcome}`);
  logger.info('───────────────────────────────────────────────────────────────');
  logger.info('');
}

// ─── Per-fixture job ──────────────────────────────────────────────────────────

/**
 * Analyzes a single fixture and posts to Telegram if the pick is approved.
 * This runs at `kickoff - HOURS_BEFORE_KICKOFF`, giving the most up-to-date
 * live context right before each event.
 */
async function runFixtureJob(fixture: Fixture, date: string, context?: FixtureRunContext): Promise<void> {
  logFixtureBlockStart(fixture, date, context);

  let outcome = 'unknown';

  try {
    if (!config.analysis.forceAnalysis && alreadyPosted(fixture.id, date)) {
      logger.info(`[scheduler] ${fixture.id} already posted — skipping`);
      outcome = 'already-posted';
      return;
    }

    const results = await runFullAnalysisPipeline([fixture], date);

    if (results.length === 0) {
      logger.info(
        `[scheduler] no qualifying pick for ${fixture.homeTeam} vs ${fixture.awayTeam}`
      );
      outcome = 'no-pick';
      return;
    }

    await publishSingleResult(results[0], date);
    outcome = 'posted';
  } catch (err) {
    outcome = 'error';
    logger.error(`[scheduler] analysis failed for ${fixture.id}: ${String(err)}`);
  } finally {
    logFixtureBlockEnd(fixture, outcome, context);
  }
}

// ─── Planning job ─────────────────────────────────────────────────────────────

/**
 * Fetches the next day's fixtures and schedules a per-fixture
 * analysis job to fire `HOURS_BEFORE_KICKOFF` hours before each event.
 *
 * @param dateOverride  Override the target date (test mode). Normally tomorrow.
 */
export async function runPlanningJob(dateOverride?: string): Promise<void> {
  const targetDate = dateOverride ?? tomorrowUtc();
  logger.info(`[scheduler] planning job triggered — scheduling fixtures for ${targetDate}`);

  let fixtures: Fixture[] | null = loadFixtures(targetDate);

  if (fixtures) {
    logger.info(`[scheduler] using ${fixtures.length} fixture(s) from checkpoint for ${targetDate}`);
  } else {
    try {
      fixtures = await withRetry(() => fetchTodayFixtures(targetDate), {
        maxAttempts: 3,
        label: 'fetchTodayFixtures',
      });
    } catch (err) {
      logger.error(`[scheduler] failed to fetch fixtures: ${String(err)}`);
      return;
    }
    saveFixtures(targetDate, fixtures);
  }

  if (fixtures.length === 0) {
    logger.info(`[scheduler] no fixtures on ${targetDate}`);
    return;
  }

  logger.info(`[scheduler] ${fixtures.length} fixture(s) found — scheduling pre-match jobs`);

  const hoursMs = config.scheduler.hoursBeforeKickoff * 60 * 60 * 1000;
  const now = Date.now();
  // In test/override mode, run jobs immediately and awaited (sequential) so
  // the caller can await the full run before process.exit().
  const testMode = !!dateOverride;

  if (testMode) {
    for (const [index, fixture] of fixtures.entries()) {
      await runFixtureJob(fixture, targetDate, { index: index + 1, total: fixtures.length });
    }
    return;
  }

  // Production: schedule each fixture job to fire HOURS_BEFORE_KICKOFF before kickoff.
  let scheduled = 0;
  for (const fixture of fixtures) {
    const kickoff = new Date(fixture.date).getTime();
    const postAt = kickoff - hoursMs;
    const delayMs = postAt - now;

    if (delayMs <= 0) {
      logger.warn(
        `[scheduler] ${fixture.homeTeam} vs ${fixture.awayTeam}: post time already passed, running now`
      );
      void runFixtureJob(fixture, targetDate);
    } else {
      const postTimeAthens = formatAthensDateTimeCompact(new Date(postAt).toISOString());
      const kickoffAthens = formatAthensDateTimeCompact(fixture.date);
      logger.info(
        `[scheduler] ${fixture.homeTeam} vs ${fixture.awayTeam}: post at ${postTimeAthens} Athens (kickoff ${kickoffAthens})`
      );
      setTimeout(() => void runFixtureJob(fixture, targetDate), delayMs);
      scheduled++;
    }
  }

  logger.info(`[scheduler] ${scheduled} pre-match job(s) scheduled`);
}

// ─── Cron registration ────────────────────────────────────────────────────────

/**
 * On startup, check if today's fixtures were already checkpointed (e.g. after a
 * server restart) and reschedule any not-yet-posted pre-match jobs.
 */
function recoverTodayJobs(): void {
  const today = todayUtc();
  const fixtures = loadFixtures(today);
  if (!fixtures || fixtures.length === 0) return;

  const hoursMs = config.scheduler.hoursBeforeKickoff * 60 * 60 * 1000;
  const now = Date.now();
  let recovered = 0;

  for (const fixture of fixtures) {
    if (alreadyPosted(fixture.id, today)) continue; // already sent before restart

    const kickoff = new Date(fixture.date).getTime();
    const postAt = kickoff - hoursMs;
    const delayMs = postAt - now;

    if (delayMs <= 0) {
      // Post window already started — run immediately
      logger.warn(
        `[scheduler] recovery: ${fixture.homeTeam} vs ${fixture.awayTeam} post time passed, running now`
      );
      void runFixtureJob(fixture, today);
    } else {
      const postTimeAthens = formatAthensDateTimeCompact(new Date(postAt).toISOString());
      logger.info(
        `[scheduler] recovery: ${fixture.homeTeam} vs ${fixture.awayTeam} rescheduled for ${postTimeAthens} Athens`
      );
      setTimeout(() => void runFixtureJob(fixture, today), delayMs);
      recovered++;
    }
  }

  if (recovered > 0) {
    logger.info(`[scheduler] recovery: ${recovered} pre-match job(s) rescheduled from checkpoint`);
  }
}

/**
 * Registers the nightly planning cron job.
 * Fires once per day to schedule the next day's per-fixture analysis posts.
 */
export function startScheduler(): void {
  const { planningCron, timezone } = config.scheduler;

  if (!cron.validate(planningCron)) {
    throw new Error(`Invalid cron expression: "${planningCron}"`);
  }

  // Recover any pending jobs for today in case of restart
  recoverTodayJobs();

  cron.schedule(
    planningCron,
    async () => {
      try {
        await runPlanningJob();
      } catch (err) {
        logger.error(`[scheduler] unhandled error in planning job: ${String(err)}`);
      }
    },
    { timezone }
  );

  // ── Monday 10:00 Athens — weekly (and optionally monthly) reports ──────────
  cron.schedule(
    '0 10 * * 1',
    async () => {
      // Weekly report — always runs every Monday
      try {
        await runWeeklyReport();
      } catch (err) {
        logger.error(`[scheduler] weekly report failed: ${String(err)}`);
      }

      // Monthly report — only on the first Monday of a new calendar month
      if (isFirstMondayOfMonth()) {
        try {
          await runMonthlyReport();
        } catch (err) {
          logger.error(`[scheduler] monthly report failed: ${String(err)}`);
        }
      }
    },
    { timezone }
  );

  logger.info(`[scheduler] planning cron registered — will run: "${planningCron}" (${timezone}), ` +
    `posting each fixture ${config.scheduler.hoursBeforeKickoff}h before kickoff`
  );
  logger.info(`[scheduler] report cron registered — every Monday 10:00 ${timezone}`);
  logger.info(`[scheduler] halftime updates: per-fixture setTimeout (no cron)`);
}
