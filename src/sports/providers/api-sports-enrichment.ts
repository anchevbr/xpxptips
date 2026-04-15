import { config } from '../../config';
import { logger } from '../../utils/logger';
import { prewarmApiSportsBinding } from './api-sports-live';
import type {
  Fixture,
  H2HGame,
  H2HRecord,
  InjuryReport,
  MatchData,
  TeamStats,
} from '../../types';

const FOOTBALL_BASE_URL = 'https://v3.football.api-sports.io';
const BASKETBALL_BASE_URL = 'https://v1.basketball.api-sports.io';

type ApiResponse<T> = {
  errors?: unknown;
  response?: T;
  results?: number;
};

interface FootballH2HItem {
  fixture: {
    date: string;
  };
  league: {
    name: string;
  };
  teams: {
    home: { id?: number | null; name: string };
    away: { id?: number | null; name: string };
  };
  goals: {
    home?: number | null;
    away?: number | null;
  };
}

interface FootballInjuryItem {
  player: {
    name: string;
    type?: string | null;
    reason?: string | null;
  };
  team: {
    id?: number | null;
    name: string;
  };
}

interface BasketballH2HItem {
  date: string;
  league: {
    name: string;
  };
  teams: {
    home: { id?: number | null; name: string };
    away: { id?: number | null; name: string };
  };
  scores: {
    home: { total?: number | null };
    away: { total?: number | null };
  };
}

interface ProviderEnrichment {
  homeTeamStats: TeamStats;
  awayTeamStats: TeamStats;
  h2h: H2HRecord;
  homeInjuries: InjuryReport;
  awayInjuries: InjuryReport;
  structuredContext?: string;
  dataQuality: MatchData['dataQuality'];
  dataQualityNotes: string[];
}

function timeoutSignal(): AbortSignal | undefined {
  return config.sports.apiSportsTimeoutMs > 0
    ? AbortSignal.timeout(config.sports.apiSportsTimeoutMs)
    : undefined;
}

function describeErrors(errors: unknown): string | null {
  if (errors == null) return null;
  if (Array.isArray(errors)) return errors.length > 0 ? JSON.stringify(errors) : null;
  if (typeof errors === 'object') {
    return Object.keys(errors as Record<string, unknown>).length > 0
      ? JSON.stringify(errors)
      : null;
  }
  return String(errors);
}

async function getApiSportsJson<T>(baseUrl: string, path: string, params: Record<string, string>): Promise<ApiResponse<T> | null> {
  if (!config.sports.apiSportsKey.trim()) {
    logger.warn('[enrichment] APISPORTS_API_KEY is missing');
    return null;
  }

  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  try {
    const res = await fetch(url, {
      headers: { 'x-apisports-key': config.sports.apiSportsKey },
      signal: timeoutSignal(),
    });
    if (!res.ok) {
      logger.warn(`[enrichment] API-Sports HTTP ${res.status} for ${url.pathname}${url.search}`);
      return null;
    }
    return (await res.json()) as ApiResponse<T>;
  } catch (err) {
    logger.warn(`[enrichment] API-Sports request failed for ${url.pathname}${url.search}: ${String(err)}`);
    return null;
  }
}

function emptyStats(team: string): TeamStats {
  return {
    team,
    lastFiveGames: [],
    homeRecord: { wins: 0, losses: 0 },
    awayRecord: { wins: 0, losses: 0 },
  };
}

function emptyInjury(team: string): InjuryReport {
  return {
    team,
    players: [],
    suspensions: [],
    lastUpdated: new Date().toISOString(),
  };
}

function emptyH2H(): H2HRecord {
  return {
    totalGames: 0,
    homeTeamWins: 0,
    awayTeamWins: 0,
    draws: 0,
    lastFiveGames: [],
  };
}

function sortByDateDesc<T>(items: T[], getDate: (item: T) => string): T[] {
  return [...items].sort((left, right) => getDate(right).localeCompare(getDate(left)));
}

async function fetchFootballH2H(fixture: Fixture): Promise<H2HRecord> {
  if (!fixture.homeTeamId || !fixture.awayTeamId) {
    return emptyH2H();
  }

  const data = await getApiSportsJson<FootballH2HItem[]>(
    FOOTBALL_BASE_URL,
    '/fixtures/headtohead',
    { h2h: `${fixture.homeTeamId}-${fixture.awayTeamId}` },
  );
  if (!data) return emptyH2H();

  const errors = describeErrors(data.errors);
  if (errors) {
    logger.warn(`[enrichment] football H2H failed for ${fixture.id}: ${errors}`);
    return emptyH2H();
  }

  const response = sortByDateDesc((data.response ?? []) as FootballH2HItem[], item => item.fixture.date);
  let homeWins = 0;
  let awayWins = 0;
  let draws = 0;

  const lastFiveGames: H2HGame[] = response.slice(0, 5).map((item) => {
    const homeId = item.teams.home.id != null ? String(item.teams.home.id) : null;
    const awayId = item.teams.away.id != null ? String(item.teams.away.id) : null;
    const homeScore = item.goals.home ?? 0;
    const awayScore = item.goals.away ?? 0;

    if (homeScore === awayScore) {
      draws++;
    } else if (
      (homeId === fixture.homeTeamId && homeScore > awayScore) ||
      (awayId === fixture.homeTeamId && awayScore > homeScore)
    ) {
      homeWins++;
    } else {
      awayWins++;
    }

    return {
      date: item.fixture.date,
      homeTeam: item.teams.home.name,
      awayTeam: item.teams.away.name,
      homeScore,
      awayScore,
      competition: item.league.name,
    };
  });

  return {
    totalGames: response.length,
    homeTeamWins: homeWins,
    awayTeamWins: awayWins,
    draws,
    lastFiveGames,
  };
}

async function fetchBasketballH2H(fixture: Fixture): Promise<H2HRecord> {
  if (!fixture.homeTeamId || !fixture.awayTeamId) {
    return emptyH2H();
  }

  const data = await getApiSportsJson<BasketballH2HItem[]>(
    BASKETBALL_BASE_URL,
    '/games',
    { h2h: `${fixture.homeTeamId}-${fixture.awayTeamId}` },
  );
  if (!data) return emptyH2H();

  const errors = describeErrors(data.errors);
  if (errors) {
    logger.warn(`[enrichment] basketball H2H failed for ${fixture.id}: ${errors}`);
    return emptyH2H();
  }

  const response = sortByDateDesc((data.response ?? []) as BasketballH2HItem[], item => item.date);
  let homeWins = 0;
  let awayWins = 0;

  const lastFiveGames: H2HGame[] = response.slice(0, 5).map((item) => {
    const homeId = item.teams.home.id != null ? String(item.teams.home.id) : null;
    const awayId = item.teams.away.id != null ? String(item.teams.away.id) : null;
    const homeScore = item.scores.home.total ?? 0;
    const awayScore = item.scores.away.total ?? 0;

    if (
      (homeId === fixture.homeTeamId && homeScore > awayScore) ||
      (awayId === fixture.homeTeamId && awayScore > homeScore)
    ) {
      homeWins++;
    } else {
      awayWins++;
    }

    return {
      date: item.date,
      homeTeam: item.teams.home.name,
      awayTeam: item.teams.away.name,
      homeScore,
      awayScore,
      competition: item.league.name,
    };
  });

  return {
    totalGames: response.length,
    homeTeamWins: homeWins,
    awayTeamWins: awayWins,
    draws: 0,
    lastFiveGames,
  };
}

async function fetchFootballInjuries(fixture: Fixture): Promise<{ home: InjuryReport; away: InjuryReport }> {
  const home = emptyInjury(fixture.homeTeam);
  const away = emptyInjury(fixture.awayTeam);
  const binding = await prewarmApiSportsBinding({
    fixtureId: fixture.id,
    league: fixture.league,
    homeTeam: fixture.homeTeam,
    awayTeam: fixture.awayTeam,
    date: fixture.date,
    liveDataProvider: fixture.liveDataProvider,
    liveDataFixtureId: fixture.liveDataFixtureId,
  });
  const liveDataFixtureId = fixture.liveDataFixtureId ?? binding?.liveDataFixtureId;

  if (!liveDataFixtureId) {
    return { home, away };
  }

  const data = await getApiSportsJson<FootballInjuryItem[]>(
    FOOTBALL_BASE_URL,
    '/injuries',
    { fixture: liveDataFixtureId },
  );
  if (!data) return { home, away };

  const errors = describeErrors(data.errors);
  if (errors) {
    logger.warn(`[enrichment] football injuries failed for ${fixture.id}: ${errors}`);
    return { home, away };
  }

  for (const item of (data.response ?? []) as FootballInjuryItem[]) {
    const target = item.team.id != null && fixture.homeTeamId === String(item.team.id) ? home : away;
    const status = item.player.type === 'Questionable' ? 'questionable' : 'out';
    target.players.push({
      name: item.player.name,
      status,
      reason: item.player.reason ?? undefined,
    });
  }

  return { home, away };
}

function buildStructuredContext(fixture: Fixture, h2h: H2HRecord, homeInjuries: InjuryReport, awayInjuries: InjuryReport): string | undefined {
  const lines: string[] = [];

  if (h2h.totalGames > 0) {
    lines.push('── API-SPORTS H2H ─────────────────────────────────────────');
    lines.push(
      `${fixture.homeTeam}: ${h2h.homeTeamWins} νίκες | ${fixture.awayTeam}: ${h2h.awayTeamWins} νίκες | Ισοπαλίες: ${h2h.draws}`
    );
    for (const game of h2h.lastFiveGames) {
      lines.push(`  ${game.date} ${game.homeTeam} ${game.homeScore}-${game.awayScore} ${game.awayTeam} (${game.competition})`);
    }
  }

  if (homeInjuries.players.length > 0 || awayInjuries.players.length > 0) {
    lines.push('── API-SPORTS AVAILABILITY ────────────────────────────────');
    lines.push(
      `${fixture.homeTeam}: ${homeInjuries.players.length > 0 ? homeInjuries.players.map(player => `${player.name}${player.reason ? ` (${player.reason})` : ''}`).join(', ') : 'Καμία αναφορά'}`
    );
    lines.push(
      `${fixture.awayTeam}: ${awayInjuries.players.length > 0 ? awayInjuries.players.map(player => `${player.name}${player.reason ? ` (${player.reason})` : ''}`).join(', ') : 'Καμία αναφορά'}`
    );
  }

  return lines.length > 0 ? lines.join('\n') : undefined;
}

export async function enrichFromApiSports(fixture: Fixture): Promise<ProviderEnrichment> {
  const homeTeamStats = emptyStats(fixture.homeTeam);
  const awayTeamStats = emptyStats(fixture.awayTeam);

  if (!config.sports.apiSportsKey.trim()) {
    return {
      homeTeamStats,
      awayTeamStats,
      h2h: emptyH2H(),
      homeInjuries: emptyInjury(fixture.homeTeam),
      awayInjuries: emptyInjury(fixture.awayTeam),
      structuredContext: undefined,
      dataQuality: 'low',
      dataQualityNotes: ['APISPORTS_API_KEY is missing — no provider data available'],
    };
  }

  const h2h = fixture.competition === 'football'
    ? await fetchFootballH2H(fixture)
    : await fetchBasketballH2H(fixture);

  const injuries = fixture.competition === 'football'
    ? await fetchFootballInjuries(fixture)
    : { home: emptyInjury(fixture.homeTeam), away: emptyInjury(fixture.awayTeam) };

  const structuredContext = buildStructuredContext(fixture, h2h, injuries.home, injuries.away);
  const hasStructuredData = Boolean(structuredContext);

  return {
    homeTeamStats,
    awayTeamStats,
    h2h,
    homeInjuries: injuries.home,
    awayInjuries: injuries.away,
    structuredContext,
    dataQuality: hasStructuredData ? 'medium' : 'medium',
    dataQualityNotes: hasStructuredData
      ? ['API-Sports free plan provided H2H and availability context; season-wide standings/form are not available on the current plan']
      : ['API-Sports free plan did not return structured season context; analysis relies mainly on odds and live web search'],
  };
}