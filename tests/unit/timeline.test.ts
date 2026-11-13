import { describe, expect, it } from "bun:test";
import {
  clearTimeline,
  dlog,
  formatTimeline,
  formatTimelineHeader,
  getTimeline,
  isTimelineEnabled,
  setTimelineEnabled,
  setTimelineSink,
  shortKey,
} from "../../src/lib/debug/timeline";

describe("diagnostic timeline", () => {
  it("is a no-op collector until enabled", () => {
    setTimelineEnabled(false);
    dlog("test", "recorded while off");
    expect(getTimeline()).toHaveLength(0);
  });

  it("records ordered transition entries with monotonic offsets", () => {
    setTimelineEnabled(true);
    clearTimeline();
    dlog("queue", "dispatch", { page: "p1" });
    dlog("registry", "pending", { page: "p1" });
    const entries = getTimeline();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      scope: "queue",
      msg: "dispatch",
      data: { page: "p1" },
    });
    expect(entries[1].scope).toBe("registry");
    expect(entries[1].ut).toBeGreaterThanOrEqual(entries[0].ut);
    setTimelineEnabled(false);
  });

  it("caps the buffer and truncates oversized values", () => {
    setTimelineEnabled(true);
    clearTimeline();
    const long = "x".repeat(500);
    for (let i = 0; i < 900; i++) dlog("boot", "fill", { long, i });
    // Bounded so a long session cannot grow the log without limit.
    expect(getTimeline().length).toBeLessThanOrEqual(800);
    const last = getTimeline().at(-1)!;
    expect((last.data as any).long.length).toBeLessThan(200);
    expect((last.data as any).long).toContain("…");
    setTimelineEnabled(false);
  });

  it("redacts data URLs from the log", () => {
    setTimelineEnabled(true);
    clearTimeline();
    const dataUrl = "data:image/jpeg;base64,AAAA...";
    dlog("detect", "snapshot", { src: dataUrl });
    const [entry] = getTimeline();
    expect((entry.data as any).src).toBe(`data:(${dataUrl.length} chars)`);
    setTimelineEnabled(false);
  });

  it("clears previous entries when disabled", () => {
    setTimelineEnabled(true);
    clearTimeline();
    dlog("boot", "one");
    setTimelineEnabled(false);
    expect(getTimeline()).toHaveLength(0);
  });

  it("round-trips to the human-readable file format", () => {
    setTimelineEnabled(true);
    clearTimeline();
    dlog("queue", "dispatch", { page: "p1", active: 1 });
    const lines = formatTimeline().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[queue] dispatch");
    expect(lines[0]).toContain('"page":"p1"');
    expect(formatTimelineHeader("probe")).toContain("# probe");
    setTimelineEnabled(false);
  });

  it("sink is invoked per entry", () => {
    setTimelineEnabled(true);
    clearTimeline();
    const seen: string[] = [];
    setTimelineSink((e) => seen.push(e.msg));
    dlog("queue", "enqueue");
    dlog("queue", "dispatch");
    expect(seen).toEqual(["enqueue", "dispatch"]);
    setTimelineSink(null);
    setTimelineEnabled(false);
  });

  it("stays unique enough to correlate pages", () => {
    const long = `https://reader.test/manga/series/${"a".repeat(60)}/page/001.jpg?token=${"b".repeat(50)}`;
    const k = shortKey(long);
    // Short enough for the log, long enough to distinguish pages.
    expect(k.length).toBeLessThanOrEqual(26);
    expect(k).toContain("…");
  });
});
