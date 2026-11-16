import { describe, expect, it } from "bun:test";
import {
  allowsHost,
  DEFAULT_SCOPE,
  looksLikeReaderPage,
  withHost,
} from "../../src/entrypoints/content/auto-translate-scope";

describe("auto-translate scope", () => {
  it("defaults to domain scope — nothing auto-translates until a site is added", () => {
    // A fresh install must not auto-translate every tab. The default is the
    // whitelist: an unlisted host (Instagram, a random reader) is refused until
    // the user explicitly opts in. Global scope is opt-in, not the start state.
    expect(DEFAULT_SCOPE.scope).toBe("domain");
    expect(allowsHost(DEFAULT_SCOPE, "mangadex.org")).toBe(false);
    expect(allowsHost({ scope: "global", domains: {} }, "example.com")).toBe(
      true,
    );
  });

  it("is a whitelist, not a blacklist", () => {
    // The whole point of domain scope is that unlisted hosts are refused. A
    // blacklist would let a newly visited reader start spending on its own.
    const state = { scope: "domain" as const, domains: { "reader.test": true } };
    expect(allowsHost(state, "reader.test")).toBe(true);
    expect(allowsHost(state, "other.test")).toBe(false);
    expect(allowsHost(state, "catalog.test")).toBe(false);
  });

  it("adds and removes one host without disturbing the others", () => {
    // Start from domain scope: `withHost` records a host decision, it does not
    // change the scope, so a global state would still allow the removed host.
    let state = withHost({ scope: "domain" as const, domains: {} }, "a.test", true);
    state = withHost(state, "b.test", true);
    state = withHost(state, "a.test", false);
    expect(state.domains).toEqual({ "b.test": true });
    expect(allowsHost(state, "a.test")).toBe(false);
  });

  it("does not mutate the state it is given", () => {
    const before = { scope: "domain" as const, domains: {} };
    const after = withHost(before, "x.test", true);
    expect(before.domains).toEqual({});
    expect(after.domains).toEqual({ "x.test": true });
  });
});

describe("reader page shape", () => {
  it("rejects anything under the size floor", () => {
    expect(looksLikeReaderPage(300, 400, 1200)).toBe(false);
    expect(looksLikeReaderPage(800, 300, 1200)).toBe(false);
  });

  it("accepts a full-width page", () => {
    expect(looksLikeReaderPage(900, 1300, 1200)).toBe(true);
  });

  it("rejects a catalog cover — big, but a grid cell", () => {
    // 600x800 covers are common on catalog grids. Size alone lets them through;
    // width share is what separates them from a page.
    expect(looksLikeReaderPage(600, 800, 1400)).toBe(false);
  });

  it("accepts a tall webtoon strip narrower than the column", () => {
    expect(looksLikeReaderPage(700, 4000, 1400)).toBe(true);
  });

  it("does not divide by a zero document width", () => {
    expect(looksLikeReaderPage(900, 1300, 0)).toBe(true);
  });
});
