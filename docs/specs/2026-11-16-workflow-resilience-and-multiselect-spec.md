# Specification: Single-Label Multi-Select Restoration, Sampling Resilience, Media Fallback, Optimiser Dry-Run Pass-Through, and Rebuild-First Guard

**Date:** 2026-11-16  
**Target:** External Agent (`@tsp/contracts`, `@tsp/domain`, `@tsp/agents`, `@tsp/optimiser`, `@tsp/bff`, `@tsp/platform`, and `@tsp/web`)  
**Contract Impact:** Breaking `Schema` / `LabelSignature` / `Answer` / `MixUp` update + additive `ExampleMedia.externalUrl` (`Contract change: restore single/multi selection on the single project label and add ExampleMedia.externalUrl`)

---

## 1. Restore `Single-select` / `Multi-select` on the Project's Single Label

### 1.1 Product Rule
Every project still classifies **exactly one label** (`StructuredPrompt.label: Schema`, never multiple unrelated `fields[]`), **but that single label MUST support both `Single-select` (`kind: 'single'`) and `Multi-select` (`kind: 'multi'`, choosing `min` to `max` values)**. For example, a single-topic project picks 1 category (`single`), whereas a multi-tag project on one taxonomy picks 1 to 3 tags from that label (`multi`). Unrelated dimensions remain separate projects.

### 1.2 Contracts & Domain (`@tsp/contracts`, `@tsp/domain`)
1. **`Schema`, `LabelSignature`, and `Answer` (`packages/contracts/src/types.ts`)**:
   ```ts
   export type LabelKind = 'single' | 'multi';

   export interface Schema {
     /** JSON key for this project's label, e.g. "category" or "topics". */
     name: string;
     kind: LabelKind;
     /** Multi-select only: minimum and maximum values an answer may hold. */
     min?: number;
     max?: number;
     values: LabelValue[];
   }

   export interface LabelSignature {
     name: string;
     kind: LabelKind;
     min?: number;
     max?: number;
     values: string[];
   }

   /** Chosen value(s) of the project's label: 1 item when single, min..max unique items when multi. */
   export type Answer = string[];
   ```
   - **Backwards-tolerant reads**:
     - `normalizeStructured` / `readStructured`: default missing `label.kind` on stored prompts to `'single'`.
     - Helper `asAnswer(raw: unknown): Answer`: tolerate plain `string` answers stored immediately prior to this change (`typeof raw === 'string' ? (raw ? [raw] : []) : Array.isArray(raw) ? raw : []`) when reading `GoldLabel.answer`, `Prediction.answer`, and `DatasetRemoval.gold`.
     - `readGoldAnswer(raw, schema)` (`packages/domain/src/labels.ts`): accept `"Value"`, `["V1", "V2"]`, or `{ [key]: "Value" | ["V1", "V2"] }`, deduplicating values and checking cardinality (`1` for `single`, `min..max` for `multi`) and membership in `schema.values`.
2. **Validation & XML Compilation (`packages/domain/src/structured.ts`)**:
   - `checkStructured`: when `label.kind === 'multi'`, validate `min` (`default 1`) and `max` (`default label.values.length`) satisfy `0 <= min <= max <= label.values.length` and `max >= 1`.
   - `compilePrompt`:
     - `<output_labels name="{attr(sig.name)}" selection="{sig.kind}"{bounds}>` (include ` min="{min}" max="{max}"` when `sig.kind === 'multi'`).
     - `<output_format>`:
       - `single`: `{"{sig.name}": "{v1 | v2 | ...}"}` (exactly one allowed value).
       - `multi`: `{"{sig.name}": ["{v1}" | "{v2}" | ...]}` plus cardinality rule (`Choose {min} to {max} values` / `Choose {exact} values`).
3. **Metrics, Mix-ups, Stratification, and Pareto Scoring (`metrics.ts`, `dataset.ts`, `gepa.ts`)**:
   - `MixUp`: restore `kind: 'confused' | 'extra' | 'missed'` with `gold: string | null` and `predicted: string | null` (`confused` for `single`; false-positive `extra` and false-negative `missed` for `multi`). Update `aiSuggestion` (`T4`), `scriptedAgent`, and agent views accordingly.
   - `computeMetrics`: score each value one-vs-rest (`it.gold.includes(v.name)` vs `it.predicted.includes(v.name)`), `macroF1` as mean over active values, and `accuracy` as exact-set match (`sameAnswer(it.gold, it.predicted)`).
   - `isRight(gold, predicted)` & `exampleScore(gold, predicted)` (`gepa.ts`): `isRight` checks exact set equality; `exampleScore` returns set F1 / Jaccard overlap in `[0, 1]` (`1` on exact match, `0` on `null` / disjoint, partial credit when `multi` gets some values right so the Pareto front rewards partial multi-select progress).
   - `assignEvalHalves` (`dataset.ts`): stratify each labeled example by its rarest chosen value in `gold[e.id]` (which is exact per-value stratification when `single`).

### 1.3 Editor, Pages, and Helper Prompts (`@tsp/web`, `@tsp/agents`)
- **`StructuredEditor.tsx` (`LabelEditor`)**:
  - Inside the top `Label name` card row, place the `Single-select` / `Multi-select` `<Seg>` switch and, when `kind === 'multi'`, the `Choose [min] to [max]` compact number inputs (plus `Changed` badge if `kind`/`min`/`max` differs from `base`).
  - Keep the **stacked vertical value cards** below (`v.name`, badges, `Move up` / `Move down` / `Remove value`, full-width `<Grow>` `Definition`, and `<Marks>`) unchanged.
- **`Gold Labels` (`apps/web/src/app/(project)/gold/page.tsx`)**:
  - `ModelAnswer`: render all values in `found.answer` as chips (highlighting chips that differ from `gold` on `Mismatches`).
  - `YourAnswer`: when `schema.kind === 'single'`, clicking a chip selects it exclusively; when `schema.kind === 'multi'`, show a subtle `{min} to {max}` hint, toggle chips up to `max`, and enable `Save` once `answer.length >= (min ?? 1)`.
- **`Eval Dataset` (`apps/web/src/app/(project)/dataset/page.tsx`)**:
  - In `RemovedCard`, format `r.gold` cleanly as `Array.isArray(r.gold) ? r.gold.join(', ') : (r.gold || t('None'))` (fixing the bug where `Object.values(string)` split removed gold labels into comma-separated single characters).
- **Agent Presets (`apps/agents/src/presets.ts`)**:
  - Update `PROMPT_SHAPE`, `common`, `prompt_agent`, and `optimiser` to include `"kind": "single" | "multi"` (and optional `"min"`, `"max"` when `"multi"`) on `"label"`. Keep the rule that each project owns **one** label (unrelated dimensions go in separate projects).

---

## 2. Step 1 `Prompt Design` — Remove `Edit prompt` Button on Approved View

- **Observed issue**: After approving the initial prompt as `v1` on Step 1 (`Prompt Design`), the header in `Approved` (`apps/web/src/app/(project)/prompt-design/page.tsx`, line 132) renders `<Button label={t('Edit prompt')} href={href('/prompt/edit', {v: v.id})} />`. Clicking it jumps the user straight to Step 4 (`Prompt Tuning`), breaking the Step 1 -> Step 2 onboarding flow.
- **Requirement**: Remove the `Edit prompt` button from `Approved` on `Prompt Design` (keep the `Approved as v1` badge, `View full prompt`, and `Next: Eval Dataset`). Prompt editing belongs on Step 4 (`Prompt Tuning`). Update `e2e-check.cjs` if it clicked `Edit prompt` from `Prompt Design`.

---

## 3. Step 2 `Eval Dataset` — Continuous Progress State & Per-Example Fault Tolerance

### 3.1 Keep Progress Screen Mounted Until Snapshot Persistence Completes
- **Observed bug**: In `apps/bff/src/services/dataset.ts`, `startSampleDataset` awaits `sampleTask(projectId, n)`, whose `finally` block deletes `activeSampling` *before* `saveSnapshot(...)` writes the 90 `examples` and `dataset_snapshots` documents to the store. Over a remote document store, `saveSnapshot` takes 10–15 seconds; during that entire window `samplingTask` is `null` and `snapshot` is still `null`, so `DatasetPage` drops back to the `"No examples yet"` empty screen (`<Start>`) for 10+ seconds before suddenly jumping to the dataset detail page! (`uploadDatasetText` -> `loadFeatures` + `saveSnapshot` has the exact same gap.)
- **Requirement**: Keep `activeSampling` active (holding the progress view on screen—for example keeping `task` in `activeSampling` until `saveSnapshot` and `projects.patch({snapshotId})` finish) so the UI **never flashes back to `<Start>`** while saving examples, transitioning directly from `<CenterProgress>` to `<Ready>` once persistence is 100% done.

### 3.2 Isolate Individual Example Failures (Skip Instead of Blocking the Task)
- **Requirement**: A failure to fetch or persist an individual example MUST NOT abort the entire sampling, upload, or append task, and MUST NOT leave orphaned `examples` documents without a `dataset_snapshots` record:
  - In `saveSnapshot` (`dataset.ts`) and `appendExamples` (`governance.ts`), persist examples with per-item error isolation (for example a fault-tolerant `insertManySettled` or per-record `try/catch` inside `insertMany` batches).
  - If individual examples fail validation or storage insertion, **skip them**, add the skipped count to `counts.invalid`, compute/re-balance `optimiserHalf` across the examples that succeeded, and complete the snapshot normally as long as at least 1 valid example was saved.
  - Only fail the task if **0** valid examples could be saved.

---

## 4. Step 3 `Gold Labels` — Embed Player Origin Policy & External Open Link

1. **Add optional `externalUrl?: string` on `ExampleMedia` (`packages/contracts/src/platform-api.ts`)**:
   - Represents a standalone URL where a human labeler can open the item in a new browser tab when cross-site iframe embedding is restricted, rate-limited, or requires top-level session cookies.
   - In `ExampleCard` (`apps/web/src/app/(project)/gold/page.tsx`), when `media?.externalUrl` is present, render a compact ghost/inline link (`Open item`, translated in `zh.ts`, `target="_blank" rel="noopener noreferrer"`) in the media bar beneath the viewer (and when neither `playerUrl` nor `stills` is available, offer it directly inside the tile).
2. **Iframe `referrerPolicy` & `allow` attributes (`gold/page.tsx`)**:
   - On the media `<iframe src={media.playerUrl} ...>`, explicitly set `referrerPolicy="origin"` and `allow="autoplay; encrypted-media; picture-in-picture; fullscreen"` so cross-origin embed players always receive the host origin needed for embed-token authentication (without leaking project query parameters) and allow click-to-play media playback.

---

## 5. Workflow Auto-Start Gate — Do Not Auto-Score `v1` Before Leaving `Gold Labels`

- **Observed bug**: When a user opens and saves `Project Settings` early (for example renaming the project or customizing thresholds on Step 1, which sets `project.settingsConfirmed = true`), `dueStarts()` (`packages/domain/src/auto-start.ts:66`) checks only `settingsConfirmed && canScore(state.facts)`. As soon as the user saves their 6th gold label on Step 3 (`Gold Labels`), `v1` scoring starts automatically in the background while the user is still labeling the remaining 84 items—and that premature run prevents `balanceHalves()` from stratifying the dataset when the user finishes Step 3!
- **Requirement**: Require `state.facts.approved.includes('gold')` inside `dueStarts(state)` (`packages/domain/src/auto-start.ts`). Automatic background scoring NEVER starts until Step 3 (`Gold Labels`) has been approved via `Next: Prompt Tuning`. (Manual clicks on `Score` on Step 4 remain unaffected.) Update unit tests in `auto-start.test.ts` and `bff.test.ts` if they assumed auto-start fired without `'gold'` in `approvedNodes`.

---

## 6. Step 4 `Prompt Tuning` — Allow Dry-Run Ties Through to Full Evaluation

- **Observed bug**: In `compareDryRun` (`packages/domain/src/gepa.ts:180-185`) and `apps/optimiser/src/optimiser.ts:430-465`, when a candidate prompt achieves the **exact same dry-run pass count** as its parent (`passed === parentPassed`) on the same 20 dry-run items, `better` and `tied` are both `false`, so the candidate is immediately **`dropped`**! Even when `differs` is `true`, `tied` increments `wasted++` and aborts the run after 2 ties. On real tasks, targeted improvements to rare/boundary values frequently tie on a 20-item sample (`12/20 vs 12/20`), causing `v2.1`, `v2.2`, and `v2.3` to all be dropped without ever being scored on the full eval set.
- **Requirement**:
  - Change the dry-run filter to **non-regression pass-through**:
    - When `candidateScore >= parentScore` on the dry run (`passed >= parentPassed`, or mean `exampleScore` `>=` parent for `multi`), **let the candidate proceed to `full` eval-set labeling and `report` scoring**!
    - Drop a candidate in `dry_run` **only when it regresses** (`candidateScore < parentScore`).
  - Determine `wasted` / progress **after full `report` scoring**:
    - Reset `wasted = 0` when the candidate's full held-out `macroF1` beats its parent's (or start version's) `macroF1`; increment `wasted++` when a candidate failed checks, repeated an existing prompt, was dropped for regressing in the dry run, or did not beat its parent on the full eval-set `macroF1` (while still keeping non-regressing full-scored versions in the Pareto pool if they win examples on the optimiser half). Remove the premature `consecutiveTiesLimit` stop caused by dry-run ties.

---

## 7. Step 4 `Prompt Tuning` — Advise `Rebuild scores` Before Optimising or Editing

- **Observed UX gap**:
  1. The top-right `Rebuild scores` button (`apps/web/src/app/(project)/prompt/page.tsx:238`) is currently enabled whenever `!running`, even when `state.scoresUpdating` is `false` (nothing is out of date).
  2. When `state.scoresUpdating` IS `true` (gold labels changed, so `Rebuild scores` needs to be triggered), `Advice` (`Auto Optimise` / `Improve with AI`) disappears silently while `Edit prompt` navigates straight into the editor on stale scores without warning the user.
- **Requirement**:
  1. **Disable `Rebuild scores` when scores are already current**: set `disabled={running || !state.scoresUpdating}` on the `Rebuild scores` button (with a helpful `title` when up to date vs running), so `Rebuild scores` being enabled strictly means scores are out of date and ready to rebuild.
  2. **Keep actions visible and show an advisory dialog when `Rebuild scores` is actionable (`state.scoresUpdating && !running`)**:
     - Keep the `Advice` card rendered when `!running && !showPanel` (falling back to the newest report per version when current-context reports have not been rebuilt yet so `Improve with AI` and `Auto Optimise` remain visible).
     - Whenever `state.scoresUpdating && !running` and the user clicks **`Auto Optimise`**, **`Improve with AI`**, or **`Edit prompt`** (turning `Edit prompt` on `PromptPage` into a guarded click action when `state.scoresUpdating` is true), open an advisory `<Dialog>`:
       - **Title**: `Rebuild scores first?`
       - **Body**: `Gold labels changed since these scores were calculated. Rebuild scores first so editing and optimisation use your latest labels.`
       - **Actions**:
         - `Cancel` (closes dialog)
         - `Continue anyway` (proceeds immediately to the requested `Edit prompt` / `Improve with AI` / `Auto Optimise` action)
         - `Rebuild scores` (primary button: runs `await rebuildReports(state.project.id)` and closes the dialog with updated scores on screen).

---

## 8. Error Banner `Retry` Feedback & `Improve with AI` Chat Localization

1. **`ActionErrorBanner` `Retry` spinner & copy (`apps/web/src/ui/index.tsx`)**:
   - Have `Retry`'s `onClick` return the async retry Promise (`async () => { const r = e.retry!; await r(); }`, clearing the error banner when `r()` succeeds or replacing it if it fails again) so the `Retry` button itself shows its pending spinner even when the original `<Button>` unmounted/remounted during a page state change.
   - Fix awkward gerund concatenation in `failed()` (`"Couldn't auto sampling."`): use natural phrasing that works for any button label, e.g. `"{action} failed. {why}"` (`what` kept with its leading capital, such as `"Auto sampling failed. Check your connection and try again."`), updating `zh.ts` accordingly.
2. **Localize `Improve with AI` persisted chat summary (`apps/bff/src/services/agents.ts:355-357`)**:
   - Include `msg` catalog keys on the chat message saved by `improveWithAi` (`I made 1 change to {version}. Hover each mark to see why.` / `I made {n} changes to {version}. Hover each mark to see why.` / `I have no new change for {version}.`) and add them to `packages/domain/src/locales/zh.ts` so the message renders in Chinese under the `zh` locale.

---

## 9. Verification Checklist

1. `./internal/deploy/check-public.sh` — Clean English-only public files and strict workspace boundaries.
2. `npm run check` — Boundaries, TypeScript, i18n catalog completeness (`zh.ts` updated & dead keys pruned), and unit tests covering:
   - Single-label `single` and `multi` (`Schema`, `Answer = string[]`, `compilePrompt`, `parseOutput`, `readGoldAnswer`, `computeMetrics`, `MixUp` `confused`/`extra`/`missed`, `assignEvalHalves`, `exampleScore`).
   - `dueStarts` waiting until `'gold'` is in `approvedNodes` even when `settingsConfirmed` is already `true`.
   - `compareDryRun` & `optimiser` letting dry-run ties (`passed === parentPassed`) proceed to full evaluation and dropping only dry-run regressions (`passed < parentPassed`).
   - Per-example storage failure isolation during `saveSnapshot` / `appendExamples` and continuous `samplingTask` presence until snapshot creation completes.
3. `npm run build` & `node apps/web/scripts/e2e-check.cjs` — Updated for `Single-select / Multi-select` toggle in `LabelEditor`, no `Edit prompt` button on approved `Prompt Design`, `Rebuild scores` disabled when current + advisory dialog when stale before `Edit prompt` / `Improve with AI` / `Auto Optimise`, and clean `E2E PASSED`.
