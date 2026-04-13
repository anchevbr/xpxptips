// ─────────────────────────────────────────────────────────────────────────────
// picks-store.ts
//
// Persists every published tip to data/picks-log.json so the weekly/monthly
// report job can look back and calculate results.
//
// Structure: array of PickRecord — one entry per published tip.
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';
import type { PickRecord } from '../types';

const PICKS_LOG = path.resolve('./data/picks-log.json');

function readPicks(): PickRecord[] {
  try {
    if (!fs.existsSync(PICKS_LOG)) return [];
    return JSON.parse(fs.readFileSync(PICKS_LOG, 'utf-8')) as PickRecord[];
  } catch (err) {
    logger.warn(`[picks-store] could not read picks log: ${String(err)}`);
    return [];
  }
}

function writePicks(picks: PickRecord[]): void {
  try {
    const dir = path.dirname(PICKS_LOG);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PICKS_LOG, JSON.stringify(picks, null, 2), 'utf-8');
  } catch (err) {
    logger.warn(`[picks-store] could not write picks log: ${String(err)}`);
  }
}

/**
 * Saves a new pick record. If a record with the same fixtureId already exists,
 * it is replaced (idempotent — safe to call on retry).
 */
export function addPick(record: PickRecord): void {
  const picks = readPicks();
  const idx = picks.findIndex(p => p.fixtureId === record.fixtureId);
  if (idx >= 0) {
    picks[idx] = record;
  } else {
    picks.push(record);
  }
  writePicks(picks);
  logger.info(`[picks-store] saved pick: ${record.homeTeam} vs ${record.awayTeam} (${record.finalPick})`);
}

/**
 * Updates the outcome of a previously saved pick after the match is played.
 */
export function updateOutcome(
  fixtureId: string,
  outcome: 'win' | 'loss' | 'void',
  actualScore: string
): void {
  const picks = readPicks();
  const idx = picks.findIndex(p => p.fixtureId === fixtureId);
  if (idx < 0) {
    logger.warn(`[picks-store] cannot update outcome — not found: ${fixtureId}`);
    return;
  }
  picks[idx]!.outcome = outcome;
  picks[idx]!.actualScore = actualScore;
  picks[idx]!.resolvedAt = new Date().toISOString();
  writePicks(picks);
}

/**
 * Marks a pick as having received its halftime Telegram update.
 */
export function updateHalftimeNotified(fixtureId: string): void {
  const picks = readPicks();
  const idx = picks.findIndex(p => p.fixtureId === fixtureId);
  if (idx < 0) {
    logger.warn(`[picks-store] cannot mark halftime — not found: ${fixtureId}`);
    return;
  }
  picks[idx]!.halfTimeNotifiedAt = new Date().toISOString();
  writePicks(picks);
}

/**
 * Marks a pick as having received its full-time Telegram update.
 */
export function updateFulltimeNotified(fixtureId: string): void {
  const picks = readPicks();
  const idx = picks.findIndex(p => p.fixtureId === fixtureId);
  if (idx < 0) {
    logger.warn(`[picks-store] cannot mark fulltime — not found: ${fixtureId}`);
    return;
  }
  picks[idx]!.fullTimeNotifiedAt = new Date().toISOString();
  writePicks(picks);
}

/**
 * Returns all picks whose match date falls within [from, to] inclusive.
 * Dates are YYYY-MM-DD strings.
 */
export function getPicksInRange(from: string, to: string): PickRecord[] {
  return readPicks().filter(p => p.date >= from && p.date <= to);
}

export function getAllPicks(): PickRecord[] {
  return readPicks();
}
