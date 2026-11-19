# Code vs. Unified UI canvas: gaps to discuss

The platform is named **Sprint** (2026-11-09).

The web app (`apps/web`) was rebuilt on 2026-11-06 to look like the approved "Unified UI" page of
the UI canvas. The styles are a copy of the canvas styles (`apps/web/src/ui/kit.css`), and every
page was compared with its board in screenshots at 1920 × 1080. This list is everything that still
does not match, or that the canvas does not decide. Items that were approved or done are deleted
from this list; git history keeps them.

## 1.0.0 screens, drawn from the build (2026-11-13)

Phase 2 of 1.0.0 was coded from the spec with the existing components and styles. On 2026-11-13
the canvas was updated from the built site: each of these screens is a board made from the page's
own markup and stylesheet, so board and code are the same. They still need a design review; the
last column lists what to decide. Boards for states the browser check does not reach (loading,
failed, stopped and similar) are the earlier drawings with the four-step bar.

| Screen | What was built | To decide |
| --- | --- | --- |
| Prompt Design | The structured prompt in four sections; "AI draft" badge, View full prompt, Discard and Approve in the header; a "Not carried over" card above the prompt after an import | Layout and order of the sections |
| Prompt editor | The same structured parts in place of the free-text editor | — |
| Change marks | A strip under each changed box: added words green, removed words struck through, the reason as hover text | The spec asks for marks inside the text; a plain text box cannot colour words, so they sit under it |
| View full prompt | A dialog with the compiled text, read-only, and Copy prompt | — |
| Project Settings | One dialog: pass rule (Default or Custom), the checks with a subtitle each and locked values for Default, the labeling model | — |
| Settings button | A ghost button in the top island, left of the avatar | Placement |
| Projects list, Delete | A trash button per row; the dialog asks for the exact name | — |
| Attention halo | Approve and Save ring twice in the brand colour while a helper's draft waits; Next: Eval Dataset does the same after Approve | — |
| AI Suggestion on Prompt Tuning | Six fixed headlines (too few gold labels, add examples, review mismatches, optimise, switch back from a dropped version, use as final prompt) | The "add examples" card appears with append in phase 3 |
| Dropped badge | Hover says why the version was dropped | — |
| Finish | The final card shows Copy prompt and Finish, then a Finished badge | — |

## 1.0.0 phases 3 and 4, built from the spec (2026-11-14)

Coded from the spec with the existing components and styles, before any board was drawn. The canvas
gets boards for them from the build, as for phase 2; they need a design review.

| Screen | What was built | To decide |
| --- | --- | --- |
| Eval Dataset | Examples card with Examples, Gold-labeled, Waiting for gold labels and Removed and a line per data source; Add examples as its own card beside it (#29); Remove unlabeled (keep N) in a dialog | Where the add actions sit |
| Eval Dataset, Label balance | Gold labels per value, sorted; rare values yellow, none red; the halves on hover over the count; Downsample on a value over 70% of 30 or more labels | — |
| Eval Dataset, Removed (N) | Item ID, why, gold label, when (who on hover), Restore per row and Restore all | — |
| Eval Dataset, banner | "Fewer than 20 examples: scores will be rough until you add more examples." | — |
| Gold Labels, filters | To label / Labeled on Eval set, To review / Reviewed on Mismatches, in the header | — |
| Gold Labels, Your answer | Save in the card header on both tabs, no autosave, no "Use the model's answer"; a "Saved" beat, then the next example | — |
| Gold Labels, Comment | Comments listed oldest first (who, when, the version on Mismatches), then "Add a comment"; replaces Why | — |
| Gold Labels, Remove example | A ghost button on the example card; a dialog with Broken or Out of scope | Placement |
| Prompt versions, score line | After "Scored on ...": "N gold-labeled examples removed" and "N new examples wait for gold labels", each with a hover | The line sits under the field table, inside the card's scroll area: on a 1080-pixel-high screen with three or more fields it is below the fold until you scroll the card. Move it above the table? |
| Ask AI, Send | Enter sends, Shift+Enter adds a line, never while an input method composes; the Send button's hover says so | — |

Motion (the 2026-11-12 motion audit, M1 to M6) lives in `app.css` only, not in the canvas kit:
the motion tokens, eased colours and a small press on controls, the step body settling in, the
slide between examples on Gold Labels, media fading in, Ask AI widening its slot as it opens and
closes, and dialogs, hints and banners coming in. Reduced motion turns all of it off. Static boards
cannot show it.

## 1.1.0, built from the spec (2026-11-14)

| Screen | What was built | To decide |
| --- | --- | --- |
| Avatar menu | A small menu under the avatar: the user's name, "Language", English and Chinese (current one ticked) | Whether account items join it later |
| Projects list | A Created by column between Project and Created | — |
| Project Settings | A Name field at the top of the dialog; Save renames | — |
| Ask AI, problem report | The helper's draft as a normal reply ending "Shall I send it?"; after a yes, the ticket id in the reply and an action line "You sent a problem report T-…" | — |
| Chinese pages | Every page, dialog, hover, badge and banner; action lines and the AI Suggestion card too | Wording review by a Chinese reader |

Known limits of the language switch:
- The static export is built in English, so a Chinese user sees English for the first paint.
- A switch re-renders the page in place: unsaved edits on that page (a prompt draft, an unsaved
  gold label) are dropped. The switch is rare and sits in a menu, so this was left as is.
- Not translated: the Optimiser's change notes and Improve with AI's change reasons (they describe
  prompt text), model names and descriptions, feature descriptions, and data.
- The stand-in helper (no model) understands English only; a real model reads either language.

## 2026-11-16 acceptance refinements, built from the spec

| Screen | What was built | To decide |
| --- | --- | --- |
| Prompt Design and Edit prompt | Persona & Task, Input Features, Output Labels & Definitions, Rule Groups, top to bottom; nothing ticked on a new project | — |
| Rule Groups | A card per group: a title box, the rules in a growing box, Move up / Move down / Remove; Add rule group below; against a base version, New and Changed badges, word marks under the title and the rules, and removed groups listed struck through | Whether to drag to reorder instead of the arrows |
| Field editor | The Tie-break rules box is gone | — |
| View full prompt | The compiled text in XML-style sections | — |
| Project Settings | Name, Evaluation and Labeling model, each set off by a line and space; Default / Custom switch beside the Evaluation heading; no intro line, no model description; the checks by name only, with no explanation line and no line between them | — |
| Model dropdown | The site's own list under the button (rounded, like the avatar menu), keyboard-driven | Use it for every dropdown added later |
| Avatar and project logo | Letters in bold (700) and a touch larger (14 px) | — |
| Sign-in | The usual spinner until the user is known; "We could not confirm who you are" with Retry when nobody is signed in; Sign out at the bottom of the avatar menu when the platform supports it | The sign-in error page is not on the canvas |

## 2026-11-16 single-label projects, built from the spec

| Screen | What was built | To decide |
| --- | --- | --- |
| Output Labels & Definitions | A Label name box, then one card per value: the value name, its definition in a growing box, Move up / Move down / Remove; Add value below; New and Changed badges and word marks against a base version, removed values struck through | Whether to drag to reorder instead of the arrows |
| Prompt Tuning version card | Macro-F1 of the label; a table per value (Value, F1, Precision, Recall, Examples) | — |
| Gold Labels | One model answer and one answer row per item; Compare with is the site's own dropdown | — |
| Dataset, Label balance | One list of values, no label-name pill | — |
| Ask AI | No page tag, no "Prompt helper answers" and no "Helpers read your recent messages"; Shift+Enter sends, Enter adds a line | — |

## 2026-11-16 workflow resilience and single or multi select, built from the spec

| Screen | What was built | To decide |
| --- | --- | --- |
| Output Labels & Definitions | Beside the Label name: a Single-select / Multi-select switch, and for multi "Choose [1] to [3]"; each value card gets "Only on its own" (with a hover) for multi; read-only shows a "Multi-select · choose 1 to 3" tag | Whether the switch belongs in Project Settings instead |
| Gold Labels | Multi select: chips toggle, "Choose 1 to 3" hint, chips lock when full, an exclusive value clears the others; an "Open item" link under the media (and in the empty tile) | — |
| Prompt Design (approved) | No Edit prompt button | — |
| Eval Dataset | "Saving the examples" at full progress with no Stop until the dataset is saved; "N could not be saved" (hover) on the dataset line | — |
| Prompt Tuning | Rebuild scores is greyed while scores are up to date; the AI Suggestion stays when they are out of date; "Rebuild scores first?" dialog; Optimiser rounds with no gain show a "No gain" tag | — |
| Failure banner | "{Action} failed. {why}"; Retry spins | — |

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
| Prompt editor, feature hover | Not drawn | A feature's description shows on hover with "Click to copy" | Feature descriptions come from the feature info source |
| Ask AI, the staying helper | Until the page changes | Until the page changes or the page is reloaded (kept in this browser tab) | Not saved with the project |
| Step-Loading board | Spinner while the next step loads | Steps switch at once (the state is already loaded); the spinner shows only on the first load | Nothing to wait for |
| Prompt versions, Filtered | 1 on the board | Always 0 on the stand-ins (they have no safety filter); the real adapter reports it with `LlmCallError('filtered')` | Stand-ins |
| Step bar | Gold Labels "In progress" in the labeling board | Gold Labels is Finished once the eval set is labeled, In progress while it is partly labeled | Rule from the doc applied to the data |

## Behaviour without a place in the canvas

| What | Status |
| --- | --- |
| Automatic paid starts | Decided 2026-11-06: every task starts by itself, with no cost limit and no Approve card. The user stops a costly task with its Stop button |
| Choosing which models to use | One labeling model per project, chosen in Project Settings (decided 2026-11-09). Comparing models comes later |
| Reading document links | The helpers read a linked document with the `read_doc` tool. The public build's stand-in opens nothing, so the helper asks for the pasted text; a deployment connects the real document service (docs/integration.md) |
| Agent replies | The helpers read model names and version labels the way the pages show them. The page views hold no cost or time, and the helpers' rules say never to mention either (MVP review finding 16) |
| Gold Labels, a version with no answer for an example | The Model answer card says "No answer from this version for this example" (not drawn) |
| Gold Labels, no mismatches left | The Mismatches tab shows "No mismatches left" with the usual empty-state look (not drawn) |

## Tech changes

- Astryx (`@astryxdesign/*`), StyleX and ECharts are gone. The look is the canvas CSS, and the
  chart is SVG drawn like the canvas chart. This changes the 2026-10-26 decision to use Astryx.
- The font is Figtree from Google Fonts, as on the canvas. The internal platform may need it
  self-hosted.
