// ─────────────────────────────────────────────────────────────────────────────
// thesportsdb-enrichment.ts
//
// Fetches structured standings, recent form, and event stats from TheSportsDB
// using the premium API key (env: THESPORTSDB_API_KEY).
//
// V2 Endpoints (header auth):
//   /api/v2/json/schedule/previous/team/{idTeam}      → last 10 results
//   /api/v2/json/lookup/event_stats/{idEvent}          → event statistics
//
// V1 Endpoints (URL auth - no V2 alternative):
//   /api/v1/json/{key}/lookuptable.php?l={leagueId}   → league standings (soccer only)
// ─────────────────────────────────────────────────────────────────────────────

import { logger } from '../../utils/logger';

const V1_BASE_URL = 'https://www.thesportsdb.com/api/v1/json';
const V2_BASE_URL = 'https://www.thesportsdb.com/api/v2/json';

function apiKey(): string {
  return process.env['THESPORTSDB_API_KEY'] ?? '123';
}

// V1 API (URL-based auth) - for standings only
async function getV1<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${V1_BASE_URL}/${apiKey()}${path}`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (!text || text.trim() === '') return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

// V2 API (header-based auth) - for everything else
async function getV2<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${V2_BASE_URL}${path}`, {
      headers: { 'X-API-KEY': apiKey() },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (!text || text.trim() === '') return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StandingEntry {
  rank: number;
  team: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDiff: number;
  points: number;
}

export interface RecentResult {
  date: string;
  homeTeam: string;
  awayTeam: string;
  homeScore: number | null;
  awayScore: number | null;
  competition: string;
}

export interface EventStats {
  homeShots?: number;
  awayShots?: number;
  homeShotsOnTarget?: number;
  awayShotsOnTarget?: number;
  homePossession?: number;
  awayPossession?: number;
  homeYellowCards?: number;
  awayYellowCards?: number;
  homeRedCards?: number;
  awayRedCards?: number;
  homeCorners?: number;
  awayCorners?: number;
  homeFouls?: number;
  awayFouls?: number;
}

export interface TeamEnrichment {
  recentForm: RecentResult[];       // last ≤10 results
  standing: StandingEntry | null;   // null when not available (knockout, NBA, etc.)
}

export interface FixtureEnrichment {
  home: TeamEnrichment;
  away: TeamEnrichment;
  eventStats: EventStats | null;    // Pre-match stats if available
}

// ─── Standings (V1 only) ──────────────────────────────────────────────────────

interface RawTableRow {
  intRank: string;
  strTeam: string;
  intPlayed: string;
  intWin: string;
  intDraw: string;
  intLoss: string;
  intGoalsFor: string;
  intGoalsAgainst: string;
  intGoalDifference: string;
  intPoints: string;
}

interface LookupTableResponse {
  table: RawTableRow[] | null;
}

async function fetchStandings(leagueId: string): Promise<StandingEntry[]> {
  const data = await getV1<LookupTableResponse>(`/lookuptable.php?l=${leagueId}`);
  if (!data?.table) return [];
  return data.table.map((r) => ({
    rank: parseInt(r.intRank, 10),
    team: r.strTeam,
    played: parseInt(r.intPlayed, 10),
    won: parseInt(r.intWin, 10),
    drawn: parseInt(r.intDraw, 10),
    lost: parseInt(r.intLoss, 10),
    goalsFor: parseInt(r.intGoalsFor, 10),
    goalsAgainst: parseInt(r.intGoalsAgainst, 10),
    goalDiff: parseInt(r.intGoalDifference, 10),
    points: parseInt(r.intPoints, 10),
  }));
}

function findStanding(standings: StandingEntry[], teamName: string): StandingEntry | null {
  // Exact match first, then partial
  const exact = standings.find((s) => s.team.toLowerCase() === teamName.toLowerCase());
  if (exact) return exact;
  const partial = standings.find(
    (s) =>
      s.team.toLowerCase().includes(teamName.toLowerCase()) ||
      teamName.toLowerCase().includes(s.team.toLowerCase())
  );
  return partial ?? null;
}

// ─── Recent form (V2) ─────────────────────────────────────────────────────────

interface V2Event {
  dateEvent: string;
  strHomeTeam: string;
  strAwayTeam: string;
  intHomeScore: string | null;
  intAwayScore: string | null;
  strLeague: string;
}

interface V2SchedulePreviousResponse {
  schedule: V2Event[] | null;
}

async function fetchRecentForm(teamId: string): Promise<RecentResult[]> {
  const data = await getV2<V2SchedulePreviousResponse>(`/schedule/previous/team/${teamId}`);
  if (!data?.schedule) return [];
  return data.schedule.map((r) => ({
    date: r.dateEvent,
    homeTeam: r.strHomeTeam,
    awayTeam: r.strAwayTeam,
    homeScore: r.intHomeScore !== null ? parseInt(r.intHomeScore, 10) : null,
    awayScore: r.intAwayScore !== null ? parseInt(r.intAwayScore, 10) : null,
    competition: r.strLeague,
  }));
}

// ─── Event Stats (V2) ─────────────────────────────────────────────────────────

interface V2StatEntry {
  strStat: string;
  intHome: string | null;
  intAway: string | null;
}

interface V2EventStatsResponse {
  lookup: V2StatEntry[] | null;
}

async function fetchEventStats(eventId: string): Promise<EventStats | null> {
  const data = await getV2<V2EventStatsResponse>(`/lookup/event_stats/${eventId}`);
  if (!data?.lookup) return null;

  const stats: EventStats = {};
  
  for (const stat of data.lookup) {
    const statName = stat.strStat?.toLowerCase() ?? '';
    const homeVal = stat.intHome ? parseInt(stat.intHome, 10) : undefined;
    const awayVal = stat.intAway ? parseInt(stat.intAway, 10) : undefined;

    if (statName.includes('shot') && !statName.includes('on target') && !statName.includes('on goal')) {
      stats.homeShots = homeVal;
      stats.awayShots = awayVal;
    } else if (statName.includes('on target') || statName.includes('on goal')) {
      stats.homeShotsOnTarget = homeVal;
      stats.awayShotsOnTarget = awayVal;
    } else if (statName.includes('possession')) {
      stats.homePossession = homeVal;
      stats.awayPossession = awayVal;
    } else if (statName.includes('yellow')) {
      stats.homeYellowCards = homeVal;
      stats.awayYellowCards = awayVal;
    } else if (statName.includes('red')) {
      stats.homeRedCards = homeVal;
      stats.awayRedCards = awayVal;
    } else if (statName.includes('corner')) {
      stats.homeCorners = homeVal;
      stats.awayCorners = awayVal;
    } else if (statName.includes('foul')) {
      stats.homeFouls = homeVal;
      stats.awayFouls = awayVal;
    }
  }

  return Object.keys(stats).length > 0 ? stats : null;
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Fetches standings, recent form, and event stats for a fixture.
 * Gracefully returns empty/null values on any failure.
 */
export async function enrichFromTheSportsDB(
  homeTeam: string,
  awayTeam: string,
  homeTeamId: string | undefined,
  awayTeamId: string | undefined,
  leagueId: string | undefined,
  eventId?: string,
): Promise<FixtureEnrichment> {
  // Fetch standings once if leagueId available
  let standings: StandingEntry[] = [];
  if (leagueId) {
    standings = await fetchStandings(leagueId);
    if (standings.length > 0) {
      logger.info(`[enrichment] standings fetched for league ${leagueId} (${standings.length} teams)`);
    }
  }

  // Fetch recent form + event stats in parallel
  const [homeForm, awayForm, eventStats] = await Promise.all([
    homeTeamId ? fetchRecentForm(homeTeamId) : Promise.resolve([]),
    awayTeamId ? fetchRecentForm(awayTeamId) : Promise.resolve([]),
    eventId ? fetchEventStats(eventId) : Promise.resolve(null),
  ]);

  if (homeForm.length > 0) logger.info(`[enrichment] ${homeTeam}: ${homeForm.length} recent results`);
  if (awayForm.length > 0) logger.info(`[enrichment] ${awayTeam}: ${awayForm.length} recent results`);
  if (eventStats) logger.info(`[enrichment] event stats available for fixture`);

  return {
    home: {
      recentForm: homeForm,
      standing: standings.length > 0 ? findStanding(standings, homeTeam) : null,
    },
    away: {
      recentForm: awayForm,
      standing: standings.length > 0 ? findStanding(standings, awayTeam) : null,
    },
    eventStats,
  };
}

/** Formats enrichment data as a compact text block for injection into the expert prompt. */
export function formatEnrichmentBlock(
  homeTeam: string,
  awayTeam: string,
  enrichment: FixtureEnrichment,
): string {
  const { home, away, eventStats } = enrichment;
  const lines: string[] = [];

  // Standings
  if (home.standing || away.standing) {
    lines.push('── STANDINGS ──────────────────────────────────────────────');
    if (home.standing) {
      const s = home.standing;
      lines.push(`${homeTeam}: #${s.rank} | P${s.played} W${s.won} D${s.drawn} L${s.lost} GD${s.goalDiff > 0 ? '+' : ''}${s.goalDiff} Pts${s.points}`);
    }
    if (away.standing) {
      const s = away.standing;
      lines.push(`${awayTeam}: #${s.rank} | P${s.played} W${s.won} D${s.drawn} L${s.lost} GD${s.goalDiff > 0 ? '+' : ''}${s.goalDiff} Pts${s.points}`);
    }
  }

  // Recent form
  const formatForm = (results: RecentResult[], team: string): string => {
    if (results.length === 0) return '(no data)';
    return results
      .slice(0, 5)
      .map((r) => {
        const isHome = r.homeTeam.toLowerCase().includes(team.toLowerCase().split(' ')[0]);
        const score = r.homeScore !== null && r.awayScore !== null ? `${r.homeScore}-${r.awayScore}` : 'TBD';
        const opponent = isHome ? r.awayTeam : r.homeTeam;
        const venue = isHome ? 'H' : 'A';
        const result =
          r.homeScore !== null && r.awayScore !== null
            ? isHome
              ? r.homeScore > r.awayScore ? 'W' : r.homeScore < r.awayScore ? 'L' : 'D'
              : r.awayScore > r.homeScore ? 'W' : r.awayScore < r.homeScore ? 'L' : 'D'
            : '-';
        return `  ${r.date} ${venue} ${opponent} ${score} [${result}]  (${r.competition})`;
      })
      .join('\n');
  };

  if (home.recentForm.length > 0 || away.recentForm.length > 0) {
    lines.push('── RECENT FORM (last 5) ────────────────────────────────────');
    lines.push(`${homeTeam}:`);
    lines.push(formatForm(home.recentForm, homeTeam));
    lines.push(`${awayTeam}:`);
    lines.push(formatForm(away.recentForm, awayTeam));
  }

  // Event Stats (if available)
  if (eventStats && Object.keys(eventStats).length > 0) {
    lines.push('── EVENT STATISTICS ───────────────────────────────────────');
    const stats = eventStats;
    
    if (stats.homeShots !== undefined || stats.awayShots !== undefined) {
      lines.push(`Shots: ${stats.homeShots ?? '-'} - ${stats.awayShots ?? '-'} (H-A)`);
    }
    if (stats.homeShotsOnTarget !== undefined || stats.awayShotsOnTarget !== undefined) {
      lines.push(`Shots on Target: ${stats.homeShotsOnTarget ?? '-'} - ${stats.awayShotsOnTarget ?? '-'}`);
    }
    if (stats.homePossession !== undefined || stats.awayPossession !== undefined) {
      lines.push(`Possession: ${stats.homePossession ?? '-'}% - ${stats.awayPossession ?? '-'}%`);
    }
    if (stats.homeCorners !== undefined || stats.awayCorners !== undefined) {
      lines.push(`Corners: ${stats.homeCorners ?? '-'} - ${stats.awayCorners ?? '-'}`);
    }
    if (stats.homeFouls !== undefined || stats.awayFouls !== undefined) {
      lines.push(`Fouls: ${stats.homeFouls ?? '-'} - ${stats.awayFouls ?? '-'}`);
    }
    if (stats.homeYellowCards !== undefined || stats.awayYellowCards !== undefined) {
      lines.push(`Yellow Cards: ${stats.homeYellowCards ?? '-'} - ${stats.awayYellowCards ?? '-'}`);
    }
    if (stats.homeRedCards !== undefined || stats.awayRedCards !== undefined) {
      lines.push(`Red Cards: ${stats.homeRedCards ?? '-'} - ${stats.awayRedCards ?? '-'}`);
    }
  }

  return lines.join('\n');
}
