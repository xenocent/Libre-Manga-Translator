import { describe, expect, it } from "bun:test";
import { estimateGeminiPaidCostUsd } from "../../src/lib/server/gemini-pricing";

const fullUsage = {
  inputTokens: 1_000_000,
  outputTokens: 1_000_000,
  thinkingTokens: 0,
  cachedInputTokens: 0,
};

describe("Gemini paid-tier price estimates", () => {
  it("uses the published 2026 Gemini 3.8 Flash rates", () => {
    expect(
      estimateGeminiPaidCostUsd(
        "gemini-3.8-flash",
        fullUsage,
        new Date("2026-11-07T00:00:00Z"),
      ),
    ).toBeCloseTo(4.5);
  });

  it("switches to the published 2027 rate on its effective date", () => {
    expect(
      estimateGeminiPaidCostUsd(
        "gemini-3.8-flash",
        fullUsage,
        new Date("2027-01-01T00:00:00Z"),
      ),
    ).toBeCloseTo(9);
  });

  it("prices cached input at the public cache rate", () => {
    expect(
      estimateGeminiPaidCostUsd(
        "gemini-3.8-flash",
        { ...fullUsage, inputTokens: 1_000_000, cachedInputTokens: 500_000, outputTokens: 0 },
        new Date("2026-11-07T00:00:00Z"),
      ),
    ).toBeCloseTo(0.4125);
  });

  it("uses the published Gemini 3.5 Flash-Lite rate", () => {
    expect(
      estimateGeminiPaidCostUsd(
        "gemini-3.5-flash-lite",
        fullUsage,
        new Date("2026-11-07T00:00:00Z"),
      ),
    ).toBeCloseTo(2.8);
  });

  it("prices the selectable 3.7 and 3.5 flash models, not just the default", () => {
    // Cost used to read "Unknown" for any model without an explicit entry, so
    // users who picked a non-default flash model got working counters and no
    // cost at all. Every selectable `configs.geminiModels` id must resolve.
    const cost = (id: string) =>
      estimateGeminiPaidCostUsd(id, fullUsage, new Date("2026-11-07T00:00:00Z"));
    expect(cost("gemini-3.7-flash")).not.toBeNull();
    expect(cost("gemini-3.5-flash")).not.toBeNull();
  });

  it("does not guess a rate or fill missing token categories", () => {
    // A truly unknown model id must stay null rather than silently pricing as a
    // flash tier — a wrong price is worse than no price.
    expect(
      estimateGeminiPaidCostUsd("gemini-nonexistent-flash", fullUsage),
    ).toBeNull();
    expect(
      estimateGeminiPaidCostUsd("gemini-3.8-flash", {
        inputTokens: 100,
        outputTokens: 10,
      }),
    ).toBeNull();
  });
});
