import { beforeEach, describe, expect, it, mock } from "bun:test";

/**
 * The writer is a thin wrapper over `browser.downloads.download`. These tests
 * pin the two behaviours that matter for diagnostics:
 *   1. Repeated flushes OVERWRITE one file instead of piling up copies.
 *   2. A refused write returns false and never throws into the pipeline.
 */

type DownloadCall = {
  url: string;
  filename: string;
  conflictAction: string;
  saveAs: boolean;
};

let calls: DownloadCall[] = [];
let behaviour: () => Promise<number> = async () => 1;

(globalThis as any).browser = {
  downloads: {
    download: async (opts: DownloadCall) => {
      calls.push(opts);
      return behaviour();
    },
    search: async () => [{ id: 7 }],
    show: async () => {},
  },
};

const { writeFileLog, revealFileLog, FILE_LOG_FILENAME } = await import(
  "../../src/lib/debug/file-log"
);

beforeEach(() => {
  calls = [];
  behaviour = async () => 1;
});

describe("debug file log writer", () => {
  it("writes text as a data URL and overwrites the same filename", async () => {
    const ok = await writeFileLog("line one\nline two");
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].conflictAction).toBe("overwrite");
    expect(calls[0].filename).toBe(FILE_LOG_FILENAME);
    expect(decodeURIComponent(calls[0].url.split(",").slice(1).join(","))).toBe(
      "line one\nline two",
    );

    // A second flush must target the same path, so the newest log wins.
    await writeFileLog("line one\nline two\nline three");
    expect(calls).toHaveLength(2);
    expect(calls[1].filename).toBe(calls[0].filename);
  });

  it("honours a caller-supplied filename", async () => {
    await writeFileLog("x", { filename: "custom.log" });
    expect(calls[0].filename).toBe("custom.log");
  });

  it("returns false instead of throwing when the browser refuses", async () => {
    behaviour = async () => {
      throw new Error("Invalid filename");
    };
    // Logging must never break translation.
    expect(await writeFileLog("x")).toBe(false);
  });

  it("treats a user-cancelled download as a quiet no-write", async () => {
    const warn = mock(() => {});
    const original = console.warn;
    console.warn = warn as any;
    behaviour = async () => {
      throw new Error("Download canceled by the user");
    };
    expect(await writeFileLog("x")).toBe(false);
    // Cancellation is expected when the browser prompts; do not warn.
    expect(warn).not.toHaveBeenCalled();
    console.warn = original;
  });

  it("reveals the written file by its download entry", async () => {
    expect(await revealFileLog()).toBe(true);
  });

  it("reports failure to reveal when no download matches", async () => {
    (globalThis as any).browser.downloads.search = async () => [];
    expect(await revealFileLog("missing.log")).toBe(false);
  });
});
