import { describe, it, expect } from "bun:test";
import { getTargetSource } from "../../src/entrypoints/content/target-source";
import {
  queryScopedTargets,
  type QueryableRoot,
} from "../../src/entrypoints/content/auto-translate-targets";

function fakeRoot(
  selectors: Record<string, Element[]>,
): QueryableRoot {
  return {
    querySelectorAll(selector: string) {
      return selectors[selector] ?? [];
    },
  };
}

const image = (id: string) => ({ id }) as unknown as Element;

describe("adapter-scoped auto-translate target discovery", () => {
  it("collects canvas/image targets from every matching page container", () => {
    const first = image("page-1");
    const second = image("page-2");
    const pageOne = fakeRoot({ "canvas.page-image, canvas, img": [first] });
    const pageTwo = fakeRoot({ "canvas.page-image, canvas, img": [second] });
    const documentRoot = fakeRoot({
      ".image-container, .viewer": [pageOne as unknown as Element, pageTwo as unknown as Element],
    });

    expect(
      queryScopedTargets(
        documentRoot,
        ".image-container, .viewer",
        "canvas.page-image, canvas, img",
      ),
    ).toEqual([first, second]);
  });

  it("deduplicates a target returned through nested matching containers", () => {
    const page = image("page");
    const inner = fakeRoot({ canvas: [page] });
    const outer = fakeRoot({ canvas: [page] });
    const documentRoot = fakeRoot({
      ".container, .page": [outer as unknown as Element, inner as unknown as Element],
    });

    expect(queryScopedTargets(documentRoot, ".container, .page", "canvas")).toEqual([
      page,
    ]);
  });

  it("queries the document when the adapter container selector matches nothing", () => {
    const page = image("page");
    const documentRoot = fakeRoot({
      ".missing-container": [],
      canvas: [page],
    });

    expect(queryScopedTargets(documentRoot, ".missing-container", "canvas")).toEqual([
      page,
    ]);
  });

  it("refreshes reused canvases without changing normal image src behavior", () => {
    const imageDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "HTMLImageElement",
    );
    const canvasDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "HTMLCanvasElement",
    );

    class FakeImage {
      src = "https://cdn.example.org/page-1.jpg";
    }
    class FakeCanvas {
      width = 900;
      height = 1300;
      pixels = "data:image/jpeg;base64,page-1";
      toDataURL() {
        return this.pixels;
      }
    }

    Object.defineProperty(globalThis, "HTMLImageElement", {
      configurable: true,
      value: FakeImage,
    });
    Object.defineProperty(globalThis, "HTMLCanvasElement", {
      configurable: true,
      value: FakeCanvas,
    });

    try {
      const normalImage = new FakeImage() as unknown as HTMLImageElement;
      expect(getTargetSource(normalImage, true)).toBe(
        "https://cdn.example.org/page-1.jpg",
      );

      const canvas = new FakeCanvas();
      const target = canvas as unknown as HTMLCanvasElement;
      expect(getTargetSource(target)).toBe("data:image/jpeg;base64,page-1");

      canvas.pixels = "data:image/jpeg;base64,page-2";
      expect(getTargetSource(target)).toBe("data:image/jpeg;base64,page-1");
      expect(getTargetSource(target, true)).toBe("data:image/jpeg;base64,page-2");
    } finally {
      if (imageDescriptor) {
        Object.defineProperty(globalThis, "HTMLImageElement", imageDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "HTMLImageElement");
      }
      if (canvasDescriptor) {
        Object.defineProperty(globalThis, "HTMLCanvasElement", canvasDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "HTMLCanvasElement");
      }
    }
  });
});
