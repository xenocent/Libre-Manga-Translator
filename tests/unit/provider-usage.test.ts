import { describe, expect, it } from "bun:test";
import {
  mergeProviderUsage,
  normalizeGeminiUsageMetadata,
  normalizeOpenAICompatibleUsage,
} from "../../src/lib/server/usage";

describe("provider-reported token usage", () => {
  it("normalizes Gemini's reported token metadata", () => {
    expect(
      normalizeGeminiUsageMetadata({
        promptTokenCount: 120,
        candidatesTokenCount: 35,
        thoughtsTokenCount: 8,
        cachedContentTokenCount: 20,
      }),
    ).toEqual({
      inputTokens: 120,
      outputTokens: 35,
      thinkingTokens: 8,
      cachedInputTokens: 20,
    });
    expect(normalizeGeminiUsageMetadata(undefined)).toBeUndefined();
  });

  it("reads Gemini's omitted billing categories as zero, not unknown", () => {
    // Gemini omits a counter when it is zero: a reply without thinking carries
    // no thoughtsTokenCount. Reporting that as `undefined` made the cost
    // estimator — which needs all four classes — return null on every page,
    // so the usage panel showed requests climbing beside "Unknown" forever.
    expect(normalizeGeminiUsageMetadata({ promptTokenCount: 12 })).toEqual({
      inputTokens: 12,
      outputTokens: undefined,
      thinkingTokens: 0,
      cachedInputTokens: 0,
    });

    // A record with no billed input or output is still unknown: the zero-fill
    // applies only to the categories Gemini treats as optional.
    expect(normalizeGeminiUsageMetadata({})).toBeUndefined();
    expect(
      normalizeGeminiUsageMetadata({ thoughtsTokenCount: 0 }),
    ).toBeUndefined();
  });

  it("normalizes OpenAI-compatible usage and separates reported reasoning tokens", () => {
    expect(
      normalizeOpenAICompatibleUsage({
        usage: {
          prompt_tokens: 100,
          completion_tokens: 30,
          prompt_tokens_details: { cached_tokens: 12 },
          completion_tokens_details: { reasoning_tokens: 10 },
        },
      }),
    ).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      thinkingTokens: 10,
      cachedInputTokens: 12,
    });
  });

  it("uses LM Studio token stats only when they are actually present", () => {
    expect(
      normalizeOpenAICompatibleUsage({
        stats: { tokens_evaluated: 44, tokens_predicted: 13 },
      }),
    ).toEqual({ inputTokens: 44, outputTokens: 13 });
    expect(normalizeOpenAICompatibleUsage({})).toBeUndefined();
  });

  it("sums fields only when every request reported that field", () => {
    expect(
      mergeProviderUsage([
        { inputTokens: 10, outputTokens: 4, cachedInputTokens: 2 },
        { inputTokens: 8, outputTokens: 3, cachedInputTokens: 1 },
      ]),
    ).toEqual({ inputTokens: 18, outputTokens: 7, cachedInputTokens: 3 });
    expect(
      mergeProviderUsage([
        { inputTokens: 10, outputTokens: 4 },
        { inputTokens: 8 },
      ]),
    ).toEqual({ inputTokens: 18 });
  });
});


describe("usage counter call-site contract", () => {
  it("records each page result once for both success and error paths", async () => {
    const source = await Bun.file(
      new URL("../../src/entrypoints/content/index.ts", import.meta.url),
    ).text();
    expect(source.match(/void recordProviderUsage\(/g) ?? []).toHaveLength(1);
  });
});
