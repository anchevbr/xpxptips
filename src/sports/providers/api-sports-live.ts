import { config } from '../../config';
import { updateLiveDataBinding } from '../../reports/picks-store';
import { logger } from '../../utils/logger';
import type { LiveDataProvider } from '../../types';

const FOOTBALL_BASE_URL = 'https://v3.football.api-sports.io';
const BASKETBALL_BASE_URL = 'https://v1.basketball.api-sports.io';
const DETAIL_CACHE_TTL_MS = 30_000;

type ApiResponse<T> = {
  errors?: unknown;
  response?: T;
  results?: number;
};

type SportKind = 'football' | 'basketball';

export interface LiveDataTarget {
  fixtureId: string;
  league: string;
  homeTeam: string;
  awayTeam: string;
  date: string;
  kickoffAt?: string | null;
  liveDataProvider?: LiveDataProvider | null;
  liveDataFixtureId?: string | null;
}

export interface ProviderLiveStatus {
  homeScore: number | null;
  awayScore: number | null;
  status: string;
}

export interface ProviderEventStat {
  strStat: string;
  intHome: string;
  intAway: string;
}

export interface ProviderLineupPlayer {
  strPlayer: string;
  strTeam: string;
  strPosition: string;
  strHome: string;
  strSubstitute: string;
}

export interface ResolvedApiSportsFixture {
  provider: Extract<LiveDataProvider, 'api-football' | 'api-basketball'>;
  liveDataFixtureId: string;
}

interface FootballFixtureStatus {
  short?: string | null;
  long?: string | null;
  elapsed?: number | null;
  extra?: number | null;
}

interface FootballFixtureTeam {
  id?: number | null;
  name: string;
}

interface FootballStatisticEntry {
  type: string;
  value: string | number | null;
}

interface FootballStatisticsTeam {
  team: FootballFixtureTeam;
  statistics: FootballStatisticEntry[];
}

interface FootballLineupPlayerEntry {
  player?: {
    name?: string | null;
    pos?: string | null;
  } | null;
}

interface FootballLineupTeam {
  team: FootballFixtureTeam;
  startXI?: FootballLineupPlayerEntry[] | null;
  substitutes?: FootballLineupPlayerEntry[] | null;
}

interface FootballFixtureDetail {
  fixture: {
    id: number;
    date: string;
    timestamp?: number | null;
    status?: FootballFixtureStatus | null;
  };
  league: {
    id?: number | null;
    name: string;
    season?: number | null;
  };
  teams: {
    home: FootballFixtureTeam;
    away: FootballFixtureTeam;
  };
  goals?: {
    home?: number | null;
    away?: number | null;
  } | null;
  statistics?: FootballStatisticsTeam[] | null;
  lineups?: FootballLineupTeam[] | null;
}

interface BasketballGameStatus {
  short?: string | null;
  long?: string | null;
}

interface BasketballScoreBreakdown {
  quarter_1?: number | null;
  quarter_2?: number | null;
  quarter_3?: number | null;
  quarter_4?: number | null;
  over_time?: number | null;
  total?: number | null;
}

interface BasketballTeam {
  id?: number | null;
  name: string;
}

interface BasketballGameDetail {
  id: number;
  date: string;
  timestamp?: number | null;
  status?: BasketballGameStatus | null;
  league: {
    id?: number | null;
    name: string;
    season?: string | null;
  };
  teams: {
    home: BasketballTeam;
    away: BasketballTeam;
  };
  scores: {
    home: BasketballScoreBreakdown;
    away: BasketballScoreBreakdown;
  };
}

type CacheEntry<T> = {
  expiresAt: number;
  value: T;
};

const resolvedFixtureCache = new Map<string, ResolvedApiSportsFixture | null>();
const footballFixturesByDateCache = new Map<string, FootballFixtureDetail[]>();
const basketballGamesByDateCache = new Map<string, BasketballGameDetail[]>();
const footballDetailCache = new Map<string, CacheEntry<FootballFixtureDetail | null>>();
const basketballDetailCache = new Map<string, CacheEntry<BasketballGameDetail | null>>();

const FOOTBALL_LEAGUE_IDS: Array<{ match: string; id: number }> = [
  { match: 'premier league', id: 39 },
  { match: 'la liga', id: 140 },
  { match: 'serie a', id: 135 },
  { match: 'bundesliga', id: 78 },
  { match: 'ligue 1', id: 61 },
  { match: 'uefa champions league', id: 2 },
  { match: 'uefa europa league', id: 3 },
];

const BASKETBALL_LEAGUE_IDS: Array<{ match: string; id: number }> = [
  { match: 'nba', id: 12 },
  { match: 'euroleague', id: 120 },
];

function bindingFromFixtureId(fixtureId: string): ResolvedApiSportsFixture | null {
  if (fixtureId.startsWith('api-football_')) {
    return {
      provider: 'api-football',
      liveDataFixtureId: fixtureId.replace('api-football_', ''),
    };
  }
  if (fixtureId.startsWith('api-basketball_')) {
    return {
      provider: 'api-basketball',
      liveDataFixtureId: fixtureId.replace('api-basketball_', ''),
    };
  }
  return null;
}

function hasApiSportsKey(): boolean {
  return config.sports.apiSportsKey.trim().length > 0;
}

function describeErrors(errors: unknown): string | null {
  if (errors == null) return null;
  if (Array.isArray(errors)) {
    return errors.length > 0 ? JSON.stringify(errors) : null;
  }
  if (typeof errors === 'object') {
    return Object.keys(errors as Record<string, unknown>).length > 0
      ? JSON.stringify(errors)
      : null;
  }
  return String(errors);
}

function timeoutSignal(): AbortSignal | undefined {
  return config.sports.apiSportsTimeoutMs > 0
    ? AbortSignal.timeout(config.sports.apiSportsTimeoutMs)
    : undefined;
}

async function getApiSportsJson<T>(
  baseUrl: string,
  path: string,
  params: Record<string, string | number | boolean | undefined> = {},
): Promise<ApiResponse<T> | null> {
  if (!hasApiSportsKey()) {
    return null;
  }

  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }

  try {
    const res = await fetch(url, {
      headers: { 'x-apisports-key': config.sports.apiSportsKey },
      signal: timeoutSignal(),
    });

    if (!res.ok) {
      logger.warn(`[api-sports] HTTP ${res.status} for ${url.pathname}${url.search}`);
      return null;
    }

    return (await res.json()) as ApiResponse<T>;
  } catch (err) {
    logger.warn(`[api-sports] request failed for ${url.pathname}${url.search}: ${String(err)}`);
    return null;
  }
}

function readTtlCache<T>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function writeTtlCache<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T): T {
  cache.set(key, { expiresAt: Date.now() + DETAIL_CACHE_TTL_MS, value });
  return value;
}

function normalizeName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/ß/g, 'ss')
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae')
    .replace(/\bmunchen\b/g, 'munich')
    .replace(/\bolympiakos\b/g, 'olympiacos')
    .replace(/\b(fc|cf|sc|ac|bc|bk|club|cp)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function bigrams(value: string): string[] {
  const padded = ` ${value} `;
  const grams: string[] = [];
  for (let i = 0; i < padded.length - 1; i++) {
    grams.push(padded.slice(i, i + 2));
  }
  return grams;
}

function diceCoefficient(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;

  const aBigrams = bigrams(a);
  const bCounts = new Map<string, number>();
  for (const gram of bigrams(b)) {
    bCounts.set(gram, (bCounts.get(gram) ?? 0) + 1);
  }

  let overlap = 0;
  for (const gram of aBigrams) {
    const count = bCounts.get(gram) ?? 0;
    if (count > 0) {
      overlap++;
      bCounts.set(gram, count - 1);
    }
  }

  return (2 * overlap) / (aBigrams.length + bigrams(b).length);
}

function nameSimilarity(left: string, right: string): number {
  const normalizedLeft = normalizeName(left);
  const normalizedRight = normalizeName(right);

  if (!normalizedLeft || !normalizedRight) return 0;
  if (normalizedLeft === normalizedRight) return 1;
  if (
    normalizedLeft.includes(normalizedRight) ||
    normalizedRight.includes(normalizedLeft)
  ) {
    return 0.95;
  }

  const leftTokens = new Set(normalizedLeft.split(' '));
  const rightTokens = new Set(normalizedRight.split(' '));
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap++;
  }
  const tokenScore = overlap / Math.max(leftTokens.size, rightTokens.size);
  const charScore = diceCoefficient(normalizedLeft, normalizedRight);
  return Math.max(tokenScore, charScore);
}

function toNumberOrNull(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toStatValue(value: string | number | null | undefined): string {
  return value == null ? '-' : String(value);
}

function inferSport(target: LiveDataTarget): SportKind | null {
  const league = normalizeName(target.league);
  if (league === 'nba' || league === 'euroleague') {
    return 'basketball';
  }
  if (league.length > 0) {
    return 'football';
  }
  return null;
}

function resolveFootballLeagueId(leagueName: string): number | null {
  const normalized = normalizeName(leagueName);
  const match = FOOTBALL_LEAGUE_IDS.find(entry => normalized.includes(entry.match));
  return match?.id ?? null;
}

function resolveBasketballLeagueId(leagueName: string): number | null {
  const normalized = normalizeName(leagueName);
  const match = BASKETBALL_LEAGUE_IDS.find(entry => normalized.includes(entry.match));
  return match?.id ?? null;
}

function candidateDates(target: LiveDataTarget): string[] {
  const dates = new Set<string>();
  if (target.kickoffAt) {
    const kickoff = new Date(target.kickoffAt);
    if (!Number.isNaN(kickoff.getTime())) {
      dates.add(kickoff.toISOString().slice(0, 10));
    }
  }
  if (target.date) {
    dates.add(target.date);
  }
  return [...dates];
}

function kickoffMs(target: LiveDataTarget): number | null {
  if (!target.kickoffAt) return null;
  const parsed = new Date(target.kickoffAt).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function candidateScore(
  target: LiveDataTarget,
  candidateHome: string,
  candidateAway: string,
  candidateTimestamp?: number | null,
): number {
  const homeScore = nameSimilarity(target.homeTeam, candidateHome);
  const awayScore = nameSimilarity(target.awayTeam, candidateAway);

  if (homeScore < 0.6 || awayScore < 0.6) {
    return -1;
  }

  const targetKickoff = kickoffMs(target);
  const candidateKickoff = typeof candidateTimestamp === 'number' ? candidateTimestamp * 1000 : null;
  const timeScore =
    targetKickoff !== null && candidateKickoff !== null
      ? Math.max(0, 1 - Math.abs(targetKickoff - candidateKickoff) / (6 * 60 * 60 * 1000))
      : 0.25;

  return ((homeScore + awayScore) / 2) * 3 + timeScore;
}

async function fetchFootballFixturesForDate(
  date: string,
): Promise<FootballFixtureDetail[] | null> {
  const cached = footballFixturesByDateCache.get(date);
  if (cached) return cached;

  const data = await getApiSportsJson<FootballFixtureDetail[]>(
    FOOTBALL_BASE_URL,
    '/fixtures',
    { date },
  );
  if (!data) return null;

  const errors = describeErrors(data.errors);
  if (errors) {
    logger.warn(`[api-sports] football fixtures lookup failed for ${date}: ${errors}`);
    return null;
  }

  const response = Array.isArray(data.response) ? data.response : [];
  footballFixturesByDateCache.set(date, response);
  return response;
}

async function fetchBasketballGamesForDate(date: string): Promise<BasketballGameDetail[] | null> {
  const cached = basketballGamesByDateCache.get(date);
  if (cached) return cached;

  const data = await getApiSportsJson<BasketballGameDetail[]>(
    BASKETBALL_BASE_URL,
    '/games',
    { date },
  );
  if (!data) return null;

  const errors = describeErrors(data.errors);
  if (errors) {
    logger.warn(`[api-sports] basketball games lookup failed for ${date}: ${errors}`);
    return null;
  }

  const response = Array.isArray(data.response) ? data.response : [];
  basketballGamesByDateCache.set(date, response);
  return response;
}

function persistResolvedBinding(target: LiveDataTarget, binding: ResolvedApiSportsFixture): void {
  updateLiveDataBinding(target.fixtureId, binding.provider, binding.liveDataFixtureId);
}

async function resolveFootballFixture(
  target: LiveDataTarget,
): Promise<ResolvedApiSportsFixture | null | undefined> {
  const leagueId = resolveFootballLeagueId(target.league);
  if (!leagueId) return null;

  let requestFailed = false;
  let bestMatch: FootballFixtureDetail | null = null;
  let bestScore = -1;

  for (const date of candidateDates(target)) {
    const fixtures = await fetchFootballFixturesForDate(date);
    if (!fixtures) {
      requestFailed = true;
      continue;
    }

    for (const fixture of fixtures) {
      if ((fixture.league.id ?? null) !== leagueId) continue;

      const score = candidateScore(
        target,
        fixture.teams.home.name,
        fixture.teams.away.name,
        fixture.fixture.timestamp,
      );
      if (score > bestScore) {
        bestScore = score;
        bestMatch = fixture;
      }
    }
  }

  if (bestMatch && bestScore >= 1.8) {
    return {
      provider: 'api-football',
      liveDataFixtureId: String(bestMatch.fixture.id),
    };
  }

  return requestFailed ? undefined : null;
}

async function resolveBasketballFixture(
  target: LiveDataTarget,
): Promise<ResolvedApiSportsFixture | null | undefined> {
  const leagueId = resolveBasketballLeagueId(target.league);
  if (!leagueId) return null;

  let requestFailed = false;
  let bestMatch: BasketballGameDetail | null = null;
  let bestScore = -1;

  for (const date of candidateDates(target)) {
    const games = await fetchBasketballGamesForDate(date);
    if (!games) {
      requestFailed = true;
      continue;
    }

    for (const game of games) {
      if ((game.league.id ?? null) !== leagueId) continue;

      const score = candidateScore(
        target,
        game.teams.home.name,
        game.teams.away.name,
        game.timestamp,
      );
      if (score > bestScore) {
        bestScore = score;
        bestMatch = game;
      }
    }
  }

  if (bestMatch && bestScore >= 1.8) {
    return {
      provider: 'api-basketball',
      liveDataFixtureId: String(bestMatch.id),
    };
  }

  return requestFailed ? undefined : null;
}

async function resolveApiSportsFixture(
  target: LiveDataTarget,
): Promise<ResolvedApiSportsFixture | null | undefined> {
  if (!hasApiSportsKey()) {
    return null;
  }

  const bindingFromId = bindingFromFixtureId(target.fixtureId);
  if (bindingFromId) {
    return bindingFromId;
  }

  if (
    (target.liveDataProvider === 'api-football' || target.liveDataProvider === 'api-basketball') &&
    target.liveDataFixtureId
  ) {
    return {
      provider: target.liveDataProvider,
      liveDataFixtureId: target.liveDataFixtureId,
    };
  }

  if (resolvedFixtureCache.has(target.fixtureId)) {
    return resolvedFixtureCache.get(target.fixtureId) ?? null;
  }

  const sport = inferSport(target);
  let resolved: ResolvedApiSportsFixture | null | undefined;
  if (sport === 'football') {
    resolved = await resolveFootballFixture(target);
  } else if (sport === 'basketball') {
    resolved = await resolveBasketballFixture(target);
  } else {
    resolved = null;
  }

  if (resolved !== undefined) {
    resolvedFixtureCache.set(target.fixtureId, resolved ?? null);
  }

  if (resolved) {
    persistResolvedBinding(target, resolved);
  }

  return resolved;
}

async function fetchFootballDetail(id: string): Promise<FootballFixtureDetail | null> {
  const cached = readTtlCache(footballDetailCache, id);
  if (cached !== undefined) return cached;

  const data = await getApiSportsJson<FootballFixtureDetail[]>(
    FOOTBALL_BASE_URL,
    '/fixtures',
    { id },
  );
  if (!data) return null;

  const errors = describeErrors(data.errors);
  if (errors) {
    logger.warn(`[api-sports] football fixture detail failed for ${id}: ${errors}`);
    return null;
  }

  const response = Array.isArray(data.response) ? data.response : [];
  return writeTtlCache(footballDetailCache, id, response[0] ?? null);
}

async function fetchBasketballDetail(id: string): Promise<BasketballGameDetail | null> {
  const cached = readTtlCache(basketballDetailCache, id);
  if (cached !== undefined) return cached;

  const data = await getApiSportsJson<BasketballGameDetail[]>(
    BASKETBALL_BASE_URL,
    '/games',
    { id },
  );
  if (!data) return null;

  const errors = describeErrors(data.errors);
  if (errors) {
    logger.warn(`[api-sports] basketball game detail failed for ${id}: ${errors}`);
    return null;
  }

  const response = Array.isArray(data.response) ? data.response : [];
  return writeTtlCache(basketballDetailCache, id, response[0] ?? null);
}

function mapFootballStats(detail: FootballFixtureDetail): ProviderEventStat[] {
  if (!Array.isArray(detail.statistics) || detail.statistics.length === 0) {
    return [];
  }

  const homeStats = detail.statistics.find(
    entry => nameSimilarity(entry.team.name, detail.teams.home.name) >= 0.8,
  ) ?? detail.statistics[0];
  const awayStats = detail.statistics.find(
    entry => nameSimilarity(entry.team.name, detail.teams.away.name) >= 0.8,
  ) ?? detail.statistics.find(entry => entry !== homeStats) ?? detail.statistics[1];

  if (!homeStats || !awayStats) {
    return [];
  }

  const byType = new Map<string, ProviderEventStat>();
  for (const stat of homeStats.statistics) {
    byType.set(stat.type, {
      strStat: stat.type,
      intHome: toStatValue(stat.value),
      intAway: '-',
    });
  }
  for (const stat of awayStats.statistics) {
    const existing = byType.get(stat.type);
    if (existing) {
      existing.intAway = toStatValue(stat.value);
    } else {
      byType.set(stat.type, {
        strStat: stat.type,
        intHome: '-',
        intAway: toStatValue(stat.value),
      });
    }
  }

  return [...byType.values()];
}

function mapFootballLineups(detail: FootballFixtureDetail): ProviderLineupPlayer[] {
  if (!Array.isArray(detail.lineups) || detail.lineups.length === 0) {
    return [];
  }

  const players: ProviderLineupPlayer[] = [];
  for (const lineup of detail.lineups) {
    const isHome = nameSimilarity(lineup.team.name, detail.teams.home.name) >= 0.8 ? 'Yes' : 'No';

    for (const entry of lineup.startXI ?? []) {
      const player = entry.player;
      if (!player?.name) continue;
      players.push({
        strPlayer: player.name,
        strTeam: lineup.team.name,
        strPosition: player.pos ?? '',
        strHome: isHome,
        strSubstitute: 'No',
      });
    }

    for (const entry of lineup.substitutes ?? []) {
      const player = entry.player;
      if (!player?.name) continue;
      players.push({
        strPlayer: player.name,
        strTeam: lineup.team.name,
        strPosition: player.pos ?? '',
        strHome: isHome,
        strSubstitute: 'Yes',
      });
    }
  }

  return players;
}

function pushBasketballStat(
  stats: ProviderEventStat[],
  name: string,
  home: number | null | undefined,
  away: number | null | undefined,
): void {
  if (home == null && away == null) {
    return;
  }
  stats.push({
    strStat: name,
    intHome: toStatValue(home),
    intAway: toStatValue(away),
  });
}

function mapBasketballStats(detail: BasketballGameDetail): ProviderEventStat[] {
  const home = detail.scores.home;
  const away = detail.scores.away;
  const stats: ProviderEventStat[] = [];

  pushBasketballStat(stats, 'Q1', home.quarter_1, away.quarter_1);
  pushBasketballStat(stats, 'Q2', home.quarter_2, away.quarter_2);
  pushBasketballStat(stats, 'Q3', home.quarter_3, away.quarter_3);
  pushBasketballStat(stats, 'Q4', home.quarter_4, away.quarter_4);

  const homeHalf1 = home.quarter_1 != null && home.quarter_2 != null ? home.quarter_1 + home.quarter_2 : null;
  const awayHalf1 = away.quarter_1 != null && away.quarter_2 != null ? away.quarter_1 + away.quarter_2 : null;
  pushBasketballStat(stats, '1st Half', homeHalf1, awayHalf1);

  const homeHalf2 = home.quarter_3 != null && home.quarter_4 != null ? home.quarter_3 + home.quarter_4 : null;
  const awayHalf2 = away.quarter_3 != null && away.quarter_4 != null ? away.quarter_3 + away.quarter_4 : null;
  pushBasketballStat(stats, '2nd Half', homeHalf2, awayHalf2);

  pushBasketballStat(stats, 'Overtime', home.over_time, away.over_time);
  pushBasketballStat(stats, 'Total', home.total, away.total);

  return stats;
}

export async function prewarmApiSportsBinding(
  target: LiveDataTarget,
): Promise<ResolvedApiSportsFixture | null> {
  const resolved = await resolveApiSportsFixture(target);
  return resolved ?? null;
}

export async function fetchApiSportsLiveStatus(
  target: LiveDataTarget,
): Promise<ProviderLiveStatus | null | undefined> {
  const resolved = await resolveApiSportsFixture(target);
  if (!resolved) return undefined;

  if (resolved.provider === 'api-football') {
    const detail = await fetchFootballDetail(resolved.liveDataFixtureId);
    if (!detail) return undefined;
    return {
      homeScore: toNumberOrNull(detail.goals?.home),
      awayScore: toNumberOrNull(detail.goals?.away),
      status: detail.fixture.status?.short ?? detail.fixture.status?.long ?? '',
    };
  }

  const detail = await fetchBasketballDetail(resolved.liveDataFixtureId);
  if (!detail) return undefined;
  return {
    homeScore: toNumberOrNull(detail.scores.home.total),
    awayScore: toNumberOrNull(detail.scores.away.total),
    status: detail.status?.short ?? detail.status?.long ?? '',
  };
}

export async function fetchApiSportsEventStats(
  target: LiveDataTarget,
): Promise<ProviderEventStat[] | undefined> {
  const resolved = await resolveApiSportsFixture(target);
  if (!resolved) return undefined;

  if (resolved.provider === 'api-football') {
    const detail = await fetchFootballDetail(resolved.liveDataFixtureId);
    if (!detail) return undefined;
    return mapFootballStats(detail);
  }

  const detail = await fetchBasketballDetail(resolved.liveDataFixtureId);
  if (!detail) return undefined;
  return mapBasketballStats(detail);
}

export async function fetchApiSportsEventLineup(
  target: LiveDataTarget,
): Promise<ProviderLineupPlayer[] | undefined> {
  const resolved = await resolveApiSportsFixture(target);
  if (!resolved) return undefined;

  if (resolved.provider !== 'api-football') {
    return [];
  }

  const detail = await fetchFootballDetail(resolved.liveDataFixtureId);
  if (!detail) return undefined;
  return mapFootballLineups(detail);
}

export async function fetchApiSportsEventResult(
  target: LiveDataTarget,
): Promise<ProviderLiveStatus | null | undefined> {
  const resolved = await resolveApiSportsFixture(target);
  if (!resolved) return undefined;

  const live = await fetchApiSportsLiveStatus(target);
  if (live === undefined) return undefined;
  return live;
}