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
| Ask AI, events | Small grey lines such as "Evaluation agent joined" (drawn) |

These code choices are approved but not drawn, because they are small or follow an existing pattern:

- Evaluation settings: the Checks card shows only when Custom is chosen.
- Gold Labels: an answer saves as soon as every field has a value.
- First prompt: the empty editor says "Paste your prompt, or ask AI to draft one".
- Prompt page, a version with no edits: Save as vN shows but is disabled.
- Checks: Fix runs the first fix of the error (Replace, Tick or Insert); other warnings are not shown.
- Prompt versions: the newest version is selected; with evaluation off there is no chart and the
  suggestion is "Make the training and test sets with vN"; when nothing passes it says "No version
  passes yet"; before gold labels it says "Label the eval set to start scoring".
- Ask AI stays open when moving between Prompt Engineering pages.

## Still different from the canvas

| Where | Canvas | Code | Why |
| --- | --- | --- | --- |
| Gold Labels, feature rows | Title, Description, On-screen text, Speech, Creator, Hashtags, Posted, Country and language | The same, plus Place, Interest and Summary when an example has them; empty rows are left out | The rows come from the example's features |
| Gold Labels, example media | A dark tile with a video icon | The same tile. The media interface is drafted (`MediaSource`, see `docs/handover/integration.md`, "Media") but the page does not show frames or video | Showing media needs a design once the real video interface exists |
| Step bar | Gold Labels "In progress" in the labeling board | Gold Labels is Finished once the eval set is labeled, In progress while it is partly labeled | Rule from the doc applied to the data |
| Evaluation report, Compare, gold-label upload, prompt preview, fixed prompt images, placeholder autocomplete | On the canvas but marked not in the MVP | Removed from the code | UI Design doc §10 |

## Behaviour without a place in the canvas

| What | Status |
| --- | --- |
| Automatic paid starts | Decided 2026-11-06: every task starts by itself, with no cost limit and no Approve card. The user stops a costly task with its Stop button |
| Choosing which models to use | Every model listed on Labeling models is used; there is no way to leave one out |
| Reading Lark Doc links | Links show as chips in Ask AI; the agents' Lark Doc reading tool is not built yet |
| Agent replies | The agents still name models "Model A" / "Model B" in their own text, and the page view they read still holds cost estimates, so a reply can mention cost |

## Tech changes

- Astryx (`@astryxdesign/*`), StyleX and ECharts are gone. The look is the canvas CSS, and the
  chart is SVG drawn like the canvas chart. This changes the 2026-10-26 decision to use Astryx.
- The font is Figtree from Google Fonts, as on the canvas. The internal platform may need it
  self-hosted.
