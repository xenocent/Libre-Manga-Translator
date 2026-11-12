import { DefaultConfig } from "@/lib/configs";
import { getSiteRule } from "@/lib/adapters";
import { quickHash } from "./utils";
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

export function isPending(src: string): boolean {
  return bySrc.get(srcKeyOf(src)) === "pending";
}

export function isDone(src: string): boolean {
  return bySrc.get(srcKeyOf(src)) === "done";
}

export function getStatus(src: string): TranslationStatus {
  return bySrc.get(srcKeyOf(src)) ?? "idle";
}

export interface QueueProgress {
  active: number;
  queued: number;
  completed: number;
}

let queueCounts = { active: 0, queued: 0 };

/** Pages settled this document, including ones restored straight from cache. */
export function doneCount(): number {
  let done = 0;
  for (const status of bySrc.values()) if (status === "done") done++;
  return done;
}

function publishProgress(): void {
  document.dispatchEvent(
    new CustomEvent<QueueProgress>("lmt:queue-progress", {
      detail: { ...queueCounts, completed: doneCount() },
    }),
  );
}

/** Queue depth is owned by the auto/manual queue; the rest is registry state. */
export function setQueueCounts(active: number, queued: number): void {
  if (queueCounts.active === active && queueCounts.queued === queued) return;
  queueCounts = { active, queued };
  publishProgress();
}

export function getStatusByCacheKey(cacheKey: string): TranslationStatus {
  return byCacheKey.get(cacheKey) ?? "idle";
}

export function markPending(src: string, cacheKey?: string): void {
  const k = srcKeyOf(src);
  bySrc.set(k, "pending");
  if (cacheKey) byCacheKey.set(cacheKey, "pending");
  document.dispatchEvent(
    new CustomEvent("lmt:translation-status", {
      detail: { src, cacheKey, status: "pending" as const },
    }),
  );
}

export function markDone(src: string, cacheKey?: string): void {
  bySrc.set(srcKeyOf(src), "done");
  if (cacheKey) {
    byCacheKey.set(cacheKey, "done");
  } else {
    // Overlay calls markDone(originalSrc) without the cache key. Without this
    // sweep the byCacheKey entry stays "pending" forever and the second-run
    // guard (getStatusByCacheKey === "pending") deadlocks every retry.
    const suffix = `-${pageImageHash(src)}`;
    for (const [key, status] of byCacheKey) {
      if (status === "pending" && key.endsWith(suffix)) {
        byCacheKey.set(key, "done");
      }
    }
  }
  document.dispatchEvent(
    new CustomEvent("lmt:translation-status", {
      detail: { src, cacheKey, status: "done" as const },
    }),
  );
  publishProgress();
}

export function markIdle(src: string, cacheKey?: string): void {
  bySrc.delete(srcKeyOf(src));
  if (cacheKey) {
    byCacheKey.delete(cacheKey);
  } else {
    // Same leak as markDone: error/close paths without a key must still
    // release the pending cache-key claim, otherwise the retry guard sees
    // a stale "pending" and early-returns forever.
    const suffix = `-${pageImageHash(src)}`;
    for (const key of [...byCacheKey.keys()]) {
      if (key.endsWith(suffix)) byCacheKey.delete(key);
    }
  }
  document.dispatchEvent(
    new CustomEvent("lmt:translation-status", {
      detail: { src, cacheKey, status: "idle" as const },
    }),
  );
  publishProgress();
}
