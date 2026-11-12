import { describe, it, expect } from "bun:test";
import {
  buildCacheKey,
  pageSourceKeyOf,
} from "../../src/entrypoints/content/page-identity";

const chapter = {
  origin: "https://manga-one.com",
  pathname: "/manga/66/chapter/343734",
  href: "https://manga-one.com/manga/66/chapter/343734",
};
const page = "https://cdn.example.org/manga/66/343734/0007.jpg";

describe("page cache identity", () => {
  it("is stable for one chapter and one image", () => {
    expect(buildCacheKey("id", chapter, page)).toBe(
      buildCacheKey("id", chapter, page),
    );
  });

  it("survives a signed image URL being re-issued on refresh", () => {
    const signed = `${page}?token=aaa&expires=1`;
    const rotated = `${page}?token=bbb&expires=2`;
    expect(buildCacheKey("id", chapter, signed)).toBe(
      buildCacheKey("id", chapter, rotated),
    );
    expect(pageSourceKeyOf(signed, chapter.href)).toBe(
      pageSourceKeyOf(rotated, chapter.href),
    );
    expect(buildCacheKey("id", chapter, signed)).toBe(
      buildCacheKey("id", chapter, page),
    );
  });

  it("separates languages, chapters and pages", () => {
    const otherChapter = { ...chapter, pathname: "/manga/66/chapter/343735" };
    expect(buildCacheKey("id", chapter, page)).not.toBe(
      buildCacheKey("en", chapter, page),
    );
    expect(buildCacheKey("id", chapter, page)).not.toBe(
      buildCacheKey("id", otherChapter, page),
    );
    expect(buildCacheKey("id", chapter, page)).not.toBe(
      buildCacheKey("id", chapter, `${chapter.origin}/0008.jpg`),
    );
  });

  it("keeps the query when it is the image identity", () => {
    const dynamic = "https://cdn.example.org/image.php?id=12&page=3";
    expect(buildCacheKey("id", chapter, dynamic)).not.toBe(
      buildCacheKey("id", chapter, `${dynamic}&sig=x`),
    );
    expect(pageSourceKeyOf(dynamic, chapter.href)).not.toBe(
      pageSourceKeyOf(`${dynamic}&sig=x`, chapter.href),
    );
  });

  it("preserves meaningful page parameters on image URLs", () => {
    const pageOne = "https://cdn.example.org/page.jpg?page=1&token=a";
    const pageTwo = "https://cdn.example.org/page.jpg?page=2&token=b";
    expect(pageSourceKeyOf(pageOne, chapter.href)).not.toBe(
      pageSourceKeyOf(pageTwo, chapter.href),
    );
  });

  it("treats a trailing slash as the same chapter", () => {
    expect(buildCacheKey("id", { ...chapter, pathname: `${chapter.pathname}/` }, page)).toBe(
      buildCacheKey("id", chapter, page),
    );
  });
});
