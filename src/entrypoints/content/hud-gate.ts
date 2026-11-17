/**
 * HUD visibility gate — reverted to ALWAYS SHOW.
 *
 * Attempts to conditionally hide the pill/readout by auto-translate state or
 * whitelist caused more problems than they solved (bar/translation disagreeing
 * per tab, sites that are manga sites by adapter but not by whitelist never
 * showing, etc.). Reverted: the store is a constant `true`, so the HUD shows on
 * every tab as before. Kept as a store so the components that already subscribe
 * to `$hudEnabledStore` still work unchanged.
 *
 * The per-tab manual toggle from the popup is now a no-op (the bar always
 * shows anyway) but the popup button and its message handler are left intact
 * so the control still exists.
 */

import { writable } from "svelte/store";

export const hudEnabled = writable<boolean>(true);

/** No-op: kept for API compatibility with the popup message handler. */
export function initHudGate(): () => void {
  hudEnabled.set(true);
  return () => {};
}

/** No-op: the bar always shows regardless of the per-tab toggle. */
export function setManualHud(_on: boolean): void {
  // Intentionally empty — see module comment.
}
