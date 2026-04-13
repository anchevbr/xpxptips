import OpenAI from 'openai';
import type { Response } from 'openai/resources/responses/responses';
import { logger } from './logger';
import { logOpenAIUsage } from './openai-usage';

type UsageMeta = Record<string, string | number | boolean | null | undefined>;

interface RunResponseWithActivityOptions {
  client: OpenAI;
  scope: string;
  model: string;
  params: Parameters<OpenAI['responses']['stream']>[0];
  timeoutMs: number;
  usageMeta?: UsageMeta;
}

type ResponseOutputLike = {
  type?: string;
  id?: string;
  status?: string;
  content?: Array<{ type?: string; text?: string }>;
  summary?: Array<{ text?: string }>;
  action?: {
    type?: string;
    query?: string;
    sources?: Array<{ url?: string }>;
    url?: string;
    pattern?: string;
  };
};

type ResponseLike = {
  id?: string;
  usage?: unknown;
  output_text?: string;
  output?: unknown[];
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function truncate(text: string, maxLen = 220): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 3)}...`;
}

export function extractResponseOutputText(response: ResponseLike): string {
  const direct = typeof response.output_text === 'string' ? response.output_text.trim() : '';
  if (direct) return direct;

  if (!Array.isArray(response.output)) return '';

  const parts: string[] = [];
  for (const item of response.output as ResponseOutputLike[]) {
    if (item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (content.type === 'output_text' && typeof content.text === 'string' && content.text.trim()) {
        parts.push(content.text.trim());
      }
    }
  }

  return parts.join('\n').trim();
}

function hasUsage(response: ResponseLike): boolean {
  return isObject(response.usage);
}

async function hydrateResponseIfNeeded(
  client: OpenAI,
  scope: string,
  response: Response,
  timeoutMs: number
): Promise<Response> {
  const needsHydration = !hasUsage(response) || extractResponseOutputText(response).length === 0;
  if (!needsHydration || !response.id) return response;

  const requestOptions: Parameters<OpenAI['responses']['retrieve']>[2] = {
    maxRetries: 0,
  };

  if (timeoutMs > 0) {
    requestOptions.timeout = timeoutMs;
    requestOptions.signal = AbortSignal.timeout(timeoutMs);
  }

  try {
    const hydrated = await client.responses.retrieve(response.id, {}, requestOptions);
    logger.info(`[openai-activity] ${scope} | response=hydrated | response_id=${response.id}`);
    return hydrated as Response;
  } catch (err) {
    logger.warn(
      `[openai-activity] ${scope} | response=hydrate_failed | response_id=${response.id} | error=${String(err)}`
    );
    return response;
  }
}

function logFinalActivity(scope: string, response: Response): void {
  const output = Array.isArray(response.output) ? (response.output as ResponseOutputLike[]) : [];

  for (const item of output) {
    if (item.type === 'reasoning') {
      const summaries = Array.isArray(item.summary)
        ? item.summary
            .map((entry) => entry.text?.trim())
            .filter((text): text is string => Boolean(text))
        : [];

      for (const summary of summaries) {
        logger.info(
          `[openai-activity] ${scope} | reasoning_summary_final=${truncate(summary)}`
        );
      }
      continue;
    }

    if (item.type === 'web_search_call') {
      const actionType = item.action?.type;
      const query = item.action?.query?.trim();
      const sourceCount = item.action?.sources?.length;
      const firstSource = item.action?.sources?.[0]?.url;

      if (!actionType && !query && typeof sourceCount !== 'number' && !firstSource) {
        continue;
      }

      const parts = [
        `[openai-activity] ${scope}`,
        'web_search_item=final',
        `status=${item.status ?? 'unknown'}`,
      ];

      if (item.id) parts.push(`item_id=${item.id}`);
      if (actionType) parts.push(`action=${actionType}`);
      if (query) parts.push(`query=${truncate(query, 160)}`);
      if (typeof sourceCount === 'number') parts.push(`sources=${sourceCount}`);
      if (firstSource) parts.push(`first_source=${truncate(firstSource, 160)}`);

      logger.info(parts.join(' | '));
    }
  }
}

/**
 * Runs a Responses API call via streaming so we can log real web-search activity
 * and reasoning summaries while the request is still in flight.
 */
export async function runResponseWithActivityLogging({
  client,
  scope,
  model,
  params,
  timeoutMs,
  usageMeta = {},
}: RunResponseWithActivityOptions): Promise<Response> {
  const startedAt = Date.now();
  const seenReasoningSummaries = new Set<string>();
  const requestOptions: Parameters<OpenAI['responses']['stream']>[1] = {
    maxRetries: 0,
  };

  if (timeoutMs > 0) {
    requestOptions.timeout = timeoutMs;
    requestOptions.signal = AbortSignal.timeout(timeoutMs);
  }

  const stream = client.responses.stream(params, requestOptions);

  stream.on('connect', () => {
    logger.info(`[openai-activity] ${scope} | stream=connected | model=${model}`);
  });

  stream.on('response.web_search_call.in_progress', (event) => {
    logger.info(
      `[openai-activity] ${scope} | web_search=in_progress | item_id=${event.item_id}`
    );
  });

  stream.on('response.web_search_call.searching', (event) => {
    logger.info(
      `[openai-activity] ${scope} | web_search=searching | item_id=${event.item_id}`
    );
  });

  stream.on('response.web_search_call.completed', (event) => {
    logger.info(
      `[openai-activity] ${scope} | web_search=completed | item_id=${event.item_id}`
    );
  });

  stream.on('response.reasoning_summary_text.done', (event) => {
    const text = event.text.trim();
    if (!text) return;

    const dedupeKey = `${event.item_id}:${event.summary_index}:${text}`;
    if (seenReasoningSummaries.has(dedupeKey)) return;
    seenReasoningSummaries.add(dedupeKey);

    logger.info(
      `[openai-activity] ${scope} | reasoning_summary=${truncate(text)}`
    );
  });

  try {
    const streamedResponse = await stream.finalResponse();
    const response = await hydrateResponseIfNeeded(client, scope, streamedResponse, timeoutMs);

    logger.info(
      `[openai-activity] ${scope} | stream=completed | elapsed=${Math.round((Date.now() - startedAt) / 1000)}s`
    );

    logOpenAIUsage(scope, model, response as { id?: string; usage?: unknown }, usageMeta);
    logFinalActivity(scope, response);
    return response;
  } catch (err) {
    logger.warn(
      `[openai-activity] ${scope} | stream=failed | elapsed=${Math.round((Date.now() - startedAt) / 1000)}s | error=${String(err)}`
    );
    throw err;
  }
}