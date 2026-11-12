/** Minimal query surface shared by Document and Element. */
export interface QueryableRoot {
  querySelectorAll(selector: string): ArrayLike<Element>;
}

/**
 * Collect image/canvas targets from every matching adapter container.
 *
 * Some adapters name page-level wrappers in `containerSelector`; using only
 * `document.querySelector()` silently limits a chapter scan to the first page.
 * Nested alternatives can return the same target more than once, so results
 * are deduplicated by element identity.
 */
export function queryScopedTargets(
  documentRoot: QueryableRoot,
  containerSelector: string | undefined,
  imageSelector: string,
): Element[] {
  let roots: QueryableRoot[] = [documentRoot];

  if (containerSelector) {
    try {
      const containers = Array.from(
        documentRoot.querySelectorAll(containerSelector),
      );
      if (containers.length > 0) roots = containers;
    } catch {
      // An invalid container selector falls back to querying the document.
    }
  }

  const targets = new Set<Element>();
  for (const root of roots) {
    try {
      for (const target of Array.from(root.querySelectorAll(imageSelector))) {
        targets.add(target);
      }
    } catch {
      // A bad adapter selector is handled by the caller's generic fallback.
    }
  }
  return [...targets];
}
