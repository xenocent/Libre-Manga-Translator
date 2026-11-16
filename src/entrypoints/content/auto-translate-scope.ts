/**
 * Auto-translate scope: which hosts may translate on their own.
 *
 * Auto-translate is a page-level convenience, not a browser-level one. Left
 * global it follows every tab, so a catalog homepage — hundreds of cover
 * thumbnails, none of them a page — burns tokens for artwork nobody wanted
 * translated. This module holds the decision as a pure predicate so it can be
 * asserted without a DOM.
 */

export const AUTO_SCOPE_KEY = "sync:auto-translate-scope";
export const AUTO_DOMAINS_KEY = "sync:auto-translate-domains";

/** `"global"` = every site; `"domain"` = only hosts in `domains`. */
export type AutoScope = "global" | "domain";

export interface AutoScopeState {
  scope: AutoScope;
  domains: Record<string, boolean>;
}

/**
 * What a first-time toggle should assume before the user is asked.
 *
 * Defaults to `"domain"` with an empty allowlist: nothing auto-translates until
 * the user explicitly adds a site. Global scope is opt-in, not the starting
 * state — a fresh install on Instagram must not burn tokens on fashion photos.
 */
export const DEFAULT_SCOPE: AutoScopeState = { scope: "domain", domains: {} };

/**
 * May this host translate on its own?
 *
 * `"domain"` is a whitelist, not a blacklist: an unlisted host is refused.
 * That is the safe default for a scope the user opted into specifically to
 * stop spending on sites they never meant to touch.
 */
export function allowsHost(state: AutoScopeState, host: string): boolean {
  if (state.scope !== "domain") return true;
  return state.domains[host] === true;
}

/** Store one host's decision without disturbing the others. */
export function withHost(
  state: AutoScopeState,
  host: string,
  enabled: boolean,
): AutoScopeState {
  const domains = { ...state.domains };
  if (enabled) domains[host] = true;
  else delete domains[host];
  return { ...state, domains };
}

/**
 * Does this element look like a page rather than a thumbnail?
 *
 * Only used when no site rule supplies an `imageSelector` — with a rule, the
 * selector is authoritative and this never runs. The size floor alone is not
 * enough: catalog covers regularly exceed 500px. The distinguishing shape is
 * that a page is a full-width column, while a cover is one cell of a grid, so
 * a page occupies most of the document's width and is tall enough to read.
 */
export function looksLikeReaderPage(
  width: number,
  height: number,
  docWidth: number,
): boolean {
  if (width <= 500 || height <= 500) return false;
  // A page spans the reading column; a grid cell is a fraction of it. The 0.7
  // floor is the narrowest reader column seen in practice (sidebar layouts).
  if (docWidth <= 0) return true;
  if (width >= docWidth * 0.7) return true;
  // A tall webtoon strip can be narrower than the column but is far taller than
  // any thumbnail; one screen of height is the floor.
  return height >= 1200 && width >= 400;
}
