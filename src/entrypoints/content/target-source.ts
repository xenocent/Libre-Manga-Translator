import {
  getElementSrc,
  type MangaTargetElement,
} from "../../lib/canvas/export";

/**
 * Resolve a target's current source at translation boundaries. Images already
 * expose their current src; canvases need a fresh pixel snapshot because manga
 * readers can redraw a later page into the same DOM node.
 */
export function getTargetSource(
  target: MangaTargetElement,
  refreshCanvas = false,
): string {
  return getElementSrc(target, refreshCanvas);
}
