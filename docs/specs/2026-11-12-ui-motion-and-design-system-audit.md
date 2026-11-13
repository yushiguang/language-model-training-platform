# Specification: UI Motion, Async Feedback Audit, and Design System Refinement

**Date:** 2026-11-12  
**Target:** External Agent (for Design System / Unified UI canvas review first, then `apps/web/src/ui/kit.css`, `app.css`, `@/ui`, and step pages)  
**Design Principle:** Restrained, purposeful motion (`140ms–220ms`, `cubic-bezier(0.2, 0, 0, 1)`). The top island remains stationary; panels, items, and async actions provide immediate, unmistakable tactile feedback without flashy or distracting animations.

---

## 1. Executive Summary for Design System Review

Usability testing showed that while the visual layout is clean and consistent, interactions feel abrupt ("hard cuts")—especially during repetitive human labeling on **Gold Labels**, cross-step navigation, opening/closing **Ask AI**, and clicking cross-module action buttons.

Please review the **6 concrete findings** below, update the **Unified UI** design system tokens/components (`kit.css` + `@/ui`) where appropriate, and apply the fixes across `apps/web`.

---

## 2. Detailed Audit Findings & Proposed Fixes

### Finding M1: Swallowed Promises Break Button Pending States (Critical Interaction Bug)

**Root cause in code:**  
`Button` (`apps/web/src/ui/index.tsx`) automatically renders a spinner (`<Icon name="ring" />`), sets `.btn.pending`, and locks sibling actions in `ActionGroup` **only when `onClick()` returns a `Promise`**. Several cross-module buttons wrap async calls in `void ...` or attach `.catch(...)` without returning the Promise, so clicking them gives zero visual feedback:

1. **Rebuild scores** (`apps/web/src/app/(project)/prompt/page.tsx`): Verify `onClick={() => rebuildReports(state.project.id)}` returns the Promise AND enforces a minimum `250ms` visual pending/confirmation beat (since in-memory/local rebuilds can resolve in `<15ms`, appearing broken/unresponsive to the user; on remote HTTP BFF it takes longer and needs the spinner).
2. **Auto sampling** (`apps/web/src/app/(project)/dataset/page.tsx`): `onClick={() => void startSampleDataset(...)}` swallows the Promise before the sampling progress view mounts. Return the Promise directly.
3. **Improve with AI** (`apps/web/src/app/(project)/prompt/page.tsx`): `improve()` calls `improveWithAi(...).catch(...)` without awaiting/returning before `go(...)`, and `Auto Optimise` dialog's `Start` button (`start()`) closes the dialog immediately (`setAsk(null)`) and fires `startOptimiser(...).catch(...)` un-awaited. Keep the `Start` button in pending state until `startOptimiser` initializes the run and switches to the Optimiser panel.
4. **Stop buttons** (`prompt/page.tsx`, `dataset/page.tsx`, `optimiser`): `stopOptimiser` and `stopSampleDataset` return `void`, so clicking `Stop` shows no pending state while the runner aborts. Make stop actions async (or transition immediately to a `"Stopping…"` disabled state until state updates).

**Design System / Code Action:**
- Audit every `<Button onClick={...}>` across all pages: never discard a returned `Promise` with `void`.
- Add a `minPendingMs` (e.g., `220ms`) floor inside `Button` for async actions that stay on the same page (like `Rebuild scores` or `Save` in `Labeled` view) so fast responses still register visually, without delaying navigation buttons.

---

### Finding M2: Missing Micro-Interactions on Buttons, Chips, and Controls

**Root cause in code:**  
In `apps/web/src/ui/kit.css`, `.btn`, `.ch` (answer choice chips on Gold Labels), `.opt` (radio cards), `.seg button` (segmented controls), and `.tab` have instant `:hover` and `[aria-pressed=true]` color snaps with no CSS `transition` and no `:active` press feedback.

**Design System Proposal (`kit.css`):**
- Define two standard motion tokens in `:root`:
  ```css
  --ease-out: cubic-bezier(0.2, 0, 0, 1);
  --dur-fast: 140ms;
  --dur-med: 200ms;
  ```
- Add subtle color/border/transform transitions (`transition: background-color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out), transform 100ms var(--ease-out)`) to `.btn`, `.ch`, `.opt`, `.seg button`, `.tab`, and `.icon-btn`.
- Add tactile press feedback `:active:not(:disabled) { transform: scale(0.98); }` on `.btn` and `.ch`.
- Respect `prefers-reduced-motion: reduce` globally by collapsing durations to `0.01ms` and disabling transforms.

---

### Finding M3: Step-to-Step Navigation Stops Animating After Initial Mount

**Root cause in code:**  
In `apps/web/src/components/Shell.tsx`, `<Frame>` renders `<div className="container page-in">`. Because Next.js App Router keeps the shared `(project)/layout.tsx` mounted and React reconciles `<Frame>` across step pages, the `.page-in` CSS animation only fires on initial project load—subsequent clicks on the top stepper or `Next: ...` swap page contents with a hard cut.

**Design System / Code Proposal:**
- Key the animated page body container in `Shell.tsx` by route pathname (`key={pathname}`), while keeping `<TopNav>` (the top island) and `<AskAi>` outside the keyed node so they never remount or flicker.
- Upgrade `@keyframes k-fade-in` from pure opacity to a restrained fade + `4px` upward settle (`opacity: 0; transform: translateY(4px)` -> `opacity: 1; transform: translateY(0)`, `160ms var(--ease-out)`).

---

### Finding M4: Hard Cuts During High-Frequency Labeling on Gold Labels

**Root cause in code:**  
Users spend the most continuous time on **Gold Labels**, stepping through dozens or hundreds of examples. Currently:
1. Clicking `Previous` / `Next` (`< 1 of N >`), saving an item in `To label` / `To review` (which advances to the next item), switching between `To label` and `Labeled`, or switching between `Eval set` and `Mismatches` swaps `<ExampleCard>`, `<ModelAnswer>`, and `<YourAnswer>` instantaneously with zero visual continuity.
2. Media (`<iframe>` or still `<img>` inside `.media`) pops in abruptly over the dark stage.

**Design System / Code Proposal:**
- **Directional item transition (`160ms var(--ease-out)`)**: Track navigation direction (`next` vs. `prev` vs. `tab/filter`). Wrap the two-column example workspace (`key={ex.id}`) in a lightweight transition class:
  - Advancing (`Next` or post-`Save` auto-advance in `To label`): `opacity: 0; transform: translateX(8px)` -> `opacity: 1; transform: translateX(0)`.
  - Going back (`Previous`): `opacity: 0; transform: translateX(-8px)` -> `opacity: 1; transform: translateX(0)`.
  - Switching tab or filter (`To label` <-> `Labeled`, `Eval set` <-> `Mismatches`): pure cross-fade + `4px` vertical settle.
- **Post-Save confirmation beat**: In `To label` / `To review`, when clicking `Save`, show the button pending state, flash a brief `"Saved"` confirmation (`~180ms`), then trigger the smooth forward slide to the next unlabeled item.
- **Media stage fade-in**: Fade `<img>` and `<iframe>` inside `.media` from `opacity: 0` to `1` (`180ms`) on `onLoad` while keeping the dark stage placeholder steady.

---

### Finding M5: Ask AI Drawer Open/Close Jolts the Main Workspace Width

**Root cause in code:**  
In `Shell.tsx`, `{open && side && createPortal(<AskAi ... />, side)}` mounts and unmounts the `400px` `.chat` aside instantaneously, causing `.b-main` and the centered `.island` to snap sideways by `200px` in a single frame.

**Design System / Code Proposal:**
- Animate the Ask AI aside container width/transform and opacity (`200ms var(--ease-out)`), or keep the slot transitioning smoothly from `0px` to `424px` (`overflow: hidden`) while `<AskAi>` slides in (`translateX(16px)` -> `0`, `opacity: 0` -> `1`), and cross-fade the floating `Ask AI` pill button (`.ask`).

---

### Finding M6: Abrupt Entrances on Dialogs, Banners, Version Cards, and Primary Action Cues

**Root cause in code:**  
1. `Dialog` (`.dlg-scrim` and `.dlg`), `ActionErrorBanner`, and `.tip-pop` tooltips appear in 1 frame with no entrance easing.
2. On `Prompt Tuning`, selecting different versions in the left `Versions` list swaps `VersionCard` / `DroppedCard` / `OptimiserPanel` instantaneously (only container height transitions).
3. With in-chat `Approve` cards removed (Feedback #4), users need a subtle visual cue drawing their eye to the top-right primary `Approve` (or newly unlocked `Next`) button when an AI draft lands.

**Design System / Code Proposal:**
- **Dialog entrance**: `.dlg-scrim` fades in (`150ms`); `.dlg` animates `opacity: 0; transform: scale(0.97) translateY(4px)` -> `opacity: 1; transform: scale(1) translateY(0)` (`180ms var(--ease-out)`).
- **Tooltip & Banner entrance**: `.tip-pop` fades in (`120ms`); `.banner` fades + settles (`150ms`).
- **Version detail switch**: Add a `140ms` opacity fade on the card inner body keyed by `sel.id` (or panel mode) alongside the existing `200ms` height transition on `RightColumn`.
- **Primary action attention cue (`.btn-cue`)**: When an AI proposal lands on the page (`isDraft`) or immediately after `Approve` unlocks `Next`, apply a restrained 2-cycle brand halo ring animation (`box-shadow: 0 0 0 0 rgb(79 70 229 / 35%)` -> `0 0 0 6px rgb(79 70 229 / 0)`) so the user's eye naturally finds the top-right action without intrusive modals.

---

## 3. Summary Checklist for External Agent Review

- [ ] Review whether `--ease-out`, `--dur-fast`, `--dur-med`, tactile `.btn`/`.ch` transitions, Dialog/Drawer entrance rules, and `.btn-cue` belong in `kit.css` (Unified UI canvas) vs. `app.css`.
- [ ] Update `docs/ui-gaps.md` for any motion behavior that lives only in code (`app.css`).
- [ ] Fix all swallowed Promises on action buttons and verify keyboard & `prefers-reduced-motion` accessibility.
