// ─────────────────────────────────────────────────────────────────────────────
// result-fetcher.ts
//
// Fetches the actual final score for a fixture after the match is played
// using API-Sports.
// ─────────────────────────────────────────────────────────────────────────────

import { fetchApiSportsEventResult } from '../sports/providers/api-sports-live';
import { logger } from '../utils/logger';
import type { PickRecord } from '../types';

export interface EventResult {
  homeScore: number;
  awayScore: number;
  /** Raw status string from the live-data provider */
  status: string;
}

function isFinished(status: string | null): boolean {
  if (!status) return false;
  const s = status.toLowerCase();
  return (
    s.includes('ft') ||
    s.includes('full time') ||
    s.includes('finish') ||
    s.includes('aet') ||
    s.includes('aot') ||
    s.includes('pen')
  );
}

/**
 * Fetches the final score for a fixture.
 * Returns null if the match has not yet finished or the fetch fails.
 */
export async function fetchEventResult(pick: PickRecord): Promise<EventResult | null> {
  const apiResult = await fetchApiSportsEventResult(pick);
  if (apiResult === undefined) {
    logger.warn(`[result-fetcher] unresolved API-Sports fixture for ${pick.fixtureId}`);
    return null;
  }

  if (apiResult === null) {
    logger.info(`[result-fetcher] ${pick.fixtureId} not yet finished (status: null)`);
    return null;
  }

  if (!isFinished(apiResult.status)) {
    logger.info(`[result-fetcher] ${pick.fixtureId} not yet finished (status: ${apiResult.status || 'null'})`);
    return null;
  }

  if (apiResult.homeScore === null || apiResult.awayScore === null) {
    logger.warn(`[result-fetcher] missing scores for ${pick.fixtureId}`);
    return null;
  }

  return {
    homeScore: apiResult.homeScore,
    awayScore: apiResult.awayScore,
    status: apiResult.status,
  };
}
