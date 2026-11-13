<script lang="ts">
  import { Zap, Globe } from "lucide-svelte";
  import { storage } from "#imports";
  import {
    AUTO_DOMAINS_KEY,
    AUTO_SCOPE_KEY,
    withHost,
    type AutoScope,
  } from "@/entrypoints/content/auto-translate-scope";

  let {
    autoTranslate = $bindable(false),
    concurrency = $bindable(1),
  }: {
    autoTranslate?: boolean;
    concurrency?: number;
  } = $props();

  const host = $state(
    typeof location !== "undefined" ? location.hostname : "",
  );

  let scope = $state<AutoScope>("global");
  let domainEnabled = $state(false);
  let scopeLoaded = $state(false);

  $effect(() => {
    void (async () => {
      const [storedScope, domains] = await Promise.all([
        storage.getItem<AutoScope>(AUTO_SCOPE_KEY),
        storage.getItem<Record<string, boolean>>(AUTO_DOMAINS_KEY),
      ]);
      scope = storedScope === "domain" ? "domain" : "global";
      domainEnabled = domains?.[host] === true;
      scopeLoaded = true;
    })();
  });

  /**
   * Enabling auto-translate on a host the scope refuses would do nothing, so
   * this asks once: this site only, or everywhere. The choice is written before
   * the toggle is set, so the content script never starts in an ambiguous state.
   */
  async function chooseScope(next: AutoScope) {
    scope = next;
    await storage.setItem(AUTO_SCOPE_KEY, next);
    if (next === "domain" && !domainEnabled) await toggleHost(true);
  }

  async function toggleHost(enabled: boolean) {
    const domains =
      (await storage.getItem<Record<string, boolean>>(AUTO_DOMAINS_KEY)) ?? {};
    const next = withHost({ scope, domains }, host, enabled);
    domainEnabled = enabled;
    await storage.setItem(AUTO_DOMAINS_KEY, next.domains);
  }
</script>

<div class="panel-card !p-2.5">
  <div class="flex items-center justify-between gap-3">
    <div class="flex items-center gap-2.5 min-w-0">
      <div
        class="shrink-0 w-6 h-6 rounded-md border flex items-center justify-center bg-[var(--bg-void)] border-[var(--border-faint)] text-[var(--text-dim)]"
      >
        <Zap size={13} />
      </div>
      <div class="flex flex-col min-w-0">
        <span class="text-xs font-medium leading-tight text-[var(--text-primary)]">
          Auto-translate pages
        </span>
        <span class="text-[11px] text-[var(--text-muted)] leading-tight">
          Translate pages automatically as you scroll
        </span>
      </div>
    </div>
    <label class="switch-cyber is-emerald ml-2">
      <input type="checkbox" bind:checked={autoTranslate} />
      <span class="track"><span class="thumb"></span></span>
    </label>
  </div>

  {#if autoTranslate}
    <!-- Scope: the decision that stops a catalog homepage from spending tokens -->
    {#if scopeLoaded}
      <div class="mt-2.5 pt-2 border-t border-[var(--border-faint)] space-y-1.5">
        <div class="flex items-center gap-1.5">
          <Globe size={11} class="text-[var(--text-dim)] shrink-0" />
          <span class="text-[11px] font-medium text-[var(--text-muted)]">
            Where to auto-translate
          </span>
        </div>
        <div class="grid grid-cols-2 gap-1 bg-[var(--bg-void)] p-1 rounded-lg border border-[var(--border-faint)]">
          <button
            type="button"
            onclick={() => chooseScope("domain")}
            aria-pressed={scope === "domain"}
            class="py-1 px-1 rounded-md text-[11px] transition-colors cursor-pointer border
                   {scope === 'domain'
                     ? 'bg-[var(--surface-panel)] text-[var(--accent-emerald)] font-medium border-[var(--accent-emerald)]/40'
                     : 'text-[var(--text-dim)] hover:text-[var(--text-primary)] border-transparent'}"
          >
            This site only
          </button>
          <button
            type="button"
            onclick={() => chooseScope("global")}
            aria-pressed={scope === "global"}
            class="py-1 px-1 rounded-md text-[11px] transition-colors cursor-pointer border
                   {scope === 'global'
                     ? 'bg-[var(--surface-panel)] text-[var(--accent-cyan)] font-medium border-[var(--accent-cyan)]/40'
                     : 'text-[var(--text-dim)] hover:text-[var(--text-primary)] border-transparent'}"
          >
            Every site
          </button>
        </div>

        {#if scope === "domain"}
          <div class="flex items-center justify-between gap-2">
            <span class="font-mono text-[10px] text-[var(--text-dim)] truncate" title={host}>
              {host || "unknown host"}
            </span>
            <button
              type="button"
              onclick={() => toggleHost(!domainEnabled)}
              class="shrink-0 text-[10px] px-1.5 py-px rounded border transition-colors cursor-pointer
                     {domainEnabled
                       ? 'text-[var(--accent-rose)] border-[var(--accent-rose)]/40 hover:bg-[var(--accent-rose)]/10'
                       : 'text-[var(--accent-emerald)] border-[var(--accent-emerald)]/40 hover:bg-[var(--accent-emerald)]/10'}"
            >
              {domainEnabled ? "Remove from list" : "Add this site"}
            </button>
          </div>
          {#if !domainEnabled}
            <p class="text-[10px] text-[var(--text-dim)] leading-snug">
              Not in the list — auto-translate stays off here until you add it.
            </p>
          {/if}
        {/if}
      </div>

      <div class="mt-2.5 pt-2 border-t border-[var(--border-faint)]">
        <div class="flex items-center justify-between mb-1">
          <span class="text-[11px] font-medium text-[var(--text-muted)]">
            Parallel limit
          </span>
          <span class="text-[11px] font-medium px-1.5 py-px rounded bg-[var(--bg-void)] text-[var(--accent-emerald)] border border-[var(--accent-emerald)]/30">
            {concurrency}
          </span>
        </div>
        <input
          type="range"
          min="1"
          max="10"
          step="1"
          bind:value={concurrency}
          disabled={!autoTranslate}
          class="slider-cyber is-emerald"
        />
        <div class="flex justify-between text-[10px] text-[var(--text-dim)] mt-0.5">
          <span>1 (sequential)</span>
          <span>10 (max)</span>
        </div>
      </div>
    {/if}
  {/if}
</div>
