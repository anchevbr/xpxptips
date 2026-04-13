// ─────────────────────────────────────────────────────────────────────────────
// fulltime/stats-fetcher.ts
//
// Re-exports shared fetch helpers from halftime, plus adds isFullTime().
// ─────────────────────────────────────────────────────────────────────────────

export {
  fetchLiveStatus,
  fetchEventStats,
  fetchEventLineup,
} from '../halftime/stats-fetcher';

export type {
  EventStat,
  LiveEventStatus,
  LineupPlayer,
} from '../halftime/stats-fetcher';

/**
 * Returns true when the status string indicates the match has fully concluded.
 * FT = Full Time (normal), AET = After Extra Time, Pen = decided by penalties.
 */
export function isFullTime(status: string): boolean {
  const s = status.toLowerCase().trim();
  return s === 'ft' || s === 'aet' || s === 'pen' || s === 'full time';
}

/**
 * Determines whether the pick won or lost based on the final score and market.
 * Parses the line from finalPick text (e.g. "Under 2.5" → 2.5).
 */
export function determineOutcome(
  market: string,
  finalPick: string,
  homeScore: number,
  awayScore: number
): 'win' | 'loss' | 'push' {
  const total = homeScore + awayScore;

  switch (market) {
    case 'h2h/home':
      return homeScore > awayScore ? 'win' : 'loss';
    case 'h2h/away':
      return awayScore > homeScore ? 'win' : 'loss';
    case 'h2h/draw':
      return homeScore === awayScore ? 'win' : 'loss';
    case 'btts/yes':
      return homeScore > 0 && awayScore > 0 ? 'win' : 'loss';
    case 'btts/no':
      return !(homeScore > 0 && awayScore > 0) ? 'win' : 'loss';
    case 'totals/over': {
      const m = /(\d+(?:\.\d+)?)/.exec(finalPick);
      const line = m ? parseFloat(m[1]!) : 2.5;
      if (total > line) return 'win';
      if (total < line) return 'loss';
      return 'push';
    }
    case 'totals/under': {
      const m = /(\d+(?:\.\d+)?)/.exec(finalPick);
      const line = m ? parseFloat(m[1]!) : 2.5;
      if (total < line) return 'win';
      if (total > line) return 'loss';
      return 'push';
    }
    default:
      return 'loss';
  }
}
