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
- Prompt page, a version with no edits: Save as vN shows but is disabled.
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

## Still different from the canvas

| Where | Canvas | Code | Why |
| --- | --- | --- | --- |
| Gold Labels, feature rows | Title, Description, On-screen text, Speech, Creator, Hashtags, Posted, Country and language | The same, plus every other feature the example has; empty rows are left out | Labelers must be able to see every feature (review 2026-11-09) |
| Ask AI, a paid start line | "Prompt helper started scoring v4" | "Prompt helper started scoring v4 on gpt-5.6-terra" | Two models can be scored separately; the line says which |
| Ask AI, while the optimiser runs | A few lines | One "Workflow started scoring vN on <model>" line per automatic start, so a long optimiser run adds many lines | Every automatic start is recorded, as decided; grouping them needs a design |
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
| Choosing which models to use | Every model listed on Labeling models is used; there is no way to leave one out |
| Reading document links | Links show as chips in Ask AI; the agents' document reading tool is not built yet |
| Agent replies | The helpers now read model names and version labels the way the pages show them, and their tool notes use the pages' terms. The page view they read still holds cost estimates, so a reply can mention cost |

## Tech changes

- Astryx (`@astryxdesign/*`), StyleX and ECharts are gone. The look is the canvas CSS, and the
  chart is SVG drawn like the canvas chart. This changes the 2026-10-26 decision to use Astryx.
- The font is Figtree from Google Fonts, as on the canvas. The internal platform may need it
  self-hosted.
