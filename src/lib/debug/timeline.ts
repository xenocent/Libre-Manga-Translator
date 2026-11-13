/**
 * In-memory diagnostic timeline.
 *
 * Debug entries (`DebugEntry`) record one summary per finished page. That is
 * exactly what a *stuck* page never produces, which is the case this log
 * exists for: a pipeline that stops mid-flight leaves no summary behind, so
 * the only evidence is the sequence of state transitions leading up to it.
 *
 * Every entry is a single JSONL line so the file can be read with `grep`,
 * `jq`, or a text editor without any tooling.
 */

export interface TimelineEntry {
  /** Wall clock, epoch ms. */
  t: number;
  /** Milliseconds since this document's timeline started. */
  ut: number;
  /** Which subsystem emitted it: registry, queue, detect, ocr, ... */
  scope: string;
  msg: string;
  data?: Record<string, unknown>;
}

/**
 * Bounded so a long session cannot grow the log without limit. 800 entries of
 * short strings is well under the storage quota even when the pipeline is
 * looping over a whole chapter.
 */
const MAX_ENTRIES = 800;
const MAX_STRING = 180;
const MAX_DATA_KEYS = 12;

let entries: TimelineEntry[] = [];
let started = Date.now();
let enabled = false;

/** Called on every append; used to persist and to flush to a file. */
let sink: ((entry: TimelineEntry) => void) | null = null;

/** Keeps identifiers readable while still unique enough to correlate. */
export function shortKey(key: string): string {
  if (!key) return "";
  if (key.length <= 24) return key;
  return `${key.slice(0, 16)}…${key.slice(-6)}`;
}

function sanitize(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    // Data URLs are the one thing that would blow up the log: every page
    // snapshot is a multi-hundred-KB base64 blob.
    if (value.startsWith("data:")) return `data:(${value.length} chars)`;
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  return String(value);
}

function sanitizeData(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!data) return undefined;
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const [k, v] of Object.entries(data)) {
    if (n++ >= MAX_DATA_KEYS) {
      out["…"] = "truncated";
      break;
    }
    out[k] = sanitize(v);
  }
  return out;
}

export function setTimelineEnabled(value: boolean): void {
  enabled = value;
  if (!value) entries = [];
}

export function isTimelineEnabled(): boolean {
  return enabled;
}

export function setTimelineSink(fn: ((entry: TimelineEntry) => void) | null): void {
  sink = fn;
}

/**
 * Records one transition. A no-op while debugging is off, so callers can sit
 * on hot paths (every queue drain, every registry write) without a guard.
 */
export function dlog(
  scope: string,
  msg: string,
  data?: Record<string, unknown>,
): void {
  if (!enabled) return;
  const entry: TimelineEntry = {
    t: Date.now(),
    ut: entryNow(),
    scope,
    msg,
    data: sanitizeData(data),
  };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES);
  }
  try {
    sink?.(entry);
  } catch {
    // A broken sink must never take the pipeline down with it.
  }
}

function entryNow(): number {
  return Date.now() - started;
}

export function getTimeline(): TimelineEntry[] {
  return entries;
}

export function clearTimeline(): void {
  started = Date.now();
  entries = [];
}

/** One JSONL line per entry, with a human-readable local time prefix. */
export function formatTimeline(list: TimelineEntry[] = entries): string {
  return list
    .map((e) => {
      const clock = new Date(e.t).toLocaleTimeString("en-GB", { hour12: false });
      const head = `${clock} +${String(e.ut).padStart(6, " ")}ms [${e.scope}] ${e.msg}`;
      return e.data ? `${head} ${JSON.stringify(e.data)}` : head;
    })
    .join("\n");
}

/** Header written above the entries so a saved file explains itself. */
export function formatTimelineHeader(title: string): string {
  return [
    `# ${title}`,
    `# generated ${new Date().toISOString()}`,
    `# entries ${entries.length}${entries.length >= MAX_ENTRIES ? " (capped)" : ""}`,
    "# t = wall clock, +ms = since this document's timeline started",
    "",
  ].join("\n");
}
