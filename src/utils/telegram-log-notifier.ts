import { Writable } from 'stream';
import winston from 'winston';
import { config } from '../config';
import { getTelegramLogSubscriberIds } from './telegram-log-subscribers';

type LogInfo = {
  level?: string;
  message?: unknown;
  stack?: string;
  timestamp?: string;
};

const LEVEL_PRIORITY = ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'];
const TELEGRAM_MESSAGE_LIMIT = 3500;
const MAX_BUFFERED_LINES = 200;

const IMPORTANT_INFO_PATTERNS = [
  /^\[main]/,
  /^\[telegram]/,
  /^\[scheduler]/,
  /^\[fixtures]/,
  /^\[pipeline]/,
  /^\[publisher]/,
  /^\[reports]/,
  /^\[checkpoint]/,
  /^\[halftime]/,
  /^\[fulltime]/,
];

const NOISY_INFO_PATTERNS = [
  /still running/i,
  /not FT yet/i,
  /not HT yet/i,
  /not yet finished/i,
  /quota:/i,
  /parseMarketString/i,
  /fetched odds:/i,
  /analysis loaded from checkpoint/i,
];

let queuedLines: string[] = [];
let droppedLineCount = 0;
let flushTimer: NodeJS.Timeout | null = null;
let isFlushing = false;

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function normalizeLevel(level: string | undefined): string {
  return stripAnsi((level ?? 'info').toLowerCase());
}

function normalizeMessage(message: unknown): string {
  if (typeof message === 'string') {
    return stripAnsi(message);
  }
  return stripAnsi(String(message ?? ''));
}

function currentRecipients(): string[] {
  const recipients = new Set<string>();

  if (config.telegram.logChatId.trim()) {
    recipients.add(config.telegram.logChatId.trim());
  }

  for (const chatId of getTelegramLogSubscriberIds()) {
    recipients.add(chatId);
  }

  return [...recipients];
}

function levelPassesThreshold(level: string): boolean {
  const configuredLevel = normalizeLevel(config.telegram.logLevel);
  const incomingIndex = LEVEL_PRIORITY.indexOf(level);
  const configuredIndex = LEVEL_PRIORITY.indexOf(configuredLevel);

  if (incomingIndex === -1 || configuredIndex === -1) {
    return level === 'error' || level === 'warn';
  }

  return incomingIndex <= configuredIndex;
}

function shouldForward(info: LogInfo): boolean {
  if (currentRecipients().length === 0) {
    return false;
  }

  const level = normalizeLevel(info.level);
  const message = normalizeMessage(info.message);
  if (!message || !levelPassesThreshold(level)) {
    return false;
  }

  if (level === 'info') {
    return IMPORTANT_INFO_PATTERNS.some(pattern => pattern.test(message))
      && !NOISY_INFO_PATTERNS.some(pattern => pattern.test(message));
  }

  return true;
}

function formatLine(info: LogInfo): string {
  const timestamp = typeof info.timestamp === 'string'
    ? info.timestamp
    : new Date().toISOString().replace('T', ' ').slice(0, 19);
  const level = normalizeLevel(info.level).toUpperCase();
  const message = normalizeMessage(info.message);
  const stack = typeof info.stack === 'string' ? stripAnsi(info.stack) : '';

  let text = `[${timestamp}] ${level}: ${message}`;
  if (stack && !stack.includes(message)) {
    text += `\n${stack}`;
  }

  if (text.length > 1200) {
    text = `${text.slice(0, 1197)}...`;
  }

  return text;
}

function scheduleFlush(): void {
  if (flushTimer || isFlushing) return;

  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushQueuedLogs();
  }, Math.max(1_000, config.telegram.logBatchMs));

  flushTimer.unref?.();
}

function takeBatch(): string | null {
  if (queuedLines.length === 0 && droppedLineCount === 0) {
    return null;
  }

  const parts: string[] = [];
  let length = 0;

  if (droppedLineCount > 0) {
    const notice = `[log-forwarder] ${droppedLineCount} older log line(s) were dropped due to buffer pressure`;
    parts.push(notice);
    length += notice.length;
    droppedLineCount = 0;
  }

  while (queuedLines.length > 0) {
    const next = queuedLines[0]!;
    const extra = parts.length > 0 ? 2 : 0;
    if (parts.length > 0 && length + extra + next.length > TELEGRAM_MESSAGE_LIMIT) {
      break;
    }

    queuedLines.shift();
    parts.push(next);
    length += next.length + extra;
  }

  return parts.join('\n\n');
}

async function sendTelegramBatch(chatId: string, text: string): Promise<void> {
  const url = `https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: `<pre>${escapeHtml(text)}</pre>`,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram sendMessage failed with HTTP ${response.status}: ${body}`);
  }
}

async function flushQueuedLogs(): Promise<void> {
  if (isFlushing) return;
  isFlushing = true;

  try {
    const recipients = currentRecipients();
    if (recipients.length === 0) {
      queuedLines = [];
      droppedLineCount = 0;
      return;
    }

    while (true) {
      const batch = takeBatch();
      if (!batch) break;

      const results = await Promise.allSettled(
        recipients.map(chatId => sendTelegramBatch(chatId, batch)),
      );

      for (const result of results) {
        if (result.status === 'rejected') {
          console.error(`[telegram-log-notifier] ${String(result.reason)}`);
        }
      }
    }
  } finally {
    isFlushing = false;
    if (queuedLines.length > 0) {
      scheduleFlush();
    }
  }
}

function enqueueLog(info: LogInfo): void {
  if (!shouldForward(info)) {
    return;
  }

  queuedLines.push(formatLine(info));
  if (queuedLines.length > MAX_BUFFERED_LINES) {
    const overflow = queuedLines.length - MAX_BUFFERED_LINES;
    queuedLines.splice(0, overflow);
    droppedLineCount += overflow;
  }

  scheduleFlush();
}

export function createTelegramLogTransport(): winston.transport {
  const stream = new Writable({
    objectMode: true,
    write(chunk, _encoding, callback) {
      enqueueLog(chunk as LogInfo);
      callback();
    },
  });

  return new winston.transports.Stream({
    stream,
  });
}