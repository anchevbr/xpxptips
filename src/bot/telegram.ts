// ─────────────────────────────────────────────────────────────────────────────
// telegram.ts
//
// Broadcast-only Telegram client.
// The bot never responds to users, answers commands, or behaves like an
// assistant. Its sole purpose is to post curated betting analysis to the group.
// ─────────────────────────────────────────────────────────────────────────────

import { Telegraf } from 'telegraf';
import { config } from '../config';
import { logger } from '../utils/logger';

let bot: Telegraf | null = null;

export function createBot(): Telegraf {
  if (bot) return bot;

  bot = new Telegraf(config.telegram.botToken);

  // Broadcast-only — no commands or conversational handlers registered.
  // Silently ignore any user messages so the bot does not reply to the group.

  // Error handler (logs only — no user-facing replies)
  bot.catch((err: unknown) => {
    logger.error(`[telegram] unhandled update error: ${String(err)}`);
  });

  logger.info('[telegram] broadcast-only bot configured');
  return bot;
}

/**
 * Sends a message to the configured group chat.
 * Uses HTML parse mode to render formatting.
 */
export async function sendToGroup(text: string): Promise<void> {
  const b = createBot();
  try {
    await b.telegram.sendMessage(config.telegram.groupChatId, text, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  } catch (err) {
    logger.error(`[telegram] sendToGroup failed: ${String(err)}`);
    throw err;
  }
}

/**
 * Sends a message to the configured group chat and pins it,
 * replacing whatever was previously pinned.
 */
export async function sendAndPinInGroup(text: string): Promise<void> {
  const b = createBot();
  try {
    const msg = await b.telegram.sendMessage(config.telegram.groupChatId, text, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
    await b.telegram.pinChatMessage(config.telegram.groupChatId, msg.message_id, {
      disable_notification: true,
    });
  } catch (err) {
    logger.error(`[telegram] sendAndPinInGroup failed: ${String(err)}`);
    throw err;
  }
}

/**
 * Starts the bot in long-polling mode (needed to keep the process alive and
 * receive the webhook / polling token) and handles graceful shutdown.
 */
export function launchBot(): void {
  const b = createBot();

  process.once('SIGINT', () => b.stop('SIGINT'));
  process.once('SIGTERM', () => b.stop('SIGTERM'));

  b.launch()
    .then(() => logger.info('[telegram] bot is live (broadcast-only mode)'))
    .catch((err) => logger.error(`[telegram] launch error: ${String(err)}`));
}

