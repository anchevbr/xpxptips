import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';
import { runFullAnalysisPipeline } from '../ai-analysis';
import { analyzeMatch } from '../ai-analysis/expert';
import { fetchTodayFixtures } from '../sports/fixtures';
import { enrichFixture } from '../sports/enrichment';
import { loadFixtures, saveFixtures } from '../utils/checkpoint';
import type { BettingAnalysis, Fixture, PickRecord } from '../types';

const CHECKPOINT_BASE = path.resolve('./data/checkpoints');

function isBasketballFixture(fixture: Fixture): boolean {
  return fixture.competition !== 'football';
}

function buildPickRecord(targetDate: string, fixture: Fixture, analysis: BettingAnalysis): PickRecord {
  return {
    fixtureId: fixture.id,
    date: targetDate,
    league: fixture.league,
    homeTeam: fixture.homeTeam,
    awayTeam: fixture.awayTeam,
    postedAt: new Date().toISOString(),
    kickoffAt: fixture.date,
    preMatchReasoning: analysis.shortReasoning,
    tipMessageId: null,
    finalPick: analysis.finalPick,
    bestBettingMarket: analysis.bestBettingMarket,
    confidence: analysis.confidence,
    outcome: null,
    actualScore: null,
    resolvedAt: null,
    halfTimeNotifiedAt: null,
    halfTimeMessageId: null,
    fullTimeNotifiedAt: null,
    fullTimeMessageId: null,
  };
}

function filterFixtures(fixtures: Fixture[], sportFilter?: string): Fixture[] {
  if (!sportFilter) return fixtures;

  return fixtures.filter(fixture => {
    const bball = isBasketballFixture(fixture);
    if (sportFilter === 'football') return !bball;
    if (sportFilter === 'basketball') return bball;
    return true;
  });
}

export async function loadTestPick(
  targetDate: string,
  sportFilter: string | undefined,
  logPrefix: string
): Promise<PickRecord | null> {
  let fixtures = loadFixtures(targetDate);

  if (!fixtures) {
    logger.warn(
      `[${logPrefix}] fixtures checkpoint not found for ${targetDate} — fetching fixtures on demand`
    );

    try {
      fixtures = await fetchTodayFixtures(targetDate);
    } catch (err) {
      logger.error(`[${logPrefix}] failed to fetch fixtures for ${targetDate}: ${String(err)}`);
      return null;
    }

    if (fixtures.length > 0) {
      saveFixtures(targetDate, fixtures);
    }
  }

  if (fixtures.length === 0) {
    logger.error(`[${logPrefix}] no fixtures in checkpoint for ${targetDate}`);
    return null;
  }

  const eligibleFixtures = filterFixtures(fixtures, sportFilter);
  if (eligibleFixtures.length === 0) {
    logger.error(`[${logPrefix}] no ${sportFilter} fixtures found for ${targetDate}`);
    return null;
  }

  const analysisDir = path.join(CHECKPOINT_BASE, targetDate, 'analysis');
  if (fs.existsSync(analysisDir)) {
    let analysisFiles = fs.readdirSync(analysisDir).filter(f => f.endsWith('.json'));

    if (sportFilter) {
      const fixtureMap = Object.fromEntries(eligibleFixtures.map(f => [f.id, f]));
      analysisFiles = analysisFiles.filter(file => !!fixtureMap[file.replace('.json', '')]);
    }

    if (analysisFiles.length > 0) {
      const file = analysisFiles[Math.floor(Math.random() * analysisFiles.length)]!;
      const fixtureId = file.replace('.json', '');
      const { analysis } = JSON.parse(
        fs.readFileSync(path.join(analysisDir, file), 'utf-8')
      ) as { analysis: BettingAnalysis };

      const fixture = eligibleFixtures.find(f => f.id === fixtureId);
      if (fixture) return buildPickRecord(targetDate, fixture, analysis);
    }
  }

  logger.warn(
    `[${logPrefix}] no usable analysis checkpoint for ${targetDate} — generating a test pick on demand`
  );

  const gatedResults = await runFullAnalysisPipeline(eligibleFixtures, targetDate);
  if (gatedResults.length > 0) {
    const best = gatedResults[0]!;
    logger.info(
      `[${logPrefix}] using gate-passing on-demand pick: ` +
      `${best.matchData.fixture.homeTeam} vs ${best.matchData.fixture.awayTeam} (${best.analysis.finalPick})`
    );
    return buildPickRecord(targetDate, best.matchData.fixture, best.analysis);
  }

  logger.warn(`[${logPrefix}] no gate-passing pick found — trying ungated on-demand analysis`);

  for (const fixture of eligibleFixtures) {
    logger.info(`[${logPrefix}] ungated analysis attempt: ${fixture.homeTeam} vs ${fixture.awayTeam}`);

    const matchData = await enrichFixture(fixture);
    const analysis = await analyzeMatch(matchData);

    if (analysis?.isPickRecommended) {
      logger.info(
        `[${logPrefix}] using ungated on-demand pick: ${fixture.homeTeam} vs ${fixture.awayTeam} (${analysis.finalPick})`
      );
      return buildPickRecord(targetDate, fixture, analysis);
    }
  }

  logger.error(`[${logPrefix}] no pick could be generated for ${targetDate}`);
  return null;
}