import { describe, expect, it } from "bun:test";
import { pageSourceKeyOf } from "../../src/entrypoints/content/page-identity";

/**
 * Registry key contract.
 *
 * `pageSourceKeyOf` HASHES its input, so it is not idempotent. Every guard
 * that holds an already-derived key must use the `*Key` accessors; using a
 * `src`-taking one probes `hash(hash(src))`, which never matches the entry
 * `markPending(src)` wrote.
 *
 * When that mismatch shipped, the strict block silently did nothing:
 *   - `AutoTranslateQueue.enqueue` re-admitted pages already in flight,
 *   - the `translateFn().then(...)` callback saw "not pending" and called
 *     `markIdle(src)` while the overlay was still translating, and
 *   - the rescan re-enqueued the page once the slot was free, wrapping the
 *     same <img> again. The first overlay then spun on "Translating…" forever
 *     while the second reported done — the reported "stuck" page.
 */

const BASE = "https://reader.test/manga/66/chapter/1";
const SRC = "https://cdn.reader.test/manga/66/1/0007.jpg";

const contentFiles = [
  "src/entrypoints/content/index.ts",
  "src/entrypoints/content/auto-translate.ts",
  "src/lib/components/Overlay.svelte",
];

async function read(rel: string): Promise<string> {
  return Bun.file(new URL(`../../${rel}`, import.meta.url)).text();
}

describe("page source keys", () => {
  it("hashes a derived key to something else", () => {
    // The invariant the whole registry contract rests on. If this ever
    // becomes idempotent the guards could be simplified, but until then
    // passing a key to a src-taking function is always a bug.
    const once = pageSourceKeyOf(SRC, BASE);
    const twice = pageSourceKeyOf(once, BASE);
    expect(twice).not.toBe(once);
  });

  it("is stable for the same source and base", () => {
    expect(pageSourceKeyOf(SRC, BASE)).toBe(pageSourceKeyOf(SRC, BASE));
  });
});

describe("registry key-level accessors", () => {
  it("exposes both a key-level and a src-level form of every guard", async () => {
    const registry = await read("src/entrypoints/content/translation-registry.ts");
    // Holding a derived key must never require re-deriving it.
    for (const name of ["statusOfKey", "isPendingKey", "isDoneKey"]) {
      expect(registry).toContain(`export function ${name}(`);
    }
    // The src wrappers stay, so callers that hold a raw src read naturally.
    for (const name of ["isPending", "isDone", "getStatus"]) {
      expect(registry).toContain(`export function ${name}(`);
    }
    // And the wrappers must delegate to the key form, not duplicate the map
    // lookup — that duplication is what let the two drift apart.
    expect(registry).toMatch(
      /export function isPending\(src: string\): boolean \{\s*return isPendingKey\(srcKeyOf\(src\)\);/,
    );
  });
});

describe("claim ownership", () => {
  it("offers an atomic check-and-claim instead of check-then-markIdle", async () => {
    const registry = await read("src/entrypoints/content/translation-registry.ts");
    expect(registry).toContain("export function tryMarkPending(");
    expect(registry).toContain("export function claimCacheKey(");
    // A reader that loses the race must not clear the winner's claim.
    expect(registry).toMatch(
      /export function tryMarkPending[\s\S]*?if \(bySrc\.get\(k\) === "pending"\) return false;[\s\S]*?if \(cacheKey && byCacheKey\.get\(cacheKey\) === "pending"\) return false;[\s\S]*?markPending\(src, cacheKey\);/,
    );
  });

  it("never releases a claim it does not own", async () => {
    // The old read-then-release path in startTranslationPipeline deleted the
    // other run's bySrc entry and swept its cache-key claim, so a third
    // dispatch was admitted and the page was paid for twice.
    const content = await read("src/entrypoints/content/index.ts");
    expect(content).not.toMatch(
      /getStatusByCacheKey\(pendingCacheKey\) === "pending"\)\s*\{\s*Registry\.markIdle/,
    );
    expect(content).toContain("Registry.tryMarkPending(originalSrc)");
    expect(content).toContain("Registry.claimCacheKey(originalSrc, pendingCacheKey)");
  });

  it("remembers the claimed cache key so an SPA URL change cannot strand it", async () => {
    const registry = await read("src/entrypoints/content/translation-registry.ts");
    // Recomputing the key at release time used `window.location.href` of that
    // moment; the stored key was built from the href at claim time, so a
    // chapter swap in between made the suffix sweep miss its own entry.
    expect(registry).toContain("claimedCacheKey");
    expect(registry).toContain("export function claimedCacheKeyOf(");
    expect(registry).toMatch(
      /export function claimCacheKey\(src: string, cacheKey: string\)[\s\S]*?claimedCacheKey\.set\(srcKeyOf\(src\), cacheKey\);/,
    );
  });

  it("only sweeps pending entries as a last resort", async () => {
    const registry = await read("src/entrypoints/content/translation-registry.ts");
    // Deleting a "done" marker made a finished page look unclaimed later.
    expect(registry).toMatch(
      /for \(const \[key, status\] of byCacheKey\) \{\s*if \(status === "pending" && key\.endsWith\(suffix\)\) byCacheKey\.delete\(key\);/,
    );
  });
});

describe("no guard is fed an already-derived key", () => {
  it("only uses *Key accessors on variables produced by srcKeyOf", async () => {
    for (const file of contentFiles) {
      const source = await read(file);
      // Collect every local name assigned from srcKeyOf(...). Those hold a
      // derived key and must go through the *Key accessors.
      const derived = new Set<string>();
      for (const m of source.matchAll(
        /(?:const|let)\s+(\w+)\s*=\s*Registry\.srcKeyOf\(/g,
      )) {
        derived.add(m[1]!);
      }
      for (const key of derived) {
        const srcGuard = new RegExp(
          `Registry\\.(?:isPending|isDone|getStatus)\\(\\s*${key}\\s*\\)`,
        );
        // The reported bug: `const k = srcKeyOf(src); isPending(k)`.
        expect(source).not.toMatch(srcGuard);
      }
    }
  });
});

describe("doneCount — live vs cache-restored", () => {
  it("counts from liveDoneSrcs, not from the full bySrc map", async () => {
    // doneCount() used to filter bySrc for "done" entries, which included
    // cache-restored pages (loaded from storage, not translated this session).
    // A chapter restoring 15 cached pages + translating 2 live showed "17/17"
    // — hiding the 2 real pages the user watched translate.
    const registry = await read("src/entrypoints/content/translation-registry.ts");
    // doneCount must return the size of the dedicated live set, not filter bySrc.
    expect(registry).toMatch(
      /export function doneCount\(\): number \{\s*return liveDoneSrcs\.size;/,
    );
    // liveDoneSrcs must exist as a dedicated Set.
    expect(registry).toContain("const liveDoneSrcs = new Set<string>();");
  });

  it("exposes markLiveDone as a distinct entry point", async () => {
    const registry = await read("src/entrypoints/content/translation-registry.ts");
    expect(registry).toContain("export function markLiveDone(src: string): void {");
    // markLiveDone adds to the live set only — it must not also call markDone.
    expect(registry).toMatch(
      /export function markLiveDone\(src: string\): void \{\s*liveDoneSrcs\.add\(srcKeyOf\(src\)\);/,
    );
  });

  it("Overlay live success path calls both markDone and markLiveDone", async () => {
    const overlay = await read("src/lib/components/Overlay.svelte");
    // The live success path (executeTranslation → renderTranslations → done)
    // must report both: markDone for the registry done-state guard, and
    // markLiveDone for the honest "how many did we translate now" counter.
    expect(overlay).toContain("Registry.markLiveDone(");
  });

  it("Overlay cache-restore path does NOT call markLiveDone", async () => {
    const overlay = await read("src/lib/components/Overlay.svelte");
    // Cache-restored pages are translated in a previous session — the user
    // is not watching them now. markLiveDone must not be called from the
    // restore path or doneCount() over-counts.
    // Find the cache-restore function and assert markLiveDone is absent inside it.
    const restoreFn = overlay.match(
      /(?:async\s+)?function\s+(?:handleCacheRestore|restoreFromCache|applyCache)\w*\([\s\S]*?\n\}/,
    );
    // If no named restore function is found, fall back to a looser check:
    // count markLiveDone calls and assert they appear fewer times than markDone.
    if (restoreFn) {
      expect(restoreFn[0]).not.toContain("markLiveDone");
    } else {
      const liveCount = (overlay.match(/markLiveDone\(/g) ?? []).length;
      const doneCountCalls = (overlay.match(/(?<!Live)\bmarkDone\(/g) ?? []).length;
      // At least one markDone call that is NOT paired with markLiveDone —
      // that is the cache-restore call.
      expect(doneCountCalls).toBeGreaterThan(liveCount);
    }
  });
});
