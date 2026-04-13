import { enrichFixture } from '../sports/enrichment';
import { screenFixtures } from './screener';
import { analyzeMatch } from './expert';
import { marketAvailable } from '../odds';
import { logger } from '../utils/logger';
import { config } from '../config';
import {
  saveScreeningResult,
  loadScreeningResult,
  saveAnalysis,
  loadAnalysis,
} from '../utils/checkpoint';
import type { Fixture, ScreeningResult, BettingAnalysis, MatchData } from '../types';

export type AnalysisResult = {
  matchData: MatchData;
  analysis: BettingAnalysis;
};

// ─── Publication gate ─────────────────────────────────────────────────────────
// A tip may only be published when ALL six conditions are met:
//   1. Fixture data is confirmed (fixture.status === 'scheduled')
//   2. Data quality passes threshold (not 'low')
//   3. The model recommends a pick (isPickRecommended === true)
//   4. Confidence passes the minimum threshold
//   5. The betting market exists in the connected odds source
//   6. The fixture has not already been posted today (checked in scheduler)

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
      matchData.fixture
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
 * Orchestrates the full two-phase pipeline:
 *   1. Fast screening  — scores all fixtures, selects best candidates
 *   2. Expert analysis — deep analysis on shortlisted fixtures only
 *   3. Six-gate publication check before accepting each result
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

  // ── Phase 1: Screen (with checkpoint resume) ──────────────────────────────
  const cachedScreening = fixtures.map((f) => loadScreeningResult(date, f.id));
  const uncachedFixtures = fixtures.filter((_, i) => cachedScreening[i] === null);

  const freshScreening: ScreeningResult[] =
    uncachedFixtures.length > 0 ? await screenFixtures(uncachedFixtures, date) : [];

  // Persist fresh results
  for (const r of freshScreening) saveScreeningResult(date, r);

  // Merge cached + fresh in original fixture order
  const screeningResults: ScreeningResult[] = fixtures.flatMap((f, i) => {
    const result = cachedScreening[i] ?? freshScreening.find((r) => r.fixture.id === f.id);
    return result ? [result] : [];
  });

  for (const r of screeningResults) {
    const fail = !r.shouldAnalyze
      ? 'shouldAnalyze=false'
      : r.interestScore < config.analysis.minInterestScore
        ? `score ${r.interestScore} < ${config.analysis.minInterestScore}`
        : r.dataQuality === 'low'
          ? 'dataQuality=low'
          : null;
    logger.info(
      `[pipeline] screen result: ${r.fixture.homeTeam} vs ${r.fixture.awayTeam}` +
      ` | score=${r.interestScore} | quality=${r.dataQuality} | shouldAnalyze=${r.shouldAnalyze}` +
      (fail ? ` | REJECTED: ${fail}` : ' | PASSED')
    );
  }

  const candidates = config.analysis.forceAnalysis
    ? screeningResults.slice(0, config.analysis.maxCandidatesFromScreening)
    : screeningResults
        .filter(
          (r) =>
            r.shouldAnalyze &&
            r.interestScore >= config.analysis.minInterestScore &&
            r.dataQuality !== 'low'
        )
        .slice(0, config.analysis.maxCandidatesFromScreening);

  if (config.analysis.forceAnalysis) {
    logger.warn('[pipeline] FORCE_ANALYSIS=true — screening gates bypassed, all fixtures sent to expert analysis');
  }

  logger.info(
    `[pipeline] screening: ${screeningResults.length} assessed, ${candidates.length} selected for deep analysis`
  );

  if (candidates.length === 0) {
    logger.info('[pipeline] no candidates passed screening threshold');
    return [];
  }

  // ── Phase 2: Enrich → Expert analysis → Publication gate ─────────────────
  const results: AnalysisResult[] = [];

  for (const candidate of candidates) {
    try {
      logger.info(
        `[pipeline] enriching ${candidate.fixture.homeTeam} vs ${candidate.fixture.awayTeam} (score: ${candidate.interestScore})`
      );

      const matchData = await enrichFixture(candidate.fixture);

      // Reject stale/low-quality data before spending expert reasoning tokens
      if (matchData.dataQuality === 'low') {
        logger.info(
          `[pipeline] skipping ${candidate.fixture.id} — data quality is low: ${matchData.dataQualityNotes.join('; ')}`
        );
        continue;
      }

      // Load cached analysis if available (avoids repeat OpenAI call on restart)
      let analysis: BettingAnalysis | null = loadAnalysis(date, candidate.fixture.id);
      if (analysis) {
        logger.info(`[pipeline] analysis loaded from checkpoint for ${candidate.fixture.id}`);
      } else {
        analysis = await analyzeMatch(matchData);
        if (!analysis) continue;
        saveAnalysis(date, candidate.fixture.id, analysis);
      }

      const gate = await passesPublicationGate(matchData, analysis);
      if (!gate.pass) {
        logger.info(`[pipeline] "${candidate.fixture.id}" blocked by publication gate: ${gate.reason}`);
        continue;
      }

      results.push({ matchData, analysis });
      logger.info(
        `[pipeline] pick approved: "${analysis.finalPick}" (confidence: ${analysis.confidence}/10)`
      );
    } catch (err) {
      logger.error(
        `[pipeline] failed to analyze ${candidate.fixture.homeTeam} vs ${candidate.fixture.awayTeam}: ${String(err)}`
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
