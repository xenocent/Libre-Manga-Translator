# UPDATE_PLAN — Pill/Readout Correctness + Step Bar

This plan fixes the frozen-pill / lying-readout bugs seen on rawkuma (chapter 49),
adds a 3-segment step bar with per-step time, and makes "Stop this page" actually
stop. Written for `/workit` to execute top-to-bottom.

## 1. Background

On rawkuma, Gemini calls all succeed (37 green logs) yet the pill freezes on
"Detecting text…" and the bottom-right readout claims "17/17 translated" while
only 2 pages are actually rendered. The extension console shows two errors:

- `Uncaught Error: https://svelte.dev/e/effect_update_depth_exceeded`
- `Error: You must add the 'storage' permission to your manifest to use 'wxt/storage'`

There are 7 concrete defects (2 introduced by the in-progress step-bar edit):

| # | Defect | Cause | File |
|---|--------|-------|------|
| 1 | Infinite loop `effect_update_depth_exceeded` | New step-bar `$effect` reads `progressText` and writes `currentStep`/`stepStartTimes`, re-triggering itself | FloatingTrigger.svelte |
| 2 | Build break: `Registry.getStatusBySrc` does not exist | In-progress edit calls a method that isn't in the registry; real API is `getStatus(src)` | FloatingTrigger.svelte:354 |
| 3 | Pill frozen "Detecting text…" even when page done | `adoptMode` trusts the overlay's `data-lmt-progress` attribute, which is set once at mount and never cleared; a done page keeps the stale string | FloatingTrigger.svelte |
| 4 | Readout lies "17/17 translated" | `doneCount()` counts every `done` registry entry, including pages restored from cache (never translated this session) | translation-registry.ts |
| 5 | Pill vanishes when mouse moves to click it | `scheduleHide` (250ms) fires on image mouseleave; fast move to pill beats the pill's own `onmouseenter` cancel | FloatingTrigger.svelte |
| 6 | "Stop this page" does nothing visible | `cancelActive` calls `Registry.markIdle`, but the overlay is never closed/aborted — it keeps rendering | auto-translate.ts / Overlay.svelte |
| 7 | `storage` permission error (needs diagnosis) | Manifest ALREADY has `"storage"`; error likely fires in a non-extension context (setup page / test). Diagnose before touching manifest | wxt.config.ts / storage usage |

## 2. Goals

- Fix the two self-inflicted breaks (#1 #2) so the build passes and nothing loops.
- Pill shows the true per-page stage: "Translated" when done, never a stale "Detecting text…".
- Pill no longer disappears when the mouse moves onto it to click.
- "Stop this page" visibly halts the pinned page's pipeline and closes its overlay.
- Readout `completed` no longer counts cache-restored pages as translated-this-session.
- Add a 3-segment step bar (Detect → Translate → Render) with per-step elapsed time on hover.

## 3. Scope

Files/components to CHANGE:
- `src/lib/components/FloatingTrigger.svelte` — pill stage, hide race, step bar (#1 #2 #3 #5)
- `src/entrypoints/content/translation-registry.ts` — separate live-done from cache-restored (#4)
- `src/lib/components/Sidebar.svelte` — readout renders live-completed (#4)
- `src/entrypoints/content/auto-translate.ts` — stop aborts the running job (#6)
- `src/entrypoints/content/index.ts` — wire stop → overlay close (#6)

Files/components to PRESERVE (do not touch):
- `wxt.config.ts` manifest permissions — `"storage"` is already present; do not add it (#7 is diagnosis-only)
- `src/lib/components/Overlay.svelte` pipeline internals — only add a close/abort hook, do not rewrite
- All Gemini/network code — logs prove it works

Out of scope (explicitly NOT doing):
- Saved-sites in the popup (separate follow-up task, not this plan)
- OCR-inside-translate refactor
- Strict serial-queue setting
- manga-one selector tightening

## 4. Steps

1. Fix #2 first (build break): in `FloatingTrigger.svelte` line ~354, replace
   `Registry.getStatusBySrc(src)` with the real import. The registry exports
   `getStatus(src)` (translation-registry.ts:142). Import it:
   `import { isPending as isRegistryPending, getStatus as getRegistryStatus } from "@/entrypoints/content/translation-registry";`
   then use `getRegistryStatus(src)`. Verify with `npx svelte-check` → expect 0 errors
   (this alone should clear the "no such member" error).

2. Fix #1 (infinite loop): the step-bar `$effect` currently is
   `$effect(() => { if (!targetImg || status !== "translating") return; trackStep(progressText); });`
   `trackStep` writes `currentStep` and `stepStartTimes`, both read back inside the
   effect's dependency graph → self-trigger. Replace the `$effect` with a plain
   function call driven from where `progressText` is already assigned
   (`adoptMode`, `handleProgress`). Delete the `$effect(() => { ... trackStep ... })`
   block entirely; call `trackStep(msg)` synchronously right after each
   `progressText = <msg>` assignment. Verify: `npx svelte-check` 0 errors, and no
   `effect_update_depth_exceeded` at runtime.

3. Finish #3 (stale "Detecting text…"): the in-progress `adoptMode` change is the
   right direction — when `getRegistryStatus(src) === "done"`, set
   `status = "translated"`, `progressText = "Translated"`, and return early WITHOUT
   reading `getOverlayProgress`. Confirm the early-return is placed before the
   `if (q === "translating")` branch. Also guard `handleProgress`: ignore
   `lmt:progress` events whose `src` maps to a registry-`done` page.

4. Fix #5 (hide race): in `scheduleHide`, raise the timeout 250ms → 400ms, and in the
   timeout callback, do NOT hide if the cursor is over `.lmt-floating-root`. Add a
   module-scope `let cursorInPill = false;` toggled by the pill root's
   `onmouseenter`/`onmouseleave`; check it inside the timeout before `visible = false`.
   This keeps the pill alive while the mouse travels to it.

5. Fix #6 (Stop this page): `cancelActive` (auto-translate.ts) already drops the slot
   and calls `Registry.markIdle(src)`. Add overlay teardown: in `index.ts`, the
   `onStopPage` handler must, after calling `autoTranslator.cancelActive(img)`, also
   look up `translatedSrcMap`/`overlays` for that src and call `overlay.ui.remove()`
   + `overlays.delete(originalSrc)` + reset `overlay.wrapper` `data-lmt-mode` to
   `"idle"`. Expose a small helper `closeOverlayForSrc(src)` in index.ts and call it
   from `onStopPage`. If the pipeline is mid-`await`, it will still finish computing
   but its overlay is gone and the registry is idle, so nothing renders — acceptable
   for this pass. Verify by clicking Stop on a translating page → pill closes,
   overlay disappears, page returns to original.

6. Fix #4 (lying readout): in `translation-registry.ts`, track which srcs reached
   `done` via a live pipeline this session vs via cache restore. Add
   `markLiveDone(src)` called from the pipeline's success path, keep a
   `liveDoneSrcs: Set<string>`, and change `doneCount()` to count only
   `liveDoneSrcs`. Update `publishProgress` to use the new count. Verify: on a
   chapter where 2 pages translated live and 15 came from cache, readout shows
   `2/17`, not `17/17`.

7. Add the step bar (feature): in `FloatingTrigger.svelte` markup, inside the
   translating branch, render a 3-segment bar under `pillText`. Segments map to
   `currentStep` (0 Detect, 1 Translate, 2 Render). Completed segments full
   accent-cyan, current segment pulsing, future segments dim. On hover
   (`stepBarHover`), show `formatElapsed(stepElapsedMs(i))` per step. The
   `trackStep`/`stepElapsedMs`/`formatElapsed` helpers already exist from the
   in-progress edit — keep them, just remove the `$effect` per step 2.

8. Run `npx svelte-check --output human`. Expected: `0 errors`. If any error,
   stop and fix before continuing.

9. Run `bun run test:unit`. Expected: `264 pass, 0 fail`. If a test asserts the old
   `doneCount()` behavior (counting cache-restored), update that test to the new
   live-only semantics — do not weaken the assertion.

10. Run `bun run build`. Expected: exits 0, `Σ Total size` ~48.9 MB. If it fails,
    read the error and fix; do not skip.

11. Diagnose #7 (storage error, no fix yet): grep for `storage.getItem`/`storage.watch`
    calls that can run outside an extension page context (e.g. in a shared module
    imported by a test or the setup tab before `browser` is available). Report the
    file:line in the summary. Do NOT edit the manifest.

## 5. Done Criteria

All must be true to consider this complete:
- [ ] `npx svelte-check` reports 0 errors, 0 warnings
- [ ] `bun run test:unit` reports 264 pass, 0 fail
- [ ] `bun run build` exits 0
- [ ] No `effect_update_depth_exceeded` in the extension console after a full chapter
- [ ] Hovering a finished page shows pill "Translated", never frozen "Detecting text…"
- [ ] Moving the mouse onto the pill and clicking does not make it vanish
- [ ] "Stop this page" closes the overlay and the pill returns to idle/original
- [ ] Readout `completed` counts only live-translated pages (cache-restored excluded)
- [ ] Step bar shows 3 segments tracking Detect → Translate → Render with hover times

## 6. Risks & Mitigations

- **`doneCount()` semantic change breaks cache-restore UX**: pages restored from
  cache currently count as "done"; excluding them may make a fully-cached chapter
  read `0/17`. → Mitigation: if cache-restored pages are common, consider showing a
  distinct "restored" count rather than hiding them; confirm with user before
  changing visible wording beyond the count.
- **Closing the overlay mid-pipeline leaves a dangling promise**: the pipeline keeps
  running after `overlay.ui.remove()`. → Mitigation: acceptable this pass (registry
  idle + overlay gone = nothing renders); a full AbortController is a follow-up.
- **Hide-race fix (400ms + cursorInPill) delays normal hide**: pill may linger 400ms
  after leaving. → Mitigation: 400ms is short; verify it doesn't feel sticky.

## 7. Testing Plan

Goal: confirm the pill, readout, stop control, and step bar work on a real chapter.

### 7.1 Checklist

- [ ] 1. `npx svelte-check` exits 0 with no errors.
- [ ] 2. `bun run test:unit` shows 264 pass / 0 fail.
- [ ] 3. `bun run build` exits 0.
- [ ] 4. Open a rawkuma chapter with auto-translate; no `effect_update_depth_exceeded` in console.
- [ ] 5. Hover a translated page → pill reads "Translated" (not "Detecting text…").
- [ ] 6. Move mouse onto the pill and click the gear → pill does not vanish; menu opens.
- [ ] 7. On a translating page, click gear → "Stop this page" → overlay closes, pill idles.
- [ ] 8. Bottom-right readout `completed` reflects only live-translated pages.

Record results: mark `[x]` on passed items, note date and tester below.

    Tester: xenocent
    Date: 2026-11-18
    Result: [n]/8 passed; failures at: [item numbers]
    Error notes: [paste any]

### 7.2 How to Run Tests

1. From `D:\self-project\lmt-inspect`, run `npx svelte-check --output human`; confirm 0 errors.
2. Run `bun run test:unit`; confirm 264 pass / 0 fail.
3. Run `bun run build`; confirm exit 0.
4. Load `.output/chrome-mv3/` in Chrome, open a rawkuma chapter, enable auto-translate, and walk items 4-8 of the checklist while watching the console.

## 8. Additional Notes

- A. Never push to the owner/upstream repo; push only to the fork `xenocent/Libre-Manga-Translator` (remote `fork`).
- B. The `storage` permission error (#7) is diagnosis-only this pass — the manifest already grants `"storage"`, so do not add it. Report findings instead.
- C. `Registry` is not imported as a namespace in FloatingTrigger.svelte; use the named import `getStatus` (aliased `getRegistryStatus`), not `Registry.getStatusBySrc`.
- D. Update the Obsidian vault `D:\mindful\mindful\LMT-WIP-Handoff.md` after landing these fixes, per [[obsidian-is-memory]].
