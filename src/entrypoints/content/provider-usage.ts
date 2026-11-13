import { storage } from "#imports";
import { estimateGeminiPaidCostUsd } from "@/lib/server/gemini-pricing";
import type { ProviderTokenUsage } from "@/lib/server/usage";

export const PROVIDER_USAGE_KEY = "local:provider-usage";

export interface ProviderUsageBucket {
  apiRequests: number;
  inputTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  cachedInputTokens: number | null;
  estimatedCostUsd: number | null;
  updatedAt?: number;
}

export interface ProviderUsageSummary {
  api: ProviderUsageBucket;
  gemini: ProviderUsageBucket;
  local: ProviderUsageBucket;
}

function emptyBucket(): ProviderUsageBucket {
  return {
    apiRequests: 0,
    inputTokens: null,
    outputTokens: null,
    thinkingTokens: null,
    cachedInputTokens: null,
    estimatedCostUsd: null,
  };
}

export const EMPTY_PROVIDER_USAGE: ProviderUsageSummary = {
  api: emptyBucket(),
  gemini: emptyBucket(),
  local: emptyBucket(),
};

export function normalizeProviderUsageSummary(
  value: Partial<ProviderUsageSummary> | undefined,
): ProviderUsageSummary {
  const result: ProviderUsageSummary = {
    api: { ...emptyBucket(), ...(value?.api ?? {}) },
    gemini: { ...emptyBucket(), ...(value?.gemini ?? {}) },
    local: { ...emptyBucket(), ...(value?.local ?? {}) },
  };
  for (const bucket of [result.api, result.gemini, result.local]) {
    if (bucket.apiRequests > 0) {
      for (const field of [
        "inputTokens",
        "outputTokens",
        "thinkingTokens",
        "cachedInputTokens",
        "estimatedCostUsd",
      ] as const) {
        if (bucket[field] === undefined) bucket[field] = null;
      }
    }
  }
  return result;
}

let writeQueue: Promise<void> = Promise.resolve();

/**
 * Add one increment to a running total, or keep the total unknown.
 *
 * A field stays unknown only while it has never been observed. Once a request
 * reports nothing for a category, the previous total is *kept*, not nulled:
 *
 *   - Gemini omits `thoughtsTokenCount` when the model did no thinking, and
 *     OpenAI-compatible endpoints omit cached-input details on most replies.
 *     Treating one absent field as "this metric is unknowable forever" wiped
 *     counters that had already been measured and made the usage panel look
 *     permanently dead — the request count climbed while every token field
 *     stayed "Unknown".
 *   - The total stays honest: it is still a sum of provider-reported numbers.
 *     It only stops claiming to be a complete sum, which `metricComplete`
 *     below records per bucket.
 */
function addMetric(
  total: number | null,
  increment: number | undefined,
): number | null {
  if (typeof increment !== "number" || !Number.isFinite(increment) || increment < 0) {
    return total;
  }
  return (total ?? 0) + increment;
}

/**
 * Add one completed model run's provider-reported usage. Local WebLLM runs are
 * tracked separately and never priced; missing metrics remain unknown.
 */
export function recordProviderUsage(
  mode: string,
  diagnostics?: Pick<TranslationDiagnostics, "llmCalls" | "usage">,
  modelId = "",
): Promise<void> {
  if (mode !== "api" && mode !== "gemini" && mode !== "webgpu") {
    return Promise.resolve();
  }
  const requests = diagnostics?.llmCalls;
  if (typeof requests !== "number" || !Number.isFinite(requests) || requests <= 0) {
    return Promise.resolve();
  }

  writeQueue = writeQueue.catch(() => undefined).then(async () => {
    const saved = await storage.getItem<ProviderUsageSummary>(PROVIDER_USAGE_KEY);
    const all = normalizeProviderUsageSummary(saved ?? undefined);
    const bucket = mode === "gemini" ? all.gemini : mode === "api" ? all.api : all.local;
    const usage: ProviderTokenUsage | undefined = diagnostics?.usage;
    const nextRequests = bucket.apiRequests + Math.trunc(requests);
    const next: ProviderUsageBucket = {
      apiRequests: nextRequests,
      inputTokens: addMetric(bucket.inputTokens, usage?.inputTokens),
      outputTokens: addMetric(bucket.outputTokens, usage?.outputTokens),
      thinkingTokens: addMetric(bucket.thinkingTokens, usage?.thinkingTokens),
      cachedInputTokens: addMetric(
        bucket.cachedInputTokens,
        usage?.cachedInputTokens,
      ),
      estimatedCostUsd:
        mode === "gemini"
          ? addMetric(
              bucket.estimatedCostUsd,
              estimateGeminiPaidCostUsd(modelId, usage) ?? undefined,
            )
          : null,
      updatedAt: Date.now(),
    };
    if (mode === "gemini") all.gemini = next;
    else if (mode === "api") all.api = next;
    else all.local = next;
    await storage.setItem(PROVIDER_USAGE_KEY, all);
  });
  return writeQueue;
}
