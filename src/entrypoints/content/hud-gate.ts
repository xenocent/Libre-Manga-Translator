/**
 * Reactive HUD visibility gate.
 *
 * The pill and the progress readout render on every tab the content script
 * loads into, which read as the extension invading sites with nothing to
 * translate (YouTube, WhatsApp, Google, Binance). This store holds the single
 * boolean both components subscribe to, so flipping it hides/shows the HUD
 * without unmounting.
 *
 * The user's rule, verbatim: the HUD is completely gone when auto-translate is
 * OFF and the host is NOT whitelisted. It shows when the host is a saved manga
 * site (rawkuma, manga-one, user-saved) or when auto-translate is actively
 * running here. Plus a per-tab manual override from the popup.
 *
 * So the gate is: show iff
 *   • manual override, OR
 *   • the host is explicitly whitelisted (a saved site, shown even when
 *     auto-translate is off so the pill is on the homepage), OR
 *   • auto-translate is ON and targeting this host.
 *
 * Note we cannot just use `allowsHost`: with global scope it returns true for
 * every host, which would reopen the HUD everywhere the moment scope is
 * global — even with auto-translate off. Hence the explicit `autoEnabled`
 * factor for the auto-translate branch.
 *
 * The manual flag lives in this tab's content-script instance (no storage) —
 * a per-tab temporary "translate this page now", not a saved setting.
 */

import { writable } from "svelte/store";
import { AUTO_SCOPE_KEY, type AutoScopeState } from "./auto-translate-scope";
import { storage } from "#imports";

const AUTO_ENABLED_KEY = "sync:auto-translate";
const AUTO_DOMAINS_KEY = "sync:auto-translate-domains";

export const hudEnabled = writable<boolean>(false);

let autoEnabled = false;
let scopeState: AutoScopeState = { scope: "global", domains: {} };
let manualHud = false;

/**
 * Does this host qualify under the auto-translate scope?
 *
 * `allowsHost` alone is wrong here: with global scope it returns true for every
 * host, which would reopen the HUD everywhere even with auto-translate off. So
 * the auto branch is gated on `autoEnabled` explicitly.
 */
function hostAllowed(host: string): boolean {
  if (scopeState.scope === "global") return true;
  return scopeState.domains[host] === true;
}

function recompute(host: string): void {
  let reason: string;
  if (manualHud) {
    hudEnabled.set(true);
    reason = "manual toggle";
  } else if (scopeState.domains[host] === true) {
    // A saved manga site: explicitly in the whitelist. Shows the pill even
    // with auto-translate off so it's on the homepage. Checked regardless of
    // scope — a host the user explicitly saved counts as "saved" whether the
    // current scope is domain or global.
    hudEnabled.set(true);
    reason = "saved/whitelisted site";
  } else if (autoEnabled && hostAllowed(host)) {
    // Auto-translate actively running and targeting this host. The `autoEnabled`
    // factor is what keeps the HUD off on random tabs when auto-translate is off.
    hudEnabled.set(true);
    reason = "auto-translate on";
  } else {
    hudEnabled.set(false);
    reason = `hidden (auto=${autoEnabled ? "on" : "off"}, scope=${scopeState.scope}${scopeState.scope === "domain" ? ", listed=" + (scopeState.domains[host] === true) : ""})`;
  }
  // Decision is logged so a "gear still shows" / "bar missing" report can be
  // confirmed straight from the console without guessing which branch fired.
  console.debug(`[LMT] HUD ${reason}`);
}

/** Begin observing the settings that feed the gate, for this host. */
export function initHudGate(host: string): () => void {
  void storage.getItem<boolean>(AUTO_ENABLED_KEY).then((v) => {
    autoEnabled = v ?? false;
    recompute(host);
  });
  void storage.getItem<AutoScopeState>(AUTO_SCOPE_KEY).then((v) => {
    scopeState = v ?? scopeState;
    recompute(host);
  });

  const unwatchEnabled = storage.watch<boolean>(AUTO_ENABLED_KEY, (v) => {
    autoEnabled = v ?? false;
    recompute(host);
  });
  const unwatchScope = storage.watch<AutoScopeState>(AUTO_SCOPE_KEY, (v) => {
    scopeState = v ?? scopeState;
    recompute(host);
  });
  const unwatchDomains = storage.watch<Record<string, boolean>>(
    AUTO_DOMAINS_KEY,
    (domains) => {
      scopeState = { scope: scopeState?.scope ?? "domain", domains: domains ?? {} };
      recompute(host);
    },
  );

  return () => {
    unwatchEnabled?.();
    unwatchScope?.();
    unwatchDomains?.();
  };
}

/** Per-tab manual toggle from the popup toolbar. */
export function setManualHud(on: boolean, host: string): void {
  manualHud = on;
  recompute(host);
}
