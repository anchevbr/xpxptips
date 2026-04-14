import type { BettingAnalysis, FormattedTip, Competition, Fixture } from '../types';
import { formatAthensDateTime } from '../utils/date';
import { getFixtureOdds, extractBestOdds } from '../odds';
import { logger } from '../utils/logger';

const COMPETITION_EMOJI: Record<Competition, string> = {
  EuroLeague: '🏀',
  NBA: '🏀',
  football: '⚽',
  other: '🏆',
};

/**
 * Formats a BettingAnalysis into a clean, Greek-language Telegram post.
 * Uses HTML parse mode so bold/italic formatting renders properly.
 * Layout is designed for quick mobile reading in a Telegram group.
 */
export async function formatTip(
  analysis: BettingAnalysis,
  fixture: Fixture
): Promise<FormattedTip> {
  const emoji = COMPETITION_EMOJI[fixture.competition] ?? '🏆';
  const leagueLabel = fixture.league;
  const athensTime = formatAthensDateTime(fixture.date);

  const lines: string[] = [
    `${emoji} <b>${leagueLabel} | ${fixture.homeTeam} vs ${fixture.awayTeam}</b>`,
    ``,
    `🕐 <i>${athensTime}</i>`,
    ``,
    analysis.shortReasoning,
  ];

  lines.push('');
  lines.push(`📌 <b>Πρόταση:</b> ${analysis.finalPick}`);

  // Fetch and display actual odds
  try {
    logger.info(`[formatter] fetching odds for ${fixture.homeTeam} vs ${fixture.awayTeam}`);
    logger.info(`[formatter] finalPick: "${analysis.finalPick}"`);
    logger.info(`[formatter] bestBettingMarket: "${analysis.bestBettingMarket}"`);
    
    const eventOdds = await getFixtureOdds(fixture);
    if (eventOdds) {
      logger.info(`[formatter] got odds data with ${eventOdds.bookmakers.length} bookmakers`);
      const bestOdds = extractBestOdds(eventOdds, analysis.bestBettingMarket, fixture, analysis.finalPick);
      
      if (bestOdds) {
        logger.info(`[formatter] extracted best odds: ${bestOdds.toFixed(2)} for market "${analysis.bestBettingMarket}"`);
        lines.push(`💰 <b>Απόδοση:</b> ${bestOdds.toFixed(2)}`);
      } else {
        logger.warn(`[formatter] no odds found for market "${analysis.bestBettingMarket}"`);
      }
    } else {
      logger.warn(`[formatter] no event odds returned`);
    }
  } catch (err) {
    logger.warn(`[formatter] failed to fetch odds for ${fixture.id}: ${String(err)}`);
  }

  return {
    competition: fixture.competition,
    text: lines.join('\n'),
    confidence: analysis.confidence,
    fixtureId: fixture.id,
    fixture,
  };
}

