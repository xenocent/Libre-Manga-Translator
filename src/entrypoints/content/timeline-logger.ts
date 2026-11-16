/**
 * Content-script side of the timeline log.
 *
 * The transit timeline lives in `@/lib/debug/timeline`; this module turns it on
 * and keeps a copy in extension storage. It must be installed before the
 * pipeline starts so early transitions (queue dispatch, registry claim) are not
 * lost. Nothing here writes to disk — see the note above `flushNow`.
 */
import { storage } from "#imports";
import {
  clearTimeline,
  dlog,
  formatTimeline,
  formatTimelineHeader,
  getTimeline,
  isTimelineEnabled,
  setTimelineEnabled,
  setTimelineSink,
} from "@/lib/debug/timeline";

const TIMELINE_ENABLED_KEY = "local:debug-enabled";
const TIMELINE_STORAGE_KEY = "local:debug-timeline";

let installed = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let pendingFlush = false;

/**
 * Writes the whole buffer to storage, not a delta.
 *
 * Storage is cheap and stays local — no download event. This is the authoritative
 * copy a wedge leaves behind in the extension.
 */
async function flushNow(): Promise<void> {
  flushTimer = null;
  if (!isTimelineEnabled()) return;
  const text = buildText();
  try {
    await storage.setItem(TIMELINE_STORAGE_KEY, text);
  } catch (err) {
    // "Extension context invalidated" fires when the extension reloads while an
    // old content script is still alive — the write is expected to fail there
    // and there is nothing to recover, so stay quiet instead of spamming the
    // console on every flush tick.
    const message = err instanceof Error ? err.message : String(err ?? "");
    if (!/invalidat/i.test(message)) {
      console.warn("LMT: timeline storage write failed:", err);
    }
  }
}

function buildText(): string {
  return [
    formatTimelineHeader(`LMT debug timeline — ${location.href}`),
    formatTimeline(),
  ].join("\n");
}

/**
 * Coalesces bursts. A chapter start fires dozens of transitions in a few
 * hundred ms; one flush per 400 ms keeps the stored copy current without paying
 * a storage write for every line.
 */
function scheduleFlush(): void {
  if (!isTimelineEnabled()) return;
  if (flushTimer) {
    pendingFlush = true;
    return;
  }
  flushTimer = setTimeout(() => {
    void flushNow();
    if (pendingFlush) {
      pendingFlush = false;
      scheduleFlush();
    }
  }, 400);
}

/**
 * Installs the timeline once per document, honouring the debug toggle.
 *
 * Returns immediately when debugging is off: nothing is buffered, so a normal
 * session pays a single storage read and no per-transition work.
 */
export async function installTimelineLogger(): Promise<void> {
  if (installed) return;
  installed = true;

  let enabled = false;
  try {
    enabled = (await storage.getItem<boolean>(TIMELINE_ENABLED_KEY)) ?? false;
  } catch {
    enabled = false;
  }
  setTimelineEnabled(enabled);
  if (enabled) {
    clearTimeline();
    setTimelineSink(() => scheduleFlush());
    dlog("boot", "timeline enabled", {
      url: location.href,
      ua: navigator.userAgent.slice(0, 80),
    });
  }

  // The toggle is global, so a session started with debugging off can begin
  // recording the moment it is flipped — without a page reload. Turning it off
  // flushes to storage once so the record is not left mid-burst.
  storage.watch<boolean>(TIMELINE_ENABLED_KEY, (value) => {
    const on = value ?? false;
    if (on === isTimelineEnabled()) return;
    setTimelineEnabled(on);
    if (on) {
      clearTimeline();
      setTimelineSink(() => scheduleFlush());
      dlog("boot", "timeline enabled (toggle)", { url: location.href });
    } else {
      setTimelineSink(null);
      void flushNow();
    }
  });

  // Flush to storage when the page goes away so the record survives. Storage
  // only — no download. `visibilitychange` is the reliable one: a bfcache
  // navigation never fires `pagehide` handlers.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      void flushNow();
    } else if (isTimelineEnabled()) {
      // Coming back from bfcache: the queue may have been torn down.
      dlog("boot", "page visible again", {
        timelineEntries: getTimeline().length,
      });
    }
  });
  window.addEventListener("pagehide", () => void flushNow());
}

/** Records a page-level fact the DebugEntry path would miss. */
export function recordTimeline(
  scope: string,
  msg: string,
  data?: Record<string, unknown>,
): void {
  dlog(scope, msg, data);
  scheduleFlush();
}
