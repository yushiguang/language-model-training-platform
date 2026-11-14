# UI gaps: closed items, 2026-11-06 to 2026-11-12

One-time record. These sections were cut from `docs/ui-gaps.md` on 2026-11-12: every item here
was approved or done, so it is history, not an open gap. The open list stays in
[../ui-gaps.md](../ui-gaps.md). Delete this file once nobody needs the trail (git keeps it).

## Approved on 2026-11-09

Evelyn approved every difference the code had from the canvas. The canvas was updated to match,
and its row "6 · More states, drawn from the code" now draws the states it lacked:

| Where | What the code and the canvas now do |
| --- | --- |
| Top island | Project icon (avatar style, the project's first letter) and name, the steps, then the stand-in tag and the user, in one rounded panel as wide as the content. It moves left with the content when Ask AI opens. There is no platform name in it |
| Projects page (`/`) | Island with "Sprint", title "Projects", a "New project" card and a table of projects (drawn) |
| Schema settings, editing a saved schema | "Unsaved changes" tag, Discard and Save in the header (drawn) |
| Gold Labels, model answer | Hidden: Hide turns into Show and the card keeps only its title (drawn). No answer yet: the card is not shown at all (drawn) |
| Gold Labels, example media | Item ID only, no length |
| First prompt | No back arrow |
| Prompt page, View prompt | The same page read-only, with Edit prompt in the header (drawn) |
| Prompt versions, the big score | Always the lowest field's Macro-F1, so the number, the chart and the list agree with the pass rule |
| Prompt versions, stopped or not scored | Grey line saying why, with Score or Resume (drawn) |
| Training Set, a run stopped | Labeling card with a Stopped tag and Resume (drawn) |
| Training Set, Add examples | Removed; adding examples to a dataset comes in a later version |
| Ask AI, events | Small grey action lines such as "Scores helper joined to answer" (drawn; see below for the 2026-11-09 set) |

These code choices are approved but not drawn, because they are small or follow an existing pattern:

- Evaluation settings: the Checks card shows only when Custom is chosen.
- Gold Labels: an answer saves as soon as every field has a value.
- First prompt: the empty editor says "Paste your prompt, or ask AI to draft one".
- Prompt page, a version with no edits: the Save buttons show but are disabled (2026-11-10: Save and Save as vN, see below).
- Checks: Fix runs the first fix of the error (Replace, Tick or Insert); other warnings are not shown.
- Prompt versions: the newest version is selected; with evaluation off there is no chart and the
  suggestion is "Make the training and test sets with vN"; when nothing passes it says "No version
  passes yet"; before gold labels it says "Label the eval set to start scoring".
- Ask AI stays open (or closed) when moving between any steps: the shell is shared by every step
  page since 2026-11-09 (it was per page before, so this line used to be wrong).

## Done on 2026-11-09: review, hands-on pass and the new canvas states

Evelyn approved the canvas row "7 · Agents, motion and states" and the no-gold version card, and
asked for the code. What the code does now (the review `docs/review-2026-11-09.md` and the
hands-on list `docs/acceptance-2026-11-09.md` are covered by the same pass):

| Where | What the code does |
| --- | --- |
| Ask AI, helpers | Each answer names its helper: Assistant, Labels helper, Prompt helper, Scores helper. The header says who answers ("Scores helper answers") |
| Ask AI, a helper joins | A grey line "Scores helper joined to answer"; the "I'll bring in…" reply is not shown. The helper keeps answering on that page; from another page the page's own helper answers again, with a line "Assistant answers on Dataset". A helper that stayed passes work for another helper on (for example the Scores helper hands "try the prompt" to the Prompt helper) |
| Ask AI, while a turn runs | A live line with a spinner ("Thinking…", "Reading the v4 report…"), then the reply streams in with a caret. Read tools are not shown as lines |
| Ask AI, action lines | Saved in the chat: a draft put on a page, You approved or discarded the schema, You saved it as vN (after a helper's draft), a helper's paid start, Workflow starts (scoring, the optimiser), You stopped work. 12px, the time on the right; a line with a place to go is itself the link |
| Ask AI, dates and memory | A date line where the day changes; "Helpers read your recent messages" under the input |
| Ask AI, input | Enter adds a line and never sends; only the button sends. The box grows to 6 lines, then scrolls with no scrollbar. Enter does not submit the Projects name either |
| Schema settings, AI draft | Header: "AI draft" tag, Discard, Approve. The chat card's Approve stays as a shortcut. The labeling policy is gone everywhere (the value definitions and the prompt carry the rules) |
| Buttons | A button doing work shows a spinner, and its header group is locked. A failure shows one red banner at the top of the content with Retry |
| Step changes | The island, the project state and Ask AI stay mounted; the new step fades in (150ms). The panel spinner shows only while the project first loads |
| Labeling models | A model without temperature shows a grey "Not supported" box with a grey label |
| Step numbers | Centred in their circles |
| Prompt versions, labeled with no gold labels | Labeled N / M, Filtered and Failed (hover text, Failed red when above 0, 80px apart), the AI Suggestion "Label the eval set to start scoring", and a Label distribution card. The list shows labeled counts; no chart |
| Training Set | "Label counts" is now "Label distribution" |
| Gold Labels, feature rows | Every feature the example has is listed (the known ones by their names first, then the rest), except images and ids |
| Projects page | A project with every step done shows "Finished"; the project finishes by itself once the training set and the test set are done |
| Stand-in sampling | 400ms per step of 8 examples (was 120ms), so the progress can be seen |

## Done on 2026-11-09: the Optimiser screens

Evelyn approved the canvas boards for one labeling model per project, the finished Setup summary
(R2-1), Auto Optimise with Max rounds, the Optimiser progress panel, two-level version numbers,
dropped versions, Failed with Retry, a pass that starts the training and test sets, and Improve
with AI. What the code does (the boards are U-B-Setup-Models and the U-E-* boards):

| Where | What the code does |
| --- | --- |
| Setup, Labeling model | A Model card (one radio per model, its tag on the right, its description on hover) and a Settings card, 400px and the rest |
| Setup, finished | Opens on the "Setup" summary: Schema, Evaluation and Labeling model, one line each, with Edit; Next: Dataset |
| Prompt versions, below the bar | AI Suggestion "<field> holds vN back", the top mix-up as its line, and "Improve with AI or Auto Optimise [10] rounds" |
| Prompt versions, a pass | "Improve with AI" replaces "Keep improving" next to "Make training and test sets" |
| Versions list | All or Major; Optimiser tag on the run's versions; Best only on the best version when it passes; Running and Dropped tags |
| Optimiser panel | Replaces the version card while a run is going, failed or paused: Round N / max, Started from, Started at, the Now line with "since" and progress, then every round (Round, Version, Change, Result). Stop, or Retry when Failed |
| A dropped version | "vX passed a / n" and "vY passed b / n" (hover says what they count), "Dropped after dry run", and the same per field |
| A pass from the Optimiser | AI Suggestion "vX passes, training and test sets started", "The Optimiser stopped after round N of M. Labeling started with vX.", Go to Training Set |
| Prompt editor | Save (main, the next minor; its number on hover) and Save as vN (the next major, "v3" not "v3.0"); with no edits both are off and there is no Discard (2026-11-10). A helper's draft shows "Draft from Prompt helper" |
| Prompt editor, change marks (2026-11-10) | Word by word: added text green, removed text a small red space; hover shows what was removed and, for a helper's or the Optimiser's change, why. Marks show for a helper's draft and your own unsaved edits (against the opened version), and on an Optimiser version with no edits (against its parent, with a grey "Changes from vX" tag) |
| Gold Labels (R2-2) | The model answer starts hidden on every example; Show reveals it for that example only, and the label records that it was seen |
| Ask AI (R2-5) | The newest start line of work that is still running spins (scoring and the Optimiser, test answers, the training set) |

## Done on 2026-11-10: acceptance round 3

Evelyn accepted the answers D1 to D5 in the investigation and approved canvas rows 9 ("Acceptance
round 3") and 10 ("Prompt versions: one layout"). What the code does:

| Item | What the code does |
| --- | --- |
| R3-1 Hints | A hover or keyboard focus on a dashed-underline word opens a small popover (it flips above or left near the edges; Escape closes it). Hints stay only on words that need one (Filtered, Failed, rounds, the "Fewer than N" warnings, the dry run's "vX passed", Invalid dropped, a disabled control's reason, the model options); Gold labels, Train size and check lines that say everything lost theirs |
| R3-2 Chat | Long words and links wrap inside the bubbles |
| R3-3 Unsaved draft | The editor's and the first prompt's unsaved template, features and images go with every Ask AI turn (`pageView.data.unsaved`) |
| R3-4 Projects | While loading: "Loading projects" with a spinner and three grey rows. On error: a red banner with Retry. Each row's current step fills in as its project loads |
| R3-5 Pending | A link button shows a spinner while its page loads; buttons that navigate stay busy until the new page shows |
| R3-6 Improve with AI | Opens Ask AI, then the editor, where the draft appears |
| R3-7 Start version | Auto Optimise starts from the version selected in the list. When a better minor of the same major exists, a dialog asks: "Start from vX" or, as the main button, "Start from vBest" (U-F-Optimise-Confirm) |
| R3-8 One layout | The chart card is always there (an empty grey area with a note before any score). The Versions list and the right column are both 478px high. The right column is the detail card, which scrolls inside with a fade, plus the AI Suggestion when there is one; only the detail card's height changes (200 ms). With no gold labels, Label distribution is inside the detail card. The Optimiser panel scrolls inside |
| R3-9 Optimiser | The panel shows "Best so far" (score and version). The helpers read up to 8 wrong examples of the optimiser half (never the held-out half), text features cut to about 300 characters; a merge reads up to 4 examples each version wins. The dry run is half of the optimiser half, at most 20 |
| R3-10 Helpers | A question gets an answer and never a draft; an unclear request gets one short question first; a big rewrite starts with a one-line summary |

## Done on 2026-11-10: fixes from the MVP review

Canvas rows 11 ("Fixes from the MVP review") and 12 ("Mismatches on Gold Labels"). What the code does:

| Item | What the code does |
| --- | --- |
| Step bar (finding 9) | Gold Labels says "recommended" |
| Dataset (finding 10) | AI Suggestion "Check the labels against your data" with Check labels. The Labels helper joins in Ask AI, reads 20 random examples (never the held-out half; images as content parts), answers, may put a draft on Schema settings, and keeps answering on Dataset |
| Prompt versions | "Score" with the precise term on hover, for the big number and the field column |
| Optimiser (finding 6) | A passing version is confirmed by labeling the held-out half again ("Confirming v3.5: labeling the held-out half again"); a pass the second labeling misses shows "Not confirmed" with its score on hover, and the run goes on |
| Improve with AI | One line in Ask AI: "I made 3 changes to v2. Hover each mark to see why." |
| Training Set (findings 12, 18) | No banner for rare values (the legend marks them). The test set says how many rows carry the model's answer, not a gold label, with why on hover |
| Gold Labels (finding 2) | The Model answer card picks the version to compare with (default: the best scored version with answers on the whole eval set). A Mismatches tab lists the eval examples where that version disagrees with the gold label, wrong in the most versions first, with the model's answer shown and the different field in red. "Keep my label" and "Use the model's answer" (or a third answer on the chips) take the example off the list and are recorded |
| Prompt versions (finding 2) | The AI Suggestion "The model disagrees with N of your labels" right after the first score, and "N examples were wrong in every version" when Auto Optimise ends without a pass; Review labels opens the Mismatches tab |

## Done on 2026-11-11: acceptance round 4

Evelyn approved canvas row 13 ("Acceptance round 4") and asked for the code (2026-11-11). What the
code does:

| Item | What the code does |
| --- | --- |
| R4-1 Score | "Score" stays, with the real metric in small grey text next to it: "Lowest field macro-F1" on the big number, "Macro-F1" on the field column. No hover |
| R4-2 Fade | No fade at the bottom of the version card or the Versions list |
| R4-3 Rounds | The AI Suggestion has no rounds box. Auto Optimise always opens one dialog: "Start from" (only when a better minor of the same major exists; the best is picked), "Max rounds" (prefilled 10), Cancel and Start. The "model disagrees" suggestion also lost its rounds box |
| R4-4 Why | On Mismatches the Model answer card adds "Model's reason" (the model's own sentence), or "Not readable" with the invalid reason in red. Your answer adds "Why", saved with Keep or Change. Notes on optimiser-half examples go to the Optimiser and Improve with AI as the person's own reading of the label; notes on the held-out half never reach a helper |
| R4-5 Reviewed | One "Compare with" for the page, at the end of the tab row: every tab shows that version's answers. A review belongs to a gold label and a version. Mismatches has "To review N / Reviewed M" for the picked version; a reviewed example shows the decision ("Kept my label", "Used the model's answer" or "Changed my label"), its time, the note read-only, and Reopen. Reopen puts it back in To review, and a changed label goes back to what it was |
| R4-6 Invalid | Invalid answers and answers the safety filter stopped are left out of every score (reports, the Optimiser's comparisons) and counted on their own: "Scored on 16 of 17 examples · 1 invalid (6%, above 1%) · 0 filtered left out" under the field table, red when over the cap. Every pass also needs at most 1% invalid answers (the project's own limit when Setup sets one). The Optimiser's per-example score still counts an invalid answer as 0 and skips filtered ones |

Not drawn, decided in code: a reviewed example with no note shows no Why box; "Reviewed" with
nothing in it shows "Nothing reviewed yet".

## Done on 2026-11-11: acceptance round 5

Evelyn said go on Claude's picks (2026-11-11). These are small changes coded without new canvas
boards; the canvas still shows the old states for them.

| Item | What the code does |
| --- | --- |
| R5-8 Gold Labels | An ordinary step: no "recommended" tag in the step bar. Setup's pass rule has no "None" any more (it skipped gold labels; a project saved with none opens on Default), and the unused skip call is gone |
| R5-1 Mismatches | When a version has scores, the Mismatches tab (count "–") and Compare with (disabled) are there from the first paint, so nothing pops in |
| R5-2 Compare with | The first visit picks the best version; from then on the pick holds for the session (per project). Only the "(best)" mark moves |
| R5-3 AI Suggestion | No "or" between Improve with AI and Auto Optimise |
| R5-4 After gold edits | Reports the edits archived are rebuilt from saved answers (nothing is labeled). Meanwhile the version card shows a "Scores updating" badge instead of "Not scored", and there is no AI Suggestion. Start in the Auto Optimise dialog takes you to the Optimiser panel |
| R5-5 Many edits | A review applies to the list at once, so you keep going. Nothing else is worked out: a grey "Scores out of date" note (why on hover) shows next to Compare with and on Prompt versions. Prompt versions has a "Rebuild scores" button in the page head (2026-11-12, not drawn), which works every score out again from saved answers |
| R5-6 Ties | A dry run that ties its parent (as many fields right, on different examples) goes on to the full labeling, with a grey "Tied" badge next to its score. It counts as a wasted round, and 2 ties in a row end the run |
| R5-7 Parent | Round 1 always changes the version you started from. Each round says "from vX" before its change, with why on hover (best on N examples of the optimiser half). The dry run's Now line says "against vX". The dialog says how later rounds pick |

## Done on 2026-11-12: acceptance round 6

Canvas page 2, row 14 ("Acceptance round 6"), approved by Evelyn. She skipped R6-4 and R6-1.

- **R6-2.** An eye icon button in the Versions header, left of All / Major, hides versions the Optimiser dropped. The hover says "Hide dropped versions"; while hiding, the eye is crossed out on a grey button and says "Show dropped versions". Off by default, remembered for the session (per project). It shows in the All view only.
- **R6-3.** On Mismatches nothing saves on its own. The Your answer header keeps its place and holds "Use the model's answer" (it only fills the chips) and Save. Save records keeping the label, the model's answer, or a third answer, so "Keep my label" and Reopen are gone. A reviewed item opens in place with its review filled in; Save is off until the chips or Why change ("Not saved" shows), and saving adds a review, updates the item where it is, and shows "N reviews" with the earlier ones on hover. On this tab "Next: Prompt Engineering" is grey, so Save is the one accent button.
- **Run end.** A run that finishes without a pass (or is stopped) keeps its panel, tagged Finished, until a version is picked (remembered for the session). Under the round line it says either "vX beat vY: a against b" or "No change beat vY. vY is still the best at b", with the detail on hover and a "Show vX" button. A run that passes still goes straight on to the training set.

## 0.x rows moved out on 2026-11-14

These rows described screens that 1.0.0 removed (Setup, Training Set, the approved card in Ask AI)
or features decided out of the MVP. Moved here from `docs/ui-gaps.md` (review of phases 1 and 2,
Minor 2).

| Where | Canvas | Code | Why |
| --- | --- | --- | --- |
| Training Set, Labeling settings | Prompt and Model | Prompt only (one model per project); changes the Optimiser dropped are not offered | One model per project |
| Ask AI, approved schema | The approved card | The approved card and the line "You approved the schema" | Both are records of the same act |
| Removed before the canvas (review 2026-11-09) | — | Prompt page: no diff preview, version selector or change note; Labeling models: no description, cost or speed per model | The canvas has none of them; to discuss if they are wanted back |
| Evaluation report, Compare, gold-label upload, prompt preview, fixed prompt images, placeholder autocomplete | On the canvas but marked not in the MVP | Removed from the code | Out of the MVP (decided 2026-11-06) |
