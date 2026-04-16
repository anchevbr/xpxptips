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
import { prewarmApiSportsBinding } from '../sports/providers/api-sports-live';
import { logger } from '../utils/logger';
import type { AnalysisResult } from '../ai-analysis';
import type { PickRecord } from '../types';

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
  const postedAt = new Date().toISOString();

  try {
    const tipMessageId = await sendToGroup(formatted.text);
    markPosted(matchData.fixture.id, date, matchData.fixture.competition);

    const savedPick: PickRecord = {
      fixtureId: matchData.fixture.id,
      date,
      league: matchData.fixture.league,
      homeTeam: matchData.fixture.homeTeam,
      awayTeam: matchData.fixture.awayTeam,
      postedAt,
      kickoffAt: matchData.fixture.date,
      liveDataProvider: matchData.fixture.liveDataProvider ?? null,
      liveDataFixtureId: matchData.fixture.liveDataFixtureId ?? null,
      preMatchReasoning: analysis.shortReasoning,
      tipMessageId,
      finalPick: analysis.finalPick,
      bestBettingMarket: analysis.bestBettingMarket,
      confidence: analysis.confidence,
      outcome: null as null,
      actualScore: null as null,
      resolvedAt: null as null,
      halfTimeNotifiedAt: null as null,
      halfTimeMessageId: null as null,
      fullTimeNotifiedAt: null as null,
      fullTimeMessageId: null as null,
    };

    // Persist to picks-log for weekly/monthly reports
    addPick(savedPick);

    // Best-effort binding so live polling and result resolution can reuse the
    // provider's native fixture id even if it was missing on the original pick.
    if (!savedPick.liveDataProvider || !savedPick.liveDataFixtureId) {
      try {
        const binding = await prewarmApiSportsBinding(savedPick);
        if (binding) {
          savedPick.liveDataProvider = binding.provider;
          savedPick.liveDataFixtureId = binding.liveDataFixtureId;
          logger.info(
            `[publisher] live-data binding: ${savedPick.fixtureId} -> ${binding.provider}:${binding.liveDataFixtureId}`
          );
        }
      } catch (err) {
        logger.warn(`[publisher] live-data binding failed for ${savedPick.fixtureId}: ${String(err)}`);
      }
    }

    // Schedule a halftime live-stats update for this fixture
    const kickoffMs = new Date(matchData.fixture.date).getTime();
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
