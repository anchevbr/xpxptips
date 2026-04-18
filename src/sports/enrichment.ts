import { buildCachedKnowledgeContext, recordEnrichmentSnapshot } from '../cache/event-intelligence';
import { logger } from '../utils/logger';
import { enrichFromApiSports } from './providers/api-sports-enrichment';
import { fetchOddsForFixture, getAverageOdds, getMostCommonTotalsLine } from './providers/odds-api';
import type { Fixture, MatchData, ScheduleContext } from '../types';

const emptySchedule: ScheduleContext = {
  homeBackToBack: false,
  awayBackToBack: false,
};

export async function enrichFixture(fixture: Fixture): Promise<MatchData> {
  logger.info(`[enrichment] enriching ${fixture.homeTeam} vs ${fixture.awayTeam}`);

  const providerEnrichment = await enrichFromApiSports(fixture);

  // Fetch real-time odds from The Odds API
  let availableOdds: MatchData['availableOdds'];
  try {
    const eventOdds = await fetchOddsForFixture(
      fixture.homeTeam,
      fixture.awayTeam,
      fixture.league,
      fixture.date
    );

    if (eventOdds) {
      const isSoccer = fixture.competition === 'football';
      const totalsLine = getMostCommonTotalsLine(eventOdds);

      const homeWin = getAverageOdds(eventOdds, 'h2h', fixture.homeTeam);
      const draw = isSoccer ? getAverageOdds(eventOdds, 'h2h', 'Draw') : null;
      const awayWin = getAverageOdds(eventOdds, 'h2h', fixture.awayTeam);
      const over25 = getAverageOdds(eventOdds, 'totals', 'Over', totalsLine);
      const under25 = getAverageOdds(eventOdds, 'totals', 'Under', totalsLine);
      const bttsYes = isSoccer ? getAverageOdds(eventOdds, 'btts', 'Yes') : null;
      const bttsNo = isSoccer ? getAverageOdds(eventOdds, 'btts', 'No') : null;

      availableOdds = {
        homeWin: homeWin ?? undefined,
        draw: draw ?? undefined,
        awayWin: awayWin ?? undefined,
        totalsLine,
        over25: over25 ?? undefined,
        under25: under25 ?? undefined,
        bttsYes: bttsYes ?? undefined,
        bttsNo: bttsNo ?? undefined,
        bookmakerCount: eventOdds.bookmakers.length,
      };

      const line = totalsLine ?? (isSoccer ? 2.5 : '?');
      logger.info(
        `[enrichment] odds: Home ${homeWin?.toFixed(2) ?? '-'} | ${isSoccer ? `Draw ${draw?.toFixed(2) ?? '-'} | ` : ''}Away ${awayWin?.toFixed(2) ?? '-'} | ` +
        `O${line} ${over25?.toFixed(2) ?? '-'} | U${line} ${under25?.toFixed(2) ?? '-'}${isSoccer ? ` | BTTS ${bttsYes?.toFixed(2) ?? '-'}` : ''}`
      );
    }
  } catch (err) {
    logger.warn(`[enrichment] failed to fetch odds: ${String(err)}`);
  }

  recordEnrichmentSnapshot(fixture, providerEnrichment.structuredContext, availableOdds);
  const cachedKnowledgeContext = buildCachedKnowledgeContext(fixture);

  return {
    fixture,
    homeTeamStats: providerEnrichment.homeTeamStats,
    awayTeamStats: providerEnrichment.awayTeamStats,
    h2h: providerEnrichment.h2h,
    homeInjuries: providerEnrichment.homeInjuries,
    awayInjuries: providerEnrichment.awayInjuries,
    scheduleContext: emptySchedule,
    dataQuality: providerEnrichment.dataQuality,
    dataQualityNotes: providerEnrichment.dataQualityNotes,
    structuredContext: providerEnrichment.structuredContext,
    cachedKnowledgeContext,
    availableOdds,
  };
}
