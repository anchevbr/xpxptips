import 'dotenv/config';
import { logger } from './utils/logger';
import { runPlanningJob } from './scheduler';

/**
 * Test runner — execute the full AI pipeline for a specific date.
 *
 * Usage:
 *   npm run test-runner 2026-04-16
 *   npm run test-runner
 *
 * Fetches fixtures, runs screening + expert analysis, and publishes picks to Telegram.
 * All published picks are logged to logs/picks.log for audit.
 */
async function main(): Promise<void> {
  const testDate = process.argv[2] ?? '2026-04-16';

  logger.info('');
  logger.info('═══════════════════════════════════════════════════════════════');
  logger.info('TEST RUNNER — Full AI Pipeline');
  logger.info('═══════════════════════════════════════════════════════════════');
  logger.info(`Testing date: ${testDate}`);
  logger.info(`Mode: LIVE (FORCE_ANALYSIS=${process.env.FORCE_ANALYSIS === 'true' ? 'true (bypasses gates)' : 'false (real validation)'})`);
  logger.info('');

  try {
    // Run the full pipeline for the given date
    await runPlanningJob(testDate);

    logger.info('');
    logger.info('═══════════════════════════════════════════════════════════════');
    logger.info('TEST RUNNER COMPLETE');
    logger.info('═══════════════════════════════════════════════════════════════');
    logger.info('Check logs/picks.log for published picks');
    logger.info('Check logs/combined.log for full execution trace');
    logger.info('');

    process.exit(0);
  } catch (err) {
    logger.error(`Test runner failed: ${String(err)}`);
    logger.error(err instanceof Error ? err.stack : '');
    process.exit(1);
  }
}

main();
