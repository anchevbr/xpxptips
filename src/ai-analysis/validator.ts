import { logger } from '../utils/logger';
import type { BettingAnalysis, Fixture } from '../types';

/**
 * Validates and sanitizes the raw object returned by the model before it
 * is treated as a BettingAnalysis. Returns null if the shape is invalid.
 */
export function validateAnalysis(
  raw: unknown,
  fixture: Fixture
): BettingAnalysis | null {
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

  if (
    !loosyMatch(homeTeam, fixture.homeTeam) ||
    !loosyMatch(awayTeam, fixture.awayTeam)
  ) {
    logger.warn(
      `[validator] team name mismatch: model="${homeTeam} vs ${awayTeam}", fixture="${fixture.homeTeam} vs ${fixture.awayTeam}" — correcting`
    );
  }

  return {
    event: String(obj['event']).trim(),
    competition: String(obj['competition']).trim(),
    date: String(obj['date']).trim(),
    homeTeam: fixture.homeTeam,  // always trust fixture source
    awayTeam: fixture.awayTeam,
    keyFacts: (obj['keyFacts'] as unknown[]).map(String).filter(Boolean),
    riskFactors: (obj['riskFactors'] as unknown[]).map(String).filter(Boolean),
    bestBettingMarket: String(obj['bestBettingMarket']).trim(),
    finalPick: String(obj['finalPick']).trim(),
    confidence: Number(obj['confidence']),
    shortReasoning: String(obj['shortReasoning']).trim(),
    dataQualityNote: String(obj['dataQualityNote']).trim(),
    isPickRecommended: Boolean(obj['isPickRecommended']),
    noPickReason: typeof obj['noPickReason'] === 'string' ? obj['noPickReason'] : undefined,
  };
}

/** Case-insensitive partial match for team name validation */
function loosyMatch(a: string, b: string): boolean {
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalize(a).includes(normalize(b).slice(0, 5)) ||
    normalize(b).includes(normalize(a).slice(0, 5));
}
