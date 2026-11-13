export interface ProviderTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  thinkingTokens?: number;
  cachedInputTokens?: number;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function firstTokenCount(...values: unknown[]): number | undefined {
  for (const value of values) {
    const count = tokenCount(value);
    if (count !== undefined) return count;
  }
  return undefined;
}

function hasUsage(value: ProviderTokenUsage): boolean {
  return Object.values(value).some((count) => count !== undefined);
}

/**
 * Read the token counts Gemini reported in `usageMetadata`.
 *
 * Gemini omits a counter entirely when it is zero: a reply without thinking
 * carries no `thoughtsTokenCount`, and a request without cached context
 * carries no `cachedContentTokenCount`. Reading those omissions as "unknown"
 * made `estimateGeminiPaidCostUsd` bail out on every single page, because it
 * requires all four classes before it will price anything — the usage panel
 * showed requests climbing next to a permanently "Unknown" cost.
 *
 * Omitted billing categories are therefore read as 0 (nothing was billed),
 * while the input/output counts stay strictly provider-reported: a missing
 * prompt or candidate count still leaves the whole record unknown.
 */
export function normalizeGeminiUsageMetadata(
  metadata: unknown,
): ProviderTokenUsage | undefined {
  const raw = asRecord(metadata);
  const inputTokens = tokenCount(raw.promptTokenCount);
  const outputTokens = tokenCount(raw.candidatesTokenCount);
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  const usage: ProviderTokenUsage = {
    inputTokens,
    outputTokens,
    thinkingTokens: tokenCount(raw.thoughtsTokenCount) ?? 0,
    cachedInputTokens: tokenCount(raw.cachedContentTokenCount) ?? 0,
  };
  return hasUsage(usage) ? usage : undefined;
}

/** Normalize OpenAI-compatible usage; LM Studio stats are a conservative fallback. */
export function normalizeOpenAICompatibleUsage(
  response: unknown,
): ProviderTokenUsage | undefined {
  const data = asRecord(response);
  const usage = asRecord(data.usage);
  const stats = asRecord(data.stats);
  const promptDetails = asRecord(
    usage.prompt_tokens_details ?? usage.input_tokens_details,
  );
  const completionDetails = asRecord(
    usage.completion_tokens_details ?? usage.output_tokens_details,
  );

  const thinkingTokens = firstTokenCount(
    completionDetails.reasoning_tokens,
    usage.reasoning_tokens,
    usage.thinking_tokens,
    stats.thinking_tokens,
  );
  const totalCompletion = firstTokenCount(
    usage.completion_tokens,
    usage.output_tokens,
    stats.tokens_predicted,
    stats.completion_tokens,
  );
  const usageResult: ProviderTokenUsage = {
    inputTokens: firstTokenCount(
      usage.prompt_tokens,
      usage.input_tokens,
      stats.tokens_evaluated,
      stats.prompt_tokens,
    ),
    // Some providers include reasoning tokens in completion_tokens; separate
    // them when the provider exposes the component to avoid double counting.
    outputTokens:
      totalCompletion === undefined
        ? undefined
        : Math.max(0, totalCompletion - (thinkingTokens ?? 0)),
    thinkingTokens,
    cachedInputTokens: firstTokenCount(
      promptDetails.cached_tokens,
      usage.cached_input_tokens,
      usage.cached_tokens,
      stats.cached_tokens,
    ),
  };
  return hasUsage(usageResult) ? usageResult : undefined;
}

/** Sum a page's call records only when every call reported that field. */
export function mergeProviderUsage(
  calls: readonly (ProviderTokenUsage | undefined)[],
): ProviderTokenUsage | undefined {
  if (calls.length === 0) return undefined;
  const fields = [
    "inputTokens",
    "outputTokens",
    "thinkingTokens",
    "cachedInputTokens",
  ] as const;
  const merged: ProviderTokenUsage = {};
  for (const field of fields) {
    const values = calls.map((call) => call?.[field]);
    if (
      values.every(
        (value) =>
          typeof value === "number" && Number.isFinite(value) && value >= 0,
      )
    ) {
      merged[field] = (values as number[]).reduce((total, value) => total + value, 0);
    }
  }
  return hasUsage(merged) ? merged : undefined;
}
