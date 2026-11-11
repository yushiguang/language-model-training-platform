# Code vs. Unified UI canvas: gaps to discuss

The platform is named **Sprint** (2026-11-09).

The web app (`apps/web`) was rebuilt on 2026-11-06 to look like the approved "Unified UI" page of
the UI canvas. The styles are a copy of the canvas styles (`apps/web/src/ui/kit.css`), and every
page was compared with its board in screenshots at 1920 × 1080. This list is everything that does
not match, or that the canvas does not decide, so it can be discussed after coding.

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
| R5-5 Many edits | A review applies to the list at once, so you keep going. The lists and the reports are worked out once, 1.5 s after the last edit, with "Scores updating" next to Compare with until then. Saved answers on the whole eval set are read once per page and reused |
| R5-6 Ties | A dry run that ties its parent (as many fields right, on different examples) goes on to the full labeling, with a grey "Tied" badge next to its score. It counts as a wasted round, and 2 ties in a row end the run |
| R5-7 Parent | Round 1 always changes the version you started from. Each round says "from vX" before its change, with why on hover (best on N examples of the optimiser half). The dry run's Now line says "against vX". The dialog says how later rounds pick |

## Still different from the canvas

| Where | Canvas | Code | Why |
| --- | --- | --- | --- |
| Prompt editor, the red space | A 12px gap between the words | The same red space drawn over the gap between the words, taking no room (margins of -6px) | The marks sit under the text box, so the text must keep its exact place for the caret. The space overlaps the letters on each side by a few pixels |
| Prompt editor, a change's reason | Shown on hover over the change | Shown on hover, matched to the change by its words (else by order when the counts match); a change with no match shows no reason | The helper names each change by its words, not by a position in the prompt |
| Gold Labels, feature rows | Title, Description, On-screen text, Speech, Creator, Hashtags, Posted, Country and language | The same, plus every other feature the example has; empty rows are left out | Labelers must be able to see every feature (review 2026-11-09) |
| Ask AI, a paid start line | "Prompt helper started scoring v4" | "Prompt helper started scoring v4 on gpt-5.6-terra" | The line names the model; with one model per project it could go |
| Improve with AI, Ask AI | "Improve v2" from the user, then the helper joins | "You asked the Prompt helper to improve v2", the one-line reply (U-H-Improve-Reply), then "Prompt helper put a draft on Edit prompt" | Started from the page's button, so there is no typed message |
| Optimiser, Paused | Not drawn | A run whose page closed shows "Paused" (grey) and Resume in the panel. A second tab on the same page watches a run that is still going (one run per project); if the first tab closed, it shows Paused and nothing resumes until Resume is pressed | Like a paused labeling run; accepted by Evelyn on 2026-11-10 |
| Optimiser, other round results | Running, Dropped after dry run, Failed the Checks, Failed, Stopped | Also "Same as an earlier version" for a change that repeats a version | Not drawn |
| Optimiser, a failed round's version | Not in the list | Not in the list until Retry goes on with it | As drawn; a version stopped by Stop shows a grey "Stopped" tag |
| Optimiser, the Now line's progress | Always a bar | A bar only while a labeling step runs (not while the agent writes a change) | There is nothing to count while it writes |
| Training Set, Labeling settings | Prompt and Model | Prompt only (one model per project); changes the Optimiser dropped are not offered | One model per project |
| Prompt editor, feature hover | Not drawn | A feature's description shows on hover with "Click to copy" | Feature descriptions come from the feature info source |
| Ask AI, approved schema | The approved card | The approved card and the line "You approved the schema" | Both are records of the same act |
| Ask AI, the staying helper | Until the page changes | Until the page changes or the page is reloaded (kept in this browser tab) | Not saved with the project |
| Step-Loading board | Spinner while the next step loads | Steps switch at once (the state is already loaded); the spinner shows only on the first load | Nothing to wait for |
| Prompt versions, Filtered | 1 on the board | Always 0 on the stand-ins (they have no safety filter); the real adapter reports it with `LlmCallError('filtered')` | Stand-ins |
| Removed before the canvas (review 2026-11-09) | — | Prompt page: no diff preview, version selector or change note; Labeling models: no description, cost or speed per model | The canvas has none of them; to discuss if they are wanted back |
| Step bar | Gold Labels "In progress" in the labeling board | Gold Labels is Finished once the eval set is labeled, In progress while it is partly labeled | Rule from the doc applied to the data |
| Evaluation report, Compare, gold-label upload, prompt preview, fixed prompt images, placeholder autocomplete | On the canvas but marked not in the MVP | Removed from the code | UI Design doc §10 |

## Behaviour without a place in the canvas

| What | Status |
| --- | --- |
| Automatic paid starts | Decided 2026-11-06: every task starts by itself, with no cost limit and no Approve card. The user stops a costly task with its Stop button |
| Choosing which models to use | One labeling model per project, chosen on Setup (decided 2026-11-09). Comparing models comes later |
| Reading document links | The helpers read a linked document with the `read_doc` tool. The public build's stand-in opens nothing, so the helper asks for the pasted text; the internal agent connects the real document service (docs/handover/integration.md) |
| Agent replies | The helpers read model names and version labels the way the pages show them. The page views hold no cost or time, and the helpers' rules say never to mention either (MVP review finding 16) |
| Gold Labels, a version with no answer for an example | The Model answer card says "No answer from this version for this example" (not drawn) |
| Gold Labels, no mismatches left | The Mismatches tab shows "No mismatches left" with the usual empty-state look (not drawn) |

## Tech changes

- Astryx (`@astryxdesign/*`), StyleX and ECharts are gone. The look is the canvas CSS, and the
  chart is SVG drawn like the canvas chart. This changes the 2026-10-26 decision to use Astryx.
- The font is Figtree from Google Fonts, as on the canvas. The internal platform may need it
  self-hosted.
