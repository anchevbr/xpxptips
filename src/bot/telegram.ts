// ─────────────────────────────────────────────────────────────────────────────
// telegram.ts
//
// Telegram client for broadcast posting plus private operator log subscription.
// Group chats remain broadcast-only. Private /start and /logs commands are used
// only to opt a personal chat in or out of runtime log delivery.
// ─────────────────────────────────────────────────────────────────────────────

import { Telegraf } from 'telegraf';
import { config } from '../config';
import {
  addTelegramLogSubscriber,
  getTelegramLogSubscriberIds,
  isTelegramLogSubscriber,
  removeTelegramLogSubscriber,
} from '../utils/telegram-log-subscribers';
import { logger } from '../utils/logger';

let bot: Telegraf | null = null;

type SendToGroupOptions = {
  replyToMessageId?: number;
};

function operatorChatIds(): string[] {
  const recipients = new Set<string>();

  if (config.telegram.logChatId.trim()) {
    recipients.add(config.telegram.logChatId.trim());
  }

  for (const chatId of getTelegramLogSubscriberIds()) {
    recipients.add(chatId);
  }

  return [...recipients];
}

export function createBot(): Telegraf {
  if (bot) return bot;

  bot = new Telegraf(config.telegram.botToken);

  bot.start(async (ctx) => {
    if (ctx.chat.type !== 'private') return;

    addTelegramLogSubscriber(String(ctx.chat.id));
    await ctx.reply(
      'Personal runtime logs were enabled for this chat.\n' +
      'Use /logs status to check status and /logs off to stop them.',
      { link_preview_options: { is_disabled: true } },
    );
  });

  bot.command('logs', async (ctx) => {
    if (ctx.chat.type !== 'private') return;

    const text = 'text' in ctx.message ? ctx.message.text : '/logs';
    const action = text.split(/\s+/)[1]?.toLowerCase() ?? 'status';
    const chatId = String(ctx.chat.id);

    if (action === 'on' || action === 'start') {
      const added = addTelegramLogSubscriber(chatId);
      await ctx.reply(
        added
          ? 'This private chat is now subscribed to runtime logs.'
          : 'This private chat is already subscribed to runtime logs.',
        { link_preview_options: { is_disabled: true } },
      );
      return;
    }

    if (action === 'off' || action === 'stop') {
      const removed = removeTelegramLogSubscriber(chatId);
      await ctx.reply(
        removed
          ? 'Runtime log delivery was disabled for this chat.'
          : 'This private chat was not subscribed to runtime logs.',
        { link_preview_options: { is_disabled: true } },
      );
      return;
    }

    await ctx.reply(
      isTelegramLogSubscriber(chatId)
        ? 'This private chat is subscribed to runtime logs.'
        : 'This private chat is not subscribed. Use /logs on to enable it.',
      { link_preview_options: { is_disabled: true } },
    );
  });

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
export async function sendToGroup(text: string, options: SendToGroupOptions = {}): Promise<number> {
  const b = createBot();
  try {
    const sendOptions: Parameters<typeof b.telegram.sendMessage>[2] & {
      reply_to_message_id?: number;
      allow_sending_without_reply?: boolean;
    } = {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    };

    if (options.replyToMessageId) {
      sendOptions.reply_to_message_id = options.replyToMessageId;
      sendOptions.allow_sending_without_reply = true;
    }

    const msg = await b.telegram.sendMessage(config.telegram.groupChatId, text, sendOptions);
    return msg.message_id;
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

export async function sendToOperatorChats(text: string): Promise<number> {
  const b = createBot();
  const recipients = operatorChatIds();

  if (recipients.length === 0) {
    return 0;
  }

  const results = await Promise.allSettled(
    recipients.map(chatId =>
      b.telegram.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      })
    )
  );

  let delivered = 0;
  for (const result of results) {
    if (result.status === 'fulfilled') {
      delivered += 1;
      continue;
    }

    logger.error(`[telegram] sendToOperatorChats failed: ${String(result.reason)}`);
  }

  return delivered;
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

