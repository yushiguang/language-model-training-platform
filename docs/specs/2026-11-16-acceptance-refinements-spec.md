# Specification: Acceptance Pass Refinements — Auth Session UX, Structured Rule Groups, XML Prompt Compilation, and Project Settings Redesign

**Date:** 2026-11-16  
**Target:** External Agent (contracts, domain, agents, bff, Unified UI design system, and web app)  
**Contract Impact:** Breaking `StructuredPrompt` update (`Contract change: custom RuleGroup list, removal of field note, XML prompt compilation, and optional Identity.signOut`)

---

## 1. Authentication State & Top-Island Avatar UX

Hands-on acceptance testing on the hosted preview environment revealed that the **Projects** page (`/`) and project pages render before user identity is resolved, showing an empty avatar circle and no sign-out affordance:

1. **Await or cache `RuntimeInfo` cleanly across the app**:
   - Currently `UserEnd` (`apps/web/src/components/Shell.tsx`) fetches `getRuntimeInfo()` inside a per-mount `useEffect` with `user = ''`, causing an empty avatar circle on initial load and whenever `LocaleProvider` re-mounts the tree (`<Fragment key={locale}>`).
   - Cache the resolved `RuntimeInfo` at module/client level so page navigation and language switches render the signed-in user's name and initial immediately with zero blank flash.
   - Gate the **Projects** home page (`/`) and project shell on `getRuntimeInfo()` (showing the standard loading state until identity resolves; if `getRuntimeInfo()` rejects due to unauthenticated state, surface a retryable error state instead of rendering an anonymous page).
2. **Sign-out support on `Identity` (`packages/contracts/src/platform-api.ts`)**:
   - Add optional `signOut?(): Promise<void>` on `Identity` (`RuntimeInfo.canSignOut?: boolean` and `signOut(): Promise<void>` on `BffContract` / `BffClient`).
   - When `canSignOut` is `true` (provided by the hosting platform's SSO adapter; `false` on local stand-ins), render a **Sign out** item (translated in `zh.ts`) at the bottom of the avatar menu (`UserMenu`).
3. **Typography problem on project icon & default user avatar**:
   - **Observed issue**: The project icon badge (`.proj-ic`, showing `"S"` on `/` or the project's initial) and the default user avatar badge (`.avatar` / `.avatar-btn`) look visually thin and lack weight. Notably, `.avatar-btn` in `app.css` declares `font: inherit`, which resets `kit.css`'s `.avatar` font-weight back to normal `400`.
   - **Goal for External Agent**: Please review and update the design system / CSS so both `.proj-ic` and `.avatar` / `.avatar-btn` render in a crisp **bold** weight.

---

## 2. Prompt Design Reorganisation, Custom Rule Groups, and XML Compilation

### 2.1 Empty Input Features on New Projects
- **Observed issue**: `emptyStructuredPrompt()` (`packages/domain/src/structured.ts`) pre-ticks `Description`, `OCR_Text`, `ASR`, and `Title` on brand-new projects. In real multimodal tasks (for example cover-only visual moderation that forbids `OCR_Text` and `ASR`), pre-ticked features mislead users and violate task constraints.
- **Requirement**: `emptyStructuredPrompt()` MUST initialize `features` completely empty (`{ video: [], photo_text: [], metadata: [] }`). Features are ticked only by the user or by `Prompt helper` when drafting/importing a prompt.

### 2.2 Re-evaluated Section Order on `Prompt Design` and `Prompt Edit`
Arrange the `StructuredEditor` sections top-to-bottom in the natural authoring order:

1. **Persona & Task** *(moved to #1, top of page)* — Role and task description (`taskSummary`: who the model is and what it is judging).
2. **Input Features** *(#2)* — Checkboxes for `Video`, `Photo and text`, and `Metadata` (all unchecked initially on a new project).
3. **Output Labels & Definitions** *(#3)* — Label fields (`Single-select` / `Multi-select`) and each value's multi-line `Definition`.
   - **Remove `Tie-break rules` (`StructuredFieldPrompt.note`)**: Remove the fixed per-field `Tie-break rules` box from `FieldEditor` and remove `note` from `StructuredFieldPrompt`. Field-ordering, short-circuit priority, and cross-value rules belong in user-named **Rule Groups** below.
4. **Rule Groups** *(#4, replacing the hardcoded `General / fallback rules` box)* — User-created, user-named rule groups.

### 2.3 User-Defined Rule Groups (`RuleGroup[]`)
Real production prompts organize instructions into domain-specific groups (for example *"Core Principles & Priority Order"*, *"Input Handling Rules"*, *"Non-Photorealistic Alignment"*), each containing multi-line paragraphs and nested bullet criteria—not a single hardcoded *"General / fallback rules"* box, and not flat single-line rule inputs.

- **Data model (`packages/contracts/src/types.ts`)**:
  ```ts
  export interface RuleGroup {
    id: string;
    /** User-defined group title, e.g. "Label Priority Rules" or "Input Handling Rules". */
    title: string;
    /** Multi-line free-form text block (paragraphs, numbered/bulleted sub-rules). */
    content: string;
  }
  ```
  Replace `generalRules: string` on `StructuredPrompt` with `ruleGroups: RuleGroup[]` (starting as `[]` on an empty prompt).
- **Editor interaction**:
  - Users can add (`+ Add rule group`), rename (`title` input), edit (`content` auto-growing multi-line textarea), reorder (optional up/down or clean list order), and remove rule groups.
  - Validation (`checkStructured`): if a rule group is added, require a non-empty `title` (or ignore completely empty groups on tidy, refusing a group that has `content` without a `title`).
  - Word-level change marks (`diffWords` + `withReasons`): match rule groups against `base.ruleGroups` (by `id`, falling back to matching `title`), rendering word-level additions/deletions under modified rule groups, and badging newly added or removed groups.
  - Update `Prompt helper` (`draft_prompt`, `import_prompt`, `revise_prompt`, `improve`) and `Optimiser` (`reflect`, `merge`) presets, `rewordOnly`, `readStructured`, `compare_versions`, and `scriptedAgent` stand-in to read and write `ruleGroups` (preserving multi-section headings as distinct `RuleGroup` entries during prompt import so real prompts import cleanly with minimal `unmapped` text).

### 2.4 XML-Style Prompt Compilation (`compilePrompt`)
Update `compilePrompt(p: StructuredPrompt, signature?: LabelSignature): string` in `packages/domain/src/structured.ts` to emit clean **XML-tagged sections** instead of Markdown `##` headings, giving language models unambiguous structural boundaries and stronger resistance against prompt-injection text inside item features:

```xml
<persona_and_task>
{taskSummary}
</persona_and_task>

<input_features>
  <feature name="Title">{{Title}}</feature>
  <feature name="Description">{{Description}}</feature>
  <feature name="Cover">{{Cover}}</feature>
</input_features>

<output_labels>
  <field name="category" selection="single">
    <label value="ValueA">{definition}</label>
    <label value="ValueB">{definition}</label>
  </field>
</output_labels>

<rules>
  <rule_group name="{group.title}">
{group.content}
  </rule_group>
</rules>

<output_format>
Return one JSON object only, with exact field keys and allowed label values from <output_labels>:
{"category": "ValueA | ValueB"}
</output_format>
```
*(Omit `<rules>` when `ruleGroups` has no non-empty groups; include `<reference_images>` when `p.images.length > 0`; escape XML attribute quotes on user-supplied names; keep `@sprint/labeling`'s trailing `REASON_LINE` behavior compatible.)*

---

## 3. Project Settings Dialog Redesign (Visual & UX Issues)

Hands-on review of the **Project Settings** dialog (`apps/web/src/components/ProjectSettings.tsx`) identified 6 usability and visual issues. Please let the External Agent determine the exact spacing tokens and component styling within the Unified UI design system to address all 6 points:

1. **Redesign the `Evaluation` section header & mode toggle**:
   - **Observed issue**: The two-column layout with `"Pass rule"` on the left (two large bordered radio cards with multi-line descriptions) and `"Checks"` on the right looks cluttered and unbalanced.
   - **Requirement**:
     - Remove the `"Pass rule"` and `"Checks"` sub-headings completely.
     - Remove the two large radio cards and their descriptions.
     - Place a compact `Default` / `Custom` segmented switch (or toggle control) directly to the **right of the `"Evaluation"` section heading**, with the checks table spanning cleanly underneath.
2. **Keep `Invalid outputs` as-is**:
   - Retain the existing `Invalid outputs` (`≤ 1%`, always checked) row in the checks table and in `judge()`.
3. **Remove the dialog's top introductory description**:
   - Delete the subtitle `"Check these once before the first scoring run. You can change them later with Settings at the top."` even on first confirmation.
4. **Remove the labeling model description line**:
   - Delete `{info?.description && <span className="set-sub">{info.description}</span>}` (e.g. `"Higher quality preset..."`) under the Labeling model fields.
5. **Unify the `Model` dropdown with the site's design system**:
   - **Observed issue**: `<Select>` currently wraps a native browser `<select>`, whose OS-native popup menu clashes with the rest of the Unified UI (such as the custom rounded popover menu `.menu-pop` used under the avatar).
   - **Requirement**: Replace native `<select>` styling/popup (in `Select` or `ProjectSettings` + Gold `Compare with` if shared) with a custom keyboard-accessible popover listbox matching the Unified UI design system.
6. **Clearer visual separation between settings sections**:
   - **Observed issue**: `Name`, `Evaluation`, and `Labeling model` sit too close together with uniform spacing, making it hard to tell at a glance where one group ends and the next begins.
   - **Requirement**: Rebalance vertical spacing and/or subtle section dividers/grouping inside `Project Settings` so the three sections read as distinct, scannable groups.

---

## 4. Verification Checklist

1. `npm run check` — Boundaries, TypeScript, i18n catalog completeness test (`zh.ts` updated for all new/changed keys, dead keys pruned), and unit tests for XML `compilePrompt`, empty initial features, `ruleGroups` diff/import/rewording, and `signOut`.
2. `npm run build` — Clean static export.
3. `node apps/web/scripts/e2e-check.cjs` — Updated for empty initial features on `Prompt Design`, the 4-section order (`Persona & Task -> Input Features -> Output Labels & Definitions -> Rule Groups`), XML full-prompt preview, and the redesigned `Project Settings` dialog (`Default` / `Custom` switch in the `Evaluation` header).
