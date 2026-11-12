import type { ProviderTokenUsage } from "./usage";

interface GeminiTokenRates {
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion: number;
}

const RATE_CHANGE_2027 = Date.UTC(2027, 0, 1);

/**
 * Public Google AI Studio standard paid-tier rates (USD per million tokens).
 * Verified against https://aistudio.google.com/docs/pricing on 2026-11-07.
 * Models without a published, exact matching rate intentionally return unknown.
 */
export function geminiPaidTokenRates(
  modelId: string,
  at = new Date(),
): GeminiTokenRates | undefined {
  if (modelId === "gemini-3.8-flash" || modelId === "gemini-3.6-flash") {
    return at.getTime() >= RATE_CHANGE_2027
      ? {
          inputPerMillion: 1.5,
          outputPerMillion: 7.5,
          cachedInputPerMillion: 0.15,
        }
      : {
          inputPerMillion: 0.75,
          outputPerMillion: 3.75,
          cachedInputPerMillion: 0.075,
        };
  }
  if (modelId === "gemini-3.5-flash-lite") {
    return {
      inputPerMillion: 0.3,
      outputPerMillion: 2.5,
      cachedInputPerMillion: 0.03,
    };
  }
  if (modelId === "gemini-3.1-flash-lite") {
    return {
      inputPerMillion: 0.25,
      outputPerMillion: 1.5,
      cachedInputPerMillion: 0.025,
    };
  }
  return undefined;
}

/**
 * Estimate paid-tier Gemini token charges only when every billed token class is
 * present in provider metadata. Includes cached-input rate and thinking tokens;
 * excludes taxes, discounts, and cache-storage duration charges.
 */
export function estimateGeminiPaidCostUsd(
  modelId: string,
  usage: ProviderTokenUsage | undefined,
  at = new Date(),
): number | null {
  const rates = geminiPaidTokenRates(modelId, at);
  const input = usage?.inputTokens;
  const output = usage?.outputTokens;
  const thinking = usage?.thinkingTokens;
  const cached = usage?.cachedInputTokens;
  if (
    !rates ||
    input === undefined ||
    output === undefined ||
    thinking === undefined ||
    cached === undefined ||
    cached > input
  ) {
    return null;
  }

  const uncachedInput = input - cached;
  return (
    (uncachedInput * rates.inputPerMillion +
      cached * rates.cachedInputPerMillion +
      (output + thinking) * rates.outputPerMillion) /
    1_000_000
  );
}
