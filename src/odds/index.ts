// ─────────────────────────────────────────────────────────────────────────────
// Odds-market availability and verification module
//
// PURPOSE: Before publishing any tip, verify that:
//   1. The recommended betting market exists for this fixture
//   2. The odds meet the minimum threshold (default: 1.50)
//   3. Real bookmakers are offering the market
//
// INTEGRATION: Uses The Odds API to fetch real-time odds from European
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

function extractLineFromFinalPick(finalPick?: string): number | undefined {
  if (!finalPick) return undefined;
  const match = /(\d+(?:\.\d+)?)/.exec(finalPick);
  return match ? parseFloat(match[1]!) : undefined;
}

export async function marketAvailable(
  fixtureId: string,
  market: string,
  fixture?: Fixture,
  finalPick?: string,
): Promise<boolean> {
  if (!fixture) {
    logger.warn(`[odds] Gate 5: no fixture provided for ${fixtureId} — blocking`);
    return false;
  }

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

  const { marketKey, outcomeName } = parseMarketString(market, fixture);

  if (!marketKey || !outcomeName) {
    logger.warn(`[odds] Gate 5: cannot parse market "${market}" — blocking`);
    return false;
  }

  const point = marketKey === 'totals' ? extractLineFromFinalPick(finalPick) : undefined;
  const avgOdds = getAverageOdds(eventOdds, marketKey, outcomeName, point);

  if (!avgOdds) {
    logger.warn(
      `[odds] Gate 5: market "${market}" (${marketKey}/${outcomeName}${point !== undefined ? ` @ ${point}` : ''}) not available — blocking`
    );
    return false;
  }

  if (avgOdds < config.analysis.minAcceptableOdds) {
    logger.warn(
      `[odds] Gate 5: odds ${avgOdds.toFixed(2)} below minimum ${config.analysis.minAcceptableOdds} for "${market}" — BLOCKING (no value in heavy favorites)`
    );
    return false;
  }

  logger.info(
    `[odds] Gate 5 PASS: "${market}" (${outcomeName}${point !== undefined ? ` @ ${point}` : ''}) available at ${avgOdds.toFixed(2)} ` +
    `(threshold: ${config.analysis.minAcceptableOdds})`
  );

  return true;
}

export async function getFixtureOdds(fixture: Fixture): Promise<EventOdds | null> {
  return fetchOddsForFixture(fixture.homeTeam, fixture.awayTeam, fixture.league, fixture.date);
}

export function extractBestOdds(
  eventOdds: EventOdds,
  market: string,
  fixture: Fixture,
  finalPick?: string,
): number | null {
  const { marketKey, outcomeName } = parseMarketString(market, fixture);
  logger.info(`[odds] parseMarketString("${market}") → marketKey: "${marketKey}", outcomeName: "${outcomeName}"`);

  if (!marketKey || !outcomeName) {
    logger.warn(`[odds] failed to parse market: "${market}"`);
    return null;
  }

  const point = marketKey === 'totals' ? extractLineFromFinalPick(finalPick) : undefined;
  const odds = getAverageOdds(eventOdds, marketKey, outcomeName, point);
  logger.info(
    `[odds] getAverageOdds(marketKey: "${marketKey}", outcomeName: "${outcomeName}"${point !== undefined ? `, point: ${point}` : ''}) → ${odds?.toFixed(2) ?? 'null'}`
  );
  return odds;
}

function parseMarketString(
  market: string,
  fixture: Fixture
): { marketKey: string; outcomeName: string } | { marketKey: null; outcomeName: null } {
  switch (market.trim().toLowerCase()) {
    case 'h2h/home':
      return { marketKey: 'h2h', outcomeName: fixture.homeTeam };
    case 'h2h/draw':
      return { marketKey: 'h2h', outcomeName: 'Draw' };
    case 'h2h/away':
      return { marketKey: 'h2h', outcomeName: fixture.awayTeam };
    case 'totals/over':
      return { marketKey: 'totals', outcomeName: 'Over' };
    case 'totals/under':
      return { marketKey: 'totals', outcomeName: 'Under' };
    case 'btts/yes':
      return { marketKey: 'btts', outcomeName: 'Yes' };
    case 'btts/no':
      return { marketKey: 'btts', outcomeName: 'No' };
    default:
      logger.warn(`[odds] unable to parse market: "${market}"`);
      return { marketKey: null, outcomeName: null };
  }
}
