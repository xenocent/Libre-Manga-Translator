// Manga One - https://manga-one.com
// Canvas-based reader. Chapter URLs: /manga/<id>/chapter/<id>
// Query params carry pagination (type, sort_type, page, limit).
// Canvas elements render the page artwork; selectors below target the
// common wrapper patterns for this platform. Adjust after inspecting DOM.

export default {
  id: "manga-one",
  domain: "manga-one.com",
  seriesName: {
    regex: "\\/manga\\/([\\w-]+)\\/chapter",
    source: "path",
  },
  chapterId: {
    regex: "\\/chapter\\/([\\w-]+)",
    source: "path",
  },
  pageIndex: {
    regex: "[?&]page=(\\d+)",
    source: "hash",
  },
  containerSelector: "[class*=\"chapter\" i], [class*=\"reader\" i], [class*=\"viewer\" i], main",
  imageSelector: "canvas",
  pillPosition: "bottom-left",
  toolbarPosition: "bottom-left",
} satisfies SiteRule;
