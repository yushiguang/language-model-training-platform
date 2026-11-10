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
| Prompt editor | Save as vN.M (the next minor) and Save as new version (the next major). A helper's draft shows "Draft from Prompt helper" and the lines it added in green |
| Gold Labels (R2-2) | The model answer starts hidden on every example; Show reveals it for that example only, and the label records that it was seen |
| Ask AI (R2-5) | The newest start line of work that is still running spins (scoring and the Optimiser, test answers, the training set) |

## Still different from the canvas

| Where | Canvas | Code | Why |
| --- | --- | --- | --- |
| Gold Labels, feature rows | Title, Description, On-screen text, Speech, Creator, Hashtags, Posted, Country and language | The same, plus every other feature the example has; empty rows are left out | Labelers must be able to see every feature (review 2026-11-09) |
| Ask AI, a paid start line | "Prompt helper started scoring v4" | "Prompt helper started scoring v4 on gpt-5.6-terra" | The line names the model; with one model per project it could go |
| Prompt editor, change marks | Added text green; removed text is a small red space, and hovering it shows what was removed (and the reason, for a helper's or the Optimiser's change). Marks show for a helper's draft, for your own unsaved edits, and on an Optimiser version against its parent (redrawn 2026-11-10) | Added lines green for a helper's draft only; removed text is not shown, and reasons are in the Prompt helper's message in Ask AI | Not coded yet (waits for the go). The marks must sit above the text box so they can be hovered |
| Prompt editor, Save buttons | Save (main, the next minor of the opened version, its number on hover) and Save as vN (the next major, written as "v3", not "v3.0"); with no edits, both are off and there is no Discard (2026-11-10) | Save as vN.M (main) and Save as new version | Not coded yet (waits for the go) |
| Improve with AI, Ask AI | "Improve v2" from the user, then the helper joins | "You asked the Prompt helper to improve v2", the helper's message with each change and its reason, then "Prompt helper put a draft on Edit prompt" | Started from the page's button, so there is no typed message |
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
| Reading document links | Links show as chips in Ask AI; the agents' document reading tool is not built yet |
| Agent replies | The helpers now read model names and version labels the way the pages show them, and their tool notes use the pages' terms. The page view they read still holds cost estimates, so a reply can mention cost |

## Tech changes

- Astryx (`@astryxdesign/*`), StyleX and ECharts are gone. The look is the canvas CSS, and the
  chart is SVG drawn like the canvas chart. This changes the 2026-10-26 decision to use Astryx.
- The font is Figtree from Google Fonts, as on the canvas. The internal platform may need it
  self-hosted.
