/**
 * File-backed debug logging.
 *
 * The in-extension debug view has one blind spot by construction: it shows
 * *finished* pages. A page that hangs mid-pipeline (the exact case this exists
 * for — Gemini says done, the image sits on "translating") never reaches the
 * code that writes a `DebugEntry`, so the panel stays empty while the browser
 * is visibly stuck.
 *
 * This writer is driven by two sources:
 *   1. The transition timeline (`@/lib/debug/timeline`) — every queue/registry/
 *      stage change, in order, with relative timings.
 *   2. The `DebugEntry` summaries the pipeline already produces.
 *
 * Both are serialized to a single append-only text file and handed to the
 * browser's Downloads API, which is the only way an extension can put a file
 * on disk. Because MV3 cannot hold a file handle across a service-worker
 * restart, each flush writes the *whole* current buffer as one download.
 * Downloads from the same path overwrite, so the newest flush is the file.
 */

export interface FileLogOptions {
  /** File name inside the browser's download folder. */
  filename?: string;
  /** "uniquify" is wrong here: repeated flushes must overwrite, not pile up. */
  conflictAction?: "overwrite" | "uniquify";
}

export const FILE_LOG_FILENAME = "lmt-debug-timeline.log";

/**
 * A log file per page.
 *
 * Every tab flushes to the same download folder. With one shared name, two
 * open chapters overwrite each other's timeline and the file you inspect is
 * whichever tab flushed last — exactly the wrong file when you are trying to
 * see which page wedged. The name is derived from the page URL and is stable
 * across flushes, so a single page still overwrites only its own file.
 */
export function logFilenameFor(href: string, tag = "timeline"): string {
  // 32-bit FNV-1a, matching the extension's other page keys: short and stable.
  let hash = 0x811c9dc5;
  for (let i = 0; i < href.length; i++) {
    hash ^= href.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const id = (hash >>> 0).toString(16).padStart(8, "0");
  return `lmt-debug-${tag}-${id}.log`;
}

/**
 * Downloads API rejects with a user-cancelled error when the browser wants
 * confirmation; that must not be reported as an extension fault.
 */
function isUserCancelled(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? "");
  return /cancel/i.test(message);
}

/**
 * Writes `content` to the download folder, replacing the previous flush.
 *
 * Returns false when the browser refused the write (permission not granted,
 * download cancelled). Callers treat that as "no file this time" — logging
 * must never break translation, so the in-memory buffer stays authoritative.
 */
export async function writeFileLog(
  content: string,
  options: FileLogOptions = {},
): Promise<boolean> {
  const filename = options.filename ?? FILE_LOG_FILENAME;
  const conflictAction = options.conflictAction ?? "overwrite";
  try {
    // Blob URLs are the only way to hand arbitrary text to `downloads.download`
    // from an extension. An object URL from the service worker is not
    // reachable by the download manager, so the text is passed as a data URL.
    const url = `data:text/plain;charset=utf-8,${encodeURIComponent(content)}`;
    const downloadId = await browser.downloads.download({
      url,
      filename,
      conflictAction,
      saveAs: false,
    });
    return typeof downloadId === "number" && downloadId > 0;
  } catch (err) {
    if (!isUserCancelled(err)) {
      console.warn("LMT: file log write failed:", err);
    }
    return false;
  }
}

/**
 * Opens the log file in the browser's download list so the user can find it
 * without hunting through the filesystem.
 */
export async function revealFileLog(
  filename = FILE_LOG_FILENAME,
): Promise<boolean> {
  try {
    const [item] = await browser.downloads.search({ filenameRegex: filename });
    if (!item?.id) return false;
    await browser.downloads.show(item.id);
    return true;
  } catch {
    return false;
  }
}
