# Code vs. Unified UI canvas: gaps to discuss

The platform is named **Sprint** (2026-11-09).

The web app (`apps/web`) was rebuilt on 2026-11-06 to look like the approved "Unified UI" page of
the UI canvas. The styles are a copy of the canvas styles (`apps/web/src/ui/kit.css`), and every
page was compared with its board in screenshots at 1920 × 1080. This list is everything that still
does not match, or that the canvas does not decide. Items that were approved or done between
2026-11-06 and 2026-11-12 (acceptance rounds 3 to 6, the MVP review) are in
[tmp/2026-11-ui-gaps-history.md](tmp/2026-11-ui-gaps-history.md).

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
| Evaluation report, Compare, gold-label upload, prompt preview, fixed prompt images, placeholder autocomplete | On the canvas but marked not in the MVP | Removed from the code | Out of the MVP (decided 2026-11-06) |

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
