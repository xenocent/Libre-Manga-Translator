import { DefaultConfig } from "@/lib/configs";
import { getSiteRule } from "@/lib/adapters";
import { quickHash } from "./utils";
import { dlog, shortKey } from "@/lib/debug/timeline";
import {
  buildCacheKey,
  pageSourceKeyOf,
  PAGE_CACHE_PREFIX,
  type PageCacheKey,
} from "./page-identity";
import { storage } from "#imports";

/**
 * LMT-only, content-isolated translation registry.
 * Strict block: pending → any second request for same src/cacheKey returns immediately.
 * Error/crash → markIdle (delete) so pill or queue can retrigger.
 * No window.__LMT__ exposure — page world cannot see or bypass.
 */

export type TranslationStatus = "idle" | "pending" | "done";

const bySrc = new Map<string, TranslationStatus>(); // srcKey(originalSrc) → status
const byCacheKey = new Map<string, TranslationStatus>(); // local:page-cache-… → status
/**
 * The exact cache key each src claimed, so release never has to re-derive it.
 * The key format embeds the URL at claim time; recomputing it at release time
 * makes the sweep miss whenever the reader changed URL in between.
 */
const claimedCacheKey = new Map<string, string>(); // srcKey → cacheKey

export function srcKeyOf(src: string): string {
  return pageSourceKeyOf(src, window.location.href);
}

/** How far the ordinal-page-index key format is probed. */
const LEGACY_PROBE_PAGES = 64;

export function pageImageHash(originalSrc: string): string {
  return pageSourceKeyOf(originalSrc, window.location.href);
}

export async function resolveCacheKey(
  originalSrc: string,
): Promise<PageCacheKey> {
  const targetLang =
    (await storage.getItem<string>("sync:target-lang")) ?? DefaultConfig.targetLang;
  return buildCacheKey(targetLang, window.location, originalSrc);
}

/**
 * A page record left under an earlier key format (an ordinal page index).
 * Probed by name; `get(null)` would drag every cached data URL into memory.
 */
export async function findLegacyPageCache(
  originalSrc: string,
): Promise<PageCache | undefined> {
  const { seriesName, chapterId } = await getSiteRule();
  const targetLang =
    (await storage.getItem<string>("sync:target-lang")) ?? DefaultConfig.targetLang;
  // Raw, not normalized: those keys hashed the URL exactly as served.
  const imgHash = quickHash(originalSrc);
  const name = `${seriesName}-${chapterId}`;
  const keys: string[] = [];
  for (let page = 0; page <= LEGACY_PROBE_PAGES; page++) {
    keys.push(`${PAGE_CACHE_PREFIX}${targetLang}-${name}-p${page}-${imgHash}`);
  }
  keys.push(`${PAGE_CACHE_PREFIX}${targetLang}-${name}-${imgHash}`);

  const found = await browser.storage.local.get(keys);
  for (const key of keys) {
    const value = found[key] as PageCache | undefined;
    if (value?.bboxes) return value;
  }
  return undefined;
}

/**
 * Deletes every persisted record for this page, current and legacy format.
 *
 * Returns the number of records removed. Never enumerates `storage.local` —
 * each record is a multi-megabyte data URL, so deletion is by exact key only:
 * the current cache key plus the same bounded probe set `findLegacyPageCache`
 * uses.
 *
 * Backs the overlay's persistent "translate again" control: the in-session
 * retranslate (`handleBackToRefine`) already clears the in-memory inpaint cache,
 * but without this the stale record replays on the next page visit.
 */
export async function deletePageCache(originalSrc: string): Promise<number> {
  const current = await resolveCacheKey(originalSrc);
  const { seriesName, chapterId } = await getSiteRule();
  const targetLang =
    (await storage.getItem<string>("sync:target-lang")) ?? DefaultConfig.targetLang;
  const imgHash = quickHash(originalSrc);
  const name = `${seriesName}-${chapterId}`;
  const keys: string[] = [current];
  for (let page = 0; page <= LEGACY_PROBE_PAGES; page++) {
    keys.push(`${PAGE_CACHE_PREFIX}${targetLang}-${name}-p${page}-${imgHash}`);
  }
  keys.push(`${PAGE_CACHE_PREFIX}${targetLang}-${name}-${imgHash}`);

  const existing = await browser.storage.local.get(keys);
  const present = keys.filter((k) => existing[k] !== undefined);
  if (present.length > 0) {
    await browser.storage.local.remove(present);
  }
  return present.length;
}

/**
 * ── Key-level accessors ──────────────────────────────────────────────────
 * `pageSourceKeyOf` HASHES its input, so it is not idempotent: passing an
 * already-derived key to a `src`-taking function looks up `hash(hash(src))`,
 * which never matches the entry `markPending(src)` wrote. That made every
 * guard below silently read "idle" for pages that were pending or done, so
 * the documented strict block did nothing — scan re-observed finished pages
 * and a second pipeline could claim an image already in flight.
 *
 * These take a key that `srcKeyOf` already produced and never re-hash it.
 * Use them whenever you hold a key; the `src` wrappers derive exactly once.
 */
export function statusOfKey(key: string): TranslationStatus {
  return bySrc.get(key) ?? "idle";
}

export function isPendingKey(key: string): boolean {
  return bySrc.get(key) === "pending";
}

export function isDoneKey(key: string): boolean {
  return bySrc.get(key) === "done";
}

export function isPending(src: string): boolean {
  return isPendingKey(srcKeyOf(src));
}

export function isDone(src: string): boolean {
  return isDoneKey(srcKeyOf(src));
}

export function getStatus(src: string): TranslationStatus {
  return statusOfKey(srcKeyOf(src));
}

export interface QueueProgress {
  active: number;
  queued: number;
  completed: number;
  /** Pages this document currently exposes as translation targets. */
  detected: number;
}

let queueCounts = { active: 0, queued: 0 };
let detectedCount = 0;

/** Pages settled this document, including ones restored straight from cache. */
export function doneCount(): number {
  let done = 0;
  for (const status of bySrc.values()) if (status === "done") done++;
  return done;
}

/**
 * How many qualifying pages the scanner currently sees. This is the "max
 * image" half of the readout: `completed` alone cannot say whether the chapter
 * is finished or the scanner simply never found the rest.
 */
export function getDetectedCount(): number {
  return detectedCount;
}

export function setDetectedCount(count: number): void {
  if (detectedCount === count) return;
  detectedCount = count;
  publishProgress();
}

function publishProgress(): void {
  document.dispatchEvent(
    new CustomEvent<QueueProgress>("lmt:queue-progress", {
      detail: {
        ...queueCounts,
        completed: doneCount(),
        detected: detectedCount,
      },
    }),
  );
}

/** Queue depth is owned by the auto/manual queue; the rest is registry state. */
export function setQueueCounts(active: number, queued: number): void {
  if (queueCounts.active === active && queueCounts.queued === queued) return;
  queueCounts = { active, queued };
  dlog("queue", "depth", { active, queued, detected: detectedCount });
  publishProgress();
}

export function getStatusByCacheKey(cacheKey: string): TranslationStatus {
  return byCacheKey.get(cacheKey) ?? "idle";
}

export function markPending(src: string, cacheKey?: string): void {
  const k = srcKeyOf(src);
  bySrc.set(k, "pending");
  if (cacheKey) byCacheKey.set(cacheKey, "pending");
  dlog("registry", "pending", { page: shortKey(k) });
  document.dispatchEvent(
    new CustomEvent("lmt:translation-status", {
      detail: { src, cacheKey, status: "pending" as const },
    }),
  );
}

/**
 * Check-and-claim as ONE synchronous step.
 *
 * The caller used to do `if (getStatusByCacheKey(key) === "pending") markIdle()
 * else markPending()`. Both halves are wrong when the slot belongs to another
 * run: `markIdle` deletes the shared `bySrc` entry (releasing work still in
 * flight) and its suffix sweep clears the other run's cache-key claim too, so
 * a third dispatch is admitted and the page is paid for twice.
 *
 * Returns false when either layer is already claimed, and in that case writes
 * NOTHING — the holder keeps its claim and releases it on its own terminal
 * event. No `await` between the test and the write, so it cannot interleave.
 */
export function tryMarkPending(src: string, cacheKey?: string): boolean {
  const k = srcKeyOf(src);
  if (bySrc.get(k) === "pending") return false;
  if (cacheKey && byCacheKey.get(cacheKey) === "pending") return false;
  markPending(src, cacheKey);
  return true;
}

/**
 * Claim the cache-key layer only if it is free, and remember WHICH key this
 * src claimed. Recall matters: the key embeds `origin+pathname` from the URL
 * at claim time, so a reader that changes URL mid-page (SPA chapter swap)
 * would otherwise make the release-time suffix sweep miss its own key and
 * leave a stale "pending" that blocks the page for the document's lifetime.
 */
export function claimCacheKey(src: string, cacheKey: string): boolean {
  if (byCacheKey.get(cacheKey) === "pending") return false;
  byCacheKey.set(cacheKey, "pending");
  claimedCacheKey.set(srcKeyOf(src), cacheKey);
  return true;
}

/** The exact cache key this src claimed, if its claim is still open. */
export function claimedCacheKeyOf(src: string): string | undefined {
  return claimedCacheKey.get(srcKeyOf(src));
}

function releaseCacheKey(src: string, cacheKey?: string): boolean {
  const k = srcKeyOf(src);
  const owned = cacheKey ?? claimedCacheKey.get(k);
  claimedCacheKey.delete(k);
  if (owned) {
    byCacheKey.delete(owned);
    return true;
  }
  // Last resort for callers that never went through claimCacheKey: sweep by
  // suffix. Only "pending" entries are touched — deleting a "done" marker
  // here would make a finished page look unclaimed to any later reader.
  const suffix = `-${pageImageHash(src)}`;
  for (const [key, status] of byCacheKey) {
    if (status === "pending" && key.endsWith(suffix)) byCacheKey.delete(key);
  }
  return false;
}

export function markDone(src: string, cacheKey?: string): void {
  bySrc.set(srcKeyOf(src), "done");
  if (cacheKey) {
    byCacheKey.set(cacheKey, "done");
  } else {
    // Overlay calls markDone(originalSrc) without the cache key. Without this
    // the byCacheKey entry stays "pending" forever and the second-run guard
    // (getStatusByCacheKey === "pending") deadlocks every retry.
    const k = srcKeyOf(src);
    const owned = claimedCacheKey.get(k);
    if (owned) {
      byCacheKey.set(owned, "done");
      claimedCacheKey.delete(k);
    } else {
      const suffix = `-${pageImageHash(src)}`;
      for (const [key, status] of byCacheKey) {
        if (status === "pending" && key.endsWith(suffix)) {
          byCacheKey.set(key, "done");
        }
      }
    }
  }
  document.dispatchEvent(
    new CustomEvent("lmt:translation-status", {
      detail: { src, cacheKey, status: "done" as const },
    }),
  );
  dlog("registry", "done", {
    page: shortKey(srcKeyOf(src)),
    completed: doneCount(),
    detected: detectedCount,
  });
  publishProgress();
}

export function markIdle(src: string, cacheKey?: string): void {
  bySrc.delete(srcKeyOf(src));
  releaseCacheKey(src, cacheKey);
  document.dispatchEvent(
    new CustomEvent("lmt:translation-status", {
      detail: { src, cacheKey, status: "idle" as const },
    }),
  );
  dlog("registry", "idle (slot released, retryable)", {
    page: shortKey(srcKeyOf(src)),
    completed: doneCount(),
    detected: detectedCount,
  });
  publishProgress();
}
