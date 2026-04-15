import type { PickRecord } from '../types';

export type HalftimeTipState = 'won' | 'lost' | 'on-track' | 'under-pressure';

function extractLine(finalPick: string): number | null {
  const match = /(\d+(?:\.\d+)?)/.exec(finalPick);
  return match ? parseFloat(match[1]!) : null;
}

export function assessHalftimeTipState(
  pick: PickRecord,
  homeScore: number | null,
  awayScore: number | null
): HalftimeTipState {
  if (homeScore === null || awayScore === null) {
    return 'under-pressure';
  }

  const total = homeScore + awayScore;
  const line = extractLine(pick.finalPick);

  switch (pick.bestBettingMarket) {
    case 'h2h/home':
      return homeScore > awayScore ? 'on-track' : 'under-pressure';
    case 'h2h/away':
      return awayScore > homeScore ? 'on-track' : 'under-pressure';
    case 'h2h/draw':
      return homeScore === awayScore ? 'on-track' : 'under-pressure';
    case 'btts/yes':
      if (homeScore > 0 && awayScore > 0) return 'won';
      if (homeScore > 0 || awayScore > 0) return 'on-track';
      return 'under-pressure';
    case 'btts/no':
      return homeScore > 0 && awayScore > 0 ? 'lost' : 'on-track';
    case 'totals/over':
      if (line === null) return 'under-pressure';
      if (total > line) return 'won';
      return line - total <= 1 ? 'on-track' : 'under-pressure';
    case 'totals/under':
      if (line === null) return 'under-pressure';
      if (total > line) return 'lost';
      return line - total <= 0.5 ? 'under-pressure' : 'on-track';
    default:
      return 'under-pressure';
  }
}

export function halftimeStatusLabel(state: HalftimeTipState): string {
  switch (state) {
    case 'won':
      return 'Έχει ήδη επιβεβαιωθεί';
    case 'lost':
      return 'Έχει ήδη χαθεί';
    case 'on-track':
      return 'Είναι σε καλό δρόμο';
    default:
      return 'Είναι σε κίνδυνο';
  }
}