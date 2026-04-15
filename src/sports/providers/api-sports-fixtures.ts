import { config } from '../../config';
import { logger } from '../../utils/logger';
import type { Competition, Fixture } from '../../types';

const FOOTBALL_BASE_URL = 'https://v3.football.api-sports.io';
const BASKETBALL_BASE_URL = 'https://v1.basketball.api-sports.io';

const FOOTBALL_LEAGUES = new Set([39, 140, 135, 78, 61, 2, 3]);
const BASKETBALL_LEAGUES = new Map<number, Competition>([
  [12, 'NBA'],
  [120, 'EuroLeague'],
]);

type ApiResponse<T> = {
  errors?: unknown;
  response?: T;
  results?: number;
};

interface FootballFixtureResponse {
  fixture: {
    id: number;
    date: string;
    venue?: {
      name?: string | null;
    } | null;
    status?: {
      short?: string | null;
    } | null;
  };
  league: {
    id?: number | null;
    name: string;
  };
  teams: {
    home: {
      id?: number | null;
      name: string;
    };
    away: {
      id?: number | null;
      name: string;
    };
  };
}

interface BasketballGameResponse {
  id: number;
  date: string;
  venue?: string | null;
  status?: {
    short?: string | null;
  } | null;
  league: {
    id?: number | null;
    name: string;
  };
  teams: {
    home: {
      id?: number | null;
      name: string;
    };
    away: {
      id?: number | null;
      name: string;
    };
  };
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
    logger.warn('[fixtures] APISPORTS_API_KEY is missing');
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
      logger.warn(`[fixtures] API-Sports HTTP ${res.status} for ${url.pathname}${url.search}`);
      return null;
    }
    return (await res.json()) as ApiResponse<T>;
  } catch (err) {
    logger.warn(`[fixtures] API-Sports request failed for ${url.pathname}${url.search}: ${String(err)}`);
    return null;
  }
}

function mapFootballStatus(raw: string | null | undefined): Fixture['status'] {
  switch ((raw ?? '').toUpperCase()) {
    case 'NS':
    case 'TBD':
      return 'scheduled';
    case '1H':
    case 'HT':
    case '2H':
    case 'ET':
    case 'BT':
    case 'P':
    case 'LIVE':
    case 'INT':
    case 'SUSP':
      return 'live';
    default:
      return 'finished';
  }
}

function mapBasketballStatus(raw: string | null | undefined): Fixture['status'] {
  switch ((raw ?? '').toUpperCase()) {
    case 'NS':
    case 'TBD':
      return 'scheduled';
    case 'Q1':
    case 'Q2':
    case 'Q3':
    case 'Q4':
    case 'OT':
    case 'BT':
    case 'HT':
      return 'live';
    default:
      return 'finished';
  }
}

async function fetchFootballFixtures(date: string): Promise<Fixture[]> {
  const data = await getApiSportsJson<FootballFixtureResponse[]>(FOOTBALL_BASE_URL, '/fixtures', { date });
  if (!data) return [];

  const errors = describeErrors(data.errors);
  if (errors) {
    logger.warn(`[fixtures] API-FOOTBALL failed for ${date}: ${errors}`);
    return [];
  }

  const response = Array.isArray(data.response) ? data.response : [];
  const fixtures = response
    .filter(item => item.league.id != null && FOOTBALL_LEAGUES.has(item.league.id))
    .map((item): Fixture => ({
      id: `api-football_${item.fixture.id}`,
      competition: 'football',
      league: item.league.name,
      homeTeam: item.teams.home.name,
      awayTeam: item.teams.away.name,
      date: item.fixture.date,
      venue: item.fixture.venue?.name ?? undefined,
      status: mapFootballStatus(item.fixture.status?.short),
      homeTeamId: item.teams.home.id != null ? String(item.teams.home.id) : undefined,
      awayTeamId: item.teams.away.id != null ? String(item.teams.away.id) : undefined,
      leagueId: item.league.id != null ? String(item.league.id) : undefined,
      liveDataProvider: 'api-football',
      liveDataFixtureId: String(item.fixture.id),
    }));

  logger.info(`[fixtures] API-FOOTBALL returned ${fixtures.length} tracked fixture(s) for ${date}`);
  return fixtures;
}

async function fetchBasketballFixtures(date: string): Promise<Fixture[]> {
  const data = await getApiSportsJson<BasketballGameResponse[]>(BASKETBALL_BASE_URL, '/games', { date });
  if (!data) return [];

  const errors = describeErrors(data.errors);
  if (errors) {
    logger.warn(`[fixtures] API-BASKETBALL failed for ${date}: ${errors}`);
    return [];
  }

  const response = Array.isArray(data.response) ? data.response : [];
  const fixtures = response
    .filter(item => item.league.id != null && BASKETBALL_LEAGUES.has(item.league.id))
    .map((item): Fixture => ({
      id: `api-basketball_${item.id}`,
      competition: BASKETBALL_LEAGUES.get(item.league.id!)!,
      league: BASKETBALL_LEAGUES.get(item.league.id!)!,
      homeTeam: item.teams.home.name,
      awayTeam: item.teams.away.name,
      date: item.date,
      venue: item.venue ?? undefined,
      status: mapBasketballStatus(item.status?.short),
      homeTeamId: item.teams.home.id != null ? String(item.teams.home.id) : undefined,
      awayTeamId: item.teams.away.id != null ? String(item.teams.away.id) : undefined,
      leagueId: item.league.id != null ? String(item.league.id) : undefined,
      liveDataProvider: 'api-basketball',
      liveDataFixtureId: String(item.id),
    }));

  logger.info(`[fixtures] API-BASKETBALL returned ${fixtures.length} tracked fixture(s) for ${date}`);
  return fixtures;
}

export async function fetchFixturesViaApiSports(date: string): Promise<Fixture[]> {
  logger.info(`[fixtures] fetching fixtures for ${date} via API-Sports`);
  const [footballFixtures, basketballFixtures] = await Promise.all([
    fetchFootballFixtures(date),
    fetchBasketballFixtures(date),
  ]);
  const fixtures = [...footballFixtures, ...basketballFixtures].sort((left, right) =>
    left.date.localeCompare(right.date),
  );
  logger.info(`[fixtures] API-Sports total: ${fixtures.length} fixture(s) for ${date}`);
  return fixtures;
}