import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';

// ─── Persistent JSON dedup store ──────────────────────────────────────────────
// Structure: { "YYYY-MM-DD": { "fixtureId": "competition" } }

type DedupStore = Record<string, Record<string, string>>;

const storePath = config.db.path.replace(/\.db$/, '.json');

function readStore(): DedupStore {
  try {
    const dir = path.dirname(storePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(storePath)) return {};
    return JSON.parse(fs.readFileSync(storePath, 'utf-8')) as DedupStore;
  } catch (err) {
    logger.warn(`[dedup] could not read store: ${String(err)}`);
    return {};
  }
}

function writeStore(store: DedupStore): void {
  try {
    const dir = path.dirname(storePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(storePath, JSON.stringify(store, null, 2), 'utf-8');
  } catch (err) {
    logger.warn(`[dedup] could not write store: ${String(err)}`);
  }
}

/**
 * Returns true if a tip for this fixture has already been posted today.
 */
export function alreadyPosted(fixtureId: string, date: string): boolean {
  const store = readStore();
  return !!(store[date] && store[date][fixtureId]);
}

/**
 * Records that a tip for this fixture was posted today.
 */
export function markPosted(fixtureId: string, date: string, competition: string): void {
  const store = readStore();
  if (!store[date]) store[date] = {};
  store[date][fixtureId] = competition;
  writeStore(store);
}

