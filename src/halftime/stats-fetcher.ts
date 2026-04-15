// ─────────────────────────────────────────────────────────────────────────────
// halftime/stats-fetcher.ts
//
// Fetches live event status + halftime stats from API-Sports.
// ─────────────────────────────────────────────────────────────────────────────

import type { PickRecord } from '../types';
import {
  fetchApiSportsEventLineup,
  fetchApiSportsEventStats,
  fetchApiSportsLiveStatus,
} from '../sports/providers/api-sports-live';
import { logger } from '../utils/logger';

export interface EventStat {
  strStat: string;
  intHome: string;
  intAway: string;
}

export interface LiveEventStatus {
  homeScore: number | null;
  awayScore: number | null;
  /** Raw status string from the live-data provider, e.g. "HT", "1H", "2H", "FT" */
  status: string;
}

export async function fetchLiveStatus(pick: PickRecord): Promise<LiveEventStatus | null> {
  const apiStatus = await fetchApiSportsLiveStatus(pick);
  if (apiStatus === undefined) {
    logger.warn(`[live-status] unresolved API-Sports fixture for ${pick.fixtureId}`);
    return null;
  }
  return apiStatus;
}

export async function fetchEventStats(pick: PickRecord): Promise<EventStat[]> {
  const apiStats = await fetchApiSportsEventStats(pick);
  if (apiStats === undefined) {
    logger.warn(`[halftime] unresolved API-Sports stats for ${pick.fixtureId}`);
    return [];
  }
  return apiStats;
}

/** Returns true when the status string indicates halftime */
export function isHalftime(status: string): boolean {
  const s = status.toLowerCase().trim();
  return s === 'ht' || s === 'half time' || s === 'halftime';
}

// ─── Lineup ───────────────────────────────────────────────────────────────────

export interface LineupPlayer {
  strPlayer: string;
  strTeam: string;
  strPosition: string;
  strHome: string; // "Yes" = home team, "No" = away team
  strSubstitute: string; // "Yes" | "No"
}

export async function fetchEventLineup(pick: PickRecord): Promise<LineupPlayer[]> {
  const apiLineup = await fetchApiSportsEventLineup(pick);
  if (apiLineup === undefined) {
    logger.warn(`[halftime] unresolved API-Sports lineup for ${pick.fixtureId}`);
    return [];
  }
  return apiLineup;
}
