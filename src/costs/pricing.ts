type ModelPricing = {
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion: number;
  outputUsdPerMillion: number;
};

export type UsageCostBreakdown = {
  inputCostUsd: number;
  cachedInputCostUsd: number;
  outputCostUsd: number;
  webSearchCostUsd: number;
  totalCostUsd: number;
};

const MODEL_PRICING: Record<string, ModelPricing> = {
  'gpt-5.4': {
    inputUsdPerMillion: 2.5,
    cachedInputUsdPerMillion: 0.25,
    outputUsdPerMillion: 15,
  },
  'gpt-5.4-mini': {
    inputUsdPerMillion: 0.75,
    cachedInputUsdPerMillion: 0.075,
    outputUsdPerMillion: 4.5,
  },
  'gpt-5.4-nano': {
    inputUsdPerMillion: 0.2,
    cachedInputUsdPerMillion: 0.02,
    outputUsdPerMillion: 1.25,
  },
};

export const WEB_SEARCH_USD_PER_1000_CALLS = 10;

function perMillionToPerToken(rate: number): number {
  return rate / 1_000_000;
}

export function normalizeModelName(model: string): string {
  return model.trim().toLowerCase().replace(/\s+/g, '-');
}

export function getModelPricing(model: string): ModelPricing | null {
  return MODEL_PRICING[normalizeModelName(model)] ?? null;
}

export function calculateUsageCostUsd(
  model: string,
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
  webSearchCalls: number,
): UsageCostBreakdown | null {
  const pricing = getModelPricing(model);
  if (!pricing) {
    return null;
  }

  const safeInputTokens = Math.max(0, inputTokens);
  const safeCachedInputTokens = Math.max(0, Math.min(cachedInputTokens, safeInputTokens));
  const billableInputTokens = safeInputTokens - safeCachedInputTokens;
  const safeOutputTokens = Math.max(0, outputTokens);
  const safeWebSearchCalls = Math.max(0, webSearchCalls);

  const inputCostUsd = billableInputTokens * perMillionToPerToken(pricing.inputUsdPerMillion);
  const cachedInputCostUsd =
    safeCachedInputTokens * perMillionToPerToken(pricing.cachedInputUsdPerMillion);
  const outputCostUsd = safeOutputTokens * perMillionToPerToken(pricing.outputUsdPerMillion);
  const webSearchCostUsd = safeWebSearchCalls * (WEB_SEARCH_USD_PER_1000_CALLS / 1_000);
  const totalCostUsd = inputCostUsd + cachedInputCostUsd + outputCostUsd + webSearchCostUsd;

  return {
    inputCostUsd,
    cachedInputCostUsd,
    outputCostUsd,
    webSearchCostUsd,
    totalCostUsd,
  };
}