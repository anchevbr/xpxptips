// ─────────────────────────────────────────────────────────────────────────────
// halftime/stats-fetcher.ts
//
// Fetches live event status + halftime stats from TheSportsDB.
// ─────────────────────────────────────────────────────────────────────────────

import { logger } from '../utils/logger';

export interface EventStat {
  strStat: string;
  intHome: string;
  intAway: string;
}

export interface LiveEventStatus {
  homeScore: number | null;
  awayScore: number | null;
  /** Raw status string from TheSportsDB, e.g. "HT", "1H", "2H", "FT" */
  status: string;
}

function apiKey(): string {
  return process.env['THESPORTSDB_API_KEY'] ?? '123';
}

function numericId(fixtureId: string): string {
  return fixtureId.replace(/^sportsdb_/, '');
}

/**
 * Fetches the current live status and score for an event.
 * Returns null on failure.
 */
export async function fetchLiveStatus(fixtureId: string): Promise<LiveEventStatus | null> {
  const id = numericId(fixtureId);
  const url = `https://www.thesportsdb.com/api/v2/json/lookup/event/${id}`;

  try {
    const res = await fetch(url, {
      headers: { 'X-API-KEY': apiKey() },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      logger.warn(`[live-status] fetchLiveStatus HTTP ${res.status} for ${fixtureId}`);
      return null;
    }

    const data = (await res.json()) as { lookup: Array<{
      intHomeScore?: string | null;
      intAwayScore?: string | null;
      strStatus?: string | null;
    }> | null };

    const ev = Array.isArray(data.lookup) ? data.lookup[0] : null;
    if (!ev) return null;

    return {
      homeScore: ev.intHomeScore != null ? parseInt(ev.intHomeScore, 10) : null,
      awayScore: ev.intAwayScore != null ? parseInt(ev.intAwayScore, 10) : null,
      status: ev.strStatus ?? '',
    };
  } catch (err) {
    logger.warn(`[live-status] fetchLiveStatus error for ${fixtureId}: ${String(err)}`);
    return null;
  }
}

/**
 * Fetches the stats breakdown for an event (available from halftime onward).
 * Returns an empty array on failure or when stats are not yet available.
 */
export async function fetchEventStats(fixtureId: string): Promise<EventStat[]> {
  const id = numericId(fixtureId);
  const url = `https://www.thesportsdb.com/api/v2/json/lookup/event_stats/${id}`;

  try {
    const res = await fetch(url, {
      headers: { 'X-API-KEY': apiKey() },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      logger.warn(`[halftime] fetchEventStats HTTP ${res.status} for ${fixtureId}`);
      return [];
    }

    const data = (await res.json()) as { lookup?: EventStat[] | null };
    return data.lookup ?? [];
  } catch (err) {
    logger.warn(`[halftime] fetchEventStats error for ${fixtureId}: ${String(err)}`);
    return [];
  }
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

/**
 * Fetches the starting lineup (and subs) for an event.
 * Returns an empty array on failure or when not yet available.
 */
export async function fetchEventLineup(fixtureId: string): Promise<LineupPlayer[]> {
  const id = numericId(fixtureId);
  const url = `https://www.thesportsdb.com/api/v2/json/lookup/event_lineup/${id}`;

  try {
    const res = await fetch(url, {
      headers: { 'X-API-KEY': apiKey() },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      logger.warn(`[halftime] fetchEventLineup HTTP ${res.status} for ${fixtureId}`);
      return [];
    }

    const data = (await res.json()) as { lookup?: LineupPlayer[] | null };
    return data.lookup ?? [];
  } catch (err) {
    logger.warn(`[halftime] fetchEventLineup error for ${fixtureId}: ${String(err)}`);
    return [];
  }
}
