import cron from 'node-cron';
import { config } from '../config';
import { logger } from '../utils/logger';
import { runDailyOpenAISpendReport } from '../costs/openai-spend';
import { fetchTodayFixtures } from '../sports/fixtures';
import { runFullAnalysisPipeline } from '../ai-analysis';
import { publishSingleResult } from '../bot/publisher';
import { alreadyPosted } from './dedup';
import {
  formatAthensDateTimeCompact,
  todayInTimeZone,
  tomorrowInTimeZone,
  yesterdayInTimeZone,
} from '../utils/date';
import { withRetry } from '../utils/retry';
import { saveFixtures, loadFixtures } from '../utils/checkpoint';
import { runWeeklyReport, runMonthlyReport, isFirstMondayOfMonth } from '../reports';
import { getAllPicks, updateKickoffAt } from '../reports/picks-store';
import { recoverHalftimeWatch } from '../halftime';
import { recoverFulltimeWatch } from '../fulltime';
import type { Fixture, PickRecord } from '../types';

type FixtureRunContext = {
  index?: number;
  total?: number;
};

type ScheduleFixtureResult = 'scheduled' | 'started-immediately';

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

function resolvePickKickoffAt(
  pick: PickRecord,
  fixturesByDate: Map<string, Fixture[] | null>
): string | null {
  if (pick.kickoffAt) {
    return pick.kickoffAt;
  }

  let fixtures = fixturesByDate.get(pick.date);
  if (fixtures === undefined) {
    fixtures = loadFixtures(pick.date);
    fixturesByDate.set(pick.date, fixtures);
  }

  const fixture = fixtures?.find(candidate => candidate.id === pick.fixtureId);
  if (!fixture) {
    return null;
  }

  pick.kickoffAt = fixture.date;
  updateKickoffAt(pick.fixtureId, fixture.date);
  return fixture.date;
}

function recoverPublishedWatchers(): void {
  const { timezone } = config.scheduler;
  const recentDates = new Set([
    yesterdayInTimeZone(timezone),
    todayInTimeZone(timezone),
    tomorrowInTimeZone(timezone),
  ]);
  const fixturesByDate = new Map<string, Fixture[] | null>();
  const candidatePicks = getAllPicks().filter(
    pick =>
      (!pick.halfTimeNotifiedAt || !pick.fullTimeNotifiedAt) &&
      (pick.kickoffAt || recentDates.has(pick.date))
  );

  if (candidatePicks.length === 0) {
    return;
  }

  let halftimeRecovered = 0;
  let fulltimeRecovered = 0;
  let missingKickoff = 0;

  for (const pick of candidatePicks) {
    const kickoffAt = resolvePickKickoffAt(pick, fixturesByDate);
    if (!kickoffAt) {
      missingKickoff++;
      continue;
    }

    if (recoverHalftimeWatch(pick)) halftimeRecovered++;
    if (recoverFulltimeWatch(pick)) fulltimeRecovered++;
  }

  if (halftimeRecovered > 0 || fulltimeRecovered > 0) {
    logger.info(
      `[scheduler] recovery: rescheduled ${halftimeRecovered} halftime watcher(s) and ${fulltimeRecovered} full-time watcher(s)`
    );
  }

  if (missingKickoff > 0) {
    logger.warn(
      `[scheduler] recovery: skipped ${missingKickoff} published pick(s) with no kickoff time in picks-log or fixture checkpoint)`
    );
  }
}

// ─── Per-fixture job ──────────────────────────────────────────────────────────

/**
 * Runs analysis for a single fixture and sends it immediately if the result
 * passes all publication gates.
 */
async function runFixtureJob(
  fixture: Fixture,
  date: string,
  context?: FixtureRunContext
): Promise<void> {
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
      logger.info(`[scheduler] no qualifying pick for ${fixture.homeTeam} vs ${fixture.awayTeam}`);
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

function scheduleFixtureJob(
  fixture: Fixture,
  date: string,
  now: number,
  context?: FixtureRunContext,
  recovery = false,
): ScheduleFixtureResult {
  const analysisLeadMs = config.scheduler.analysisHoursBeforeKickoff * 60 * 60 * 1000;
  const kickoff = new Date(fixture.date).getTime();
  const runAt = kickoff - analysisLeadMs;
  const delayMs = runAt - now;
  const kickoffAthens = formatAthensDateTimeCompact(fixture.date);
  const prefix = recovery ? 'recovery: ' : '';

  if (delayMs <= 0) {
    logger.warn(
      `[scheduler] ${prefix}${fixture.homeTeam} vs ${fixture.awayTeam}: analysis window already started, running now`
    );
    void runFixtureJob(fixture, date, context);
    return 'started-immediately';
  }

  logger.info(
    `[scheduler] ${prefix}${fixture.homeTeam} vs ${fixture.awayTeam}: analyze and send at ${formatAthensDateTimeCompact(new Date(runAt).toISOString())} Athens (kickoff ${kickoffAthens})`
  );
  setTimeout(() => void runFixtureJob(fixture, date, context), delayMs);
  return 'scheduled';
}

// ─── Planning job ─────────────────────────────────────────────────────────────

/**
 * Fetches the target day's fixtures and schedules a single per-fixture
 * analysis job that sends immediately if approved.
 *
 * @param dateOverride  Override the target date (test mode). Normally today in TIMEZONE.
 */
export async function runPlanningJob(dateOverride?: string): Promise<void> {
  const targetDate = dateOverride ?? todayInTimeZone(config.scheduler.timezone);
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

  logger.info(`[scheduler] ${fixtures.length} fixture(s) found — scheduling analysis jobs`);

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

  let scheduled = 0;
  let startedImmediately = 0;
  for (const [index, fixture] of fixtures.entries()) {
    const scheduleResult = scheduleFixtureJob(
      fixture,
      targetDate,
      now,
      { index: index + 1, total: fixtures.length },
      false,
    );
    if (scheduleResult === 'scheduled') {
      scheduled++;
    } else {
      startedImmediately++;
    }
  }

  logger.info(
    `[scheduler] ${scheduled} analysis job(s) scheduled, ${startedImmediately} started immediately`
  );
}

// ─── Cron registration ────────────────────────────────────────────────────────

/**
 * On startup, check if today's or tomorrow's fixtures were already
 * checkpointed in TIMEZONE and reschedule any pending analysis jobs after a
 * restart.
 */
function recoverJobsForDate(date: string): void {
  const fixtures = loadFixtures(date);
  if (!fixtures || fixtures.length === 0) return;

  const now = Date.now();
  let scheduled = 0;
  let startedImmediately = 0;

  for (const fixture of fixtures) {
    if (alreadyPosted(fixture.id, date)) continue;
    const scheduleResult = scheduleFixtureJob(fixture, date, now, undefined, true);
    if (scheduleResult === 'scheduled') {
      scheduled++;
    } else {
      startedImmediately++;
    }
  }

  if (scheduled > 0 || startedImmediately > 0) {
    logger.info(
      `[scheduler] recovery: ${scheduled} analysis job(s) rescheduled for ${date}, ` +
      `${startedImmediately} started immediately`
    );
  }
}

/**
 * Registers the nightly planning cron job.
 * Fires once per day to schedule the current TIMEZONE day's per-fixture
 * analysis posts.
 */
export function startScheduler(): void {
  const { dailySpendCron, planningCron, timezone, analysisHoursBeforeKickoff } = config.scheduler;

  if (!cron.validate(dailySpendCron)) {
    throw new Error(`Invalid cron expression: "${dailySpendCron}"`);
  }

  if (!cron.validate(planningCron)) {
    throw new Error(`Invalid cron expression: "${planningCron}"`);
  }

  if (analysisHoursBeforeKickoff <= 0) {
    throw new Error(
      `Invalid scheduler offset: ANALYSIS_HOURS_BEFORE_KICKOFF (${analysisHoursBeforeKickoff}) must be greater than 0`
    );
  }

  // Recover any pending jobs for today and tomorrow in TIMEZONE in case of restart.
  recoverJobsForDate(todayInTimeZone(timezone));
  recoverJobsForDate(tomorrowInTimeZone(timezone));
  recoverPublishedWatchers();

  cron.schedule(
    dailySpendCron,
    async () => {
      try {
        await runDailyOpenAISpendReport();
      } catch (err) {
        logger.error(`[scheduler] daily spend report failed: ${String(err)}`);
      }
    },
    { timezone }
  );

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

  logger.info(
    `[scheduler] planning cron registered — will run: "${planningCron}" (${timezone}), ` +
    `analyzing and posting each fixture ${analysisHoursBeforeKickoff}h before kickoff`
  );
  logger.info(
    `[scheduler] daily spend cron registered — will run: "${dailySpendCron}" (${timezone}), reporting yesterday's fixture-date OpenAI spend to operator Telegram chats`
  );
  logger.info(`[scheduler] report cron registered — every Monday 10:00 ${timezone}`);
  logger.info(`[scheduler] halftime updates: per-fixture setTimeout (no cron)`);
}
