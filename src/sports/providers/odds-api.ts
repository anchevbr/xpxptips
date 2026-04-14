// ─────────────────────────────────────────────────────────────────────────────
// The Odds API integration
//
// Fetches real-time betting odds from European bookmakers.
// Used in Gate 5 to verify markets are available and odds meet minimum threshold.
//
// API Docs: https://the-odds-api.com/liveapi/guides/v4/
// ─────────────────────────────────────────────────────────────────────────────

import { config } from '../../config';
import { logger } from '../../utils/logger';
import { createOpenAIClient } from '../../utils/openai-client';
import { logOpenAIUsage } from '../../utils/openai-usage';

const openai = createOpenAIClient();

const BASE_URL = 'https://api.the-odds-api.com/v4';

function apiKey(): string {
  return process.env['THE_ODDS_API_KEY'] ?? '';
}

const LEAGUE_SPORT_KEY_MAP: Record<string, string> = {
  'Premier League': 'soccer_epl',
  'La Liga': 'soccer_spain_la_liga',
  'Serie A': 'soccer_italy_serie_a',
  'Bundesliga': 'soccer_germany_bundesliga',
  'Ligue 1': 'soccer_france_ligue_one',
  'UEFA Champions League': 'soccer_uefa_champs_league',
  'UEFA Europa League': 'soccer_uefa_europa_league',
  'NBA': 'basketball_nba',
  'EuroLeague': 'basketball_euroleague',
};

export interface OddsOutcome {
  name: string;
  price: number;
  point?: number;
}

export interface OddsMarket {
  key: string;
  outcomes: OddsOutcome[];
}

export interface Bookmaker {
  key: string;
  title: string;
  lastUpdate: string;
  markets: OddsMarket[];
}

export interface EventOdds {
  id: string;
  sportKey: string;
  commenceTime: string;
  homeTeam: string;
  awayTeam: string;
  bookmakers: Bookmaker[];
}

interface EventOddsApiResponse {
  id: string;
  home_team: string;
  away_team: string;
  commence_time: string;
  bookmakers: Array<{
    key: string;
    title: string;
    last_update: string;
    markets: Array<{
      key: string;
      outcomes: Array<{
        name: string;
        price: number;
        point?: number;
      }>;
    }>;
  }>;
}

interface ApiEvent {
  id: string;
  home_team: string;
  away_team: string;
  commence_time: string;
}

function samePoint(a?: number, b?: number): boolean {
  if (a === undefined || b === undefined) return a === b;
  return Math.abs(a - b) < 1e-9;
}

function normalizeTeamName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(fc|sc|ac|cf|afc|fk|as|sv|rc|cd)\b/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function teamNamesMatch(a: string, b: string): boolean {
  const na = normalizeTeamName(a);
  const nb = normalizeTeamName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  return false;
}

function resolveH2HOutcomeName(outcomeName: string, eventOdds: EventOdds): string {
  if (teamNamesMatch(outcomeName, eventOdds.homeTeam)) return eventOdds.homeTeam;
  if (teamNamesMatch(outcomeName, eventOdds.awayTeam)) return eventOdds.awayTeam;

  const callerTokens = new Set(
    normalizeTeamName(outcomeName).split(' ').filter((word) => word.length >= 5)
  );

  if (callerTokens.size > 0) {
    if (normalizeTeamName(eventOdds.homeTeam).split(' ').some((word) => callerTokens.has(word))) {
      return eventOdds.homeTeam;
    }
    if (normalizeTeamName(eventOdds.awayTeam).split(' ').some((word) => callerTokens.has(word))) {
      return eventOdds.awayTeam;
    }
  }

  return outcomeName;
}

function findOutcome(
  eventOdds: EventOdds,
  market: OddsMarket,
  marketKey: string,
  outcomeName: string,
  point?: number,
): OddsOutcome | undefined {
  if (marketKey === 'h2h' && outcomeName !== 'Draw') {
    const apiName = resolveH2HOutcomeName(outcomeName, eventOdds);
    return market.outcomes.find((outcome) => outcome.name === apiName);
  }

  return market.outcomes.find(
    (outcome) =>
      outcome.name.toLowerCase() === outcomeName.toLowerCase() &&
      (point === undefined || samePoint(outcome.point, point))
  );
}

export function getMostCommonTotalsLine(eventOdds: EventOdds): number | undefined {
  const counts = new Map<number, number>();

  for (const bookmaker of eventOdds.bookmakers) {
    const market = bookmaker.markets.find((entry) => entry.key === 'totals');
    const point = market?.outcomes.find((outcome) => outcome.name === 'Over')?.point ?? market?.outcomes[0]?.point;
    if (point !== undefined) {
      counts.set(point, (counts.get(point) ?? 0) + 1);
    }
  }

  if (counts.size === 0) return undefined;
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

async function resolveEventId(
  sportKey: string,
  homeTeam: string,
  awayTeam: string,
  key: string
): Promise<ApiEvent | null> {
  const model = config.openai.model;
  const effort = config.openai.expertEffort;
  const url = `${BASE_URL}/sports/${sportKey}/events?apiKey=${key}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });

  if (!response.ok) return null;

  const events = (await response.json()) as ApiEvent[];
  if (events.length === 0) return null;

  const list = events.map((event, index) => `${index}: ${event.home_team} vs ${event.away_team}`).join('\n');
  const prompt =
    `Which event matches this fixture?\nHome: ${homeTeam}\nAway: ${awayTeam}\n\n` +
    `Events:\n${list}\n\nReply with only the integer index, or -1 if none match.`;

  try {
    const resp = await openai.responses.create({
      model,
      input: [{ role: 'user', content: prompt }],
      reasoning: { effort },
    } as Parameters<typeof openai.responses.create>[0]);

    logOpenAIUsage('odds-event-match', model, resp as { id?: string; usage?: unknown }, {
      sportKey,
      homeTeam,
      awayTeam,
      events: events.length,
    });

    const raw = ((resp as { output_text?: string }).output_text ?? '').trim();
    const index = parseInt(raw, 10);

    if (!Number.isNaN(index) && index >= 0 && index < events.length) {
      logger.info(
        `[odds-api] matched "${homeTeam} vs ${awayTeam}" → "${events[index]!.home_team} vs ${events[index]!.away_team}"`
      );
      return events[index]!;
    }

    logger.warn(`[odds-api] no match found for ${homeTeam} vs ${awayTeam} in ${sportKey}`);
  } catch (error) {
    logger.warn(`[odds-api] event match failed: ${String(error)}`);
  }

  return null;
}

export async function fetchOddsForFixture(
  homeTeam: string,
  awayTeam: string,
  league: string,
  _commenceTime: string
): Promise<EventOdds | null> {
  const key = apiKey();
  if (!key) {
    logger.warn('[odds-api] THE_ODDS_API_KEY not set — skipping odds lookup');
    return null;
  }

  const sportKey = LEAGUE_SPORT_KEY_MAP[league];
  if (!sportKey) {
    logger.warn(`[odds-api] no sport key mapping for league: ${league}`);
    return null;
  }

  try {
    const apiEvent = await resolveEventId(sportKey, homeTeam, awayTeam, key);
    if (!apiEvent) {
      logger.warn(`[odds-api] no odds found for ${homeTeam} vs ${awayTeam} in ${league}`);
      return null;
    }

    const isSoccer = sportKey.startsWith('soccer_');
    const markets = isSoccer ? 'h2h,totals,btts' : 'h2h,totals';
    const oddsUrl =
      `${BASE_URL}/sports/${sportKey}/events/${apiEvent.id}/odds` +
      `?apiKey=${key}&regions=eu&markets=${markets}&oddsFormat=decimal`;

    const response = await fetch(oddsUrl, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      logger.error(`[odds-api] HTTP ${response.status} for event ${apiEvent.id}`);
      return null;
    }

    const remaining = response.headers.get('x-requests-remaining');
    const last = response.headers.get('x-requests-last');
    if (remaining && last) {
      logger.info(`[odds-api] quota: cost ${last}, ${remaining} remaining`);
    }

    const data = (await response.json()) as EventOddsApiResponse;

    return {
      id: data.id,
      sportKey,
      commenceTime: apiEvent.commence_time,
      homeTeam: apiEvent.home_team,
      awayTeam: apiEvent.away_team,
      bookmakers: (data.bookmakers ?? []).map((bookmaker) => ({
        key: bookmaker.key,
        title: bookmaker.title,
        lastUpdate: bookmaker.last_update,
        markets: bookmaker.markets,
      })),
    };
  } catch (error) {
    logger.error(`[odds-api] fetch failed: ${String(error)}`);
    return null;
  }
}

export function getBestOdds(
  eventOdds: EventOdds,
  marketKey: string,
  outcomeName: string,
  point?: number,
): number | null {
  let bestPrice = 0;
  let matchCount = 0;

  for (const bookmaker of eventOdds.bookmakers) {
    const market = bookmaker.markets.find((entry) => entry.key === marketKey);
    if (!market) continue;

    const outcome = findOutcome(eventOdds, market, marketKey, outcomeName, point);
    if (!outcome) continue;

    matchCount++;
    if (outcome.price > bestPrice) {
      bestPrice = outcome.price;
      if (matchCount <= 3) {
        logger.info(
          `[odds-api] getBestOdds: ${bookmaker.title} | ${marketKey} | ${outcomeName}${point !== undefined ? ` @ ${point}` : ''} → ${outcome.price}`
        );
      }
    }
  }

  if (matchCount > 0) {
    logger.info(
      `[odds-api] getBestOdds final: ${marketKey}/${outcomeName}${point !== undefined ? ` @ ${point}` : ''} → ${bestPrice} (from ${matchCount} bookmakers)`
    );
  } else {
    logger.warn(
      `[odds-api] getBestOdds: NO MATCHES for ${marketKey}/${outcomeName}${point !== undefined ? ` @ ${point}` : ''}`
    );
  }

  return bestPrice > 0 ? bestPrice : null;
}

export function getAverageOdds(
  eventOdds: EventOdds,
  marketKey: string,
  outcomeName: string,
  point?: number,
): number | null {
  const prices: number[] = [];

  for (const bookmaker of eventOdds.bookmakers) {
    const market = bookmaker.markets.find((entry) => entry.key === marketKey);
    if (!market) continue;

    const outcome = findOutcome(eventOdds, market, marketKey, outcomeName, point);
    if (outcome) prices.push(outcome.price);
  }

  if (prices.length === 0) return null;
  return prices.reduce((sum, price) => sum + price, 0) / prices.length;
}

export function formatOddsSummary(eventOdds: EventOdds): string {
  const lines: string[] = [];
  lines.push(`${eventOdds.homeTeam} vs ${eventOdds.awayTeam}`);
  const isSoccer = eventOdds.sportKey.startsWith('soccer_');

  const homeOdds = getBestOdds(eventOdds, 'h2h', eventOdds.homeTeam);
  const drawOdds = isSoccer ? getBestOdds(eventOdds, 'h2h', 'Draw') : null;
  const awayOdds = getBestOdds(eventOdds, 'h2h', eventOdds.awayTeam);

  if (homeOdds || drawOdds || awayOdds) {
    if (isSoccer) {
      lines.push(
        `H2H: ${eventOdds.homeTeam} ${homeOdds?.toFixed(2) ?? '-'} | Draw ${drawOdds?.toFixed(2) ?? '-'} | ${eventOdds.awayTeam} ${awayOdds?.toFixed(2) ?? '-'}`
      );
    } else {
      lines.push(
        `H2H: ${eventOdds.homeTeam} ${homeOdds?.toFixed(2) ?? '-'} | ${eventOdds.awayTeam} ${awayOdds?.toFixed(2) ?? '-'}`
      );
    }
  }

  const totalsLine = getMostCommonTotalsLine(eventOdds);
  const overOdds = getBestOdds(eventOdds, 'totals', 'Over', totalsLine);
  const underOdds = getBestOdds(eventOdds, 'totals', 'Under', totalsLine);

  if (overOdds || underOdds) {
    const line = totalsLine ?? 2.5;
    lines.push(`Totals ${line}: Over ${overOdds?.toFixed(2) ?? '-'} | Under ${underOdds?.toFixed(2) ?? '-'}`);
  }

  lines.push(`Bookmakers: ${eventOdds.bookmakers.length}`);
  return lines.join('\n');
}
