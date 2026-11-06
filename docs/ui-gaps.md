# Code vs. Unified UI canvas: gaps to discuss

The web app (`apps/web`) was rebuilt on 2026-11-06 to look like the approved "Unified UI" page of
the UI canvas. The styles are a copy of the canvas styles (`apps/web/src/ui/kit.css`), and every
page was compared with its board in screenshots at 1920 × 1080. This list is everything that does
not match, or that the canvas does not decide, so it can be discussed after coding.

## Not drawn on the canvas, so the code chose

| Where | What the code does | Why |
| --- | --- | --- |
| Projects page (`/`) | Built from the same parts: step-bar strip with only the brand, title "Projects", a "New project" card (name box, Create project) and a table of projects with their current step and created date | The canvas has no projects page |
| Schema settings, editing a saved schema | An "Unsaved changes" tag, Discard and Save appear in the header after an edit (the same pattern as the prompt page) | The canvas draws only the empty, draft and approved states |
| Evaluation settings | The Checks card shows only when Custom is chosen | The canvas draws Custom only; with Default or None the checks have nothing to set |
| Gold Labels, model answer hidden | Hide turns into Show, and the card keeps only its title | The canvas draws the shown state only |
| Gold Labels, saving | An answer saves as soon as every field has a value; the arrows move between examples | The canvas has a Saved tag but no Save button |
| Gold Labels, no model answer yet | One grey line: "No model answer yet. It appears once a prompt version has labeled this example." | Not drawn |
| First prompt | No back arrow | It only shows when there is no version yet, so "Prompt versions" would be empty |
| First prompt, empty editor | Placeholder "Paste your prompt, or ask AI to draft one" | Not drawn |
| Prompt page, View prompt | The same page read-only, with Edit prompt in the header | The canvas links View prompt to an old board |
| Prompt page, a version with no edits | Save as vN shows but is disabled; no tag, no Discard | The canvas draws the edited state only |
| Checks, which fix the Fix button runs | The first fix of the error: Replace for a typo, Tick for a placeholder that isn't ticked, Insert for a ticked feature missing from the template | One Fix per error in the design; Untick is no longer offered |
| Checks, other warnings | Not shown: "image features make up most of the cost" and "value X isn't named in the prompt" | The canvas draws only the one-type warning, and cost is never shown |
| Prompt versions, which version is selected | The newest | The canvas selects v4 (the best) in one board and v13 (the newest) in another |
| Prompt versions, a version not scored yet or stopped | The card shows "Prompt vN", Created, Edit prompt and View prompt, a grey line saying why there is no score, and Score or Resume | Not drawn |
| Prompt versions, with evaluation off | No chart and no scores; the suggestion is "Make the training and test sets with vN" | Not drawn |
| Prompt versions, suggestion when nothing passes | "No version passes yet", the best version's reason, Keep improving | The canvas draws only the passing cases |
| Prompt versions, suggestion before gold labels | "Label the eval set to start scoring" with Go to Gold Labels | Not drawn |
| Training Set, a run stopped or paused | The Labeling card with a Stopped (or Failed) tag and Resume | Not drawn |
| Training Set, Add examples | Opens Dataset | Dataset can't add examples to an existing dataset in the MVP, so this needs a decision |
| Ask AI, events | Lines like "Evaluation agent joined" show as small grey text | Not drawn |
| Ask AI, open state | Stays open when moving between Prompt Engineering pages | Not drawn |

## Drawn, but the code differs

| Where | Canvas | Code | Why |
| --- | --- | --- | --- |
| Prompt versions, the big score | The sample numbers mix two meanings (v4 shows 0.85, the average of its fields; v7 shows 0.71, its lowest field) | Always the lowest field's Macro-F1, so the big number, the chart and the list agree with the pass rule ("every field must reach 0.80") | Needs a decision if the average is wanted |
| Gold Labels, example media | Item ID and length ("7340015838 · 0:48") | Item ID only | The examples have no length feature |
| Gold Labels, example media | A dark tile with a video icon | The same tile; frames and images aren't shown | Matches the canvas; showing the real frames would need a decision |
| Gold Labels, feature rows | Title, Description, On-screen text, Speech, Creator, Hashtags, Posted, Country and language | The same, plus Place, Interest and Summary when an example has them; empty rows are left out | |
| Step bar | Gold Labels "In progress" in the labeling board | Gold Labels is Finished once the eval set is labeled, In progress while it is partly labeled | Rule from the doc applied to the data |
| Training Set, Labeling settings | "v4 · 0.85 · passed" | The same format; a version with no score shows only "vN" | |
| Evaluation report, Compare, gold-label upload, prompt preview, fixed prompt images, placeholder autocomplete | On the canvas but marked not in the MVP | Removed from the code | UI Design doc §10 |

## Behaviour without a place in the canvas

| What | Status |
| --- | --- |
| Automatic paid starts | Decided 2026-11-06: every task starts by itself, with no cost limit and no Approve card. The user stops a costly task with its Stop button. The switch, the $1 and $5 caps and the 120% pause are removed |
| Choosing which models to use | Every model listed on Labeling models is used; there is no way to leave one out |
| Reading Lark Doc links | Links show as chips in Ask AI; the agents' Lark Doc reading tool is not built yet |
| Agent replies | The agents still name models "Model A" / "Model B" in their own text, and the page view they read still holds cost estimates, so a reply can mention cost |

## Tech changes

- Astryx (`@astryxdesign/*`), StyleX and ECharts are gone. The look is the canvas CSS, and the
  chart is SVG drawn like the canvas chart. This changes the 2026-10-26 decision to use Astryx.
- The font is Figtree from Google Fonts, as on the canvas. The internal platform may need it
  self-hosted.
