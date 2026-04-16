import { sendToOperatorChats } from '../bot/telegram';
import { config } from '../config';
import { yesterdayInTimeZone } from '../utils/date';
import { logger } from '../utils/logger';
import { readOpenAIUsageLogEntries, type OpenAIUsageLogEntry } from '../utils/openai-usage';
import { calculateUsageCostUsd, normalizeModelName } from './pricing';

type SpendBucket = {
  requests: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningOutputTokens: number;
  webSearchCalls: number;
  inputCostUsd: number;
  cachedInputCostUsd: number;
  outputCostUsd: number;
  webSearchCostUsd: number;
  totalCostUsd: number;
};

type DailySpendSummary = {
  targetDate: string;
  total: SpendBucket;
  byScope: Array<[string, SpendBucket]>;
  byModel: Array<[string, SpendBucket]>;
  unknownModels: string[];
};

function createEmptyBucket(): SpendBucket {
  return {
    requests: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    reasoningOutputTokens: 0,
    webSearchCalls: 0,
    inputCostUsd: 0,
    cachedInputCostUsd: 0,
    outputCostUsd: 0,
    webSearchCostUsd: 0,
    totalCostUsd: 0,
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatTokenCount(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}

function formatDateGreek(date: string): string {
  const [year, month, day] = date.split('-').map(part => parseInt(part, 10));
  return `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;
}

function getAthensDateString(occurredAt: string): string | null {
  const date = new Date(occurredAt);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.scheduler.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const year = parts.find(part => part.type === 'year')?.value;
  const month = parts.find(part => part.type === 'month')?.value;
  const day = parts.find(part => part.type === 'day')?.value;

  if (!year || !month || !day) {
    return null;
  }

  return `${year}-${month}-${day}`;
}

function resolveEntryDate(entry: OpenAIUsageLogEntry): string | null {
  const taggedDate = entry.meta.date;
  if (typeof taggedDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(taggedDate)) {
    return taggedDate;
  }
  return getAthensDateString(entry.occurredAt);
}

function accumulateBucket(bucket: SpendBucket, entry: OpenAIUsageLogEntry): void {
  bucket.requests += 1;
  bucket.inputTokens += entry.inputTokens;
  bucket.cachedInputTokens += entry.cachedInputTokens;
  bucket.outputTokens += entry.outputTokens;
  bucket.totalTokens += entry.totalTokens;
  bucket.reasoningOutputTokens += entry.reasoningOutputTokens;
  bucket.webSearchCalls += entry.webSearchCalls;

  const cost = calculateUsageCostUsd(
    entry.model,
    entry.inputTokens,
    entry.cachedInputTokens,
    entry.outputTokens,
    entry.webSearchCalls,
  );

  if (!cost) {
    return;
  }

  bucket.inputCostUsd += cost.inputCostUsd;
  bucket.cachedInputCostUsd += cost.cachedInputCostUsd;
  bucket.outputCostUsd += cost.outputCostUsd;
  bucket.webSearchCostUsd += cost.webSearchCostUsd;
  bucket.totalCostUsd += cost.totalCostUsd;
}

function sortBucketsDesc(map: Map<string, SpendBucket>): Array<[string, SpendBucket]> {
  return [...map.entries()].sort((left, right) => right[1].totalCostUsd - left[1].totalCostUsd);
}

export function summarizeDailyOpenAISpend(targetDate: string): DailySpendSummary {
  const entries = readOpenAIUsageLogEntries().filter(entry => resolveEntryDate(entry) === targetDate);
  const total = createEmptyBucket();
  const byScope = new Map<string, SpendBucket>();
  const byModel = new Map<string, SpendBucket>();
  const unknownModels = new Set<string>();

  for (const entry of entries) {
    accumulateBucket(total, entry);

    const scopeBucket = byScope.get(entry.scope) ?? createEmptyBucket();
    accumulateBucket(scopeBucket, entry);
    byScope.set(entry.scope, scopeBucket);

    const modelKey = normalizeModelName(entry.model);
    const modelBucket = byModel.get(modelKey) ?? createEmptyBucket();
    accumulateBucket(modelBucket, entry);
    byModel.set(modelKey, modelBucket);

    if (!calculateUsageCostUsd(entry.model, 0, 0, 0, 0)) {
      unknownModels.add(entry.model);
    }
  }

  return {
    targetDate,
    total,
    byScope: sortBucketsDesc(byScope),
    byModel: sortBucketsDesc(byModel),
    unknownModels: [...unknownModels].sort(),
  };
}

export function formatDailyOpenAISpendReport(summary: DailySpendSummary): string {
  const { targetDate, total, byScope, byModel, unknownModels } = summary;
  const lines = [
    `<b>Daily OpenAI Spend — ${escapeHtml(formatDateGreek(targetDate))}</b>`,
    `Athens fixture date: <code>${escapeHtml(targetDate)}</code>`,
    '',
    `<b>Requests</b>: ${formatTokenCount(total.requests)}`,
    `<b>Tokens</b>: input ${formatTokenCount(total.inputTokens)} | cached ${formatTokenCount(total.cachedInputTokens)} | output ${formatTokenCount(total.outputTokens)} | reasoning ${formatTokenCount(total.reasoningOutputTokens)} | total ${formatTokenCount(total.totalTokens)}`,
    `<b>Web search calls</b>: ${formatTokenCount(total.webSearchCalls)}`,
    '',
    `<b>Cost (USD)</b>`,
    `Input: ${formatUsd(total.inputCostUsd)}`,
    `Cached input: ${formatUsd(total.cachedInputCostUsd)}`,
    `Output: ${formatUsd(total.outputCostUsd)}`,
    `Web search: ${formatUsd(total.webSearchCostUsd)}`,
    `<b>Total: ${formatUsd(total.totalCostUsd)}</b>`,
  ];

  if (byModel.length > 0) {
    lines.push('', '<b>By Model</b>');
    for (const [model, bucket] of byModel) {
      lines.push(
        `• <code>${escapeHtml(model)}</code> — ${formatUsd(bucket.totalCostUsd)} | req ${formatTokenCount(bucket.requests)} | in ${formatTokenCount(bucket.inputTokens)} | out ${formatTokenCount(bucket.outputTokens)} | search ${formatTokenCount(bucket.webSearchCalls)}`
      );
    }
  }

  if (byScope.length > 0) {
    lines.push('', '<b>By Scope</b>');
    for (const [scope, bucket] of byScope) {
      lines.push(
        `• <code>${escapeHtml(scope)}</code> — ${formatUsd(bucket.totalCostUsd)} | req ${formatTokenCount(bucket.requests)} | in ${formatTokenCount(bucket.inputTokens)} | out ${formatTokenCount(bucket.outputTokens)} | search ${formatTokenCount(bucket.webSearchCalls)}`
      );
    }
  }

  if (unknownModels.length > 0) {
    lines.push(
      '',
      `<b>Unpriced models</b>: ${escapeHtml(unknownModels.join(', '))}`,
      'Those requests were counted in tokens/requests but excluded from USD totals.'
    );
  }

  if (total.requests === 0) {
    lines.splice(2, 0, 'No recorded OpenAI usage for this fixture date.');
  }

  return lines.join('\n');
}

export async function runDailyOpenAISpendReport(targetDate?: string): Promise<void> {
  const reportDate = targetDate ?? yesterdayInTimeZone(config.scheduler.timezone);
  const summary = summarizeDailyOpenAISpend(reportDate);
  const recipientsReached = await sendToOperatorChats(formatDailyOpenAISpendReport(summary));

  if (recipientsReached === 0) {
    logger.warn(`[costs] no operator Telegram recipients configured — spend report for ${reportDate} was not sent`);
    return;
  }

  logger.info(
    `[costs] daily OpenAI spend report sent for ${reportDate} to ${recipientsReached} recipient(s) | total=${formatUsd(summary.total.totalCostUsd)}`
  );
}