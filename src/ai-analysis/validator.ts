import { logger } from '../utils/logger';
import { containsGreek, preferGreekEntityName } from '../utils/greek-text';
import type { BettingAnalysis, MatchData } from '../types';

/**
 * Validates and sanitizes the raw object returned by the model before it
 * is treated as a BettingAnalysis. Returns null if the shape is invalid.
 */
export function validateAnalysis(
  raw: unknown,
  matchData: MatchData
): BettingAnalysis | null {
  const { fixture } = matchData;
  if (typeof raw !== 'object' || raw === null) {
    logger.warn('[validator] analysis is not an object');
    return null;
  }

  const obj = raw as Record<string, unknown>;

  // Required string fields (bestBettingMarket and finalPick can be empty when no pick)
  for (const field of ['event', 'competition', 'date', 'homeTeam', 'awayTeam',
    'shortReasoning', 'dataQualityNote']) {
    if (typeof obj[field] !== 'string' || !(obj[field] as string).trim()) {
      logger.warn(`[validator] missing or empty field: ${field}`);
      return null;
    }
  }
  // When a pick is recommended these must also be non-empty
  if (obj['isPickRecommended'] !== false) {
    for (const field of ['bestBettingMarket', 'finalPick']) {
      if (typeof obj[field] !== 'string' || !(obj[field] as string).trim()) {
        logger.warn(`[validator] missing or empty field: ${field}`);
        return null;
      }
    }
  }

  // Required number field
  if (typeof obj['confidence'] !== 'number' || (obj['confidence'] as number) < 1 || (obj['confidence'] as number) > 10) {
    logger.warn('[validator] confidence out of range');
    return null;
  }

  // Required boolean
  if (typeof obj['isPickRecommended'] !== 'boolean') {
    logger.warn('[validator] isPickRecommended is not boolean');
    return null;
  }

  // Required arrays
  for (const field of ['keyFacts', 'riskFactors']) {
    if (!Array.isArray(obj[field])) {
      logger.warn(`[validator] ${field} is not an array`);
      return null;
    }
  }

  // Sanitize: hallucination guard — ensure teams match fixture
  // (model sometimes swaps or invents team names)
  const homeTeam = String(obj['homeTeam']).trim();
  const awayTeam = String(obj['awayTeam']).trim();
  const resolvedHomeTeam = preferGreekEntityName(homeTeam, fixture.homeTeam);
  const resolvedAwayTeam = preferGreekEntityName(awayTeam, fixture.awayTeam);
  const hasModelGreekTeamNames = containsGreek(homeTeam) || containsGreek(awayTeam);

  if (!hasModelGreekTeamNames && (!loosyMatch(homeTeam, fixture.homeTeam) || !loosyMatch(awayTeam, fixture.awayTeam))) {
    logger.warn(
      `[validator] team name mismatch: model="${homeTeam} vs ${awayTeam}", fixture="${fixture.homeTeam} vs ${fixture.awayTeam}" — correcting`
    );
  }

  const bestBettingMarket = String(obj['bestBettingMarket']).trim();
  const finalPick = canonicalizeFinalPick(
    bestBettingMarket,
    String(obj['finalPick']).trim(),
    matchData,
    resolvedHomeTeam,
    resolvedAwayTeam,
  );

  return {
    event: String(obj['event']).trim(),
    competition: String(obj['competition']).trim(),
    date: String(obj['date']).trim(),
    homeTeam: resolvedHomeTeam,
    awayTeam: resolvedAwayTeam,
    keyFacts: (obj['keyFacts'] as unknown[]).map(String).filter(Boolean),
    riskFactors: (obj['riskFactors'] as unknown[]).map(String).filter(Boolean),
    bestBettingMarket,
    finalPick,
    confidence: Number(obj['confidence']),
    shortReasoning: String(obj['shortReasoning']).trim(),
    dataQualityNote: String(obj['dataQualityNote']).trim(),
    isPickRecommended: Boolean(obj['isPickRecommended']),
    noPickReason: typeof obj['noPickReason'] === 'string' ? obj['noPickReason'] : undefined,
  };
}

function extractPickLine(finalPick: string): number | null {
  const match = /(\d+(?:\.\d+)?)/.exec(finalPick);
  return match ? parseFloat(match[1]!) : null;
}

function formatPickLine(line: number): string {
  return Number.isInteger(line) ? line.toFixed(0) : line.toString();
}

function canonicalizeFinalPick(
  market: string,
  rawFinalPick: string,
  matchData: MatchData,
  homeTeamLabel: string,
  awayTeamLabel: string,
): string {
  const trimmed = rawFinalPick.trim();
  if (!trimmed) return trimmed;

  switch (market) {
    case 'h2h/home':
      return matchData.fixture.competition === 'football'
        ? 'Άσσος'
        : `Νίκη ${homeTeamLabel}`;
    case 'h2h/draw':
      return 'Ισοπαλία';
    case 'h2h/away':
      return matchData.fixture.competition === 'football'
        ? 'Διπλό'
        : `Νίκη ${awayTeamLabel}`;
    case 'btts/yes':
      return 'G/G';
    case 'btts/no':
      return 'NG';
    case 'totals/over': {
      const line = extractPickLine(trimmed)
        ?? matchData.availableOdds?.totalsLine
        ?? (matchData.fixture.competition === 'football' ? 2.5 : null);
      return line === null ? trimmed : `Over ${formatPickLine(line)}`;
    }
    case 'totals/under': {
      const line = extractPickLine(trimmed)
        ?? matchData.availableOdds?.totalsLine
        ?? (matchData.fixture.competition === 'football' ? 2.5 : null);
      return line === null ? trimmed : `Under ${formatPickLine(line)}`;
    }
    default:
      return trimmed;
  }
}

/** Case-insensitive partial match for team name validation */
function loosyMatch(a: string, b: string): boolean {
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalize(a).includes(normalize(b).slice(0, 5)) ||
    normalize(b).includes(normalize(a).slice(0, 5));
}
