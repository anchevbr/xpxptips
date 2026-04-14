// ─────────────────────────────────────────────────────────────────────────────
// checkpoint.ts
//
// Saves pipeline state to disk after each step so the bot can resume from
// where it left off after a server restart.
//
// Layout: data/checkpoints/{date}/
//   fixtures.json             — all fetched fixtures for the date
//   analysis/{fixtureId}.json — per-fixture expert analysis
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import { logger } from './logger';
import type { Fixture, BettingAnalysis } from '../types';

const CHECKPOINT_BASE = path.resolve('./data/checkpoints');
const ANALYSIS_CHECKPOINT_VERSION = 4;

function cpDir(date: string, ...sub: string[]): string {
  return path.join(CHECKPOINT_BASE, date, ...sub);
}

function ensureDir(d: string): void {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function safeWrite(file: string, data: unknown): void {
  try {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    logger.warn(`[checkpoint] write failed ${file}: ${String(err)}`);
  }
}

function safeRead<T>(file: string): T | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch (err) {
    logger.warn(`[checkpoint] read failed ${file}: ${String(err)}`);
    return null;
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

export function saveFixtures(date: string, fixtures: Fixture[]): void {
  const file = cpDir(date, 'fixtures.json');
  safeWrite(file, { savedAt: new Date().toISOString(), fixtures });
  logger.info(`[checkpoint] fixtures saved → ${file}`);
}

export function loadFixtures(date: string): Fixture[] | null {
  const file = cpDir(date, 'fixtures.json');
  const data = safeRead<{ fixtures: Fixture[] }>(file);
  if (!data) return null;
  logger.info(`[checkpoint] fixtures loaded from disk for ${date} (${data.fixtures.length} fixture(s))`);
  return data.fixtures;
}

// ── Expert analysis ───────────────────────────────────────────────────────────

export function saveAnalysis(date: string, fixtureId: string, analysis: BettingAnalysis): void {
  const file = cpDir(date, 'analysis', `${fixtureId}.json`);
  safeWrite(file, { version: ANALYSIS_CHECKPOINT_VERSION, savedAt: new Date().toISOString(), analysis });
}

export function loadAnalysis(date: string, fixtureId: string): BettingAnalysis | null {
  const file = cpDir(date, 'analysis', `${fixtureId}.json`);
  const data = safeRead<{ version?: number; savedAt?: string; analysis: BettingAnalysis }>(file);
  if (!data?.analysis) return null;
  if (data.version !== ANALYSIS_CHECKPOINT_VERSION) {
    logger.info(
      `[checkpoint] analysis cache invalid for ${fixtureId} on ${date}` +
      ` | version=${data.version ?? 'none'} expected=${ANALYSIS_CHECKPOINT_VERSION}`
    );
    return null;
  }
  logger.info(
    `[checkpoint] analysis loaded from disk for ${fixtureId} on ${date}` +
    ` | savedAt=${data.savedAt ?? 'unknown'}`
  );
  return data.analysis;
}
