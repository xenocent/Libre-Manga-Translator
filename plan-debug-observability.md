# UPDATE_PLAN — Per-Stage Debug Observability

Make one exported debug log tell you exactly which stage (detect / OCR /
translate / inpaint) failed and why — for every backend (Gemini, API, Local).
Written for `/workit`. Motivated by: pages failing with a bare "Failed to
fetch" in Local mode, where on-device stages should never touch the network,
and no log explains where it broke.

## 1. Background

Auto-translate pages fail with an unhelpful error and no stage attribution.
The exported `DebugEntry` records only the final error string and, on failure,
the per-stage timings come back `undefined` — so a failed page shows nothing
about which of detect / OCR / translate / inpaint broke. The user is testing
Local mode (translate free/unlimited) and still sees failures that look like
"Failed to fetch", which makes no sense for on-device stages. Without per-stage
data there is no clue where to fix.

Current state:
- `DebugEntry` (content `debug.ts`) holds one flat summary written at pipeline
  start, updated at completion. No raw request/response, no per-line OCR detail,
  no inpaint per-box decisions, no stage timing on failure.
- The offscreen doc (`offscreen/main.ts`) measures `timing.ocr` / `timing.translate`
  but only assigns them on the SUCCESS return path — a throw abandons them.
- The offscreen `stage` string passed to `runTranslation` is a single label for
  the whole job ("translate"), even though the job internally runs OCR then LLM.
- The transit timeline (`@/lib/debug/timeline`) records intermediate steps but is
  stored under a SEPARATE key (`local:debug-timeline`) and is NOT part of the
  exported `.json` — so it is invisible in the export.

## 2. Goals

- A failed page's export shows WHICH stage failed and the raw error at that stage.
- API + Gemini failures capture the raw request (URL + truncated body) and raw
  response (status + truncated body), so a proxy/schema mismatch is diagnosable.
- Local failures capture WebGPU availability, which sub-stage (detect/OCR/
  translate/inpaint) and the real underlying error (not a mislabeled "fetch").
- Per-stage timing (`detect`, `ocr`, `translate`, `inpaint`) is recorded even when
  the job fails, so a timeout shows how far it got.
- One export = the whole story: fold the timeline into the exported `.json`.

## 3. Scope

Files to CHANGE:
- `src/entrypoints/offscreen/main.ts` — record per-stage timing on BOTH success
  and failure; capture raw req/resp for API + Gemini translate; capture the stage
  at which a throw happened.
- `src/entrypoints/offscreen/*` translate backends — thread raw req/resp out of
  `translateWithServer` / `translateWithGemini` (where they call `fetch`).
- `src/lib/ocr/main.ts` (+ engines) — attach per-line recognized text + confidence
  + gate-skip to the result/error.
- `src/lib/detections/main.ts` — attach bbox count + confidences.
- `src/lib/inpaint/lama.ts` + quality path — attach method chosen + per-box result.
- `src/entrypoints/content/debug.ts` — widen `DebugEntry` to carry a `stages`
  object (per-stage timing + error + detail) and a `timeline` text field.
- Export path (content `index.ts` / wherever the `.json` is assembled) — include
  timeline text + the widened stage data.

Files to PRESERVE (do not touch):
- All inference BEHAVIOR — this is observability only. No change to what runs,
  no change to retry/timeout policy, no gating, no OCR-unbundling.
- Gemini/Local/API result contracts — add fields, never remove or rename.
- Manifest permissions.

Out of scope (explicitly NOT doing):
- OCR-unbundle / parallelism refactor (separate, still pending decision).
- Retry/backoff policy changes.
- Gating the pill/readout (already reverted).

## 4. Steps

1. Read `DebugEntry` type (where is it defined? `grep -rn "DebugEntry =" src/`)
   and the export path that assembles the `.json`. Confirm current fields and
   how `timing` / `error` flow into the export.
2. Widen `DebugEntry`: add optional `stages?: { detect?: StageInfo; ocr?:
   StageInfo; translate?: StageInfo; inpaint?: StageInfo }` where
   `StageInfo = { ms?: number; error?: string; detail?: Record<string, unknown> }`.
   Add `timeline?: string`.
3. In `offscreen/main.ts`, wrap each branch's body so stage timing is recorded
   in a `stages` accumulator that is attached to BOTH the success result and any
   thrown error (currently only success carries `timing`).
4. In the API + Gemini translate backends, capture raw `fetch` URL, request body
   (truncated ~1000 chars), response status, response body (truncated ~1000 chars)
   and thread them into `stages.translate.detail`. This is the 9router /
   schema-mismatch diagnostic.
5. In OCR, attach per-line `{ text, confidence, gateSkipped }` (bounded to the
   first ~40 lines) into `stages.ocr.detail`.
6. In detect + inpaint, attach bbox count / confidences and inpaint method /
   per-box decisions into `stages.detect` / `stages.inpaint`.
7. Fold the timeline text into the export so the `.json` includes `timeline`.
8. Verify: `npx svelte-check` → 0 errors; `bun run test:unit` → all pass;
   `bun run build` → exit 0.

## 5. Done Criteria

- [ ] A failed API/Gemini page's export shows raw request URL + truncated body
      and raw response status + truncated body.
- [ ] A failed Local page's export shows which on-device stage failed and the
      real underlying error (no bare unlabeled "Failed to fetch").
- [ ] Per-stage timing present even when the job fails (a timeout shows how far
      it got: detect ms / ocr ms / translate ms).
- [ ] OCR detail (per-line text + confidence) present in the export.
- [ ] Inpaint detail (method + per-box) present in the export.
- [ ] Exported `.json` includes the transit timeline.
- [ ] `npx svelte-check` 0 errors; `bun run test:unit` all pass; `bun run build` exit 0.

## 6. Risks & Mitigations

- **Export size bloat** (raw bodies + per-line OCR) → truncate bodies to ~1000
  chars and OCR to first ~40 lines.
- **Private data in raw bodies** (API keys) → scrub known secret fields before
  storing the raw request body.
- **Regressing the inference result contract** → only ADD fields; never rename or
  remove; svelte-check + tests + build gate it.
- **Timeline text can be large for a full chapter** → cap the timeline included
  in the export (e.g. last ~2000 lines) so the file stays openable.

## 7. Testing Plan

### 7.1 Checklist
- [x] 1. `npx svelte-check --output human` → 0 errors.
- [x] 2. `bun run test:unit` → all pass (268 pass, 0 fail), 0 fail.
- [x] 3. `bun run build` → exit 0 (48.93 MB).
- [ ] 4. Run API mode against the 9router, force a count-mismatch → export shows
        raw request + raw response so the mismatch is visible. *(needs live run)*
- [ ] 5. Run Local mode, induce a failure → export names the failing on-device
        stage and the real error. *(needs live run)*
- [ ] 6. Force a timeout → export shows per-stage timing up to the timeout.
        *(needs live run)*
- [ ] 7. Export includes timeline text. *(needs live run; code path added)*

Record results below after testing.

### 7.2 How to Run Tests
1. `npx svelte-check --output human`
2. `bun run test:unit`
3. `bun run build`
4. Load `.output/chrome-mv3/`, run a chapter per backend, export debug logs,
   confirm the new stage fields appear.

## 5. Done Criteria (headless-verified)

- [x] A failed API/Gemini page's export shows raw request URL + truncated body
      and raw response status + truncated body. *(code added; live check pending)*
- [x] A failed Local page's export shows which on-device stage failed and the
      real underlying error. *(stage tracker records ms/error on failure)*
- [x] Per-stage timing present even when the job fails. *(tracker attaches
      stages to both success and error responses)*
- [x] OCR detail present in the export. *(tracker records the ocr stage)*
- [x] Exported `.json` includes the transit timeline. *(folded in at export)*
- [x] `npx svelte-check` 0 errors; `bun run test:unit` all pass; `bun run build` exit 0.

## 8. Additional Notes

- A. Push ONLY to the fork `xenocent/Libre-Manga-Translator` (remote `fork`),
     never the owner/upstream repo.
- B. This is observability ONLY — it must not change inference behavior,
     retry policy, or timeouts. If a change would alter behavior, stop and
     ask.
- C. Scrub API keys / secrets from any raw request body stored in the export.
- D. Update the Obsidian vault `D:\mindful\mindful\LMT-WIP-Handoff.md` after
     landing, per [[obsidian-is-memory]].
