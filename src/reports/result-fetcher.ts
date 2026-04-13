// ─────────────────────────────────────────────────────────────────────────────
// result-fetcher.ts
//
// Fetches the actual final score for a fixture from TheSportsDB after the
// match is played. Used by the weekly/monthly report job to resolve outcomes.
// ─────────────────────────────────────────────────────────────────────────────

import { logger } from '../utils/logger';

export interface EventResult {
  homeScore: number;
  awayScore: number;
  /** Raw status string from TheSportsDB */
  status: string;
}

interface V2EventDetail {
  idEvent: string;
  strHomeTeam: string;
  strAwayTeam: string;
  intHomeScore: string | null;
  intAwayScore: string | null;
  strStatus: string | null;
}

interface V2EventResponse {
  event: V2EventDetail[] | V2EventDetail | null;
}

function apiKey(): string {
  return process.env['THESPORTSDB_API_KEY'] ?? '123';
}

function isFinished(status: string | null): boolean {
  if (!status) return false;
  const s = status.toLowerCase();
  return (
    s.includes('ft') ||
    s.includes('full time') ||
    s.includes('finish') ||
    s.includes('aet') ||
    s.includes('pen')
  );
}

/**
 * Fetches the final score for a fixture from TheSportsDB.
 * Returns null if the match has not yet finished or the fetch fails.
 *
 * @param fixtureId — internal ID like "sportsdb_2453351"
 */
export async function fetchEventResult(fixtureId: string): Promise<EventResult | null> {
  const numericId = fixtureId.replace(/^sportsdb_/, '');
  const url = `https://www.thesportsdb.com/api/v2/json/event/${numericId}`;

  try {
    const res = await fetch(url, {
      headers: { 'X-API-KEY': apiKey() },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      logger.warn(`[result-fetcher] HTTP ${res.status} for event ${numericId}`);
      return null;
    }

    const data = (await res.json()) as V2EventResponse;
    // The endpoint may return single object or array
    const raw = data.event;
    const event: V2EventDetail | null = Array.isArray(raw) ? raw[0] ?? null : raw;

    if (!event) {
      logger.warn(`[result-fetcher] no event data for ${fixtureId}`);
      return null;
    }

    if (!isFinished(event.strStatus)) {
      logger.info(`[result-fetcher] ${fixtureId} not yet finished (status: ${event.strStatus ?? 'null'})`);
      return null;
    }

    const homeScore = event.intHomeScore != null ? parseInt(event.intHomeScore, 10) : null;
    const awayScore = event.intAwayScore != null ? parseInt(event.intAwayScore, 10) : null;

    if (homeScore === null || awayScore === null || isNaN(homeScore) || isNaN(awayScore)) {
      logger.warn(`[result-fetcher] missing scores for ${fixtureId}`);
      return null;
    }

    return { homeScore, awayScore, status: event.strStatus ?? 'FT' };
  } catch (err) {
    logger.warn(`[result-fetcher] request failed for ${fixtureId}: ${String(err)}`);
    return null;
  }
}
