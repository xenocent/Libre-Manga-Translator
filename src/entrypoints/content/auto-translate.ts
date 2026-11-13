import { resolveActiveSiteRule, type SiteRule } from "@/lib/adapters";
import { storage } from "#imports";
import * as Registry from "./translation-registry";
import { queryScopedTargets } from "./auto-translate-targets";
import { getTargetSource } from "./target-source";
import { dlog, shortKey } from "@/lib/debug/timeline";
import type { MangaTargetElement } from "@/lib/canvas";
import {
  allowsHost,
  AUTO_DOMAINS_KEY,
  AUTO_SCOPE_KEY,
  looksLikeReaderPage,
  type AutoScopeState,
} from "./auto-translate-scope";

export type TranslateFn = (img: MangaTargetElement) => Promise<void>;

export const MANUAL_CONCURRENCY = 3;

/**
 * Hard ceiling on how long one dispatch may hold its slot.
 *
 * Every other release path is event-driven: the overlay emits done or idle,
 * or the task rejects. If none of those ever arrives — a pipeline parked in a
 * layout wait, an overlay that never mounted, a promise that resolved after
 * the slot key changed — the slot is held for the life of the tab and, at a
 * concurrency of 1, the rest of the chapter never starts. This timer is the
 * backstop for exactly that, and it fires ONCE: it frees the slot and lets
 * the ordinary rescan retry the page. It is deliberately not a retry loop.
 *
 * The budget is the worst honest case for one page: local translate (480 s)
 * plus a quality inpaint (300 s) plus detection and slack.
 */
export const SLOT_MAX_MS = 15 * 60_000;

export class AutoTranslateQueue {
  private queue: { img: MangaTargetElement; fn: TranslateFn; key: string }[] = [];
  // Slots are held for the full pipeline lifetime and released on the
  // registry `lmt:translation-status` done/idle events — NOT when
  // translateFn settles (it resolves right after overlay mount, long
  // before detect/translate/inpaint finish).
  private inFlight = new Set<string>();
  private activeTargets = new WeakSet<MangaTargetElement>();
  private inFlightTargets = new Map<string, MangaTargetElement>();
  /** Per-slot watchdog, so no dispatch can hold a slot forever. */
  private slotTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private concurrency = 1;
  private seenKeys = new Set<string>();
  private lastTranslateFn: TranslateFn | null = null;
  private statusListener: ((e: Event) => void) | null = null;

  constructor() {
    this.statusListener = (e: Event) => {
      const detail = (e as CustomEvent<{ src?: string; status?: string }>)
        .detail;
      if (!detail || !detail.src) return;
      if (detail.status !== "done" && detail.status !== "idle") return;
      const k = Registry.srcKeyOf(detail.src);
      if (detail.status === "idle") {
        // Failure/close/error → allow retry via pill or rescan.
        // Must run even when the slot was already released on `done`:
        // done keeps seenKeys (anti-requeue while overlay is open), and the
        // close path fires idle after inFlight was deleted — without this,
        // the pill's second click is silently dropped by seenKeys forever.
        this.seenKeys.delete(k);
      }
      if (!this.inFlight.has(k)) return;
      this.inFlight.delete(k);
      this.clearSlotTimer(k);
      this.releaseTarget(k);
      // done → keep seenKeys so finished pages never requeue.
      if (this.lastTranslateFn) this.drain(this.lastTranslateFn);
    };
    document.addEventListener("lmt:translation-status", this.statusListener);
  }

  private releaseTarget(k: string) {
    this.clearSlotTimer(k);
    const target = this.inFlightTargets.get(k);
    if (!target) return;
    this.inFlightTargets.delete(k);
    this.activeTargets.delete(target);
  }

  private clearSlotTimer(k: string) {
    const timer = this.slotTimers.get(k);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.slotTimers.delete(k);
  }

  /**
   * Arm the backstop for one dispatch. Firing means the page produced no
   * terminal signal at all, so free the slot exactly once and let the reader's
   * rescan re-dispatch it. `markIdle` is what makes that retry possible —
   * without it the registry would keep the page claimed and the guard would
   * drop the rescan.
   */
  private armSlotTimer(k: string, src: string) {
    this.clearSlotTimer(k);
    const timer = setTimeout(() => {
      this.slotTimers.delete(k);
      if (!this.inFlight.has(k)) return;
      dlog("queue", "slot watchdog fired", {
        page: shortKey(k),
        afterMs: SLOT_MAX_MS,
      });
      this.inFlight.delete(k);
      this.releaseTarget(k);
      this.seenKeys.delete(k);
      Registry.markIdle(src);
      if (this.lastTranslateFn) this.drain(this.lastTranslateFn);
      this.publish();
    }, SLOT_MAX_MS);
    // A held Node timer must not keep a test process (or a worker) alive.
    (timer as { unref?: () => void }).unref?.();
    this.slotTimers.set(k, timer);
  }

  destroy() {
    if (this.statusListener) {
      document.removeEventListener(
        "lmt:translation-status",
        this.statusListener,
      );
      this.statusListener = null;
    }
    for (const timer of this.slotTimers.values()) clearTimeout(timer);
    this.slotTimers.clear();
  }

  setConcurrency(n: number) {
    const clamped = Math.min(10, Math.max(1, Math.trunc(n) || 1));
    if (clamped === this.concurrency) return;
    this.concurrency = clamped;
    if (this.lastTranslateFn && this.inFlight.size < this.concurrency && this.queue.length > 0) {
      this.drain(this.lastTranslateFn);
    }
  }

  getConcurrency() {
    return this.concurrency;
  }

  evict(img: MangaTargetElement) {
    const src = getTargetSource(img, true);
    if (!src) return;
    const k = Registry.srcKeyOf(src);
    this.seenKeys.delete(k);
    const wasInFlight = this.inFlight.delete(k);
    if (wasInFlight) this.releaseTarget(k);
    if (wasInFlight && this.lastTranslateFn) {
      this.drain(this.lastTranslateFn);
    } else {
      this.publish();
    }
  }

  enqueue(
    img: MangaTargetElement,
    translateFn: (img: MangaTargetElement) => Promise<void>,
  ) {
    const src = getTargetSource(img, true);
    if (!src) return;
    const k = Registry.srcKeyOf(src);
    if (
      // Key-level guards: `k` is already derived, and srcKeyOf hashes, so the
      // src-taking guards would probe hash(hash(src)) and never match. That
      // made this "strict block" inert.
      Registry.isPendingKey(k) ||
      this.inFlight.has(k) ||
      Registry.statusOfKey(k) === "done" ||
      this.seenKeys.has(k) ||
      this.queue.some((e) => e.img === img)
    )
      return;
    this.seenKeys.add(k);
    this.queue.push({ img, fn: translateFn, key: k });
    this.lastTranslateFn = translateFn;
    dlog("queue", "enqueue", {
      page: shortKey(k),
      queued: this.queue.length,
      active: this.inFlight.size,
    });
    this.drain(translateFn);
  }

  /** Powers the queue readout beside the settings gear. */
  private publish() {
    Registry.setQueueCounts(this.inFlight.size, this.queue.length);
  }
  /**
   * The key the dispatched page ended up with. The pipeline re-reads the
   * target's source at claim time, so a recycled <img> or a redrawn canvas can
   * legitimately land on a different page than the one enqueued. When that
   * happened, move the slot (and its watchdog) onto the live key so the
   * terminal registry event releases it instead of missing a stale entry.
   */
  private slotKeyAfterMount(enqueuedKey: string, img: MangaTargetElement): string {
    if (!document.body.contains(img)) return enqueuedKey;
    const src = getTargetSource(img, false);
    if (!src) return enqueuedKey;
    const live = Registry.srcKeyOf(src);
    if (live === enqueuedKey || !this.inFlight.has(enqueuedKey)) return live;
    this.inFlight.delete(enqueuedKey);
    this.inFlight.add(live);
    this.seenKeys.delete(enqueuedKey);
    this.seenKeys.add(live);
    const timer = this.slotTimers.get(enqueuedKey);
    if (timer !== undefined) {
      this.slotTimers.delete(enqueuedKey);
      this.slotTimers.set(live, timer);
    }
    this.inFlightTargets.delete(enqueuedKey);
    this.inFlightTargets.set(live, img);
    dlog("queue", "slot rekeyed after mount", {
      was: shortKey(enqueuedKey),
      now: shortKey(live),
    });
    return live;
  }

  private drain(translateFn: (img: MangaTargetElement) => Promise<void>) {
    while (this.inFlight.size < this.concurrency && this.queue.length > 0) {
      const nextIndex = this.queue.findIndex(
        (item) => !this.activeTargets.has(item.img),
      );
      if (nextIndex < 0) break;
      const [entry] = this.queue.splice(nextIndex, 1);
      const targetImg = entry.img;
      const src = getTargetSource(targetImg, true);
      if (!src || !document.body.contains(targetImg)) {
        // Skip detached images without consuming a slot
        dlog("queue", "skip: detached or sourceless", {
          page: shortKey(entry.key),
          inDom: !!src,
        });
        this.seenKeys.delete(entry.key);
        continue;
      }
      // Strict registry guard at drain time as well (covers race between enqueue and drain)
      const k = Registry.srcKeyOf(src);
      if (k !== entry.key) {
        dlog("queue", "skip: source key changed", {
          was: shortKey(entry.key),
          now: shortKey(k),
        });
        this.seenKeys.delete(entry.key);
        if (this.seenKeys.has(k)) continue;
        this.seenKeys.add(k);
        entry.key = k;
      }
      if (Registry.isPendingKey(k) || this.inFlight.has(k)) {
        dlog("queue", "skip: already claimed", {
          page: shortKey(k),
          pending: Registry.isPendingKey(k),
          inFlight: this.inFlight.has(k),
        });
        this.seenKeys.delete(k);
        continue;
      }
      if (Registry.statusOfKey(k) === "done") {
        dlog("queue", "skip: already done", { page: shortKey(k) });
        this.seenKeys.delete(k);
        continue;
      }

      this.inFlight.add(k);
      this.activeTargets.add(targetImg);
      this.inFlightTargets.set(k, targetImg);
      this.armSlotTimer(k, src);
      dlog("queue", "dispatch", {
        page: shortKey(k),
        active: this.inFlight.size,
        queued: this.queue.length,
        concurrency: this.concurrency,
      });
      // Fire-and-forget: translateFn sets up its own overlay and async
      // flow. Failure or done signals through the registry event above.
      //
      // The pipeline may claim a DIFFERENT key than the one recorded here: a
      // slider reader recycles one <img> and only swaps its src, and a redrawn
      // canvas re-snapshots to a new URL. Both sides would then name different
      // pages, the done/idle event would never match this slot, and the
      // watchdog would be the only thing ever to free it. Re-derive the key
      // once the mount has settled and migrate the slot onto it.
      translateFn(targetImg)
        .then(() => {
          const live = this.slotKeyAfterMount(k, targetImg);
          const pending = Registry.isPendingKey(live);
          const done = Registry.statusOfKey(live) === "done";
          if (pending || done) return; // terminal event will release it
          this.inFlight.delete(live);
          this.releaseTarget(live);
          this.seenKeys.delete(live);
          Registry.markIdle(src);
          if (this.lastTranslateFn) this.drain(this.lastTranslateFn);
        })
        .catch((err) => {
          console.warn("LMT: auto-translate task failed:", err);
          dlog("queue", "task rejected", {
            page: shortKey(k),
            err: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
          });
          this.inFlight.delete(k);
          this.releaseTarget(k);
          this.seenKeys.delete(k);
          Registry.markIdle(src);
          if (this.lastTranslateFn) this.drain(this.lastTranslateFn);
        });
    }
    this.publish();
  }

  clear() {
    for (const entry of this.queue) {
      this.seenKeys.delete(entry.key);
    }
    this.queue = [];
    this.publish();
  }

  get length() {
    return this.queue.length;
  }

  get activeCount() {
    return this.inFlight.size;
  }
}

export class AutoTranslateOrchestrator {
  private isEnabled = false;
  private observer: IntersectionObserver | null = null;
  private mutationObserver: MutationObserver | null = null;
  private queue = new AutoTranslateQueue();
  private observedImages = new WeakSet<MangaTargetElement>();
  private observedSourceKeys = new WeakMap<MangaTargetElement, string>();
  private activeRule: SiteRule | null = null;
  private translateFn: ((img: MangaTargetElement) => Promise<void>) | null = null;
  private unwatchStorage: (() => void) | null = null;
  private unwatchConcurrency: (() => void) | null = null;
  private unwatchScope: (() => void) | null = null;
  private unwatchDomains: (() => void) | null = null;
  private pageRescanTimer: ReturnType<typeof setTimeout> | null = null;
  /** Host decisions; `null` until the first read lands. */
  private scopeState: AutoScopeState | null = null;

  private scheduleReaderRescan = (event: Event) => {
    if (!this.isEnabled) return;
    const target = event.target;
    if (
      event.type === "keydown" &&
      target instanceof HTMLElement &&
      target.closest("input, textarea, [contenteditable='true']")
    ) {
      return;
    }
    if (this.pageRescanTimer) clearTimeout(this.pageRescanTimer);
    this.pageRescanTimer = setTimeout(() => {
      this.pageRescanTimer = null;
      this.scanAndObserve(true);
    }, 160);
  };

  async init(translateFn: (img: MangaTargetElement) => Promise<void>) {
    this.translateFn = translateFn;

    await this.applyCap();
    await this.loadScope();
    const initialEnabled =
      await storage.getItem<boolean>("sync:auto-translate");
    if (initialEnabled ?? false) {
      await this.start();
    }

    this.unwatchStorage = storage.watch<boolean>(
      "sync:auto-translate",
      async (newVal) => {
        if (newVal) {
          // Cap first so the rescan drains at the slider value, not stale 3.
          await this.applyCap();
          this.start();
        } else {
          this.stop();
          // Manual-only mode: absolute cap of 3, slider ignored.
          this.queue.setConcurrency(MANUAL_CONCURRENCY);
        }
      },
    );

    this.unwatchConcurrency = storage.watch<number>(
      "sync:auto-translate-concurrency",
      async () => {
        await this.applyCap();
      },
    );

    // A scope change must take effect on open tabs immediately: enabling domain
    // scope on a tab that is already translating has to stop it, and adding the
    // current host has to let it begin.
    this.unwatchScope = storage.watch<AutoScopeState>(AUTO_SCOPE_KEY, (value) => {
      this.scopeState = value ?? this.scopeState;
      this.reevaluateScope();
    });
    this.unwatchDomains = storage.watch<Record<string, boolean>>(
      AUTO_DOMAINS_KEY,
      () => {
        void this.loadScope().then(() => this.reevaluateScope());
      },
    );
  }

  /**
   * Read the scope, and fold the legacy separate domain map into it.
   *
   * The two keys exist so a user can flip global/domain without losing the
   * host list; the legacy key is read but never written from here.
   */
  private async loadScope(): Promise<void> {
    const [scope, domains] = await Promise.all([
      storage.getItem<AutoScopeState["scope"]>(AUTO_SCOPE_KEY),
      storage.getItem<Record<string, boolean>>(AUTO_DOMAINS_KEY),
    ]);
    this.scopeState = {
      scope: scope === "domain" ? "domain" : "global",
      domains: domains ?? this.scopeState?.domains ?? {},
    };
  }

  /** Start or stop the observer to match the scope for this host. */
  private reevaluateScope(): void {
    const allowed = this.hostAllowed();
    if (allowed && !this.isEnabled) {
      void this.start();
    } else if (!allowed && this.isEnabled) {
      dlog("scope", "host not allowed, stopping", { host: location.hostname });
      this.stop();
    }
  }

  /**
   * Local mode is always allowed: the queue is shared with the manual pill, and
   * the pill must keep working on any site the user chooses to translate by
   * hand. Scope governs only the automatic observer.
   */
  private hostAllowed(): boolean {
    if (!this.scopeState) return true;
    return allowsHost(this.scopeState, location.hostname);
  }

  /** Manual pill path: shares the same queue even when auto is off. */
  enqueueManual(img: MangaTargetElement) {
    if (this.translateFn) {
      this.queue.enqueue(img, this.translateFn);
    }
  }

  /** Unified cap: slider 1..10 when auto ON, absolute 3 when OFF. */
  private async applyCap() {
    const [enabled, slider] = await Promise.all([
      storage.getItem<boolean>("sync:auto-translate"),
      storage.getItem<number>("sync:auto-translate-concurrency"),
    ]);
    this.queue.setConcurrency(
      enabled ? (slider ?? 1) : MANUAL_CONCURRENCY,
    );
  }

  async start() {
    if (this.isEnabled) return;
    // Scope gates the automatic observer only. A refused host stays untranslated
    // until the user either adds it or translates a page by hand.
    if (!this.hostAllowed()) {
      dlog("scope", "auto-translate refused for host", {
        host: location.hostname,
        scope: this.scopeState?.scope,
      });
      return;
    }
    this.isEnabled = true;
    this.activeRule = await resolveActiveSiteRule();

    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (
            entry.isIntersecting &&
            (entry.target instanceof HTMLImageElement || entry.target instanceof HTMLCanvasElement)
          ) {
            const img = entry.target;
            this.observer?.unobserve(img);
            if (this.translateFn) {
              this.queue.enqueue(img, this.translateFn);
            }
          }
        }
      },
      {
        root: null,
        rootMargin: "200px",
        threshold: 0,
      },
    );

    this.scanAndObserve();

    this.mutationObserver = new MutationObserver((mutations) => {
      if (!this.isEnabled) return;
      let shouldScan = false;
      let refreshCanvases = false;
      for (const m of mutations) {
        if (m.addedNodes.length > 0) {
          shouldScan = true;
        }
        if (m.type === "attributes") {
          shouldScan = true;
          refreshCanvases ||= m.target instanceof HTMLCanvasElement;
        }
      }
      if (shouldScan) {
        this.scanAndObserve(refreshCanvases);
      }
    });

    this.mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "srcset", "data-src", "data-page", "width", "height"],
    });

    document.addEventListener("click", this.scheduleReaderRescan, true);
    document.addEventListener("keydown", this.scheduleReaderRescan, true);
    document.addEventListener("wheel", this.scheduleReaderRescan, {
      capture: true,
      passive: true,
    });
    document.addEventListener("touchend", this.scheduleReaderRescan, true);
    document.addEventListener("scroll", this.scheduleReaderRescan, {
      capture: true,
      passive: true,
    });
  }

  stop() {
    this.isEnabled = false;
    document.removeEventListener("click", this.scheduleReaderRescan, true);
    document.removeEventListener("keydown", this.scheduleReaderRescan, true);
    document.removeEventListener("wheel", this.scheduleReaderRescan, true);
    document.removeEventListener("touchend", this.scheduleReaderRescan, true);
    document.removeEventListener("scroll", this.scheduleReaderRescan, true);
    if (this.pageRescanTimer) {
      clearTimeout(this.pageRescanTimer);
      this.pageRescanTimer = null;
    }
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    if (this.mutationObserver) {
      this.mutationObserver.disconnect();
      this.mutationObserver = null;
    }
    this.queue.clear();
    // Fresh WeakSet so a restart rescan re-observes dropped pages.
    // In-flight pipelines keep their registry slots and finish normally.
    this.observedImages = new WeakSet();
    this.observedSourceKeys = new WeakMap();
  }

  destroy() {
    this.stop();
    this.queue.destroy();
    if (this.unwatchStorage) {
      this.unwatchStorage();
      this.unwatchStorage = null;
    }
    if (this.unwatchConcurrency) {
      this.unwatchConcurrency();
      this.unwatchConcurrency = null;
    }
    if (this.unwatchScope) {
      this.unwatchScope();
      this.unwatchScope = null;
    }
    if (this.unwatchDomains) {
      this.unwatchDomains();
      this.unwatchDomains = null;
    }
  }

  private isQualifyingImage(img: MangaTargetElement): boolean {
    if (this.activeRule?.imageSelector) {
      try {
        if (img.matches(this.activeRule.imageSelector)) return true;
      } catch {
        // Selector syntax error fallback
      }
    }

    // No rule selector: fall back to shape. Size alone is not enough — catalog
    // covers are routinely larger than 500px in both dimensions, which is how
    // auto-translate used to spend a chapter's budget on a homepage grid. A
    // page spans the reading column; a cover is one cell of it.
    const naturalW = "naturalWidth" in img ? img.naturalWidth : img.width;
    const naturalH = "naturalHeight" in img ? img.naturalHeight : img.height;
    const clientW = img.clientWidth || img.offsetWidth;
    const clientH = img.clientHeight || img.offsetHeight;

    const width = naturalW > 0 ? naturalW : clientW;
    const height = naturalH > 0 ? naturalH : clientH;
    if (width <= 0 || height <= 0) return false;

    return looksLikeReaderPage(width, height, document.documentElement.clientWidth);
  }

  private observeImage(img: MangaTargetElement) {
    this.observeImageWithRefresh(img, false);
  }

  private observeImageWithRefresh(
    img: MangaTargetElement,
    refreshCanvas: boolean,
  ) {
    const src = getTargetSource(img, refreshCanvas);
    if (!src) return;
    const k = Registry.srcKeyOf(src);
    const previousKey = this.observedSourceKeys.get(img);
    if (previousKey === k && this.observedImages.has(img)) return;
    if (previousKey && previousKey !== k) {
      this.observer?.unobserve(img);
      this.observedImages.delete(img);
    }

    if (Registry.isPendingKey(k) || Registry.statusOfKey(k) === "done") {
      this.observedSourceKeys.set(img, k);
      this.observedImages.add(img);
      return;
    }

    const isReady =
      img instanceof HTMLCanvasElement
        ? img.width > 0 && img.height > 0
        : img.complete && img.naturalWidth > 0;

    if (isReady) {
      this.observedSourceKeys.set(img, k);
      this.observedImages.add(img);
      if (this.isQualifyingImage(img)) {
        this.observer?.observe(img);
      }
    } else if (img instanceof HTMLImageElement) {
      if (previousKey === k) return;
      this.observedSourceKeys.set(img, k);
      const onLoad = () => {
        img.removeEventListener("load", onLoad);
        if (!this.isEnabled) return;
        this.observedSourceKeys.delete(img);
        this.observedImages.delete(img);
        this.observeImage(img);
      };
      img.addEventListener("load", onLoad, { once: true });
    }
  }

  private isNearViewport(img: MangaTargetElement): boolean {
    const rect = img.getBoundingClientRect();
    const margin = 200;
    return (
      rect.bottom >= -margin &&
      rect.right >= -margin &&
      rect.top <= window.innerHeight + margin &&
      rect.left <= window.innerWidth + margin
    );
  }

  private scanAndObserve(refreshVisibleCanvases = false) {
    if (!this.isEnabled) return;

    if (this.activeRule?.imageSelector) {
      const matchingImgs = queryScopedTargets(
        document,
        this.activeRule.containerSelector,
        this.activeRule.imageSelector,
      ).filter(
        (img): img is MangaTargetElement =>
          img instanceof HTMLImageElement || img instanceof HTMLCanvasElement,
      );
      matchingImgs.forEach((img) =>
        this.observeImageWithRefresh(
          img,
          refreshVisibleCanvases &&
            img instanceof HTMLCanvasElement &&
            this.isNearViewport(img),
        ),
      );
      if (matchingImgs.length > 0) {
        // Site rule already scoped the page: everything it matched is a page.
        Registry.setDetectedCount(matchingImgs.length);
        return;
      }
    }

    // Fallback scan across all document images & canvases.
    //
    // `detected` counts only qualifying pages here. A raw `img, canvas` count
    // includes icons, logos and spacer canvases, which would inflate the
    // readout and make a finished chapter look permanently incomplete.
    const allImages = document.querySelectorAll<MangaTargetElement>("img, canvas");
    let qualifying = 0;
    allImages.forEach((img) => {
      if (this.isQualifyingImage(img)) qualifying++;
      this.observeImageWithRefresh(
        img,
        refreshVisibleCanvases &&
          img instanceof HTMLCanvasElement &&
          this.isNearViewport(img),
      );
    });
    Registry.setDetectedCount(qualifying);
  }
}
