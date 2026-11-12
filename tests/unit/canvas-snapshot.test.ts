import { describe, it, expect, beforeEach, afterEach } from "bun:test";

/**
 * `snapshotCanvasStable` and `imageToBase64` touch the DOM (canvas 2D context,
 * toDataURL). bun has no DOM, so these tests install a minimal canvas stub on
 * `globalThis` that records how many times the expensive readback path runs.
 * The contract under test is the caching + sizing logic, not real pixel
 * encoding — that is exercised in the browser e2e suite.
 */

type Ctx2D = {
  fillStyle: string;
  fillRect: () => void;
  drawImage: () => void;
};

type StubCanvas = {
  width: number;
  height: number;
  getContext: (kind: "2d", opts?: unknown) => Ctx2D | null;
  toDataURL: (type?: string, quality?: number) => string;
};

let createdCanvases: StubCanvas[] = [];

function makeStubCanvas(w: number, h: number): StubCanvas {
  const canvas: StubCanvas = {
    width: w,
    height: h,
    getContext: (kind) => {
      if (kind !== "2d") return null;
      return {
        fillStyle: "",
        fillRect: () => {},
        drawImage: () => {},
      };
    },
    toDataURL: function (this: StubCanvas, type = "image/png", quality) {
      // Deterministic and unique per current size so cache hits are observable.
      return `data:${type};stub,w${this.width}h${this.height},q${quality ?? ""}`;
    },
  };
  createdCanvases.push(canvas);
  return canvas;
}

const originalCreateElement = (globalThis as any).document?.createElement;

beforeEach(() => {
  createdCanvases = [];
  (globalThis as any).document = {
    createElement: (tag: string) => {
      if (tag === "canvas") return makeStubCanvas(300, 150);
      return {};
    },
  };
  // HTMLCanvasElement is checked with `instanceof` in the source.
  (globalThis as any).HTMLCanvasElement = class {};
  (globalThis as any).HTMLImageElement = class {};
});

afterEach(() => {
  if (originalCreateElement) {
    (globalThis as any).document.createElement = originalCreateElement;
  } else {
    delete (globalThis as any).document;
  }
  delete (globalThis as any).HTMLCanvasElement;
  delete (globalThis as any).HTMLImageElement;
});

// The module binds `document.createElement` at call time, so importing after the
// stub is installed keeps the reference live.
const { snapshotCanvasStable, imageToBase64 } = await import(
  "../../src/lib/canvas/export"
);

/** Build a fake source canvas that also passes `instanceof HTMLCanvasElement`. */
function fakeSourceCanvas(w: number, h: number): HTMLCanvasElement {
  const c = makeStubCanvas(w, h);
  Object.setPrototypeOf(c, (globalThis as any).HTMLCanvasElement.prototype);
  return c as unknown as HTMLCanvasElement;
}

describe("snapshotCanvasStable", () => {
  it("returns null for a zero-sized canvas", () => {
    const c = fakeSourceCanvas(0, 0);
    expect(snapshotCanvasStable(c)).toBeNull();
  });

  it("produces a JPEG data URL for a sized canvas", () => {
    const c = fakeSourceCanvas(800, 1200);
    const url = snapshotCanvasStable(c);
    expect(url).toMatch(/^data:image\/jpeg/);
    expect(url).toContain("w800h1200");
  });

  it("caches by backing size and reuses the same URL on a second call", () => {
    const c = fakeSourceCanvas(800, 1200);
    const first = snapshotCanvasStable(c);
    const createdAfterFirst = createdCanvases.length;
    const second = snapshotCanvasStable(c);
    expect(second).toBe(first);
    // No new 2D canvas was created for the cache hit.
    expect(createdCanvases.length).toBe(createdAfterFirst);
  });

  it("re-snapshots when the backing size changes", () => {
    const c = fakeSourceCanvas(800, 1200);
    const first = snapshotCanvasStable(c);
    c.width = 1600;
    c.height = 2400;
    const second = snapshotCanvasStable(c);
    expect(second).not.toBe(first);
    expect(second).toContain("w1600h2400");
  });
});

describe("imageToBase64 for canvas targets", () => {
  it("uses the stable snapshot for a canvas element", () => {
    const c = fakeSourceCanvas(800, 1200);
    const url = imageToBase64(c);
    expect(url).toMatch(/^data:image\/jpeg/);
    expect(url).toContain("w800h1200");
  });
});