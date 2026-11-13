/**
 * Content-script side of the timeline log.
 *
 * The transit timeline lives in `@/lib/debug/timeline`; this module turns it on
 * and keeps a copy in extension storage, plus asks the background worker to
 * write the file. It must be installed before the pipeline starts so early
 * transitions (queue dispatch, registry claim) are not lost.
 */
import { browser, storage } from "#imports";
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
import { logFilenameFor } from "@/lib/debug/file-log";

const TIMELINE_ENABLED_KEY = "local:debug-enabled";
const TIMELINE_STORAGE_KEY = "local:debug-timeline";

let installed = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let pendingFlush = false;
let fileTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * How often the file on disk is rewritten.
 *
 * The storage copy is cheap and goes out every 400 ms. The file copy goes
 * through `browser.downloads`, and rewriting it every few hundred ms would
 * flood the download shelf and get the extension throttled. Once every few
 * seconds is enough: the buffer is the record, the file is the snapshot you
 * read after a page wedges. Hidden/pagehide force an immediate final write,
 * so nothing that happened is lost.
 */
const FILE_FLUSH_MS = 4_000;

/**
 * Writes the whole buffer, not a delta.
 *
 * A delta needs a file handle that survives a service-worker restart, which
 * MV3 does not allow. Rewriting the buffer means the file on disk is always a
 * complete, self-consistent timeline — and the buffer is capped, so the write
 * stays bounded.
 */
async function flushNow(): Promise<void> {
  flushTimer = null;
  if (!isTimelineEnabled()) return;
  const text = buildText();
  try {
    await storage.setItem(TIMELINE_STORAGE_KEY, text);
  } catch (err) {
    console.warn("LMT: timeline storage write failed:", err);
  }
  scheduleFileWrite(text);
}

function buildText(): string {
  return [
    formatTimelineHeader(`LMT debug timeline — ${location.href}`),
    formatTimeline(),
  ].join("\n");
}

/** Coalesced, rate-limited handoff to the background file writer. */
function scheduleFileWrite(text: string): void {
  if (fileTimer) return;
  fileTimer = setTimeout(() => {
    fileTimer = null;
    if (!isTimelineEnabled()) return;
    void browser.runtime
      .sendMessage({
        type: "WRITE_DEBUG_FILE",
        data: { kind: "timeline", content: text, filename: logFilenameFor(location.href) },
      })
      .catch((err) => {
        console.warn("LMT: timeline file write failed:", err);
      });
  }, FILE_FLUSH_MS);
  (fileTimer as { unref?: () => void }).unref?.();
}

/** Final write: skips the rate limit, so a closing page is never truncated. */
async function flushFileNow(): Promise<void> {
  if (!isTimelineEnabled()) return;
  if (fileTimer) {
    clearTimeout(fileTimer);
    fileTimer = null;
  }
  const text = buildText();
  try {
    await storage.setItem(TIMELINE_STORAGE_KEY, text);
  } catch {
    // Best effort; the file write below is the one that matters here.
  }
  try {
    await browser.runtime.sendMessage({
      type: "WRITE_DEBUG_FILE",
      data: { kind: "timeline", content: text, filename: logFilenameFor(location.href) },
    });
  } catch (err) {
    console.warn("LMT: timeline file write failed:", err);
  }
}

/**
 * Coalesces bursts. A chapter start fires dozens of transitions in a few
 * hundred ms; one flush per 400 ms keeps the disk file current without paying
 * a message hop for every line.
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
  // recording the moment it is flipped — without a page reload.
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
      void flushFileNow();
    }
  });

  // Flush whatever exists when the page goes away. `visibilitychange` is the
  // reliable one: a bfcache navigation never fires `pagehide` handlers.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      void flushFileNow();
    } else if (isTimelineEnabled()) {
      // Coming back from bfcache: the queue may have been torn down.
      dlog("boot", "page visible again", {
        timelineEntries: getTimeline().length,
      });
    }
  });
  window.addEventListener("pagehide", () => void flushFileNow());
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
