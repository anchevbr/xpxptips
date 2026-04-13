import { logger } from '../utils/logger';
import { fetchFixturesViaTheSportsDB } from './providers/thesportsdb-fixtures';
import { config } from '../config';
import type { Fixture } from '../types';

/**
 * Returns fixtures for the given date.
 * In normal mode only returns status='scheduled'. In FORCE_ANALYSIS mode
 * returns all fixtures regardless of status (for past-date testing).
 */
export async function fetchTodayFixtures(date: string): Promise<Fixture[]> {
  logger.info(`[fixtures] fetching fixtures for ${date} via TheSportsDB`);

  let fixtures = await fetchFixturesViaTheSportsDB(date);

  // Optional test filters (set TEST_LEAGUE, TEST_LEAGUES, and/or TEST_MAX env vars)
  const testLeague = process.env.TEST_LEAGUE;
  const testLeagues = process.env.TEST_LEAGUES; // comma-separated: pick first per league
  const testMax = process.env.TEST_MAX ? parseInt(process.env.TEST_MAX, 10) : undefined;

  if (testLeagues) {
    const leagues = testLeagues.split(',').map((l) => l.trim().toLowerCase());
    const picked: Fixture[] = [];
    for (const pattern of leagues) {
      const match = fixtures.find((f) => f.league.toLowerCase().includes(pattern));
      if (match) picked.push(match);
    }
    fixtures = picked;
    logger.warn(`[fixtures] TEST_LEAGUES="${testLeagues}" — picked ${fixtures.length} fixture(s)`);
  } else if (testLeague) {
    fixtures = fixtures.filter((f) =>
      f.league.toLowerCase().includes(testLeague.toLowerCase())
    );
    logger.warn(`[fixtures] TEST_LEAGUE="${testLeague}" — filtered to ${fixtures.length} fixture(s)`);
  }

  if (testMax && testMax > 0) {
    fixtures = fixtures.slice(0, testMax);
    logger.warn(`[fixtures] TEST_MAX=${testMax} — capped to ${fixtures.length} fixture(s)`);
  }

  if (config.analysis.forceAnalysis) {
    logger.warn(`[fixtures] FORCE_ANALYSIS=true — returning all ${fixtures.length} fixture(s) regardless of status`);
    return fixtures;
  }

  const scheduled = fixtures.filter((f) => f.status === 'scheduled');
  logger.info(`[fixtures] total scheduled: ${scheduled.length}`);
  return scheduled;
}
