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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toUsage(value: unknown): OpenAIUsage | null {
  if (!isObject(value)) return null;
  return value as OpenAIUsage;
}

export function getOpenAIUsage(response: OpenAIResponseLike): OpenAIUsage | null {
  return toUsage(response.usage);
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
}