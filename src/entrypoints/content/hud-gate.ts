/**
 * Reactive HUD visibility gate.
 *
 * The pill and the progress readout render on every tab the content script
 * loads into, which read as the extension invading sites with nothing to
 * translate (YouTube, WhatsApp, Google, Binance). This store holds the single
 * boolean both components subscribe to, so flipping it hides/shows the HUD
 * without unmounting.
 *
 * The value is recomputed from three inputs:
 *   • auto-translate enabled (sync) + host allowed (scope/domains) → allowed
 *   • host is a saved manga site (scope/domains even with auto-translate off)
 *   • the user manually turned the HUD on for THIS tab from the popup
 *
 * The manual flag lives in this tab's content-script instance (no storage) —
 * a per-tab temporary "translate this page now", not a saved setting.
 */

import { writable } from "svelte/store";
import { allowsHost, AUTO_SCOPE_KEY, type AutoScopeState } from "./auto-translate-scope";
import { storage } from "#imports";

const AUTO_DOMAINS_KEY = "sync:auto-translate-domains";

export const hudEnabled = writable<boolean>(false);

let scopeState: AutoScopeState | null = null;
let manualHud = false;

function recompute(host: string): void {
  // Manual per-tab override wins outright.
  if (manualHud) {
    hudEnabled.set(true);
    return;
  }
  // Saved manga site (rawkuma, manga-one, user-saved): pill shows on the
  // homepage even with auto-translate off. `allowsHost` is false for an
  // ordinary domain-scoped empty set, so random tabs stay gated off.
  if (scopeState && allowsHost(scopeState, host)) {
    hudEnabled.set(true);
    return;
  }
  hudEnabled.set(false);
}

/** Begin observing the scope settings that feed the gate, for this host. */
export function initHudGate(host: string): () => void {
  void storage.getItem<AutoScopeState>(AUTO_SCOPE_KEY).then((v) => {
    scopeState = v ?? scopeState;
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
    unwatchScope?.();
    unwatchDomains?.();
  };
}

/** Per-tab manual toggle from the popup toolbar. */
export function setManualHud(on: boolean, host: string): void {
  manualHud = on;
  recompute(host);
}
