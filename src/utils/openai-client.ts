import OpenAI from 'openai';
import { config } from '../config';

/**
 * Creates an OpenAI client that respects the configured timeout policy.
 * If timeoutMs <= 0, no client-side timeout cap is applied.
 */
export function createOpenAIClient(timeoutMs = config.openai.timeoutMs): OpenAI {
  const options: ConstructorParameters<typeof OpenAI>[0] = {
    apiKey: config.openai.apiKey,
  };

  if (timeoutMs > 0) {
    options.timeout = timeoutMs;
  }

  return new OpenAI(options);
}