import { logger } from '../utils/logger';
import { enrichFromTheSportsDB, formatEnrichmentBlock } from './providers/thesportsdb-enrichment';
import { fetchOddsForFixture, getAverageOdds, getMostCommonTotalsLine } from './providers/odds-api';
import type { Fixture, MatchData, TeamStats, InjuryReport, ScheduleContext } from '../types';

const emptyStats = (team: string): TeamStats => ({
  team,
  lastFiveGames: [],
  homeRecord: { wins: 0, losses: 0 },
  awayRecord: { wins: 0, losses: 0 },
});

const emptyInjury = (team: string): InjuryReport => ({
  team,
  players: [],
  suspensions: [],
  lastUpdated: new Date().toISOString(),
});

const emptySchedule: ScheduleContext = {
  homeBackToBack: false,
  awayBackToBack: false,
};

export async function enrichFixture(fixture: Fixture): Promise<MatchData> {
  logger.info(`[enrichment] enriching ${fixture.homeTeam} vs ${fixture.awayTeam}`);

  // Fetch standings, recent form, and event stats from TheSportsDB if team IDs are available
  let structuredContext: string | undefined;
  if (fixture.homeTeamId || fixture.awayTeamId) {
    try {
      // Extract event ID from fixture.id (format: "sportsdb_12345")
      const eventId = fixture.id.startsWith('sportsdb_') 
        ? fixture.id.replace('sportsdb_', '') 
        : undefined;

      const enrichment = await enrichFromTheSportsDB(
        fixture.homeTeam,
        fixture.awayTeam,
        fixture.homeTeamId,
        fixture.awayTeamId,
        fixture.leagueId,
        eventId,
      );
      const block = formatEnrichmentBlock(fixture.homeTeam, fixture.awayTeam, enrichment);
      if (block.trim()) structuredContext = block;
    } catch (err) {
      logger.warn(`[enrichment] TheSportsDB enrichment failed: ${String(err)}`);
    }
  } else {
    logger.info(`[enrichment] no team IDs available for ${fixture.homeTeam} vs ${fixture.awayTeam} — skipping structured enrichment`);
  }

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

  const hasRealData = !!structuredContext;

  return {
    fixture,
    homeTeamStats: emptyStats(fixture.homeTeam),
    awayTeamStats: emptyStats(fixture.awayTeam),
    h2h: { totalGames: 0, homeTeamWins: 0, awayTeamWins: 0, draws: 0, lastFiveGames: [] },
    homeInjuries: emptyInjury(fixture.homeTeam),
    awayInjuries: emptyInjury(fixture.awayTeam),
    scheduleContext: emptySchedule,
    dataQuality: hasRealData ? 'high' : 'medium',
    dataQualityNotes: hasRealData
      ? ['Standings and recent form fetched from TheSportsDB']
      : ['No external enrichment source — expert model uses live web search context'],
    structuredContext,
    availableOdds,
  };
}
