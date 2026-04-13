// ─────────────────────────────────────────────────────────────────────────────
// The Odds API integration
//
// Fetches real-time betting odds from 40+ European bookmakers.
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

// Map our league names to The Odds API sport keys
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

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OddsOutcome {
  name: string;           // Team name or "Over"/"Under"
  price: number;          // Decimal odds (e.g., 1.61, 2.50)
  point?: number;         // For totals/spreads (e.g., 2.5)
}

export interface OddsMarket {
  key: string;            // 'h2h', 'totals', 'spreads'
  outcomes: OddsOutcome[];
}

export interface Bookmaker {
  key: string;            // 'pinnacle', 'bet365', etc.
  title: string;          // 'Pinnacle', 'Bet365'
  lastUpdate: string;     // ISO timestamp
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

/**
 * Resolve the caller's team name (from TheSportsDB) to the API's canonical team name
 * stored in eventOdds. Tries fuzzy match first, then token overlap for aliases like
 * "Fenerbahçe Basketbol" ↔ "Fenerbahce SK".
 */
function resolveH2HOutcomeName(outcomeName: string, eventOdds: EventOdds): string {
  if (teamNamesMatch(outcomeName, eventOdds.homeTeam)) return eventOdds.homeTeam;
  if (teamNamesMatch(outcomeName, eventOdds.awayTeam)) return eventOdds.awayTeam;

  // Token overlap for completely different aliases sharing a key word
  const callerTokens = new Set(
    normalizeTeamName(outcomeName).split(' ').filter((w) => w.length >= 5)
  );
  if (callerTokens.size > 0) {
    if (normalizeTeamName(eventOdds.homeTeam).split(' ').some((w) => callerTokens.has(w)))
      return eventOdds.homeTeam;
    if (normalizeTeamName(eventOdds.awayTeam).split(' ').some((w) => callerTokens.has(w)))
      return eventOdds.awayTeam;
  }

  return outcomeName;
}

// ─── Event resolution (FREE /events endpoint) ─────────────────────────────────

/**
 * Step 1 of odds fetching — uses the FREE /events endpoint (no quota cost) to find
 * the API's event ID and canonical team names for a fixture.
 * Uses the configured OpenAI model and reasoning effort to match team name variants.
 */
async function resolveEventId(
  sportKey: string,
  homeTeam: string,
  awayTeam: string,
  key: string
): Promise<ApiEvent | null> {
  const model = config.openai.model;
  const effort = config.openai.expertEffort;
  const url = `${BASE_URL}/sports/${sportKey}/events?apiKey=${key}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return null;

  const events = (await res.json()) as ApiEvent[];
  if (events.length === 0) return null;

  const list = events.map((e, i) => `${i}: ${e.home_team} vs ${e.away_team}`).join('\n');
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
    const idx = parseInt(raw, 10);
    if (!isNaN(idx) && idx >= 0 && idx < events.length) {
      logger.info(
        `[odds-api] matched "${homeTeam} vs ${awayTeam}" → "${events[idx]!.home_team} vs ${events[idx]!.away_team}"`
      );
      return events[idx]!;
    }
    logger.warn(`[odds-api] no match found for ${homeTeam} vs ${awayTeam} in ${sportKey}`);
  } catch (err) {
    logger.warn(`[odds-api] event match failed: ${String(err)}`);
  }
  return null;
}

// ─── Main exports ─────────────────────────────────────────────────────────────

/**
 * Fetches current odds for a specific fixture.
 * Returns null if no odds are available or API key is missing.
 */
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
    // Step 1 — FREE: resolve event identity via /events (no quota cost)
    const apiEvent = await resolveEventId(sportKey, homeTeam, awayTeam, key);
    if (!apiEvent) {
      logger.warn(`[odds-api] no odds found for ${homeTeam} vs ${awayTeam} in ${league}`);
      return null;
    }

    // Step 2 — fetch h2h + totals for the specific event by ID
    const isSoccer = sportKey.startsWith('soccer_');
    const markets = isSoccer ? 'h2h,totals,btts' : 'h2h,totals';
    const oddsUrl =
      `${BASE_URL}/sports/${sportKey}/events/${apiEvent.id}/odds` +
      `?apiKey=${key}&regions=eu,uk&markets=${markets}&oddsFormat=decimal`;

    const res = await fetch(oddsUrl, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      logger.error(`[odds-api] HTTP ${res.status} for event ${apiEvent.id}`);
      return null;
    }

    const remaining = res.headers.get('x-requests-remaining');
    const last = res.headers.get('x-requests-last');
    if (remaining && last) {
      logger.info(`[odds-api] quota: cost ${last}, ${remaining} remaining`);
    }

    const data = (await res.json()) as EventOddsApiResponse;

    return {
      id: data.id,
      sportKey,
      commenceTime: apiEvent.commence_time,
      homeTeam: apiEvent.home_team,   // API canonical name — used for exact outcome lookup
      awayTeam: apiEvent.away_team,   // API canonical name — used for exact outcome lookup
      bookmakers: (data.bookmakers ?? []).map((b) => ({
        key: b.key,
        title: b.title,
        lastUpdate: b.last_update,
        markets: b.markets,
      })),
    };
  } catch (err) {
    logger.error(`[odds-api] fetch failed: ${String(err)}`);
    return null;
  }
}

/**
 * Extracts the best available odds for a specific market and outcome.
 * For h2h: outcome is team name or "Draw"
 * For totals: outcome is "Over" or "Under"
 */
export function getBestOdds(
  eventOdds: EventOdds,
  marketKey: string,
  outcomeName: string
): number | null {
  let bestPrice = 0;
  let matchCount = 0;

  for (const bookmaker of eventOdds.bookmakers) {
    const market = bookmaker.markets.find((m) => m.key === marketKey);
    if (!market) continue;

    // For h2h markets: resolve caller's name to the API's canonical team name, then exact match.
    // resolveH2HOutcomeName maps e.g. "Fenerbahçe Basketbol" → "Fenerbahce SK" via token overlap.
    let outcome;
    if (marketKey === 'h2h' && outcomeName !== 'Draw') {
      const apiName = resolveH2HOutcomeName(outcomeName, eventOdds);
      outcome = market.outcomes.find((o) => o.name === apiName);
    } else {
      outcome = market.outcomes.find(
        (o) => o.name.toLowerCase() === outcomeName.toLowerCase()
      );
    }

    if (outcome && outcome.price > bestPrice) {
      bestPrice = outcome.price;
      matchCount++;
      if (matchCount <= 3) {
        logger.info(
          `[odds-api] getBestOdds: ${bookmaker.title} | ${marketKey} | ${outcomeName} → ${outcome.price}`
        );
      }
    }
  }

  if (matchCount > 0) {
    logger.info(`[odds-api] getBestOdds final: ${marketKey}/${outcomeName} → ${bestPrice} (from ${matchCount} bookmakers)`);
  } else {
    logger.warn(`[odds-api] getBestOdds: NO MATCHES for ${marketKey}/${outcomeName}`);
  }

  return bestPrice > 0 ? bestPrice : null;
}

/**
 * Gets the average odds across all bookmakers for a specific outcome.
 */
export function getAverageOdds(
  eventOdds: EventOdds,
  marketKey: string,
  outcomeName: string
): number | null {
  const prices: number[] = [];

  for (const bookmaker of eventOdds.bookmakers) {
    const market = bookmaker.markets.find((m) => m.key === marketKey);
    if (!market) continue;

    // For h2h markets: resolve caller's name to the API's canonical team name, then exact match.
    // resolveH2HOutcomeName maps e.g. "Fenerbahçe Basketbol" → "Fenerbahce SK" via token overlap.
    let outcome;
    if (marketKey === 'h2h' && outcomeName !== 'Draw') {
      const apiName = resolveH2HOutcomeName(outcomeName, eventOdds);
      outcome = market.outcomes.find((o) => o.name === apiName);
    } else {
      outcome = market.outcomes.find(
        (o) => o.name.toLowerCase() === outcomeName.toLowerCase()
      );
    }

    if (outcome) {
      prices.push(outcome.price);
    }
  }

  if (prices.length === 0) return null;
  return prices.reduce((sum, p) => sum + p, 0) / prices.length;
}

/**
 * Formats odds summary for display/logging.
 */
export function formatOddsSummary(eventOdds: EventOdds): string {
  const lines: string[] = [];
  lines.push(`${eventOdds.homeTeam} vs ${eventOdds.awayTeam}`);

  // H2H market
  const homeOdds = getBestOdds(eventOdds, 'h2h', eventOdds.homeTeam);
  const drawOdds = getBestOdds(eventOdds, 'h2h', 'Draw');
  const awayOdds = getBestOdds(eventOdds, 'h2h', eventOdds.awayTeam);

  if (homeOdds || drawOdds || awayOdds) {
    lines.push(
      `H2H: ${eventOdds.homeTeam} ${homeOdds?.toFixed(2) ?? '-'} | Draw ${drawOdds?.toFixed(2) ?? '-'} | ${eventOdds.awayTeam} ${awayOdds?.toFixed(2) ?? '-'}`
    );
  }

  // Totals market
  const overOdds = getBestOdds(eventOdds, 'totals', 'Over');
  const underOdds = getBestOdds(eventOdds, 'totals', 'Under');

  if (overOdds || underOdds) {
    // Get the line (usually 2.5 for football)
    const totalsMarket = eventOdds.bookmakers[0]?.markets.find((m) => m.key === 'totals');
    const line = totalsMarket?.outcomes[0]?.point ?? 2.5;
    lines.push(`Totals ${line}: Over ${overOdds?.toFixed(2) ?? '-'} | Under ${underOdds?.toFixed(2) ?? '-'}`);
  }

  lines.push(`Bookmakers: ${eventOdds.bookmakers.length}`);
  return lines.join('\n');
}
