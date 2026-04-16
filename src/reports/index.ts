// ─────────────────────────────────────────────────────────────────────────────
// reports/index.ts
//
// Orchestrates the weekly and monthly reporting pipeline:
//   1. Resolve any pending pick outcomes via the live-data provider
//   2. Generate an AI narrative of what went right/wrong
//   3. Format and post the report to Telegram
//
// Weekly:  runs every Monday at 10:00 Athens — covers previous 7 days
// Monthly: runs on the first Monday of a new month at 10:00 Athens —
//          covers the full previous calendar month EXCEPT the last 7 days
//          (those are covered by the same day's weekly report, no duplication)
// ─────────────────────────────────────────────────────────────────────────────

import { config } from '../config';
import { logger } from '../utils/logger';
import { dateOffsetInTimeZone, todayInTimeZone } from '../utils/date';
import { sendAndPinInGroup } from '../bot/telegram';
import { getPicksInRange, updateOutcome } from './picks-store';
import { fetchEventResult } from './result-fetcher';
import { resolveOutcome, formatScore } from './result-resolver';
import { generateNarrative } from './report-generator';
import { formatWeeklyReport, formatMonthlyReport, formatDateRange, formatMonthGreek } from './report-formatter';
import type { PickRecord } from '../types';

// ─── Date helpers ─────────────────────────────────────────────────────────────

const REPORT_TIMEZONE = config.scheduler.timezone;

/** First day of a given month as YYYY-MM-DD */
function firstDayOfMonth(yyyy: number, mm: number): string {
  return `${yyyy}-${String(mm).padStart(2, '0')}-01`;
}

/** Last day of a given month as YYYY-MM-DD */
function lastDayOfMonth(yyyy: number, mm: number): string {
  const d = new Date(yyyy, mm, 0); // day 0 of next month = last day of this month
  return `${yyyy}-${String(mm).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Returns true if today in the scheduler time zone is the first Monday of the calendar month. */
export function isFirstMondayOfMonth(): boolean {
  const today = todayInTimeZone(REPORT_TIMEZONE);
  const d = new Date(today + 'T12:00:00Z');
  if (d.getDay() !== 1) return false; // not a Monday
  return d.getDate() <= 7; // first 7 days of month = first Monday
}

// ─── Outcome resolution ───────────────────────────────────────────────────────

/**
 * For each pending pick in the list, attempts to fetch the final score
 * from the live-data provider and resolves the outcome. Updates picks-log.json in place.
 */
async function resolvePickOutcomes(picks: PickRecord[]): Promise<PickRecord[]> {
  const pending = picks.filter(p => p.outcome === null);
  if (pending.length === 0) return picks;

  logger.info(`[reports] resolving ${pending.length} pending pick outcome(s)`);

  for (const pick of pending) {
    const result = await fetchEventResult(pick);
    if (!result) {
      logger.info(`[reports] ${pick.fixtureId} — result not yet available`);
      continue;
    }

    const outcome = resolveOutcome(
      pick.bestBettingMarket,
      pick.finalPick,
      result.homeScore,
      result.awayScore
    );
    const scoreStr = formatScore(result.homeScore, result.awayScore);

    updateOutcome(pick.fixtureId, outcome, scoreStr);
    pick.outcome = outcome;
    pick.actualScore = scoreStr;

    logger.info(
      `[reports] resolved ${pick.homeTeam} vs ${pick.awayTeam}: ${scoreStr} → pick "${pick.finalPick}" → ${outcome}`
    );
  }

  return picks;
}

// ─── Weekly report ────────────────────────────────────────────────────────────

/**
 * Generates and posts the weekly report for the previous 7 days (Mon–Sun).
 * Typically called every Monday at 10:00 Athens.
 *
 * @param asOfDate  Optional date override for testing (YYYY-MM-DD).
 *                  When provided, treats that date as "today" for range calculation.
 */
export async function runWeeklyReport(asOfDate?: string): Promise<void> {
  const today = asOfDate ?? todayInTimeZone(REPORT_TIMEZONE);
  const todayDate = new Date(today + 'T12:00:00Z');
  const weekTo = new Date(todayDate);
  weekTo.setUTCDate(weekTo.getUTCDate() - 1);
  const weekFrom = new Date(todayDate);
  weekFrom.setUTCDate(weekFrom.getUTCDate() - 7);

  const weekToStr = weekTo.toISOString().slice(0, 10);
  const weekFromStr = weekFrom.toISOString().slice(0, 10);

  logger.info(`[reports] weekly report: ${weekFromStr} → ${weekToStr}`);

  let picks = getPicksInRange(weekFromStr, weekToStr);
  if (picks.length === 0) {
    logger.info('[reports] weekly: no picks in range — skipping');
    return;
  }

  picks = await resolvePickOutcomes(picks);

  const periodLabel = formatDateRange(weekFromStr, weekToStr);
  const narrative = await generateNarrative(picks, periodLabel);
  const message = formatWeeklyReport(picks, weekFromStr, weekToStr, narrative);

  try {
    await sendAndPinInGroup(message);
    logger.info(`[reports] weekly report posted and pinned (${picks.length} pick(s))`);
  } catch (err) {
    logger.error(`[reports] failed to post weekly report: ${String(err)}`);
  }
}

// ─── Monthly report ───────────────────────────────────────────────────────────

/**
 * Generates and posts the monthly report for the previous calendar month,
 * EXCLUDING the last 7 days (which are covered by that same Monday's weekly report).
 *
 * Only called on the first Monday of a new month.
 */
export async function runMonthlyReport(): Promise<void> {
  const today = todayInTimeZone(REPORT_TIMEZONE);
  const d = new Date(today + 'T12:00:00Z');

  // Previous month
  const prevMonth = d.getMonth() === 0 ? 12 : d.getMonth(); // getMonth() is 0-based
  const prevYear = d.getMonth() === 0 ? d.getFullYear() - 1 : d.getFullYear();

  // Monthly window: first day of prev month → 8 days ago (day before weekly window starts)
  const monthFrom = firstDayOfMonth(prevYear, prevMonth);
  const monthTo = dateOffsetInTimeZone(REPORT_TIMEZONE, -8); // day before the weekly window (which starts 7 days ago)

  // Safety: monthTo must not exceed last day of previous month
  const lastOfPrevMonth = lastDayOfMonth(prevYear, prevMonth);
  const effectiveTo = monthTo < lastOfPrevMonth ? monthTo : lastOfPrevMonth;

  logger.info(`[reports] monthly report: ${monthFrom} → ${effectiveTo} (${formatMonthGreek(prevYear, prevMonth)})`);

  let picks = getPicksInRange(monthFrom, effectiveTo);
  if (picks.length === 0) {
    logger.info('[reports] monthly: no picks in range — skipping');
    return;
  }

  picks = await resolvePickOutcomes(picks);

  const monthLabel = formatMonthGreek(prevYear, prevMonth);
  const narrative = await generateNarrative(picks, monthLabel);
  const message = formatMonthlyReport(picks, prevYear, prevMonth, narrative);

  try {
    await sendAndPinInGroup(message);
    logger.info(`[reports] monthly report posted and pinned (${picks.length} pick(s))`);
  } catch (err) {
    logger.error(`[reports] failed to post monthly report: ${String(err)}`);
  }
}
