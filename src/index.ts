import 'dotenv/config';
import { config } from './config';
import { logger } from './utils/logger';
import { launchBot } from './bot/telegram';
import { startScheduler } from './scheduler';

async function main(): Promise<void> {
  logger.info('── AI Betting Bot starting ──────────────────────────────');
  logger.info(`  Model    : ${config.openai.model}`);
  logger.info(
    `  Schedule : ${config.scheduler.planningCron} (${config.scheduler.timezone}), ` +
    `analyze and send ${config.scheduler.analysisHoursBeforeKickoff}h before kickoff`
  );
  logger.info(`  Spend    : ${config.scheduler.dailySpendCron} (${config.scheduler.timezone})`);
  logger.info(`  Group    : ${config.telegram.groupChatId}`);
  logger.info('─────────────────────────────────────────────────────────');

  // Start the Telegram bot (long-polling)
  launchBot();

  // Register the daily scheduler
  startScheduler();

  logger.info('[main] bot is live and scheduler is active');
}

main().catch((err) => {
  logger.error(`[main] fatal error: ${String(err)}`);
  process.exit(1);
});
