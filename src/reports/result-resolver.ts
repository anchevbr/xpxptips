// ─────────────────────────────────────────────────────────────────────────────
// result-resolver.ts
//
// Determines the outcome (win / loss / void) of a pick given the final score.
// Uses the bestBettingMarket enum token to know what to check.
// ─────────────────────────────────────────────────────────────────────────────

export type Outcome = 'win' | 'loss' | 'void';

/**
 * Extracts the numeric line from a finalPick string.
 * Examples: "Over 2.5" → 2.5, "Under 165.5" → 165.5, "Over 174" → 174
 */
function extractLine(finalPick: string): number | null {
  const match = /(\d+(?:\.\d+)?)/.exec(finalPick);
  return match ? parseFloat(match[1]!) : null;
}

/**
 * Resolves whether a pick won or lost.
 *
 * @param market     - bestBettingMarket token, e.g. "h2h/home", "totals/under"
 * @param finalPick  - human pick string, used to extract the totals line
 * @param homeScore
 * @param awayScore
 */
export function resolveOutcome(
  market: string,
  finalPick: string,
  homeScore: number,
  awayScore: number
): Outcome {
  const total = homeScore + awayScore;

  switch (market) {
    case 'h2h/home':
      return homeScore > awayScore ? 'win' : 'loss';

    case 'h2h/draw':
      return homeScore === awayScore ? 'win' : 'loss';

    case 'h2h/away':
      return awayScore > homeScore ? 'win' : 'loss';

    case 'totals/over': {
      const line = extractLine(finalPick);
      if (line === null) return 'void';
      if (total === line) return 'void'; // push
      return total > line ? 'win' : 'loss';
    }

    case 'totals/under': {
      const line = extractLine(finalPick);
      if (line === null) return 'void';
      if (total === line) return 'void'; // push
      return total < line ? 'win' : 'loss';
    }

    case 'btts/yes':
      return homeScore > 0 && awayScore > 0 ? 'win' : 'loss';

    case 'btts/no':
      return homeScore === 0 || awayScore === 0 ? 'win' : 'loss';

    default:
      return 'void';
  }
}

/**
 * Formats a score pair as a human-readable string, e.g. "2–1"
 */
export function formatScore(homeScore: number, awayScore: number): string {
  return `${homeScore}–${awayScore}`;
}
