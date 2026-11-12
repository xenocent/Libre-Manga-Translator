export type MangaTargetElement = HTMLImageElement | HTMLCanvasElement;

let taintedCanvasCounter = 0;

/**
 * Snapshot a canvas into a stable JPEG data URL for detection.
 *
 * `canvas.toDataURL()` is unreliable for GPU-accelerated / WebGL canvases: the
 * drawing buffer is not preserved after compositing, so the call can return a
 * blank (all-black or all-transparent) frame. Drawing the source canvas into a
 * fresh 2D canvas with `drawImage()` forces a deterministic readback, and
 * compositing an opaque white matte first means a transparent WebGL canvas
 * cannot become a black rectangle the detector reads as empty artwork.
 *
 * The result is cached on the element keyed by `width`x`height`, so the
 * pipeline stages (detect → inpaint → translate) reuse one snapshot and only
 * re-snapshot when the canvas is redrawn to a new backing size.
 */
export function snapshotCanvasStable(
  canvas: HTMLCanvasElement,
  quality = 0.95,
): string | null {
  const w = canvas.width;
  const h = canvas.height;
  if (!w || !h) return null;

  const key = `w${w}h${h}`;
  const cached = (canvas as any).__lmt_stable_src as
    | { key: string; url: string }
    | undefined;
  if (cached && cached.key === key) return cached.url;

  try {
    // Read the source pixels into a 2D canvas first. This works for both a
    // plain 2D canvas and a WebGL/GPU canvas, where `drawImage` triggers a
    // proper readback instead of the blank buffer `toDataURL` can return.
    const copy = document.createElement("canvas");
    copy.width = w;
    copy.height = h;
    const ctx = copy.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;

    // Opaque white matte: transparent pixels encoded as JPEG turn black.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(canvas, 0, 0);

    const dataUrl = copy.toDataURL("image/jpeg", quality);
    (canvas as any).__lmt_stable_src = { key, url: dataUrl };
    return dataUrl;
  } catch {
    return null;
  }
}

export function getElementSrc(
  el: MangaTargetElement,
  forceRefresh = false,
): string {
  if (el instanceof HTMLImageElement) return el.src;
  if (el instanceof HTMLCanvasElement) {
    if (!forceRefresh && (el as any).__lmt_src) {
      return (el as any).__lmt_src;
    }
    // A forced refresh still reuses the size-keyed stable snapshot when the
    // backing store is unchanged: readers that recycle one <canvas> and only
    // redraw its pixels must not pay a full re-encode on every pipeline stage.
    const stable = snapshotCanvasStable(el);
    if (stable) {
      (el as any).__lmt_src = stable;
      return stable;
    }
    try {
      const dataUrl = el.toDataURL("image/jpeg", 0.95);
      (el as any).__lmt_src = dataUrl;
      return dataUrl;
    } catch {
      if (!(el as any).__lmt_src) {
        taintedCanvasCounter += 1;
        (el as any).__lmt_src = `canvas://lmt-tainted-${taintedCanvasCounter}-${el.width}x${el.height}`;
      }
      return (el as any).__lmt_src;
    }
  }
  return "";
}

export function imageToBase64(img: MangaTargetElement): string | null {
  try {
    if (img instanceof HTMLCanvasElement) {
      // Prefer the stable snapshot: a WebGL canvas read with `toDataURL`
      // directly can come back blank, which the detector reads as no artwork.
      const stable = snapshotCanvasStable(img);
      if (stable) {
        (img as any).__lmt_src = stable;
        return stable;
      }
      const dataUrl = img.toDataURL("image/jpeg", 0.95);
      if (!(img as any).__lmt_src || String((img as any).__lmt_src).startsWith("data:")) {
        (img as any).__lmt_src = dataUrl;
      }
      return dataUrl;
    }
    const width = img.naturalWidth;
    const height = img.naturalHeight;
    if (!width || !height) return null;

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, width, height);

    return canvas.toDataURL("image/jpeg", 0.95);
  } catch {
    return null;
  }
}

export function exportCanvasToJpeg(
  canvas: HTMLCanvasElement,
  quality = 0.85,
  filename?: string,
): void {
  const link = document.createElement("a");
  link.download = filename || `lmt-export-${Date.now()}.jpg`;
  link.href = canvas.toDataURL("image/jpeg", quality);
  document.body.appendChild(link);
  link.click();
  link.remove();
}
