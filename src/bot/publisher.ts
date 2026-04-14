// ─────────────────────────────────────────────────────────────────────────────
// publisher.ts
//
// Responsible for sending formatted posts to the Telegram group.
// The bot is broadcast-only: it does not respond to users, process commands,
// or engage in conversation. It acts as a premium betting-analysis feed.
// ─────────────────────────────────────────────────────────────────────────────

import { sendToGroup } from './telegram';
import { formatTip } from './formatter';
import { markPosted } from '../scheduler/dedup';
import { addPick } from '../reports/picks-store';
import { scheduleHalftimeWatch } from '../halftime';
import { scheduleFulltimeWatch } from '../fulltime';
import { logger, picksLogger } from '../utils/logger';
import { sleep } from '../utils/retry';
import type { AnalysisResult } from '../ai-analysis';

const POST_DELAY_MS = 1_500; // pause between messages to avoid Telegram rate limits

/**
 * Publishes a single approved tip to the Telegram group.
 * Used by the per-fixture scheduler to post each tip independently.
 */
export async function publishSingleResult(
  result: AnalysisResult,
  date: string
): Promise<void> {
  const { analysis, matchData } = result;
  const formatted = await formatTip(analysis, matchData.fixture);

  try {
    await sendToGroup(formatted.text);
    markPosted(matchData.fixture.id, date, matchData.fixture.competition);

    // Persist to picks-log for weekly/monthly reports
    addPick({
      fixtureId: matchData.fixture.id,
      date,
      league: matchData.fixture.league,
      homeTeam: matchData.fixture.homeTeam,
      awayTeam: matchData.fixture.awayTeam,
      postedAt: new Date().toISOString(),
      finalPick: analysis.finalPick,
      bestBettingMarket: analysis.bestBettingMarket,
      confidence: analysis.confidence,
      outcome: null,
      actualScore: null,
      resolvedAt: null,
      halfTimeNotifiedAt: null,
      fullTimeNotifiedAt: null,
    });

    // Schedule a halftime live-stats update for this fixture
    const kickoffMs = new Date(matchData.fixture.date).getTime();
    const savedPick = {
      fixtureId: matchData.fixture.id,
      date,
      league: matchData.fixture.league,
      homeTeam: matchData.fixture.homeTeam,
      awayTeam: matchData.fixture.awayTeam,
      postedAt: new Date().toISOString(),
      finalPick: analysis.finalPick,
      bestBettingMarket: analysis.bestBettingMarket,
      confidence: analysis.confidence,
      outcome: null as null,
      actualScore: null as null,
      resolvedAt: null as null,
      halfTimeNotifiedAt: null as null,
      fullTimeNotifiedAt: null as null,
    };
    scheduleHalftimeWatch(savedPick, kickoffMs);
    scheduleFulltimeWatch(savedPick, kickoffMs);

    logger.info(
      `[publisher] posted: ${matchData.fixture.homeTeam} vs ${matchData.fixture.awayTeam} (${analysis.confidence}/10)`
    );
  } catch (err) {
    logger.error(
      `[publisher] failed to post ${matchData.fixture.id}: ${String(err)}`
    );
    throw err;
  }
}
