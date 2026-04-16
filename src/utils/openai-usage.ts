import fs from 'fs';
import path from 'path';
import { logger } from './logger';

export interface OpenAIUsageDetails {
  cached_tokens?: number;
  reasoning_tokens?: number;
}

export interface OpenAIUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: OpenAIUsageDetails;
  output_tokens_details?: OpenAIUsageDetails;
}

export interface OpenAIResponseLike {
  id?: string;
  usage?: unknown;
}

type UsageMeta = Record<string, string | number | boolean | null | undefined>;
type UsageMetaValue = string | number | boolean;

export interface OpenAIUsageLogEntry {
  occurredAt: string;
  scope: string;
  model: string;
  responseId?: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
  webSearchCalls: number;
  meta: Record<string, UsageMetaValue>;
}

const OPENAI_USAGE_LOG = path.resolve('./data/openai-usage.ndjson');

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function normalizeCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function serializeMeta(meta: UsageMeta): Record<string, UsageMetaValue> {
  const serialized: Record<string, UsageMetaValue> = {};

  for (const [key, value] of Object.entries(meta)) {
    if (key === 'web_search_calls' || key === 'webSearchCalls') {
      continue;
    }

    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      serialized[key] = value;
    }
  }

  return serialized;
}

function appendOpenAIUsageEntry(entry: OpenAIUsageLogEntry): void {
  try {
    ensureDir(path.dirname(OPENAI_USAGE_LOG));
    fs.appendFileSync(OPENAI_USAGE_LOG, `${JSON.stringify(entry)}\n`, 'utf-8');
  } catch (err) {
    logger.warn(`[openai-usage] failed to persist usage entry: ${String(err)}`);
  }
}

function toUsage(value: unknown): OpenAIUsage | null {
  if (!isObject(value)) return null;
  return value as OpenAIUsage;
}

export function getOpenAIUsage(response: OpenAIResponseLike): OpenAIUsage | null {
  return toUsage(response.usage);
}

export function readOpenAIUsageLogEntries(): OpenAIUsageLogEntry[] {
  try {
    if (!fs.existsSync(OPENAI_USAGE_LOG)) {
      return [];
    }

    const text = fs.readFileSync(OPENAI_USAGE_LOG, 'utf-8').trim();
    if (!text) {
      return [];
    }

    const entries: OpenAIUsageLogEntry[] = [];
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      entries.push(JSON.parse(trimmed) as OpenAIUsageLogEntry);
    }
    return entries;
  } catch (err) {
    logger.warn(`[openai-usage] failed to read usage log: ${String(err)}`);
    return [];
  }
}

/**
 * Logs exact token usage as returned by the OpenAI Responses API.
 * No local estimation is performed; values come directly from the API response.
 */
export function logOpenAIUsage(
  scope: string,
  model: string,
  response: OpenAIResponseLike,
  meta: UsageMeta = {}
): void {
  const usage = getOpenAIUsage(response);

  if (!usage) {
    logger.warn(`[openai-usage] ${scope} | model=${model} | usage=unavailable`);
    return;
  }

  const parts = [
    `[openai-usage] ${scope}`,
    `model=${model}`,
    `input_tokens=${usage.input_tokens ?? 'n/a'}`,
    `output_tokens=${usage.output_tokens ?? 'n/a'}`,
    `total_tokens=${usage.total_tokens ?? 'n/a'}`,
  ];

  if (response.id) parts.push(`response_id=${response.id}`);

  const cachedInput = usage.input_tokens_details?.cached_tokens;
  if (typeof cachedInput === 'number') {
    parts.push(`cached_input_tokens=${cachedInput}`);
  }

  const reasoningOutput = usage.output_tokens_details?.reasoning_tokens;
  if (typeof reasoningOutput === 'number') {
    parts.push(`reasoning_output_tokens=${reasoningOutput}`);
  }

  for (const [key, value] of Object.entries(meta)) {
    if (value !== undefined && value !== null) {
      parts.push(`${key}=${String(value)}`);
    }
  }

  logger.info(parts.join(' | '));

  appendOpenAIUsageEntry({
    occurredAt: new Date().toISOString(),
    scope,
    model,
    responseId: response.id,
    inputTokens: normalizeCount(usage.input_tokens),
    outputTokens: normalizeCount(usage.output_tokens),
    totalTokens: normalizeCount(usage.total_tokens),
    cachedInputTokens: normalizeCount(cachedInput),
    reasoningOutputTokens: normalizeCount(reasoningOutput),
    webSearchCalls: normalizeCount(meta.web_search_calls ?? meta.webSearchCalls),
    meta: serializeMeta(meta),
  });
}