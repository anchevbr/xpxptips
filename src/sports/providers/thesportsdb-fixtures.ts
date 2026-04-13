// ─────────────────────────────────────────────────────────────────────────────
// TheSportsDB fixture discovery
//
// Uses the V2 API (header auth) to fetch full season schedules per league.
// Filters events by date from the complete season schedule.
//
// Premium key: set THESPORTSDB_API_KEY in .env (100 req/min)
// ─────────────────────────────────────────────────────────────────────────────

import { config } from '../../config';
import { logger } from '../../utils/logger';
import type { Fixture, Competition } from '../../types';

const V2_BASE_URL = 'https://www.thesportsdb.com/api/v2/json';

// Current season for fixture lookup
// Football uses "YYYY-YYYY" format (e.g. "2025-2026")
// Basketball (EuroLeague) uses single year "YYYY" format (e.g. "2025")
function getCurrentSeason(date: string, isSingleYearSeason = false): string {
  const year = new Date(date).getFullYear();
  const month = new Date(date).getMonth() + 1; // 1-12

  if (isSingleYearSeason) {
    // EuroLeague season 2025 covers Sep 2025 – Apr 2026
    // So Jan–Aug belong to the previous year's season key
    return month >= 9 ? String(year) : String(year - 1);
  }

  // Football: seasons span calendar years (Aug–May)
  if (month >= 8) {
    return `${year}-${year + 1}`;
  } else {
    return `${year - 1}-${year}`;
  }
}

// TheSportsDB league IDs and metadata
const TARGET_LEAGUES: Array<{
  leagueId: string;     // TheSportsDB numeric league ID
  competition: Competition;
  displayName: string;
  hasStandings: boolean; // standings only available for domestic football leagues
  singleYearSeason: boolean; // true for leagues that use "2025" instead of "2025-2026"
}> = [
  { leagueId: '4328', competition: 'football',   displayName: 'Premier League',        hasStandings: true,  singleYearSeason: false },
  { leagueId: '4335', competition: 'football',   displayName: 'La Liga',               hasStandings: true,  singleYearSeason: false },
  { leagueId: '4332', competition: 'football',   displayName: 'Serie A',               hasStandings: true,  singleYearSeason: false },
  { leagueId: '4331', competition: 'football',   displayName: 'Bundesliga',            hasStandings: true,  singleYearSeason: false },
  { leagueId: '4334', competition: 'football',   displayName: 'Ligue 1',               hasStandings: true,  singleYearSeason: false },
  { leagueId: '4480', competition: 'football',   displayName: 'UEFA Champions League', hasStandings: false, singleYearSeason: false },
  { leagueId: '4481', competition: 'football',   displayName: 'UEFA Europa League',    hasStandings: false, singleYearSeason: false },
  { leagueId: '4387', competition: 'NBA',        displayName: 'NBA',                   hasStandings: false, singleYearSeason: false },
  { leagueId: '4546', competition: 'EuroLeague', displayName: 'EuroLeague',            hasStandings: false, singleYearSeason: true  },
];

// ─── Status mapping ───────────────────────────────────────────────────────────

function mapStatus(raw: string | null | undefined): Fixture['status'] {
  if (!raw) return 'scheduled';
  const s = raw.toLowerCase();
  if (s.includes('finished') || s.includes('full time') || s.includes('ft')) return 'finished';
  if (s.includes('progress') || s.includes(' 1h') || s.includes(' 2h') || s.includes('ht') || s.includes('live')) return 'live';
  return 'scheduled';
}

// ─── API types (V2) ───────────────────────────────────────────────────────────

interface V2Event {
  idEvent: string;
  idLeague: string | null;
  idHomeTeam: string | null;
  idAwayTeam: string | null;
  strHomeTeam: string;
  strAwayTeam: string;
  strLeague: string;
  strTimestamp: string | null;
  dateEvent: string;
  strTime: string | null;
  strVenue: string | null;
  strStatus: string | null;
}

interface V2ScheduleResponse {
  schedule: V2Event[] | null;
}

// ─── Fetch helpers (V2 with header auth) ──────────────────────────────────────

function apiKey(): string {
  return process.env['THESPORTSDB_API_KEY'] ?? '123';
}

function isTimeoutError(err: unknown): boolean {
  const text = String(err).toLowerCase();
  return text.includes('timeout') || text.includes('aborted');
}

async function fetchLeagueSeason(leagueId: string, season: string, displayName: string): Promise<V2Event[]> {
  const url = `${V2_BASE_URL}/schedule/league/${leagueId}/${season}`;
  const timeoutMs = config.sports.theSportsDbTimeoutMs;

  try {
    const requestInit: RequestInit = {
      headers: { 'X-API-KEY': apiKey() },
    };

    if (timeoutMs > 0) {
      requestInit.signal = AbortSignal.timeout(timeoutMs);
    }

    const res = await fetch(url, {
      ...requestInit,
    });
    if (!res.ok) {
      logger.warn(
        `[thesportsdb] ${displayName} (league ${leagueId}, season ${season}) failed with HTTP ${res.status}`
      );
      return [];
    }
    const data = (await res.json()) as V2ScheduleResponse;
    return data.schedule ?? [];
  } catch (err) {
    if (isTimeoutError(err)) {
      const timeoutText = timeoutMs > 0 ? `${timeoutMs}ms` : 'disabled timeout';
      logger.warn(
        `[thesportsdb] ${displayName} (league ${leagueId}, season ${season}) timed out after ${timeoutText} — continuing with other leagues`
      );
    } else {
      logger.warn(
        `[thesportsdb] ${displayName} (league ${leagueId}, season ${season}) request failed: ${String(err)}`
      );
    }
    return [];
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function fetchFixturesViaTheSportsDB(date: string): Promise<Fixture[]> {
  logger.info(`[thesportsdb] fetching fixtures for ${date} across ${TARGET_LEAGUES.length} leagues`);

  const results: Fixture[] = [];
  const seen = new Set<string>();

  for (const { leagueId, competition, displayName, singleYearSeason } of TARGET_LEAGUES) {
    const season = getCurrentSeason(date, singleYearSeason);
    const events = await fetchLeagueSeason(leagueId, season, displayName);

    // Small delay to avoid bursting — premium allows 100 req/min
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Filter events to only those matching the requested date
    const eventsForDate = events.filter((ev) => ev.dateEvent === date);

    for (const ev of eventsForDate) {
      // Build ISO timestamp: prefer strTimestamp, fall back to date + time
      const isoDate = ev.strTimestamp
        ? ev.strTimestamp.endsWith('Z') ? ev.strTimestamp : ev.strTimestamp + 'Z'
        : ev.strTime
          ? `${ev.dateEvent}T${ev.strTime}Z`
          : `${ev.dateEvent}T00:00:00Z`;

      const status = mapStatus(ev.strStatus);
      const key = `${ev.strHomeTeam}|${ev.strAwayTeam}|${ev.dateEvent}`;
      if (seen.has(key)) continue;
      seen.add(key);

      results.push({
        id: `sportsdb_${ev.idEvent}`,
        competition,
        league: displayName,
        homeTeam: ev.strHomeTeam,
        awayTeam: ev.strAwayTeam,
        date: isoDate,
        venue: ev.strVenue ?? undefined,
        status,
        homeTeamId: ev.idHomeTeam ?? undefined,
        awayTeamId: ev.idAwayTeam ?? undefined,
        leagueId: ev.idLeague ?? undefined,
      });
    }

    if (eventsForDate.length > 0) {
      logger.info(`[thesportsdb] ${displayName}: ${eventsForDate.length} event(s) on ${date}`);
    }
  }

  logger.info(`[thesportsdb] total: ${results.length} fixture(s) for ${date}`);
  return results;
}
