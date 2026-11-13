# UI design: the Unified UI

Status: the design system below is current. The page list at the end is the 1.0.0 four-step
workflow as built on 2026-11-13; its new screens are coded from the 1.0.0 spec and are not drawn
on the canvas yet (see [../ui-gaps.md](../ui-gaps.md)).

The screens are drawn on the UI canvas "Sprint MVP — UI Screens", page "Unified UI", approved on
2026-11-06 and kept in step with the code since (the canvas is a design artifact outside this
repo; the project owner holds the link). The rule between the two: **the coded site looks exactly
like the canvas.** Change the design first, then the code. What cannot match is listed in
[../ui-gaps.md](../ui-gaps.md). The canvas stylesheet is copied to `apps/web/src/ui/kit.css`;
rules the canvas draws inline are in `apps/web/src/ui/app.css`.

## Shell

Every page has the same frame, so users learn it once. Screens are drawn at 1920 × 1080 with the
content 1280 wide and centred; the main action of a page shows without scrolling.

- **Top island.** A floating white pill at the top of a grey page, with no white strip behind it.
  Left: the Sprint mark and the project name (an avatar-style project logo). Middle: the workflow
  steps. Right: the "Stand-in services" tag while stand-ins run, and the user's avatar. A step is
  Not started (its number), In progress (while a task runs there), Finished (green tick), Needs
  attention (!) or the current page (ink). Finished steps stay clickable and editable. The island
  moves with the main panel when Ask AI opens.
- **Page header.** One structure everywhere: the title starts at the content's left edge, the back
  arrow sits in the margin to its left, and the page's actions sit on the right. The forward
  button ("Next: Gold Labels" and so on) is the main button in the header, never a row at the
  bottom. No line of explanation under the title.
- **Scrolling.** The island and the header stay fixed. Content scrolls under them and fades out,
  only while scrolled; there is never a hard line under the header.
- **Ask AI.** A pill at the bottom right of every page. Opening it shows a 400 px panel on the
  right and the page shifts left to make room.

## Look

Greyscale, with hierarchy from size, weight and grey level. One indigo brand colour
(`--brand: #4f46e5` and its tints) marks only what the user should do or read next: the main
button, the AI Suggestion card, Ask AI, and the running step. The current step and the selected
tab are ink (`--accent: #1b1b1b`). Green and red mean pass and fail only, and always come with a
word or an icon. `kit.css` is the source of truth for every value; the table below names the
tokens, not a second copy of the numbers.

| Tokens | Used for |
| --- | --- |
| `--bg-body`, `--bg-surface`, `--bg-card`, `--bg-muted` | Page background; cards, island and inputs |
| `--accent`, `--on-accent`, `--neutral`, `--hover`, `--pressed` | Current step, selected tab, bars and switches; secondary buttons and their states |
| `--text`, `--text-2`, `--text-3`, `--text-off` | Titles and values; descriptions; labels and captions; disabled |
| `--border`, `--border-strong`, `--track` | Card and table hairlines; input outlines; progress tracks |
| `--brand`, `--brand-hover`, `--brand-bg`, `--brand-tint`, `--brand-line`, `--brand-ink` | Main button, AI Suggestion card, Ask AI, in-progress marks |
| `--ok*`, `--err*`, `--warn*`, `--info*` | Pass, fail, warning and information: text, fill and ink |
| `--r-inner` 6, `--r-el` 10, `--r-card` 12, `--r-full` | Corners of chips, controls, cards and badges |
| `--shadow-low`, `--shadow-med` | Floating things only (the Ask AI pill, dialogs); cards have a hairline and no shadow |

| Text style | Size / line · weight | Example |
| --- | --- | --- |
| Page title | 24 / 32 · 600 | Prompt Tuning |
| Card title | 17 / 24 · 700 | Versions |
| Body | 14 / 20 · 400 | Use it to make the training and test sets |
| Label | 14 / 20 · 500 | Prompt |
| Caption | 12 / 20 · 400 | Macro-F1 |
| Number / big number | 28 / 36 · 600 · 44 / 52 · 600 | 55 · 0.71 |
| Field name | 13 / 20 · mono | primary\_value |

- **Type.** Figtree for all text, with tabular figures so columns line up. Sentence case
  everywhere, except the step names, user data (field names, values, model names) and the fixed
  label "AI Suggestion". No ALL CAPS and no full stops in titles, buttons or labels.
- **Dates.** Always "2026.11.06 10:42": year.month.day, 24-hour time, no seconds, never "2 hours
  ago".
- **Spacing.** 8 between related controls, 16 between cards in a grid, 24 inside a card and
  between page sections, 32 / 40 page padding.

## Words

- **Plain terms in the UI.** "Optimiser", "Score", "helper"; the precise term (GEPA, Macro-F1)
  goes in a hover or in these docs. "Score" keeps the real metric in small grey text next to it.
- **The default is no text.** A line appears only when the user needs it to act now. Everything
  else goes behind a hover, and hover text is marked with a dashed underline.
- **Never show estimated time or cost.** Progress is a bar, "9 of 55" and a start time.
- **Defaults go straight into the input boxes**, prefilled and editable. No "Use N" or Recommend
  buttons.

## Components and rules

Every screen is built only from the parts on the canvas's Components board and checked against
its Rules board.

| Text | Use it for | Never |
| --- | --- | --- |
| Page title | Every page; names the page or the object on it | A line under the title explaining the page |
| Card title | Every card; names its one job | A description line under the card title |
| Field label | Every input, above it; names the data | Helper text under the input |
| Hover detail | Definitions, rules, limits, why something is disabled; dashed underline | The same detail in a visible paragraph. From 1.0.0 the Project Settings default panel is the exception: each setting shows its explanation as a one-line subtitle, no hover |
| AI Suggestion text | One bold headline (what the agent found) and one grey line (what to do) | Agent explanations outside its card; a third line |
| Long text | Interface text (titles, labels, buttons, table cells): one line, cut with …, full text on hover. From 1.0.0, text the user wrote and reads to work (label definitions, rules, comments, chat messages) wraps in full | Wrapping interface text onto a second line; cutting a definition the user has to read |
| Empty state | One line saying what to do, plus the button that does it | Instructions, tips or lists of steps |
| Error | One line under the field, in the user's words | Pop-ups for field errors; codes or stack traces |
| Numbers | Counts and scores the user decides on; unit or total small at the bottom right | Estimated time or cost, anywhere |

| Component | Use it for | Never |
| --- | --- | --- |
| Card | One job: title on the left, its one action on the right, content below | Cards inside cards; two main actions in one card |
| Table in a card | Lists of same-shaped items: versions, fields, models | Tables for one or two values |
| Number | A value the user compares or acts on; in a row, split by hairlines | Numbers that need a paragraph to explain |
| Status badge | The state of one thing: Passed, Below, Running, Finished, Best, Approved | Categories or decoration |
| Banner | A problem that lowers quality, with the action that fixes it (white button); one per page | Tips, news or success messages |
| AI Suggestion card | Any helper output | Plain information the system computed |
| Main button (accent) | The one next step in an area | More than one per card; destructive actions |
| Grey / text button | Other actions / row actions in tables (small, 28 high) | The main next step |
| Tabs | Two or more views of the same object (eval set and mismatches, training and test set) | Steps of a workflow |
| Options / switch / segmented / chips | One choice of a few / one check on or off (grey when locked on) / two modes / picking labels | Dropdowns for two or three choices |
| Progress | A running task: bar, "9 of 55", start time, Stop | Time left or cost so far |
| Check row | Green tick, amber warning or red error, each with its one fix ("Fix") on the right | Fix buttons with other labels |
| Inputs | Defaults already in the box, label above | "Use N" or Recommend buttons |

**Alignment and size**

- **One left edge.** Every card keeps 24 px inside its edge; title, content and table cells start on that line.
- **One centre line.** A card title and its action share a centre line; controls in a row share one height (36, or 28 in tables).
- **Tables.** First column left-aligned and wider; number and status columns centred under centred headers; later columns share the width; header 40 high, rows 48.
- **One focus per card.** One big thing (a number, a chart or a table) and at most one main action.
- **Size to content.** A card is as wide as its content needs; short content means a narrower card, with related cards side by side.
- **Title with its text.** A title sits 8 px from its own text and far from the next group.
- **Space by weight.** Heavy parts (inputs, big numbers, charts) get more space; a card ending in inputs gets 32 below instead of 24.
- **One line of text.** Interface text never wraps in a product screen. From 1.0.0, user-written content (definitions, rules, comments) wraps instead of being cut.

## Ask AI and the AI Suggestion card

Ask AI is the only way users give the helpers anything, and the AI Suggestion card is the only
place helpers speak on a page. Who the helpers are and what they may do is in
[helpers.md](helpers.md).

**Ask AI panel**

- One conversation per project, the same on every page; 400 px on the right, and the page shifts
  left.
- Top: the title "Ask AI" with a close button, one grey line saying who answers on this page, and
  a context chip naming what the helper is reading ("Prompt Tuning · v4").
- Messages: the user's in grey bubbles on the right; a helper's as plain text with no bubble,
  signed with its name (Assistant, Prompt helper, Scores helper). Follow-up chips
  under the last message send a question in one click.
- Input: text and document links only; a pasted link shows as a chip. No files and no item IDs.
  The box grows to 6 lines, then scrolls. In 0.x Enter adds a new line and only the button sends;
  1.0.0 changes this to Enter sends and Shift+Enter adds a line, guarded for CJK input methods.
- **Live progress.** While a helper works, one grey line with a spinner says what it is doing;
  then the reply streams in.
- **Action lines.** Anything that changes a page, saves or spends gets one grey line with who did
  it, what, a View link and the time. The lines are saved with the chat. Read tools stay out of
  the chat (audit log only).

**AI Suggestion card states**

| Where | State | Looks like |
| --- | --- | --- |
| On a page | Has a suggestion | Accent frame and tint; a small "AI Suggestion" label, one bold headline and one grey line on the left, its actions on the right (for example Keep improving and Make training and test sets) |
| On a page | Agent is waiting for a task and has nothing to say yet | Hidden; the card comes back when there is a suggestion |
| In Ask AI (0.x only) | Waiting for approval, Approved | Removed in 1.0.0: the chat shows no Approve card. A draft is approved with the page's main button, which gets a soft halo while the draft waits; the chat keeps one record line ("You approved the prompt as v1") |

Nothing a helper proposes changes the page until the user approves it. In a chat card there is no
spark icon and no "AI Suggestion" label.

## States and motion

Running tags and steps spin; progress bars move with a soft shimmer. A button that starts work
shows a spinner and locks until the work ends. A failure shows a red banner with Retry and keeps
the user's edits. Changing step keeps the island and the header in place. The audit of where
these rules are not yet met, and the motion tokens proposed for the design system, are in
[the UI motion spec](../specs/2026-11-12-ui-motion-and-design-system-audit.md).

## Pages

| Step | Pages | Notes |
| --- | --- | --- |
| (Projects) | The list: Project, Created, Delete | Delete asks for the project's exact name |
| Prompt Design | The structured prompt (Output Labels & Definitions, Input Features, Task summary, General rules), a helper's draft with Approve and Discard, "Not carried over", View full prompt | Replaces Setup's Schema settings. Everything starts in Ask AI: describe the task or paste a prompt |
| Eval Dataset | Empty, sampling or loading, ready | No split: every example is used for scoring. Append, prune and the label balance card come in phase 3 |
| Gold Labels | Eval set, Mismatches | The Test set tab is gone. Filters, explicit Save and comments come in phase 3 |
| Prompt Tuning | Versions with scores, the fixed AI Suggestion card, the Optimiser panel; the prompt editor (same structured parts, change marks under each changed box) | Ends with Copy prompt and Finish |
| (dialog) | Project Settings: pass rule with its checks, labeling model | Opens from Settings in the top island, and once before the first paid run. Explanations are subtitles, not hovers |

Setup and Training Set are removed; batch labeling becomes its own project kind later.

Screen-by-screen descriptions are not kept in this repo: the canvas is the source for screens,
and [the 1.0.0 spec](../specs/2026-11-12-v1.0.0-workflow-and-ddd-spec.md) describes the new ones.
