// ─────────────────────────────────────────────────────────────────────────────
// Odds-market availability and verification module
//
// PURPOSE: Before publishing any tip, verify that:
//   1. The recommended betting market exists for this fixture
//   2. The odds meet the minimum threshold (default: 1.50)
//   3. Real bookmakers are offering the market
//
// INTEGRATION: Uses The Odds API to fetch real-time odds from 40+ European
// bookmakers. Gate 5 blocks tips where markets don't exist or odds are too low.
// ─────────────────────────────────────────────────────────────────────────────

import { logger } from '../utils/logger';
import { config } from '../config';
import {
  fetchOddsForFixture,
  getAverageOdds,
  formatOddsSummary,
  type EventOdds,
} from '../sports/providers/odds-api';
import type { Fixture } from '../types';

/**
 * Verifies that the recommended betting market is available with acceptable odds.
 *
 * Returns true if:
 *   - The market exists with at least one bookmaker
 *   - The best available odds meet the minimum threshold (MIN_ACCEPTABLE_ODDS)
 *
 * @param fixtureId   Internal fixture identifier (e.g. "nba_987654")
 * @param market      Market string as produced by the AI, e.g. "Match Winner",
 *                    "Total Over 215.5", "Both Teams to Score"
 * @param fixture     The fixture object (needed to fetch odds from API)
 */
export async function marketAvailable(
  fixtureId: string,
  market: string,
  fixture?: Fixture
): Promise<boolean> {
  if (!fixture) {
    logger.warn(`[odds] Gate 5: no fixture provided for ${fixtureId} — blocking`);
    return false;
  }

  // Fetch real-time odds
  const eventOdds = await fetchOddsForFixture(
    fixture.homeTeam,
    fixture.awayTeam,
    fixture.league,
    fixture.date
  );

  if (!eventOdds) {
    logger.warn(
      `[odds] Gate 5: no odds available for ${fixture.homeTeam} vs ${fixture.awayTeam} — blocking`
    );
    return false;
  }

  logger.info(`[odds] fetched odds:\n${formatOddsSummary(eventOdds)}`);

  // Parse the AI's recommended market to determine what to check
  const { marketKey, outcomeName } = parseMarketString(market, fixture);

  if (!marketKey || !outcomeName) {
    logger.warn(`[odds] Gate 5: cannot parse market "${market}" — blocking`);
    return false;
  }

  // Get the average odds across all bookmakers for this outcome
  const avgOdds = getAverageOdds(eventOdds, marketKey, outcomeName);

  if (!avgOdds) {
    logger.warn(
      `[odds] Gate 5: market "${market}" (${marketKey}/${outcomeName}) not available — blocking`
    );
    return false;
  }

  // Check minimum odds threshold
  if (avgOdds < config.analysis.minAcceptableOdds) {
    logger.warn(
      `[odds] Gate 5: odds ${avgOdds.toFixed(2)} below minimum ${config.analysis.minAcceptableOdds} for "${market}" — BLOCKING (no value in heavy favorites)`
    );
    return false;
  }

  logger.info(
    `[odds] Gate 5 PASS: "${market}" (${outcomeName}) available at ${avgOdds.toFixed(2)} ` +
    `(threshold: ${config.analysis.minAcceptableOdds})`
  );

  return true;
}

/**
 * Fetches and returns odds data for a fixture.
 * Used by the Telegram formatter to display actual available odds.
 */
export async function getFixtureOdds(fixture: Fixture): Promise<EventOdds | null> {
  return fetchOddsForFixture(fixture.homeTeam, fixture.awayTeam, fixture.league, fixture.date);
}

/**
 * Extracts the best odds for a specific market outcome.
 * Used by the formatter to show the recommended pick's odds.
 */
export function extractBestOdds(
  eventOdds: EventOdds,
  market: string,
  fixture: Fixture
): number | null {
  const { marketKey, outcomeName } = parseMarketString(market, fixture);
  logger.info(`[odds] parseMarketString("${market}") → marketKey: "${marketKey}", outcomeName: "${outcomeName}"`);
  
  if (!marketKey || !outcomeName) {
    logger.warn(`[odds] failed to parse market: "${market}"`);
    return null;
  }
  
  const odds = getAverageOdds(eventOdds, marketKey, outcomeName);
  logger.info(`[odds] getAverageOdds(marketKey: "${marketKey}", outcomeName: "${outcomeName}") → ${odds?.toFixed(2) ?? 'null'}`);
  
  return odds;
}

/**
 * Normalises a market description string for loose comparison.
 */
export function normalizeMarket(m: string): string {
  return m.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Parses the AI's market recommendation into The Odds API format.
 *
 * Examples:
 *   "Match Winner: Home"        → { marketKey: 'h2h', outcomeName: fixture.homeTeam }
 *   "Match Winner: Man United"  → { marketKey: 'h2h', outcomeName: 'Man United' }
 *   "Total Over 2.5"            → { marketKey: 'totals', outcomeName: 'Over' }
 *   "Total Under 215.5"         → { marketKey: 'totals', outcomeName: 'Under' }
 *   "Draw"                      → { marketKey: 'h2h', outcomeName: 'Draw' }
 */
function parseMarketString(
  market: string,
  fixture: Fixture
): { marketKey: string; outcomeName: string } | { marketKey: null; outcomeName: null } {
  const norm = normalizeMarket(market);

  // Match Winner / H2H markets
  if (
    norm.includes('match winner') ||
    norm.includes('moneyline') ||
    norm.includes('1x2') ||
    norm.includes('winner')
  ) {
    // Extract team or outcome
    if (norm.includes('home')) return { marketKey: 'h2h', outcomeName: fixture.homeTeam };
    if (norm.includes('away')) return { marketKey: 'h2h', outcomeName: fixture.awayTeam };
    if (norm.includes('draw')) return { marketKey: 'h2h', outcomeName: 'Draw' };

    // Check if it mentions a specific team name
    const homeNorm = normalizeMarket(fixture.homeTeam);
    const awayNorm = normalizeMarket(fixture.awayTeam);
    if (norm.includes(homeNorm)) return { marketKey: 'h2h', outcomeName: fixture.homeTeam };
    if (norm.includes(awayNorm)) return { marketKey: 'h2h', outcomeName: fixture.awayTeam };
  }

  // Draw market
  if (norm === 'draw' || norm === 'the draw') {
    return { marketKey: 'h2h', outcomeName: 'Draw' };
  }

  // Totals / Over-Under markets
  if (norm.includes('total') || norm.includes('over') || norm.includes('under')) {
    if (norm.includes('over')) return { marketKey: 'totals', outcomeName: 'Over' };
    if (norm.includes('under')) return { marketKey: 'totals', outcomeName: 'Under' };
  }

  // Both Teams to Score (football)
  if (norm.includes('btts') || norm.includes('both teams to score') || norm.includes('g/g')) {
    if (norm.includes('yes') || norm === 'btts' || norm === 'g/g') {
      return { marketKey: 'btts', outcomeName: 'Yes' };
    }
    if (norm.includes('no')) return { marketKey: 'btts', outcomeName: 'No' };
  }

  logger.warn(`[odds] unable to parse market: "${market}"`);
  return { marketKey: null, outcomeName: null };
}
