<script lang="ts">
  import { onMount } from "svelte";
  import { browser, storage } from "#imports";
  import {
    EMPTY_PROVIDER_USAGE,
    normalizeProviderUsageSummary,
    PROVIDER_USAGE_KEY,
    type ProviderUsageSummary,
  } from "@/entrypoints/content/provider-usage";

  let { mode }: { mode: "api" | "gemini" | "webgpu" } = $props();
  let summary = $state<ProviderUsageSummary>({
    api: { ...EMPTY_PROVIDER_USAGE.api },
    gemini: { ...EMPTY_PROVIDER_USAGE.gemini },
    local: { ...EMPTY_PROVIDER_USAGE.local },
  });
  let current = $derived(mode === "gemini" ? summary.gemini : mode === "api" ? summary.api : summary.local);

  function formatMetric(value: number | null): string {
    return value === null ? "Unknown" : value.toLocaleString();
  }

  onMount(() => {
    let active = true;
    const load = async () => {
      try {
        const stored = await storage.getItem<ProviderUsageSummary>(PROVIDER_USAGE_KEY);
        if (active) summary = normalizeProviderUsageSummary(stored ?? undefined);
      } catch {
        if (active) summary = normalizeProviderUsageSummary(undefined);
      }
    };
    void load();

    const onChanged = (
      changes: Record<string, { newValue?: unknown }>,
      areaName: string,
    ) => {
      if (areaName !== "local") return;
      const change = changes["provider-usage"] ?? changes[PROVIDER_USAGE_KEY];
      if (!change) return;
      summary = normalizeProviderUsageSummary(
        change.newValue as ProviderUsageSummary | undefined,
      );
    };
    browser.storage.onChanged.addListener(onChanged);
    return () => {
      active = false;
      browser.storage.onChanged.removeListener(onChanged);
    };
  });

  const title = $derived(mode === "gemini" ? "Gemini usage" : mode === "api" ? "API usage" : "Local model usage");
  const requestLabel = $derived(mode === "webgpu" ? "Local model calls" : "API requests");
</script>

<section class="panel-card !p-2.5 flex flex-col gap-2" aria-label={title + " summary"}>
  <div class="flex items-center justify-between gap-2">
    <span class="kicker">{title}</span>
    <span class="text-[9px] uppercase tracking-wide text-[var(--text-dim)]">Local totals</span>
  </div>
  <div class="grid grid-cols-2 gap-1.5">
    <div class="rounded-md bg-[var(--bg-void)] border border-[var(--border-faint)] px-2 py-1.5">
      <div class="text-[9px] uppercase tracking-wide text-[var(--text-dim)]">{requestLabel}</div>
      <div class="text-xs font-semibold text-[var(--text-primary)]">{current.apiRequests.toLocaleString()}</div>
    </div>
    <div class="rounded-md bg-[var(--bg-void)] border border-[var(--border-faint)] px-2 py-1.5" title="Provider-reported input tokens; cached input, when present, is included.">
      <div class="text-[9px] uppercase tracking-wide text-[var(--text-dim)]">Input tokens</div>
      <div class="text-xs font-semibold text-[var(--text-primary)]">{formatMetric(current.inputTokens)}</div>
    </div>
    <div class="rounded-md bg-[var(--bg-void)] border border-[var(--border-faint)] px-2 py-1.5">
      <div class="text-[9px] uppercase tracking-wide text-[var(--text-dim)]">Output tokens</div>
      <div class="text-xs font-semibold text-[var(--text-primary)]">{formatMetric(current.outputTokens)}</div>
    </div>
    <div class="rounded-md bg-[var(--bg-void)] border border-[var(--border-faint)] px-2 py-1.5">
      <div class="text-[9px] uppercase tracking-wide text-[var(--text-dim)]">Thinking tokens</div>
      <div class="text-xs font-semibold text-[var(--text-primary)]">{formatMetric(current.thinkingTokens)}</div>
    </div>
    <div class="rounded-md bg-[var(--bg-void)] border border-[var(--border-faint)] px-2 py-1.5">
      <div class="text-[9px] uppercase tracking-wide text-[var(--text-dim)]">Cached input</div>
      <div class="text-xs font-semibold text-[var(--text-primary)]">{formatMetric(current.cachedInputTokens)}</div>
    </div>
    <div class="rounded-md bg-[var(--bg-void)] border border-[var(--border-faint)] px-2 py-1.5">
      <div class="text-[9px] uppercase tracking-wide text-[var(--text-dim)]">{mode === "gemini" ? "Est. paid cost (USD)" : "Cost (USD)"}</div>
      <div class="text-xs font-semibold text-[var(--text-primary)]">
        {current.apiRequests === 0 ? "Unknown" : current.estimatedCostUsd === null ? "Unknown" : `$${current.estimatedCostUsd.toFixed(6)}`}
      </div>
    </div>
  </div>
  {#if mode === "gemini"}
    <p class="text-[9px] leading-snug text-[var(--text-dim)]">
      Paid-tier estimate from Google’s published token rates; it remains unknown if required usage fields or a model rate are unavailable. Excludes taxes, discounts, and cache storage. <a class="underline hover:text-[var(--text-primary)]" href="https://aistudio.google.com/docs/pricing" target="_blank" rel="noreferrer">Rate source</a>.
    </p>
  {:else if mode === "api"}
    <p class="text-[9px] leading-snug text-[var(--text-dim)]">
      Token fields are counted only when the API reports them; endpoint pricing is not estimated. Thinking and cached counts are never inferred.
    </p>
  {:else}
    <p class="text-[9px] leading-snug text-[var(--text-dim)]">
      Local token counts appear only when WebLLM reports them. This extension does not estimate tokens from text length or assign a cost to local runs.
    </p>
  {/if}
</section>
