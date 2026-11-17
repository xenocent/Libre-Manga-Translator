<script lang="ts">
  import { onMount } from "svelte";
  import { Sparkles, LoaderCircle, GripVertical, Settings, Square, RotateCcw, OctagonX, ListRestart } from "lucide-svelte";
  import { isPending as isRegistryPending, getStatus as getRegistryStatus } from "@/entrypoints/content/translation-registry";
  import { getElementSrc, type MangaTargetElement } from "@/lib/canvas";
  import type { PillPosition } from "@/lib/adapters";
  import { hudEnabled as hudEnabledStore } from "@/entrypoints/content/hud-gate";

  let {
    onTranslate,
    onStopPage,
    onRestartPage,
    onStopAll,
    onRestartAll,
    getOverlayMode,
    getOverlayProgress,
    isSameSource,
    readerContainerSelector = null,
    pillPosition,
  }: {
    onTranslate?: (img: MangaTargetElement) => void;
    onStopPage?: (img: MangaTargetElement) => void;
    onRestartPage?: (img: MangaTargetElement) => void;
    onStopAll?: () => void;
    onRestartAll?: () => void;
    getOverlayMode?: (img: MangaTargetElement) => "idle" | "translating" | "translated";
    getOverlayProgress?: (img: MangaTargetElement) => string;
    isSameSource?: (img: MangaTargetElement, src: string) => boolean;
    // Site-rule reader container (when the active rule declares one) —
    // candidates inside it are treated as pages at a lower size bar.
    readerContainerSelector?: string | null;
    // Where to anchor the pill on each image (site-rule override)
    pillPosition?: PillPosition;
  } = $props();

  let x = $state(0);
  let y = $state(0);
  let visible = $state(false);
  let status = $state<"idle" | "translating" | "translated">("idle");
  let progressText = $state("Detecting text…");
  // Aggregate pipeline readout, kept current by `lmt:queue-progress`. When no
  // single page is pinned (auto-translate with nothing hovered) the pill shows
  // THIS instead of one frozen page label — previously `handleProgress` returned
  // early without a hover target, so the pill stuck on "Detecting text…" over a
  // page the queue had long since finished.
  let aggActive = $state(0);
  let aggQueued = $state(0);
  let aggCompleted = $state(0);
  let aggDetected = $state(0);
  let targetImg = $state<MangaTargetElement | null>(null);
  let targetSource = "";
  // Pipeline-active image shown without hover (manual click optimistic or
  // auto-queue). Hover takes over while hovering; pointer-leave snaps back.
  let autoImg = $state<MangaTargetElement | null>(null);
  let hoverImg = $state<MangaTargetElement | null>(null);

  let dragOffset = $state<{ x: number; y: number } | null>(null);
  let isDraggingTrigger = $state(false);
  let triggerDragStart: { mouseX: number; mouseY: number; initialX: number; initialY: number } | null = null;

  // Hover menu (gear) — shows the manual controls the user asked for: stop/restart
  // the pinned page, and stop/restart the whole chapter queue. Opens on click so a
  // stray hover can't yank it around; closes on outside click and Escape.
  let menuOpen = $state(false);

  function toggleMenu(e: MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    menuOpen = !menuOpen;
  }

  function closeMenu() {
    menuOpen = false;
  }

  function stopPage(e: MouseEvent) {
    e.stopPropagation();
    if (targetImg) onStopPage?.(targetImg);
    closeMenu();
  }

  function restartPage(e: MouseEvent) {
    e.stopPropagation();
    if (targetImg) onRestartPage?.(targetImg);
    closeMenu();
  }

  function stopAll(e: MouseEvent) {
    e.stopPropagation();
    onStopAll?.();
    closeMenu();
  }

  function restartAll(e: MouseEvent) {
    e.stopPropagation();
    onRestartAll?.();
    closeMenu();
  }

  // What the pill displays. A pinned page (hovered, or the one the user clicked)
  // shows that page's own stage; otherwise the aggregate chapter progress shows,
  // so auto-translate with nothing hovered still reports real movement instead of
  // freezing on a single stale "Detecting text…" label.
  function aggregateText(): string {
    const running = aggActive + aggQueued;
    if (running === 0 && aggCompleted === 0) return "Detecting text…";
    if (running > 0) {
      return `${aggActive}+${aggQueued} · ${aggCompleted}/${aggDetected}`;
    }
    return `${aggCompleted}/${aggDetected} done`;
  }

  let pillRunning = $derived(status === "translating" || aggActive + aggQueued > 0);
  // A pinned page (hovered or clicked) ALWAYS shows its own stage, never the
  // dense queue numbers. Previous version only showed per-page when `status ===
  // "translating"`, but `adoptMode`/`settleTarget` flips status back to "idle"
  // during the mount gap, leaking `2+4 · 4/17` onto a page you're reading.
  let pillText = $derived(targetImg ? progressText : aggregateText());

  // Pipeline step tracking. Derive the step index from `progressText` (the
  // overlay emits these exact strings) and record when each step was entered so
  // the step bar can show elapsed time per step.
  // Step order: detect (incl. model download) → translate → render.
  const STEP_LABELS = ["Detect", "Translate", "Render"] as const;
  type PipelineStep = 0 | 1 | 2; // detect, translate, render

  function stepFromProgress(msg: string): PipelineStep {
    if (/detect|download/i.test(msg)) return 0;
    if (/translat/i.test(msg)) return 1;
    if (/render|inpaint/i.test(msg)) return 2;
    return 0; // fallback: "Detecting text…" or unknown → detect
  }

  let currentStep = $state<PipelineStep>(0);
  // Timestamps for when each step was entered (ms since page start).
  let stepStartTimes = $state<number[]>([0, 0, 0]);
  let pageStartMs = $state<number>(0);

  function trackStep(msg: string) {
    const step = stepFromProgress(msg);
    const now = performance.now();
    if (step !== currentStep) {
      // Step changed — record entry time for the new step.
      currentStep = step;
      stepStartTimes = [...stepStartTimes];
      stepStartTimes[step] = now;
    }
  }

  // Called when a new page becomes the target (on click or hover during translate).
  function resetStepTracking() {
    currentStep = 0;
    pageStartMs = performance.now();
    stepStartTimes = [pageStartMs, 0, 0];
  }

  // Elapsed time for each step (ms). Completed steps use next step's start;
  // current step uses now.
  function stepElapsedMs(step: PipelineStep): number {
    if (stepStartTimes[step] === 0) return 0; // step not yet reached
    if (step < 2 && stepStartTimes[step + 1] > 0) {
      // Next step already started — this step is done.
      return stepStartTimes[step + 1] - stepStartTimes[step];
    }
    // Current or last step — use now.
    return performance.now() - stepStartTimes[step];
  }

  function formatElapsed(ms: number): string {
    if (ms < 1000) return "<1s";
    if (ms < 60000) return `${Math.round(ms / 1000)}s`;
    return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
  }

  let stepBarVisible = $derived(status === "translating" && targetImg !== null);
  let stepBarHover = $state(false);
  // The pill stays up while the chapter pipeline runs, even if the pinned page
  // scrolls off-screen. Previously `handleScrollRaw` set visible=false the moment
  // the one pinned page left the viewport, which hid the pill during auto-translate
  // — the queue kept working but the user saw nothing and read it as "stuck".
  // When nothing is pinned and the queue is idle, fall back to normal visibility.
  // `hudEnabled` is the context gate: when the content script says this page
  // should show nothing (auto-translate off + not a saved site + no manual
  // override) the pill never renders, whatever the hover/pipeline state says.
  let pillVisible = $derived(
    $hudEnabledStore && (visible || (pillRunning && aggActive + aggQueued > 0)),
  );
  // When the pill is up with no pinned page (aggregate-only mode), anchor it to
  // a fixed viewport corner so it doesn't render at stale/zero coordinates from
  // a detached image. updatePosition() only runs for pinned targets; this covers
  // the queue-progress-only case.
  let aggOnly = $derived(pillVisible && !targetImg);
  $effect(() => {
    if (!aggOnly) return;
    // Only write when the values actually differ. Assigning unconditionally
    // re-read x/y inside the effect, which re-triggers it every run and blew
    // past Svelte's update-depth limit (effect_update_depth_exceeded).
    const targetX = window.innerWidth - 140;
    const targetY = 20;
    if (x !== targetX) x = targetX;
    if (y !== targetY) y = targetY;
  });

  // Cached reader container element — resolved lazily from the selector prop
  // so isPageLike doesn't call closest() on every candidate every mouseover.
  let cachedContainer: Element | null | undefined = undefined;
  function getReaderContainer(): Element | null {
    if (cachedContainer !== undefined) return cachedContainer;
    if (!readerContainerSelector) { cachedContainer = null; return null; }
    try {
      cachedContainer = document.querySelector(readerContainerSelector);
    } catch {
      cachedContainer = null;
    }
    return cachedContainer;
  }

  try {
    const saved = localStorage.getItem("lmt-trigger-pos");
    if (saved) {
      const parsed = JSON.parse(saved);
      if (typeof parsed?.x === "number" && typeof parsed?.y === "number") {
        dragOffset = {
          x: Math.max(8, Math.min(window.innerWidth - 120, parsed.x)),
          y: Math.max(8, Math.min(window.innerHeight - 48, parsed.y)),
        };
      }
    }
  } catch {}

  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  // Tracks whether the cursor is currently over the pill itself. The hide timer
  // fires on image mouseleave; without this flag a fast move toward the pill
  // crosses the gap and hides it before the pill's own onmouseenter can cancel.
  let cursorInPill = false;
  function cancelHide() {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  }
  function isInViewport(el: Element) {
    const r = el.getBoundingClientRect();
    return (
      r.bottom > 4 &&
      r.top < window.innerHeight - 4 &&
      r.right > 4 &&
      r.left < window.innerWidth - 4
    );
  }

  function scheduleHide() {
    cancelHide();
    if (status === "translating") return;
    hideTimer = setTimeout(() => {
      // Cursor already over the pill — the user is moving to click it, never hide.
      if (cursorInPill) return;
      // Keep a translating pill pinned only while its image is attached and
      // actually on screen; scrolling it away must not leave the pill
      // stranded over the rest of the reader UI.
      if (
        status === "translating" &&
        targetImg &&
        document.body.contains(targetImg) &&
        isInViewport(targetImg)
      ) {
        return;
      }
      visible = false;
      targetImg = null;
    }, 400);
  }

  function meetsThreshold(el: MangaTargetElement) {
    const renderedW = el.offsetWidth || el.clientWidth;
    const renderedH = el.offsetHeight || el.clientHeight;
    const naturalW = "naturalWidth" in el ? el.naturalWidth : el.width;
    const naturalH = "naturalHeight" in el ? el.naturalHeight : el.height;
    return (
      (renderedW >= 260 && renderedH >= 260) ||
      (naturalW >= 260 && naturalH >= 260)
    );
  }

  // Custom-element hosts owned by this extension. Hovers landing inside our
  // own UI must never re-map or schedule hides from the document listener.
  const OWN_UI_SELECTOR =
    "lmt-root, lmt-overlay, lmt-sidebar, lmt-floating-trigger";

  const INTERACTIVE_SELECTOR =
    "a[href], button, [role='button'], [role='link'], summary, nav, header";

  // Indirect hover mapping (descendant / beneath-cursor matching) must only
  // resolve to page-like targets. Navigation chrome — episode cards, banners,
  // thumbnails inside links — clears a raw pixel threshold easily via natural
  // size, so require real on-screen page mass, and reject anything contained
  // in interactive elements.
  function isPageLike(el: MangaTargetElement) {
    const w = el.offsetWidth || el.clientWidth;
    const h = el.offsetHeight || el.clientHeight;
    // Skip hidden/zero-size elements (MangaDex hides non-current pages with
    // display:none — skipping them here avoids iterating 98 hidden images).
    if (w === 0 && h === 0) return false;
    // Thumbnails and icons: never indirect-map to images narrower than 350px,
    // regardless of occupancy (covers 280-320px range often seen in nav cards).
    if (w < 350 || h < 280) return false;
    if (el.closest(INTERACTIVE_SELECTOR)) return false;
    const container = getReaderContainer();
    if (container) {
      if (container.contains(el)) return w >= 180 && h >= 180;
    }
    const vpArea = (window.innerWidth || 1) * (window.innerHeight || 1);
    return (w * h) / vpArea >= 0.12;
  }

  // For the descendant path: the matched image must fill most of the hovered
  // element. Cards place a thumbnail beside text; real tap-overlay wrappers
  // contain (almost) nothing but the page itself.
  function fillsWrapper(child: Element, hovered: HTMLElement) {
    const c = child.getBoundingClientRect();
    const p = hovered.getBoundingClientRect();
    if (p.width <= 0 || p.height <= 0) return true;
    return (c.width * c.height) / (p.width * p.height) >= 0.6;
  }

  function srcMatches(el: MangaTargetElement, src: string) {
    return isSameSource?.(el, src) ?? getElementSrc(el, true) === src;
  }

  function queryMode(img: MangaTargetElement) {
    return getOverlayMode?.(img) ?? "idle";
  }

  // Adopt the queried overlay mode, except never downgrade an optimistic
  // "translating" while the registry still holds the image pending — the
  // overlay mounts ~1s after click, and re-querying that gap used to flash
  // the pill back to Translate (then hide on pointer-out).
  //
  // CRITICAL: when the registry says `done`, the page IS translated — do not
  // read `data-lmt-progress` from the wrapper, because that attribute is set
  // once at mount ("Detecting text…") and only updated by live progress events.
  // A finished page keeps the stale attribute forever, freezing the pill on
  // "Detecting text…" even though the pipeline ended minutes ago.
  function adoptMode(img: MangaTargetElement) {
    const q = queryMode(img);
    const src = getElementSrc(img, true);
    const pending = !!src && isRegistryPending(src);
    const sourceChanged = img === targetImg && src !== targetSource;

    if (sourceChanged) {
      targetSource = src;
      progressText = "Detecting text…";
      status = pending ? "translating" : "idle";
      if (!pending && autoImg === img) autoImg = null;
      resetStepTracking();
    }

    // Registry `done` wins over everything — show "Translated" and stop.
    // Do NOT read the wrapper's `data-lmt-progress` here: that attribute is set
    // once at mount ("Detecting text…") and only updated by live progress
    // events, so a finished page keeps the stale string forever.
    if (src && !pending && getRegistryStatus(src) === "done") {
      status = "translated";
      progressText = "Translated";
      return q;
    }

    if (q === "translating") {
      status = q;
      const wrapperProgress = getOverlayProgress?.(img) ?? "Translating…";
      progressText = wrapperProgress;
      trackStep(wrapperProgress);
    } else if (status !== "translating" || !pending) {
      status = q;
    }
    return q;
  }

  function handleDragStart(e: MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    isDraggingTrigger = true;
    triggerDragStart = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      initialX: x,
      initialY: y,
    };

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!triggerDragStart) return;
      const dx = moveEvent.clientX - triggerDragStart.mouseX;
      const dy = moveEvent.clientY - triggerDragStart.mouseY;
      x = Math.max(8, Math.min(window.innerWidth - 140, triggerDragStart.initialX + dx));
      y = Math.max(8, Math.min(window.innerHeight - 48, triggerDragStart.initialY + dy));
      dragOffset = { x, y };
    };

    const handleMouseUp = () => {
      isDraggingTrigger = false;
      triggerDragStart = null;
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      if (dragOffset) {
        try {
          localStorage.setItem("lmt-trigger-pos", JSON.stringify(dragOffset));
        } catch {}
      }
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  }

  function showFor(img: MangaTargetElement, auto: boolean) {
    cancelHide();
    // Only clear manual drag offset when the pill switches to a genuinely
    // different image — re-showing the same image after scroll-hide or
    // re-hover should preserve the user's drag position.
    const switched = targetImg !== img;
    targetImg = img;
    if (switched) {
      targetSource = getElementSrc(img, true);
      // A page can be pending in the registry but not yet mounted its overlay
      // (the gap between claim and mount). During that gap there are no
      // lmt:progress events, so showing "Detecting text…" freezes the hover
      // menu. Default to the aggregate chapter progress until the overlay
      // mounts and starts emitting per-page updates.
      progressText = aggregateText();
      status = targetSource && isRegistryPending(targetSource) ? "translating" : "idle";
      // New page → reset step tracking so the bar starts fresh.
      resetStepTracking();
    }
    if (auto) autoImg = img;
    if (switched && !isDraggingTrigger) dragOffset = null;
    updatePosition();
    visible = true;
    if (adoptMode(img) === "translated") {
      if (auto) autoImg = null;
      scheduleHide();
    }
  }

  // Settle the pill after a terminal-ish signal for the current target.
  // Keeps optimistic "translating" while the registry claim is still pending.
  function settleTarget() {
    if (!targetImg) return;
    if (!document.body.contains(targetImg)) {
      targetImg = null;
      if (autoImg && !document.body.contains(autoImg)) autoImg = null;
      visible = false;
      return;
    }
    const wasAuto = autoImg === targetImg;
    adoptMode(targetImg);
    if (status === "idle" || status === "translated") {
      if (wasAuto) autoImg = null;
      scheduleHide();
    }
  }

  function findImgForSrc(src: string): MangaTargetElement | null {
    const imgs = document.querySelectorAll<MangaTargetElement>("img, canvas");
    for (const img of imgs) {
      if (
        (img instanceof HTMLImageElement || img instanceof HTMLCanvasElement) &&
        document.body.contains(img) &&
        meetsThreshold(img) &&
        srcMatches(img, src)
      ) {
        return img;
      }
    }
    return null;
  }

  function isActive(img: MangaTargetElement) {
    if (!document.body.contains(img)) return false;
    if (queryMode(img) === "translating") return true;
    try {
      const src = getElementSrc(img, true);
      return src ? isRegistryPending(src) : false;
    } catch {
      return false;
    }
  }

  function pinFromModeEvent(e: Event) {
    const target = e.target;
    if (!(target instanceof HTMLElement) || typeof target.querySelector !== "function") {
      return null;
    }
    const el = target.querySelector<MangaTargetElement>("img, canvas");
    if (
      !el ||
      !(el instanceof HTMLImageElement || el instanceof HTMLCanvasElement) ||
      !document.body.contains(el) ||
      !meetsThreshold(el)
    ) {
      return null;
    }
    return el;
  }

  function updatePosition() {
    if (visible && targetImg && document.body.contains(targetImg)) {
      if (dragOffset) {
        x = dragOffset.x;
        y = dragOffset.y;
        return;
      }
      const rect = targetImg.getBoundingClientRect();
      const buttonHeight = 36;
      const margin = 16;
      const pos = pillPosition ?? "top-left";

      switch (pos) {
        case "top-left":
          x = Math.max(16, rect.left + margin);
          y = Math.max(20, rect.top + margin);
          break;
        case "top":
          x = Math.max(16, rect.left + rect.width / 2 - 60);
          y = Math.max(20, rect.top + margin);
          break;
        case "top-right":
          x = Math.max(16, Math.min(window.innerWidth - 140, rect.right - 140));
          y = Math.max(20, rect.top + margin);
          break;
        case "left":
          x = Math.max(16, rect.left + margin);
          y = Math.max(20, rect.top + rect.height / 2 - buttonHeight / 2);
          break;
        case "right":
          x = Math.max(16, Math.min(window.innerWidth - 140, rect.right - 140));
          y = Math.max(20, rect.top + rect.height / 2 - buttonHeight / 2);
          break;
        case "bottom":
          x = Math.max(16, rect.left + rect.width / 2 - 60);
          y = Math.max(
            20,
            Math.min(rect.bottom - buttonHeight - margin, window.innerHeight - buttonHeight - margin)
          );
          break;
        case "bottom-right":
          x = Math.max(16, Math.min(window.innerWidth - 140, rect.right - 140));
          y = Math.max(
            20,
            Math.min(rect.bottom - buttonHeight - margin, window.innerHeight - buttonHeight - margin)
          );
          break;
        case "bottom-left":
        default:
          x = Math.max(16, rect.left + margin);
          y = Math.max(
            20,
            Math.min(rect.bottom - buttonHeight - margin, window.innerHeight - buttonHeight - margin)
          );
          break;
      }
    }
  }

  function isMangaElement(el: unknown): el is MangaTargetElement {
    return el instanceof HTMLImageElement || el instanceof HTMLCanvasElement;
  }

  onMount(() => {
    // rAF handle for debounced indirect mapping — coalesces rapid
    // mouseover events that don't land directly on img/canvas.
    let indirectRaf = 0;
    let canvasRefreshTimer: ReturnType<typeof setTimeout> | null = null;

    function scheduleTargetRefresh() {
      if (!targetImg) return;
      if (canvasRefreshTimer) clearTimeout(canvasRefreshTimer);
      canvasRefreshTimer = setTimeout(() => {
        canvasRefreshTimer = null;
        const img = targetImg;
        if (!img || !document.body.contains(img)) return;
        if (img instanceof HTMLCanvasElement) getElementSrc(img, true);
        adoptMode(img);
        if ((hoverImg === img || autoImg === img) && isInViewport(img)) {
          visible = true;
          updatePosition();
        }
      }, 160);
    }

    function applyHoverTarget(el: MangaTargetElement) {
      hoverImg = el;
      cancelHide();
      if (targetImg !== el) {
        if (el instanceof HTMLCanvasElement) getElementSrc(el, true);
        showFor(el, false);
      } else {
        if (el instanceof HTMLCanvasElement) getElementSrc(el, true);
        visible = true;
        adoptMode(el);
      }
    }

    // Expensive path: querySelectorAll + elementsFromPoint, called at
    // most once per animation frame via rAF debounce.
    function resolveIndirect(target: HTMLElement, clientX: number, clientY: number) {
      let el: MangaTargetElement | null = null;
      for (const child of target.querySelectorAll<MangaTargetElement>(
        "canvas, img",
      )) {
        if (
          meetsThreshold(child) &&
          isPageLike(child) &&
          fillsWrapper(child, target)
        ) {
          el = child;
          break;
        }
      }
      if (!el) {
        // Transparent tap overlays: inspect underlying elements
        const hits = document.elementsFromPoint(clientX, clientY);
        for (const hit of hits) {
          if (isMangaElement(hit) && meetsThreshold(hit) && isPageLike(hit)) {
            el = hit;
            break;
          }
        }
      }
      if (el && document.body.contains(el)) {
        applyHoverTarget(el);
      } else if (
        targetImg &&
        targetImg !== autoImg &&
        hoverImg &&
        !target.closest(OWN_UI_SELECTOR)
      ) {
        hoverImg = null;
        scheduleHide();
      }
    }

    function handleMouseOver(e: MouseEvent) {
      const target = e.target;

      // ── Fast path: direct hover on img/canvas ──
      // This is the common case for standard readers like MangaDex where
      // <img> elements receive mouseover directly. No page-like gate —
      // small zoomed-out pages and linked reader images must still work.
      if (isMangaElement(target) && meetsThreshold(target)) {
        if (indirectRaf) { cancelAnimationFrame(indirectRaf); indirectRaf = 0; }
        applyHoverTarget(target);
        return;
      }

      // ── Indirect path: debounce to next animation frame ──
      // Readers with tap overlays or canvas wrappers need querySelectorAll +
      // elementsFromPoint, which is expensive when the container has many
      // children (MangaDex preloads ~99 img elements). Deferring to rAF
      // coalesces rapid mouseover cascades into a single resolution.
      if (
        target instanceof HTMLElement &&
        !target.closest(OWN_UI_SELECTOR)
      ) {
        const cx = e.clientX, cy = e.clientY;
        const hoveredEl = target;
        if (indirectRaf) cancelAnimationFrame(indirectRaf);
        indirectRaf = requestAnimationFrame(() => {
          indirectRaf = 0;
          resolveIndirect(hoveredEl, cx, cy);
        });
        return;
      }

      // Hover inside own UI — ignore
      if (target instanceof Element && target.closest(OWN_UI_SELECTOR)) return;

      // Un-mappable hover on non-HTMLElement — schedule hide for stale pill
      if (
        targetImg &&
        targetImg !== autoImg &&
        hoverImg
      ) {
        hoverImg = null;
        scheduleHide();
      }
    }

    function handleMouseOut(e: MouseEvent) {
      if (!isMangaElement(e.target)) return;
      if (e.target === hoverImg) hoverImg = null;
      if (e.target !== targetImg) return;
      // Pinned pipeline image stays visible without hover.
      if (targetImg === autoImg) return;
      // Snap back to the pipeline-active image instead of hiding.
      if (autoImg && isActive(autoImg)) {
        showFor(autoImg, true);
        return;
      }
      scheduleHide();
    }

    // Browsers don't reliably fire mouseout when a scrolled element slides
    // out from under a stationary cursor, so scroll/resize manages pill
    // visibility directly. Off-screen images hide the pill (keeping
    // targetImg/autoImg and the translating pin so scrolling back restores
    // it); in-view images only re-show it when the pill is still owned —
    // hovered or pipeline-pinned — never for stale indirect mappings.
    let scrollRaf = 0;
    function handleScrollRaw() {
      scheduleTargetRefresh();
      if (!targetImg) return;
      if (scrollRaf) return;
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = 0;
        if (!targetImg) return;
        if (!document.body.contains(targetImg)) {
          visible = false;
          targetImg = null;
          return;
        }
        if (isInViewport(targetImg)) {
          if (hoverImg === targetImg || autoImg === targetImg) {
            visible = true;
            updatePosition();
          }
        } else {
          visible = false;
          if (targetImg !== autoImg && hoverImg !== targetImg) targetImg = null;
        }
      });
    }

    function handleModeChange(e: Event) {
      const detail = (e as CustomEvent<{ mode?: string }>).detail;
      if (targetImg) {
        // Foreign overlay chatter must not clobber our target: settleTarget
        // only downgrades when the registry no longer holds it pending.
        settleTarget();
      }
      if (detail?.mode === "loading") {
        const img = pinFromModeEvent(e);
        if (img && img !== autoImg) autoImg = img;
        if (img && !hoverImg && (!targetImg || !isActive(targetImg))) {
          showFor(img, true);
        }
      }
    }

    function handleProgress(e: Event) {
      if (!targetImg) return;
      const customEvent = e as CustomEvent<{ src?: string; message?: string }>;
      if (
        customEvent.detail?.src &&
        customEvent.detail.message &&
        srcMatches(targetImg, customEvent.detail.src)
      ) {
        const msg = customEvent.detail.message;
        // A done page must never regress to a stale step label — ignore any
        // trailing progress events once the registry marks it complete.
        const src = getElementSrc(targetImg, true);
        if (src && getRegistryStatus(src) === "done") return;
        progressText = msg;
        trackStep(msg);
      }
    }

    // Live aggregate progress for the pill when no single page is pinned (auto
    // translate never hovers). The queue publishes active/queued; the registry
    // publishes completed/detected. Kept at module scope: the module-level
    // `$derived` pill values read these, so they cannot live inside onMount.
    function handleQueueProgress(e: Event) {
      const detail = (
        e as CustomEvent<{ active?: number; queued?: number; completed?: number; detected?: number }>
      ).detail;
      if (!detail) return;
      aggActive = detail.active ?? aggActive;
      aggQueued = detail.queued ?? aggQueued;
      aggCompleted = detail.completed ?? aggCompleted;
      aggDetected = detail.detected ?? aggDetected;
    }

    function handleTranslationStatus(e: Event) {
      const detail = (e as CustomEvent<{ src?: string; status?: string }>).detail;
      if (!detail?.src || !detail?.status) return;

      if (detail.status === "pending") {
        const img =
          targetImg && srcMatches(targetImg, detail.src)
            ? targetImg
            : findImgForSrc(detail.src);
        if (!img) return;
        autoImg = img;
        // Stay on the hovered image; pointer-leave snaps back to autoImg.
        if (hoverImg && hoverImg !== img) return;
        if (targetImg !== img) showFor(img, true);
        // No overlay yet → keep generic progress, but show translating.
        if (queryMode(img) === "translating") adoptMode(img);
        else status = "translating";
        return;
      }

      if (detail.status !== "idle" && detail.status !== "done") return;
      // Safety net for queue-dropped / early-return no-ops that never emit
      // lmt:mode-change: fall back to the queried mode — but only for OUR
      // image. Unrelated images' events used to reset the optimistic
      // "translating" set on click (the flash). The registry-pending guard
      // inside settleTarget covers the pre-mount gap.
      if (targetImg && srcMatches(targetImg, detail.src)) settleTarget();
      // Clear the pin for our own image too: `handleMouseOut` refuses to hide
      // while `targetImg === autoImg`, so a never-cleared pin here left the
      // pill stuck in Translate state after a finished translation.
      if (autoImg && srcMatches(autoImg, detail.src)) {
        autoImg = null;
      }
    }

    document.addEventListener("mouseover", handleMouseOver, { passive: true });
    document.addEventListener("mouseout", handleMouseOut, { passive: true });

    // Close the hover menu on any outside click or Escape.
    function handleMenuOutside(e: MouseEvent) {
      if (!menuOpen) return;
      const t = e.target;
      if (t instanceof Element && t.closest(".lmt-floating-root")) return;
      menuOpen = false;
    }
    function handleMenuKey(e: KeyboardEvent) {
      if (menuOpen && e.key === "Escape") menuOpen = false;
    }
    document.addEventListener("click", handleMenuOutside, true);
    document.addEventListener("keydown", handleMenuKey, true);
    document.addEventListener("click", scheduleTargetRefresh, true);
    document.addEventListener("keydown", scheduleTargetRefresh, true);
    document.addEventListener("wheel", scheduleTargetRefresh, {
      capture: true,
      passive: true,
    });
    document.addEventListener("touchend", scheduleTargetRefresh, true);
    window.addEventListener("resize", handleScrollRaw, { passive: true });
    // Capture on document: `scroll` does not bubble, and many readers (Sunday
    // Webry included) scroll an inner container — window-only listeners never
    // fired for those, so the pill stayed pinned off-screen.
    document.addEventListener("scroll", handleScrollRaw, { passive: true, capture: true });
    document.addEventListener("lmt:mode-change", handleModeChange, { passive: true });
    document.addEventListener("lmt:progress", handleProgress, { passive: true });
    document.addEventListener("lmt:queue-progress", handleQueueProgress, { passive: true });
    document.addEventListener("lmt:translation-status", handleTranslationStatus, { passive: true });

    return () => {
      document.removeEventListener("mouseover", handleMouseOver);
      document.removeEventListener("mouseout", handleMouseOut);
      document.removeEventListener("click", handleMenuOutside, true);
      document.removeEventListener("keydown", handleMenuKey, true);
      document.removeEventListener("click", scheduleTargetRefresh, true);
      document.removeEventListener("keydown", scheduleTargetRefresh, true);
      document.removeEventListener("wheel", scheduleTargetRefresh, true);
      document.removeEventListener("touchend", scheduleTargetRefresh, true);
      window.removeEventListener("resize", handleScrollRaw);
      document.removeEventListener("scroll", handleScrollRaw, true);
      document.removeEventListener("lmt:mode-change", handleModeChange);
      document.removeEventListener("lmt:progress", handleProgress);
      document.removeEventListener("lmt:queue-progress", handleQueueProgress);
      document.removeEventListener("lmt:translation-status", handleTranslationStatus);
      cancelHide();
      if (canvasRefreshTimer) {
        clearTimeout(canvasRefreshTimer);
        canvasRefreshTimer = null;
      }
      if (indirectRaf) { cancelAnimationFrame(indirectRaf); indirectRaf = 0; }
      if (scrollRaf) { cancelAnimationFrame(scrollRaf); scrollRaf = 0; }
    };
  });

  function handleTriggerClick(e: MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    if (status === "idle" && targetImg && document.body.contains(targetImg)) {
      status = "translating";
      progressText = "Detecting text…";
      autoImg = targetImg;
      onTranslate?.(targetImg);
    }
  }

</script>

{#if pillVisible && status !== "translated"}
  <!-- Pinned Floating Container -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    role="presentation"
    class="lmt-floating-root fixed z-[999999] pointer-events-auto select-none transition-opacity duration-200 {isDraggingTrigger ? 'cursor-grabbing' : ''}"
    style="top: {Math.max(8, y)}px; left: {Math.max(8, x)}px;"
    onmouseenter={() => { cursorInPill = true; cancelHide(); }}
    onmouseleave={() => { cursorInPill = false; scheduleHide(); }}
    onmousedown={(e) => e.stopPropagation()}
    onpointerdown={(e) => e.stopPropagation()}
    onclick={(e) => {
      e.stopPropagation();
      e.preventDefault();
    }}
  >
    <div class="flex items-center rounded-lg bg-[var(--surface-panel)] border border-[var(--border-line)] shadow-lg overflow-visible">
      <!-- Drag Handle -->
      <button
        type="button"
        onmousedown={handleDragStart}
        class="pl-1.5 pr-0.5 py-1 text-[var(--text-muted)] hover:text-[var(--accent-cyan)] cursor-grab active:cursor-grabbing flex items-center transition-colors border-r border-[var(--border-line)]/50"
        title="Drag to move button (可拖拽自由移动)"
        aria-label="Drag to move"
      >
        <GripVertical size={13} />
      </button>

      <!-- Main Trigger Button -->
      <button
        type="button"
        onclick={handleTriggerClick}
        class="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold tracking-wide transition-all cursor-pointer {(status === 'translating' || pillRunning) ? 'text-[var(--accent-cyan)] cursor-wait' : 'text-[var(--text-primary)] hover:text-[var(--accent-amber)] hover:shadow-[0_0_12px_var(--accent-amber-glow)]'}"
        title={pillRunning ? pillText : 'Translate manga image'}
      >
        {#if status === "translating" || pillRunning}
          <LoaderCircle size={13} class="animate-spin text-[var(--accent-cyan)]" />
          <span class="text-[11px] animate-pulse">{pillText}</span>
        {:else}
          <Sparkles size={13} class="text-[var(--accent-amber)]" />
          <span class="text-[11px]">Translate</span>
        {/if}
      </button>

      <!-- Controls menu (gear) -->
      <div class="relative flex items-center">
        <button
          type="button"
          onclick={toggleMenu}
          class="px-1.5 py-1 text-[var(--text-muted)] hover:text-[var(--accent-cyan)] cursor-pointer flex items-center transition-colors border-l border-[var(--border-line)]/50 {menuOpen ? 'text-[var(--accent-cyan)]' : ''}"
          title="Controls — stop / restart"
          aria-label="Controls"
          aria-expanded={menuOpen}
        >
          <Settings size={13} class={menuOpen ? "rotate-90 transition-transform" : "transition-transform"} />
        </button>

        {#if menuOpen}
          <div
            class="absolute top-full right-0 mt-1.5 w-52 rounded-md bg-[var(--surface-panel)] border border-[var(--border-line)] shadow-xl py-1 z-10"
            role="menu"
          >
            <button
              type="button"
              onclick={stopPage}
              class="w-full text-left px-3 py-1.5 text-[11px] text-[var(--text-primary)] hover:bg-[var(--accent-cyan)]/10 hover:text-[var(--accent-cyan)] flex items-center gap-2 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              disabled={!targetImg}
              role="menuitem"
            >
              <Square size={12} />
              <span>Stop this page</span>
            </button>
            <button
              type="button"
              onclick={restartPage}
              class="w-full text-left px-3 py-1.5 text-[11px] text-[var(--text-primary)] hover:bg-[var(--accent-cyan)]/10 hover:text-[var(--accent-cyan)] flex items-center gap-2 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              disabled={!targetImg}
              role="menuitem"
            >
              <RotateCcw size={12} />
              <span>Restart this page</span>
            </button>
            <div class="my-1 border-t border-[var(--border-line)]/50"></div>
            <button
              type="button"
              onclick={stopAll}
              class="w-full text-left px-3 py-1.5 text-[11px] text-[var(--text-primary)] hover:bg-[var(--accent-amber)]/10 hover:text-[var(--accent-amber)] flex items-center gap-2 cursor-pointer"
              role="menuitem"
            >
              <OctagonX size={12} />
              <span>Stop all pages</span>
            </button>
            <button
              type="button"
              onclick={restartAll}
              class="w-full text-left px-3 py-1.5 text-[11px] text-[var(--text-primary)] hover:bg-[var(--accent-amber)]/10 hover:text-[var(--accent-amber)] flex items-center gap-2 cursor-pointer"
              role="menuitem"
            >
              <ListRestart size={12} />
              <span>Restart all pages</span>
            </button>
          </div>
        {/if}
      </div>
    </div>

    {#if stepBarVisible}
      <!-- 3-segment pipeline step bar (Detect → Translate → Render) -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="w-full h-[3px] mt-0.5 flex gap-[2px]"
        onmouseenter={() => (stepBarHover = true)}
        onmouseleave={() => (stepBarHover = false)}
      >
        {#each STEP_LABELS as label, i}
          {@const elapsed = formatElapsed(stepElapsedMs(i as PipelineStep))}
          {@const isDone = currentStep > i}
          {@const isCurrent = currentStep === i}
          <div
            class="flex-1 rounded-full transition-colors duration-300 {isDone
              ? 'bg-[var(--accent-cyan)]'
              : isCurrent
                ? 'bg-[var(--accent-cyan)]/60 animate-pulse'
                : 'bg-[var(--border-line)]'}"
            title="{label}: {isDone || isCurrent ? elapsed : 'pending'}"
          ></div>
        {/each}
      </div>
      {#if stepBarHover}
        <div class="w-full mt-0.5 flex gap-[2px] text-[9px] text-[var(--text-dim)] leading-tight">
          {#each STEP_LABELS as label, i}
            {@const elapsed = formatElapsed(stepElapsedMs(i as PipelineStep))}
            {@const reached = currentStep >= i}
            <span class="flex-1 text-center {reached ? '' : 'opacity-40'}">
              {label} {reached ? elapsed : '·'}
            </span>
          {/each}
        </div>
      {/if}
    {/if}
  </div>
{/if}

<style>
  .lmt-floating-root {
    font-family: 'JetBrains Mono', monospace, -apple-system, sans-serif;
  }
</style>
