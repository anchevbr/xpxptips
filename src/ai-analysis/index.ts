import { enrichFixture } from '../sports/enrichment';
import { analyzeMatch } from './expert';
import { marketAvailable } from '../odds';
import { logger } from '../utils/logger';
import { config } from '../config';
import {
  saveAnalysis,
  loadAnalysis,
} from '../utils/checkpoint';
import type { Fixture, BettingAnalysis, MatchData } from '../types';

export type AnalysisResult = {
  matchData: MatchData;
  analysis: BettingAnalysis;
};

// ─── Publication gate ─────────────────────────────────────────────────────────
// A tip may only be published when ALL five conditions are met:
//   1. Fixture data is confirmed (fixture.status === 'scheduled')
//   2. Data quality passes threshold (not 'low')
//   3. The model recommends a pick (isPickRecommended === true)
//   4. Confidence passes the minimum threshold
//   5. The betting market exists in the connected odds source
// The already-posted check is handled separately in the scheduler.

async function passesPublicationGate(
  matchData: MatchData,
  analysis: BettingAnalysis
): Promise<{ pass: boolean; reason?: string }> {
  // Gate 1 — fixture confirmed (bypassed in FORCE_ANALYSIS mode for past-date testing)
  if (!config.analysis.forceAnalysis && matchData.fixture.status !== 'scheduled') {
    return { pass: false, reason: `fixture status is "${matchData.fixture.status}", not scheduled` };
  }

  // Gate 2 — data quality
  if (matchData.dataQuality === 'low') {
    return { pass: false, reason: `data quality is low: ${matchData.dataQualityNotes.join('; ')}` };
  }

  // Gate 3 — model recommends a pick
  if (!analysis.isPickRecommended) {
    return { pass: false, reason: analysis.noPickReason ?? 'model returned no_pick' };
  }

  // Gate 4 — confidence threshold
  if (analysis.confidence < config.analysis.minConfidenceToPublish) {
    return {
      pass: false,
      reason: `confidence ${analysis.confidence}/10 below threshold ${config.analysis.minConfidenceToPublish}`,
    };
  }

  // Gate 5 — odds market exists (skipped in FORCE_ANALYSIS mode)
  if (!config.analysis.forceAnalysis) {
    const marketExists = await marketAvailable(
      matchData.fixture.id,
      analysis.bestBettingMarket,
      matchData.fixture,
      analysis.finalPick,
    );
    if (!marketExists) {
      return {
        pass: false,
        reason: `market "${analysis.bestBettingMarket}" not available or odds below minimum ${config.analysis.minAcceptableOdds}`,
      };
    }
  }

  return { pass: true };
}

/**
 * Orchestrates the analysis pipeline:
 *   1. Enrich every supplied fixture with provider data and odds
 *   2. Run expert analysis for every fixture
 *   3. Apply the publication gate before accepting each result
 *
 * IMPORTANT: The model is never used to discover fixtures.
 * All fixture, injury, form, and schedule data must be collected from sports
 * data providers first and passed into the model as structured context.
 * The model acts only as analyst, synthesizer, and pick recommender.
 *
 * Returns only gate-passing results, sorted by confidence descending.
 */
export async function runFullAnalysisPipeline(
  fixtures: Fixture[],
  date: string
): Promise<AnalysisResult[]> {
  if (fixtures.length === 0) {
    logger.info('[pipeline] no fixtures supplied — skipping');
    return [];
  }

  logger.info(`[pipeline] starting for ${fixtures.length} fixtures on ${date}`);
  const results: AnalysisResult[] = [];

  logger.info(`[pipeline] sending all ${fixtures.length} fixture(s) to deep analysis`);

  for (const fixture of fixtures) {
    try {
      logger.info(`[pipeline] enriching ${fixture.homeTeam} vs ${fixture.awayTeam}`);

      const matchData = await enrichFixture(fixture);

      // Reject stale/low-quality data before spending expert reasoning tokens
      if (matchData.dataQuality === 'low') {
        logger.info(
          `[pipeline] skipping ${fixture.id} — data quality is low: ${matchData.dataQualityNotes.join('; ')}`
        );
        continue;
      }

      // Load cached analysis if available (avoids repeat OpenAI call on restart)
      let analysis: BettingAnalysis | null = loadAnalysis(date, fixture.id);
      if (analysis) {
        logger.info(`[pipeline] analysis loaded from checkpoint for ${fixture.id}`);
      } else {
        analysis = await analyzeMatch(matchData);
        if (!analysis) continue;
        saveAnalysis(date, fixture.id, analysis);
      }

      const gate = await passesPublicationGate(matchData, analysis);
      if (!gate.pass) {
        logger.info(`[pipeline] "${fixture.id}" blocked by publication gate: ${gate.reason}`);
        continue;
      }

      results.push({ matchData, analysis });
      logger.info(
        `[pipeline] pick approved: "${analysis.finalPick}" (confidence: ${analysis.confidence}/10)`
      );
    } catch (err) {
      logger.error(
        `[pipeline] failed to analyze ${fixture.homeTeam} vs ${fixture.awayTeam}: ${String(err)}`
      );
    }

    if (results.length >= config.analysis.maxTipsPerDay) {
      logger.info(`[pipeline] reached max tips per day (${config.analysis.maxTipsPerDay})`);
      break;
    }
  }

  results.sort((a, b) => b.analysis.confidence - a.analysis.confidence);

  logger.info(`[pipeline] done. ${results.length} tip(s) passed all publication gates`);
  return results;
}
