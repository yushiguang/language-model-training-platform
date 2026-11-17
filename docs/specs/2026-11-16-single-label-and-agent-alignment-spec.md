# Specification: Single-Label Project Scope, Stacked Label Cards, Agent System Alignment, and Chat/UI Refinements

**Date:** 2026-11-16  
**Target:** External Agent (architectural review + implementation across `@sprint/contracts`, `@sprint/domain`, `@sprint/agents`, `@sprint/optimiser`, `@sprint/bff`, `@sprint/platform`, and `@sprint/web`)  
**Contract Impact:** Breaking `StructuredPrompt`, `Schema`, `Answer`, `Metrics`, `AgentRuntimeContract`, and `BffContract` simplification (`Contract change: single mutually-exclusive label per project, plain string answers, and locale on DraftImprovementInput`)

---

## 0. Architectural Second-Review Request for External Agent

Section 1 of this specification introduces a deliberate product and domain-model shift: **every Prompt Tuning project owns exactly one mutually-exclusive (single-select) label**, removing multi-field (`fields[]`) and multi-select (`kind: 'multi'`, `min`, `max`) support.

Before or as you execute this change, **please conduct a second architectural review** of Section 1 against the whole codebase:
- If you agree with the design and find no hidden edge cases, proceed directly to full implementation and record the key architectural reasoning in `docs/decisions.md` and `docs/architecture.md`.
- If you identify any structural flaw, subtle invariant issue, or strictly cleaner representation in `@sprint/contracts` / `@sprint/domain`, document your counter-proposal or adjustment clearly in `docs/tmp/2026-11-16-single-label-review.md` (or apply the cleaner refinement if backwards-compatible with the product rules below and note it in the commit message).

---

## 1. Core Architectural Shift: One Mutually-Exclusive Label per Project

### 1.1 Product & Statistical Rationale

Hands-on optimization runs and beta testing established that **the quality and class balance of the eval dataset is the #1 determinant of prompt-tuning convergence**. Allowing one prompt to output multiple independent fields or non-exclusive multi-select subsets undermines both dataset governance and human labeling quality:

1. **Dataset balance cannot be satisfied simultaneously across orthogonal labels**: Downsampling a dominant value (>70%) or appending rare-value examples on `Eval Dataset` for Label A corrupts the class distribution of Label B in the same dataset.
2. **Exact stratification & clean confusion signals**: With a single mutually-exclusive label, every labeled example belongs to exactly one value ($\sum n_i = N$). `assignEvalHalves` becomes exact per-value stratification; `Downsample` never collaterally deletes rare examples of another label; `exampleScore` is a clean `{0, 1}` indicator; and every `MixUp` is a pure `gold -> predicted` confusion pair (no `extra` / `missed` multi-select noise).
3. **Human labeling focus (distillation quality)**: Human annotators make one clear mutually-exclusive judgement per item instead of juggling multiple schemas at once, minimizing false-negative omission errors.
4. **How multi-label business scenarios are handled**:
   - **Independent dimensions** -> Separate `Prompt Tuning` projects, each with its own balanced ~3,000-item eval dataset and dedicated prompt.
   - **Never mixed**: each project and its model classify one label only. Projects are never combined or merged with each other (decided 2026-11-16, see section 5).
   - **Every item needs a value**: because the label is required and exclusive, the prompt helper suggests a catch-all value (for example `Other` or `None`) when the values might not cover every item.

### 1.2 Contract Simplification (`packages/contracts`)

Flatten the multi-field and multi-select structures across `@sprint/contracts`:

1. **`Schema`, `LabelSignature`, and `StructuredPrompt` (`types.ts`)**:
   - Remove `FieldKind` (`'single' | 'multi'`), `min`, `max`, `LabelField`, `LabelSignatureField`, and `StructuredFieldPrompt`.
   - Each project defines one mutually-exclusive label with an output key `name` (used as the JSON output property key and default column name when merging projects in batch labeling, e.g. `"category"`) and `values: LabelValue[]` (at least 2 values):
     ```ts
     export interface LabelValue {
       name: string;
       /** Multi-line criteria: positive conditions, boundaries, and exemptions (formatted with lists/paragraphs). */
       definition: string;
     }

     export interface Schema {
       /** JSON key for this project's label, e.g. "category". */
       name: string;
       values: LabelValue[];
     }

     export interface LabelSignature {
       name: string;
       values: string[];
     }

     export interface StructuredPrompt {
       taskSummary: string;
       features: FeatureSelection;
       /** The project's single mutually-exclusive label: its key name and allowed values + definitions. */
       label: Schema;
       ruleGroups: RuleGroup[];
       images: PromptImage[];
     }
     ```
   - Empty initial state (`emptyStructuredPrompt()`): `label: { name: '', values: [] }` (or when the user starts adding values on an empty prompt, a sensible editable key input + value cards).
   - Validation (`checkStructured`): require non-empty `label.name.trim()`, at least 2 values in `label.values`, and non-empty unique `v.name.trim()` for every value.
2. **`Answer` (`types.ts`)**:
   - Replace `Record<string, string[]>` with a single value name `export type Answer = string;` (decided 2026-11-16: a plain string, the model's reason already has its own field; keep it consistent across `GoldLabel.answer`, `Prediction.answer`, `DatasetRemoval.gold`, `GoldLine`, and `ExampleSource.bundledLabels`).
   - **Sample-data & upload compatibility**: Update `apps/web/public/sample-data/examples.json`, `simulatedModels`, and `SAMPLE_SCHEMA` / `SAMPLE_STRUCTURED` to a single mutually-exclusive label (for example `primary_value` with its 4 values). In `uploadGold` / `importBundledGold` (`apps/bff/src/services/dataset.ts`), tolerate both the new single-label `answer` format and legacy `{ [labelName]: ["Value"] }` (or single-key `{ [anyKey]: ["Value"] }` when unambiguous) so prepared dataset files uploaded earlier continue to import cleanly.
3. **`Metrics`, `MixUp`, `DryRunResult`, and Agent Inputs (`types.ts`, `agent-api.ts`)**:
   - Remove `FieldMetrics`, `Metrics.fields`, `Metrics.lowestField`, `DryRunResult.fields`, and `MixUp.field` / `MixUp.kind` (`'extra' | 'missed'`).
   - `Metrics` directly holds the project label's `macroF1: number`, `accuracy: number`, `values: ValueMetrics[]` (`value`, `precision`, `recall`, `f1`, `support`), `lowestValue: { value: string; f1: number } | null`, `invalid`, `invalidRate`, `filtered`, `n`, `total`, `mixUps: MixUp[]` (`{ gold: string; predicted: string; count: number; exampleIds: string[] }`), and `costPer1000`.
   - Update `OptimiserReflectInput` and `DraftImprovementInput`: replace `lowestField` with `macroF1: number`, simplify `lowestValue` to `{ value: string; f1: number } | null`, and add `locale?: Locale` to `DraftImprovementInput` (see Section 3.4).
   - Update `PruneDatasetRequest`: remove `field?: string` (`downsample` needs only `value` and `keep`).
4. **`Project` sources stay as they are**: the single `sourceProjectId` / `sourcePromptVersionId` remain. No multi-project merge is reserved (decided 2026-11-16).

### 1.3 XML Prompt Compilation (`compilePrompt`)

Update `compilePrompt` in `packages/domain/src/structured.ts` for the single label and **readable multi-line `<label>` blocks**:

```xml
<persona_and_task>
{taskSummary}
</persona_and_task>

<input_features>
  <feature name="Title">{{Title}}</feature>
  <feature name="Description">{{Description}}</feature>
  <feature name="Cover">{{Cover}}</feature>
</input_features>
A feature shown as "none" is empty for this post.

<output_labels name="{attr(label.name)}" selection="single">
  <label value="{attr(v.name)}">
{v.definition}
  </label>
</output_labels>

<rules>
  <rule_group name="{attr(group.title)}">
{group.content}
  </rule_group>
</rules>

<output_format>
Return one JSON object only, with the exact key "{label.name}" and exactly one allowed value from <output_labels>:
{"{label.name}": "{v1 | v2 | ...}"}
</output_format>
```
*(When `v.definition` is empty, emit `<label value="..."/>`; when non-empty—whether one line or multi-line bullets—indent or wrap cleanly inside `<label value="...">\n...\n  </label>` so multi-paragraph definitions read clearly in `View full prompt`.)*

### 1.4 Page & Workflow Simplifications Across `@sprint/web`

1. **`Prompt Design` & `Edit prompt` (`StructuredEditor.tsx`)**:
   - Remove the two-column `Fields` sidebar (`grid-split sp-fields`), `Add field` / `Remove field`, `Single-select / Multi-select` segmented toggle, and `Choose min to max` inputs.
   - Redesign `Output Labels & Definitions` to match `Rule Groups` (detailed in Section 2.1 below).
2. **`Eval Dataset` (`apps/web/src/app/(project)/dataset/page.tsx`)**:
   - `BalanceCard` renders one clean value-balance list directly (no per-field code pill header or inter-field divider lines).
3. **`Gold Labels` (`apps/web/src/app/(project)/gold/page.tsx`)**:
   - `ModelAnswer` shows the model's chosen value chip directly (red highlight on mismatch) alongside `Model's reason`, without repeating a field-name column.
   - `YourAnswer` renders one group of mutually-exclusive value chips directly (no `Single-select` sub-caption needed).
4. **`Prompt Tuning` (`apps/web/src/app/(project)/prompt/page.tsx`)**:
   - Main metric label reads `Score` with `Macro-F1` (instead of `Lowest field macro-F1`).
   - **Upgrade the `VersionCard` breakdown table from per-field to per-value**: list every value of the project's label (`Value`, `F1`, `Precision`, `Recall`, `Examples` / `Support`, and pass/below status when value-level thresholds are active, sorted weakest `F1` first or in label order) so users immediately see which specific label value is pulling down `Macro-F1`.
   - `DroppedCard` shows overall dry-run `passed / examples` vs parent (no per-field table needed).

---

## 2. UI, Component, and Chat Shortcut Refinements

### 2.1 Stack `Output Labels & Definitions` Vertically Like `Rule Groups`
- **Observed issue**: Previously `FieldEditor` rendered values in a 2-column horizontal `<Table>` (`Value` narrow input on the left, `Definition` textarea squeezed on the right). For real production prompts where each label value has 10–25 lines of detailed criteria and exemptions, the side-by-side table wastes horizontal space and looks visually inconsistent with `Rule Groups` directly below it.
- **Requirement**: Style `Output Labels & Definitions` in `StructuredEditor.tsx` using the **same stacked vertical card pattern as `Rule Groups`**:
  - A compact top bar/card row for the project's **Label name** (`label.name`, e.g. `category`, monospace/clean input with clear label).
  - Below it, **one stacked card per `LabelValue`** (matching `.sp-group`):
    - **Top row of the card**: bold value-name input (`v.name`, styled like `.sp-group-t`) + `Draft` / `New` / `Changed` badge + spacer + `Move up` (`chev-up`), `Move down` (`chev`), and `Remove value` (`x`) icon buttons (ordering values top-to-bottom also reflects decision order cleanly).
    - **Word-level change marks** for renamed value (if applicable) and **full-width auto-growing `<Grow>` textarea** below it for `v.definition`, followed by `<Marks>` word-level diff against `base` (matched by value name or index) and struck-through `Removed` rows when a value was deleted relative to `base`.
  - `+ Add value` ghost button at the bottom (and an empty state with `Add value` when `label.values` is empty).

### 2.2 Replace Native `<select>` on Gold Labels `Compare with`
- **Observed issue**: `apps/web/src/app/(project)/gold/page.tsx` (around line 284) still uses a raw browser `<select aria-label={t('Compare with')}>` inside the `Tabs` `end` slot, whereas `Project Settings` now uses the custom Unified UI `<Select>` popover listbox.
- **Requirement**: Extend `<Select>` in `apps/web/src/ui/index.tsx` to support a compact/inline variant (for example `size?: 'md' | 'sm'`, `ariaLabel?: string` with optional visible `label?: string`, `width?: number`) so it fits cleanly inside the 32px-tall `Compare with` bar on `Gold Labels` without a stacked `.field-l` above it, and replace the native `<select>` in `gold/page.tsx`. No native `<select>` elements should remain anywhere in `apps/web/src`.

### 2.3 Chat Composer Shortcut: `Shift+Enter` to Send, `Enter` for New Line
- **Requirement** (`apps/web/src/components/AskAi.tsx`):
  - Change the `Composer` keyboard shortcut so **`Enter` inserts a normal newline** (default `<textarea>` behavior) and **`Shift+Enter` sends the message** (still guarding against active IME composition: `composing.current || e.nativeEvent.isComposing || e.keyCode === 229`).
  - Update the Send button's hover tooltip in English to **`Shift+Enter to send · Enter for new line`** (and update the matching entry in `packages/domain/src/locales/zh.ts`).
  - Update `docs/decisions.md`, `docs/ui-gaps.md`, `docs/design/ui.md`, and `apps/web/scripts/e2e-check.cjs` (`ask()` helper) to verify that plain `Enter` adds a newline without sending and `Shift+Enter` sends.

---

## 3. Agent System & Working Prompt Alignment (`@sprint/agents`, `@sprint/bff`)

Testing `Prompt helper` on real multimodal moderation prompts exposed three mismatches between our new structured prompt model and the existing agent routing / system prompts:

### 3.1 Fix `draft_prompt` vs `import_prompt` Routing on `Prompt Design`
- **Observed bug**: `PromptDesignPage` (`apps/web/src/app/(project)/prompt-design/page.tsx`) sets `page = { agent: 'prompt_agent', intent: 'draft_prompt' }`, bypassing `front_desk`. When a user pastes a complete existing prompt directly on `Prompt Design` (or first says *"Initialize from this prompt:"* and pastes the prompt in their second message), `prompt_agent` receives `intent: 'draft_prompt'` instead of `'import_prompt'`, so it summarizes/paraphrases instead of faithfully importing sections and populating `unmapped` (`Not carried over`).
- **Requirement**:
  - Ensure `prompt_agent` handles pasted/linked existing prompts identically whether invoked under `draft_prompt`, `import_prompt`, or `revise_prompt`: unify or auto-detect in `runAgentTurn` / `PRESETS.prompt_agent` so that whenever the user pastes an existing prompt (or links a prompt doc) to initialize/replace the prompt, `prompt_agent` applies the **Import** rules and returns `unmapped` passages when applicable.

### 3.2 Redefine the Boundary Between `label.values[].definition` and `ruleGroups`, with Proactive Multi-Line Formatting
- **Observed bug 1 (wrong slot)**: When importing a full prompt that had headings like `Strong Criteria`, `Weak Criteria`, `Sexy/Portrait Criteria`, `Prompt helper` wrote 1-sentence placeholders into each value's `definition` and dumped all per-value criteria into separate `ruleGroups` (`Strong rules`, `Weak rules`, ...).
- **Observed bug 2 (wall of text in `definition`)**: `PRESETS.prompt_agent.system` currently says: *"Each definition is one line that a new colleague could apply..."* and *"Rules written under a label go into a group titled `<field> rules`"*. When the user asked `Prompt helper` to move the criteria into `definition`, the model obeyed *"one line"* by stripping every line break and joining 15 criteria with semicolons into an unreadable wall of text.
- **Updated domain rules for `PRESETS` (`common`, `prompt_agent`, `optimiser`) and `scriptedAgent`**:
  1. **Single-label scope**: Every project classifies **one mutually-exclusive label**. If a user asks for multiple unrelated labels in one project, explain briefly that Sprint tunes one mutually-exclusive label per project so the eval dataset can be balanced cleanly (suggesting a separate project for each label).
  2. **What belongs in `label.values[].definition`**: **Everything that defines when that specific label value applies or does not apply**—positive criteria, visual/text thresholds, sub-cases, near-miss exclusions, and scene exemptions for that value. Never push value-specific criteria into `ruleGroups` during `draft_prompt`, `import_prompt`, `revise_prompt`, `improve`, or `optimiser` `reflect`/`merge`.
  3. **Proactive multi-line list formatting inside `definition`**: Remove the *"one line"* rule. Instruct `prompt_agent` and `optimiser` explicitly:
     - Short, simple categories may use 1–2 crisp sentences.
     - Whenever a value has **two or more conditions, thresholds, sub-cases, or exclusions/exemptions**, **proactively format `definition` across multiple lines using bulleted (`- `) or numbered (`1. `) lists and blank lines between paragraphs** (for example separating *"Applies when any of the following holds:"* bullets from *"Does not apply / Exemptions:"* bullets). Never cram multiple criteria into a single semicolon-joined paragraph.
  4. **What belongs in `ruleGroups`**: **Cross-value and task-wide rules only**—decision priority / short-circuit evaluation order across values (e.g. *"Check A -> B -> C -> None; stop at first match"*), tie-break rules when an item straddles two values, input-handling & modality rules (e.g. how to treat cover vs text, OCR caveats, prompt-injection immunity), and cross-cutting standards that apply equally across multiple values (e.g. non-photorealistic / illustration alignment).
  5. **Where `improve` and `optimiser` place fixes**:
     - If mistakes show a value's own boundary is vague, too broad, or missing an exclusion/exemption -> **refine that value's `definition`** (keeping clean bullet structure).
     - If mistakes are caused by evaluation order between two values that both match, or how an input feature is read across all values -> **update or add the relevant cross-value `ruleGroup`**.

### 3.3 Symmetric Multimodal Feature Selection (`video` + `photo_text`)
- **Observed bug**: On a task judging short-video / two-column feed items by title, description, and cover image, `Prompt helper` ticked `photo_text: ['Title', 'Description', 'Cover']` and left `video: []` completely empty—so every `video` item in the eval dataset would be sent to the labeling model with **zero features**!
- **Requirement**: Explain the feature-loading model explicitly in `PRESETS.prompt_agent.system` and `PRESETS.optimiser.system`:
  - Eval datasets routinely contain **both `video` items and `photo_text` items** (`renderPrompt` loads `features.video` + `features.metadata` for `video` items, and `features.photo_text` + `features.metadata` for `photo_text` items).
  - Unless the user explicitly states the dataset contains only `photo_text` posts or only `video` posts, **always tick the matching evidence features across BOTH `video` and `photo_text`** (for example if the task reads title, description, and cover, tick `Description` and `Cover` in `video` AND `Title`, `Description`, and `Cover` in `photo_text`, noting that `video` has no `Title` key in `featureCatalogue`).
  - Keep the rule not to tick forbidden or heavy features the user's rules exclude (e.g. if the prompt forbids pre-extracted `OCR_Text`, `ASR`, extra `Images`, or `Frame`, leave those unticked in both groups).

### 3.4 Pass `locale` to `Improve with AI` and Audit All Agent Prompts & Tool Specs
- Pass the user's `locale` into `improveWithAi` (`BffContract.improveWithAi` -> `DraftImprovementInput.locale` -> `withFeatureInfo` appending `languageLine(input.locale)`) so `Improve with AI` writes its `reply` and hover `changes[].reason` in Chinese when the user is viewing the site in Chinese (while keeping edits to `prompt` in the prompt's own language).
- Audit all 4 presets in `apps/agents/src/presets.ts` (`common`, `front_desk`, `prompt_agent`, `evaluation_agent`, `optimiser`), `TOOL_SPECS`, and `apps/bff/src/services/page-views.ts` (`reportView`, `datasetStats`, `compareVersions`, `mismatchSummary`, `projectSummary`) to remove every leftover reference to multiple fields, `lowestField`, `lowest Macro-F1 across fields`, and `single / multi`.

---

## 4. Verification Checklist

1. `./internal/deploy/check-public.sh` (English-only outside `locales/`, clean boundaries).
2. `npm run check` — Boundaries, TypeScript across all packages/apps, i18n completeness test (`zh.ts` updated for all new keys and pruned of dead multi-field/shortcut keys), and unit tests covering:
   - Single-label `StructuredPrompt`, `compilePrompt` with multi-line `<label>` formatting, `checkStructured`, `rewordOnly`, and legacy/new gold-label upload parsing.
   - Single-label `computeMetrics`, `judge`, `assignEvalHalves`, `labelBalance`, and `compareDryRun`.
   - Agent tests for `import_prompt` routing on `Prompt Design`, single-label `draft_prompt` / `improve` / `optimiser`, and `locale: 'zh'` on `draftImprovement`.
3. `npm run build` — Clean static export.
4. `node apps/web/scripts/e2e-check.cjs` — Updated for:
   - `Shift+Enter` to send and `Enter` for newline in `Ask AI`.
   - Stacked vertical value cards in `Output Labels & Definitions` (reorder/add/remove + unclipped `<Grow>`).
   - Single-label `Eval Dataset`, `Gold Labels` (including custom `<Select>` for `Compare with`, zero native `<select>` elements), and per-value metrics table on `Prompt Tuning`.

---

## 5. Decided in review (2026-11-16)

1. Each project and its model classify one label. Projects are never mixed or merged, so the label-combining advice, the multi-project batch merge and `LabelSource[]` are dropped.
2. The prompt helper suggests a catch-all value (`Other` / `None`) when the values might not cover every item.
3. Projects saved before this change are test data: they are started fresh rather than migrated. Old gold-label upload files still import.
4. `Answer` is a plain string.
5. Chat panel: remove the page tag (for example `Prompt Design`), the "Prompt helper answers" line and the "Helpers read your recent messages" line.
