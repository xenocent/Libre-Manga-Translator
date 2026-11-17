<script lang="ts">
  import { Zap, Globe, Plus, X } from "lucide-svelte";
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
  let domainList = $state<Record<string, boolean>>({});
  let newDomain = $state("");
  let showDomainList = $state(false);

  async function loadState() {
    const [storedScope, domains] = await Promise.all([
      storage.getItem<AutoScope>(AUTO_SCOPE_KEY),
      storage.getItem<Record<string, boolean>>(AUTO_DOMAINS_KEY),
    ]);
    scope = storedScope === "domain" ? "domain" : "global";
    domainEnabled = domains?.[host] === true;
    domainList = domains ?? {};
    scopeLoaded = true;
  }

  $effect(() => {
    void loadState();
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
    const next = withHost({ scope, domains: domainList }, host, enabled);
    domainEnabled = enabled;
    domainList = next.domains;
    await storage.setItem(AUTO_DOMAINS_KEY, next.domains);
  }

  async function addDomain(domain: string) {
    const clean = domain.trim().toLowerCase();
    if (!clean) return;
    const next = withHost({ scope, domains: domainList }, clean, true);
    domainList = next.domains;
    await storage.setItem(AUTO_DOMAINS_KEY, next.domains);
    newDomain = "";
  }

  async function removeDomain(domain: string) {
    const next = withHost({ scope, domains: domainList }, domain, false);
    domainList = next.domains;
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
              {domainEnabled ? "Remove this site" : "Add this site"}
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

  <!-- Saved sites (whitelist) — shown regardless of autoTranslate so you can
       review/edit the list when auto is off. A whitelisted site shows the HUD
       bar even with auto-translate off, so managing the list must not depend
       on the toggle. -->
  {#if scopeLoaded}
    <div class="mt-2 pt-2 border-t border-[var(--border-faint)]">
      <button
        type="button"
        onclick={() => (showDomainList = !showDomainList)}
        class="text-[10px] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
      >
        {showDomainList ? "Hide" : "Manage"} saved sites ({Object.keys(domainList).length})
      </button>
      {#if showDomainList}
        <div class="mt-1.5 space-y-1">
          {#each Object.entries(domainList) as [domain] (domain)}
            <div class="flex items-center justify-between gap-1.5 bg-[var(--bg-void)] px-1.5 py-1 rounded border border-[var(--border-faint)]">
              <span class="font-mono text-[10px] text-[var(--text-primary)] truncate">{domain}</span>
              <button
                type="button"
                onclick={() => removeDomain(domain)}
                class="shrink-0 p-0.5 rounded text-[var(--text-dim)] hover:text-[var(--accent-rose)] transition-colors cursor-pointer"
                aria-label="Remove {domain}"
              >
                <X size={11} />
              </button>
            </div>
          {:else}
            <p class="text-[10px] text-[var(--text-dim)] italic">No sites saved yet.</p>
          {/each}
        </div>

        <div class="mt-1.5 flex gap-1">
          <input
            type="text"
            bind:value={newDomain}
            onkeydown={(e) => e.key === "Enter" && addDomain(newDomain)}
            placeholder="example.com"
            class="flex-1 bg-[var(--bg-void)] border border-[var(--border-faint)] rounded px-1.5 py-1 text-[10px] font-mono outline-none focus:border-[var(--accent-emerald)]/40"
          />
          <button
            type="button"
            onclick={() => addDomain(newDomain)}
            disabled={!newDomain.trim()}
            class="shrink-0 px-2 py-1 rounded bg-[var(--surface-panel)] border border-[var(--accent-emerald)]/40 text-[var(--accent-emerald)] text-[10px] font-medium hover:bg-[var(--accent-emerald)]/10 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Plus size={11} />
          </button>
        </div>
      {/if}
    </div>
  {/if}
</div>
