import fs from 'fs';
import path from 'path';

const SUBSCRIBERS_PATH = path.resolve('./data/telegram-log-subscribers.json');

type SubscriberStore = {
  chatIds: string[];
};

function readStore(): SubscriberStore {
  try {
    if (!fs.existsSync(SUBSCRIBERS_PATH)) {
      return { chatIds: [] };
    }

    const raw = JSON.parse(fs.readFileSync(SUBSCRIBERS_PATH, 'utf-8')) as Partial<SubscriberStore>;
    return {
      chatIds: Array.isArray(raw.chatIds)
        ? raw.chatIds.filter((chatId): chatId is string => typeof chatId === 'string' && chatId.trim().length > 0)
        : [],
    };
  } catch {
    return { chatIds: [] };
  }
}

function writeStore(chatIds: string[]): void {
  const dir = path.dirname(SUBSCRIBERS_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(SUBSCRIBERS_PATH, JSON.stringify({ chatIds }, null, 2), 'utf-8');
}

export function getTelegramLogSubscriberIds(): string[] {
  return readStore().chatIds;
}

export function isTelegramLogSubscriber(chatId: string): boolean {
  return getTelegramLogSubscriberIds().includes(chatId);
}

export function addTelegramLogSubscriber(chatId: string): boolean {
  const normalized = chatId.trim();
  if (!normalized) return false;

  const chatIds = getTelegramLogSubscriberIds();
  if (chatIds.includes(normalized)) {
    return false;
  }

  chatIds.push(normalized);
  writeStore(chatIds);
  return true;
}

export function removeTelegramLogSubscriber(chatId: string): boolean {
  const normalized = chatId.trim();
  if (!normalized) return false;

  const chatIds = getTelegramLogSubscriberIds();
  const next = chatIds.filter(current => current !== normalized);
  if (next.length === chatIds.length) {
    return false;
  }

  writeStore(next);
  return true;
}