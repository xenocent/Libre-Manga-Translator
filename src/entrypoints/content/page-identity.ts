import { quickHash } from "./utils";

/**
 * Page identity for the translation cache, free of `window` and storage so
 * the rules can be asserted anywhere.
 *
 * Identity is the reader URL plus the pixels - not the site rule's
 * `seriesName` (a regex over `document.title`, which readers rewrite while
 * loading) and not a page ordinal (which a slider renumbers). Either one
 * hands the same page a fresh key, and a fresh key is a fresh metered request
 * for a translation already in storage.
 */

/** Every page cache key, including the `local:` driver prefix. */
export const PAGE_CACHE_PREFIX = "local:page-cache-";

export type PageCacheKey = `local:${string}`;

/**
 * A signed image URL is re-issued with a new `?token=` on every load, so the
 * query cannot be part of the identity once the path names the image file.
 */
export function imageIdentityOf(src: string, baseUrl: string): string {
  if (src.startsWith("data:") || src.startsWith("blob:")) return src;
  let url: URL;
  try {
    url = new URL(src, baseUrl);
  } catch {
    return src;
  }
  if (!/\.(jpe?g|png|webp|avif|gif|bmp)$/i.test(url.pathname)) return src;
  const volatileParam = /^(?:token|access_token|expires?|exp|signature|sig|auth|auth_key|policy|hdnts|x-amz-[\w-]+|x-goog-[\w-]+)$/i;
  const stableParams = [...url.searchParams.entries()]
    .filter(([key]) => !volatileParam.test(key))
    .sort(([aKey, aValue], [bKey, bValue]) =>
      aKey.localeCompare(bKey) || aValue.localeCompare(bValue),
    );
  const query = new URLSearchParams(stableParams).toString();
  return `${url.origin}${url.pathname}${query ? `?${query}` : ""}`;
}

/** Stable in-document source key used by queue and translation status maps. */
export function pageSourceKeyOf(src: string, baseUrl: string): string {
  return quickHash(imageIdentityOf(src, baseUrl));
}

export function buildCacheKey(
  targetLang: string,
  location: { origin: string; pathname: string; href: string },
  originalSrc: string,
): PageCacheKey {
  const path = location.pathname.replace(/\/+$/, "");
  const namespace = `${location.origin}${path || "/"}`;
  return `${PAGE_CACHE_PREFIX}${targetLang}-${namespace}-${quickHash(imageIdentityOf(originalSrc, location.href))}`;
}
