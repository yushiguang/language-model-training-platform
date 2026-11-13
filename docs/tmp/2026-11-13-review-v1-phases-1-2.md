# Public Repo Review: 1.0.0 Phases 1 & 2 (`44f11c5`)

**Date:** 2026-11-13  
**Scope:** `9af247d..44f11c5` on PR #6 (`1.0.0` phases 1 and 2, plus docs portfolio)  
**Verification:** `npm run check` passes (boundaries, typecheck, 108 unit tests); `npm run build` passes; internal adapter build passes. Pre-push full-width/non-ASCII audit failed on one file (Blocker 1 below).

**Disposition (Route B chosen by owner):** PR #5 (`0.x` baseline, tagged `v0.6.0`) is now merged into `main`, and PR #6 is retargeted to `main`. Please fix the findings below and complete **Phase 3** (dataset governance, stratified halves, Gold `To label | Labeled` + explicit `Save` + multi-comment `Comment` + full `.kv` text, expanded agent tools, and the remaining `FeatureValue` / callback-free `runTurn` contract items) and **Phase 4** (IME-safe `Enter` send and the UI motion / pending-Promise audit) before the combined `1.0.0` interactive acceptance pass. Also follow the new branch naming rule in `AGENTS.md` (`<type>/<short-kebab-topic>`, never opaque session IDs) for new branches.

---

## Blocker

1. **Non-ASCII / full-width punctuation in `packages/platform/src/standins/scripted-agent.ts:139`**
   - `const v = line.match(/^[-*]\s*["“]?([^:"”]{1,40})["”]?\s*[:：]\s*(.+)$/);` contains literal curly quotes and a full-width CJK colon (`\uff1a`), which trips the repository's non-ASCII / CJK character scanner (`[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]`).
   - **Fix:** Replace literal non-ASCII characters in regexes with `\uXXXX` escapes (`\u201c`, `\u201d`, `\uff1a`) so the source file stays strictly ASCII/English.

---

## Major

1. **`judge(..., evalCount)` checks total dataset size instead of gold-labeled eval count, allowing premature passes on 4 gold labels**
   - Location: `apps/bff/src/services/projects.ts:60`, `apps/bff/src/services/evaluation.ts:174` (`confirmScore`), `apps/bff/src/services/page-views.ts:135`, and `packages/domain/src/workflow.ts:157`.
   - Under `1.0.0` §2.5 / §4.2 / §4.4, scoring can run as soon as 4 examples (2 per half) are gold-labeled, while §4.2 specifies: *"while the scored (gold-labeled) eval examples number fewer than `thresholds.minEval`, the score is shown with a `Rough reading` tag instead of `Passed` / `Below threshold`, ... and the `Finish` / export gate stays closed."*
   - Currently `judge(r.metrics, t, evalExamples.length)` receives `evalExamples.length` (e.g., 90 sampled items) rather than `labeled.length` (e.g., 4 gold-labeled items). A project with 90 sampled items and only 4 gold labels therefore passes `evalCount >= t.minEval` (`90 >= 20`) and can be marked `Passed` on 2 held-out examples!
   - **Fix:** Pass the gold-labeled eval count (`labeled.length`) to `judge`, and implement the `Rough reading` state (`labeled.length < t.minEval`) across `projects.ts`, `Prompt Tuning`, `OptimiserPanel` end line, and `page-views.ts`.

2. **Paid agent start tools bypass `settingsConfirmed` and `canScore` guardrails**
   - Location: `apps/bff/src/services/starts.ts:66-96` (`score_version`, `start_optimiser`, and `try_prompt`).
   - UI buttons (`VersionCard`, `Advice`, `Gold Labels` Next) and `dueStarts` enforce that paid work does not run before Project Settings are confirmed (`state.facts.settingsConfirmed`) and `canScore(state.facts)` holds. Asking in `Ask AI` to score a version or start the Optimiser calls `starts.ts`, which checks neither and immediately spends money with unconfirmed default settings or 0 gold labels.
   - **Fix:** Check `state.facts.settingsConfirmed` (and `canScore(state.facts)` for `score_version` / `start_optimiser`) in `plan()`, returning a clear actionable message telling the user to confirm Project Settings (via `Settings` at the top) or finish minimum gold labeling first.

3. **Projects list links every project unconditionally to Step 4 (`/prompt`)**
   - Location: `apps/web/src/app/page.tsx:110` (`href={hrefFor(p.id, '/prompt')}`).
   - Dropping the `Current step` column should not drop step-aware routing: clicking an in-progress project that is still on Step 1 (`Prompt Design`), Step 2 (`Eval Dataset`), or Step 3 (`Gold Labels`) lands the user on Step 4's empty state.
   - **Fix:** `listProjects()` already returns `p.approvedNodes` with zero extra network calls. Route each project link to the first node in `NODES` not yet in `p.approvedNodes` (falling back to `/prompt` when all nodes are approved).

---

## Minor

1. **`idempotent()` caches rejected Promises permanently (`apps/bff/src/api.ts:24-33`)**
   - If a call carrying `idempotencyKey` rejects (e.g., transient error or validation failure), the rejected `Promise` stays in `seen`, causing retries with the same key to fail without re-running. Evict on rejection (`p.catch(() => seen.delete(k))`).
2. **Stale `0.x` rows in `docs/ui-gaps.md`**
   - Lines 34–59 of `docs/ui-gaps.md` still retain rows referencing removed `0.x` screens (`Setup`, `Training Set`, `approved schema card`). Fold or move those closed `0.x` notes to `docs/tmp/2026-11-ui-gaps-history.md` when updating `ui-gaps.md` in Phase 4.
