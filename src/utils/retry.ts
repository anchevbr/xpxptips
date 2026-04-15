import { logger } from './logger';

interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  factor?: number;
  label?: string;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  getDelayMs?: (error: unknown, attempt: number, fallbackDelayMs: number) => number | undefined;
}

function getSuggestedRetryDelayMs(error: unknown): number | undefined {
  const message = error instanceof Error ? error.message : String(error);

  const secondsMatch = message.match(/try again in\s+([0-9]+(?:\.[0-9]+)?)s/i);
  if (secondsMatch) {
    const seconds = Number.parseFloat(secondsMatch[1]!);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.ceil(seconds * 1000) + 250;
    }
  }

  const millisecondsMatch = message.match(/try again in\s+([0-9]+)\s*ms/i);
  if (millisecondsMatch) {
    const milliseconds = Number.parseInt(millisecondsMatch[1]!, 10);
    if (Number.isFinite(milliseconds) && milliseconds >= 0) {
      return milliseconds + 250;
    }
  }

  return undefined;
}

/**
 * Retries an async operation with exponential back-off.
 * Throws the last error once all attempts are exhausted.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    initialDelayMs = 500,
    factor = 2,
    label = 'operation',
    shouldRetry,
    getDelayMs,
  } = options;

  let lastError: unknown;
  let delay = initialDelayMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === maxAttempts) break;
      if (shouldRetry && !shouldRetry(err, attempt)) break;

      const nextDelay = Math.max(
        0,
        getDelayMs?.(err, attempt, delay) ?? getSuggestedRetryDelayMs(err) ?? delay
      );

      logger.warn(
        `[retry] ${label} failed (attempt ${attempt}/${maxAttempts}). Retrying in ${nextDelay}ms...`
      );
      await sleep(nextDelay);
      delay = Math.max(initialDelayMs, Math.ceil(nextDelay * factor));
    }
  }

  throw lastError;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
