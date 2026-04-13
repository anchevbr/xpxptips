import { logger } from './logger';

interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  factor?: number;
  label?: string;
}

/**
 * Retries an async operation with exponential back-off.
 * Throws the last error once all attempts are exhausted.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const { maxAttempts = 3, initialDelayMs = 500, factor = 2, label = 'operation' } = options;

  let lastError: unknown;
  let delay = initialDelayMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === maxAttempts) break;
      logger.warn(`[retry] ${label} failed (attempt ${attempt}/${maxAttempts}). Retrying in ${delay}ms…`);
      await sleep(delay);
      delay *= factor;
    }
  }

  throw lastError;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
