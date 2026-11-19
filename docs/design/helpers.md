# Helpers design: the agents in Ask AI

Status: built, as of 1.0.0 phase 2 (2026-11-13). The Labels helper is merged into the Prompt
helper; the diagnostic tools of spec 6.4 come in phase 3 (see the end).

A helper is a preset: instructions, the reasoning model, and a short list of tools for one job.
They are hand-written, with no agent framework (`apps/agents`). Code runs the workflow; helpers
explain and propose; the user approves on the page.

## The helpers

| Name in the UI | Preset | Job |
| --- | --- | --- |
| Assistant | `front_desk` | Answers questions about the current page and hands off to a specialist |
| Prompt helper | `prompt_agent` | Drafts the structured prompt (the label, its values and definitions, rule groups, input features) from a description, imports a pasted prompt, revises and explains prompts |
| Scores helper | `evaluation_agent` | Explains scores against the thresholds and recommends a next step |
| (not in chat) | `optimiser` | The reflection and merge step inside an Optimiser run |

## Rules every helper follows

- **Proposals only.** A helper never saves, never moves the workflow and never clicks. Its draft
  appears on the page that owns it (Prompt Design, or the prompt editor), and the user approves or
  discards it with the buttons at the top of that page. The chat shows no Approve card; the page's
  button gets a soft halo while a draft waits.
- **Numbers come from code.** Helpers read computed scores and counts; they never work them out.
- **Gold labels are judged by people only.** No helper says a gold label is right or wrong; odd
  labels go to the Mismatches tab, with counts only.
- **The held-out half is hidden.** No example, gold label or model answer from it reaches any
  helper; scores and counts built on it do.
- **Plain words.** No ML jargon, no cost and no time estimates in replies.
- **All user input goes through Ask AI**, as text or document links. Pages have no input cards.
- **The user's language.** Helpers answer in the language the site is shown in, using the site's
  own words for pages and buttons (one line added to the system prompt, built from the catalog's
  fixed terms). Prompt text, label and value names and version labels stay as written.
- **Problem reports (1.1.0).** When the user says something is wrong, or asks to report a problem,
  whichever helper answers asks what was expected and what happened, if it does not know, then
  calls `report_problem` without `send`, shows the draft in a few lines and asks whether to send
  it (and whether to include the prompt, when that matters). Only after the user's yes does it call
  `report_problem` with `send: true`; code refuses a send in the turn that drafted it. The reply
  gives the ticket id in one line. No helper invents a fix or promises a date.

## How it works (as built)

Agents never read the DOM. When the user sends a message, the assistant panel says where the user
is (path and URL parameters), and the workflow builds that page's **page view** from the same saved data
the page shows (`apps/workflow/src/services/page-views.ts`). The view goes with every turn, together
with the page's unsaved edits. To see more, an agent calls **read tools** (other pages, versions,
reports, examples, gold labels, predictions, prompt checks), like a coding agent reading files in
a repo: up to 4 calls per turn, each one logged, nothing changed. Changes stay proposals the user
approves on the page. All presets use the reasoning model. A question gets an answer and never a
proposal: the answer shapes make "prompt" optional, a reply with "question" (one
short question when the request is unclear) proposes nothing, and neither does a prompt equal to
the one on the page. Improve with AI reads the same wrong examples as the Optimiser.

**The structured prompt.** A helper's draft is a whole `StructuredPrompt` under the "prompt" key
(task summary, features, the label with its values and definitions, rule groups), read by
`readStructured`; helpers never write the compiled text. After the first approval the helper says
what comes next ("v1 is saved. Next, click ..."). When the user pastes an existing prompt (intent
`import_prompt`), the helper sorts it into the parts and returns every passage that has no place,
word for word, as `unmapped`; the page lists them under "Not carried over". Improve with AI and the
Optimiser may change wording only: the runtime keeps the label, its single or multi select and
bounds, the exclusive marks and the value names of the version they started from (`rewordOnly`).
The Prompt helper sets single or multi select from the task (one value per item when the values
exclude each other, several when an item can have more than one) and asks when it is unclear; on
a multi-select label it marks a catch-all such as "None" as exclusive. A criterion, exclusion or exemption for one value goes into that
value's definition (a one-line definition becomes a list); rules that compare values or apply to
all of them go into the user's rule groups, which keep their ids and titles. An import keeps each
rules section of the pasted prompt as its own group, under its heading, and moves a section named
after a value (for example "Strong criteria") into that value's definition. A long pasted prompt
is treated as an import whatever the intent (`importIntent` in `apps/agents/src/runtime.ts`). The
Prompt helper ticks a feature in both the video and the photo-and-text groups when both have it,
and suggests a catch-all value ("Other" or "None") when the values may not cover every item.
Improve with AI writes each change's reason in the site's language (the turn's `locale`).

**Images.** Wrong examples (`ExampleBrief.images`, up to 2 per example from the image features)
go to the helpers as image content parts after the text, for Improve with AI and the Optimiser. A relative sample URL is not resolved for the model; the stand-in data uses them,
real items carry absolute URLs.

**Document links.** Helpers read a document link the user pastes with the `read_doc` tool
(front desk, Prompt helper). The workflow reads it through `Platform.documents`
(`DocumentSource`, `packages/contracts/src/platform-api.ts`) as the person the helper answers
(the turn's request context); the text is cut at 20,000
characters. The public build's stand-in (`noDocuments`) opens nothing, so the helper says the
link can't be opened here and asks for the pasted text. A deployment plugs in the real
document service (docs/integration.md, "Document links").

**Broken replies.** When a helper's reply is not the JSON its preset asks for, the runtime asks
once more; on a second miss it shows plain prose as it is, or a short "please ask again" line when
the reply looks like broken JSON.

**The held-out half stays hidden from every helper** (review finding 3, decided 2026-11-11).
`visibleToAgents` in `packages/domain/src/gepa.ts` is the one rule, used wherever examples go to a
helper:
- the read tools (`get_examples`, `get_gold_labels`, `get_predictions`) leave held-out examples
  out and say so in a `note`; asking for one by id gives nothing;
- `get_report` and the report page view give mix-ups as counts only, since reports are scored on
  the held-out half;
- `try_prompt`, `get_mistakes` (Improve with AI's mistakes, mix-ups and wrong examples, from
  `scoreOnOptimiserHalf`), `get_flips` and the Optimiser read the optimiser half only.
Page views carry scores and counts only. Every preset's instructions (`common` and the
Optimiser's) say the held-out half is hidden and why, so a helper doesn't ask for it.

**The model's reason** (decided 2026-11-11). `apps/labeling` adds `REASON_LINE`
(`packages/domain/src/labels.ts`) as the last text part of every labeling prompt and of a try. It
is not part of the prompt text people see. `parseOutput` reads the "reason" key into `Prediction.reason` (at most
300 characters), also when the answer is invalid. `answersForHelpers` gives the Optimiser and
Improve with AI each wrong example with `reason` and `invalid`, and leaves filtered answers out.
Exports read `answer` only. Answers saved before this have no reason.

**The helpers' instructions** (rewritten 2026-11-11) are the shared rules in `common` plus one
text per helper in `apps/agents/src/presets.ts`. They say who does what (code runs the workflow,
helpers explain and propose, the user approves), what good labels and a good labeling prompt look
like, the Scores helper's six next steps, and what the Optimiser must avoid (rules that fit one
example, repeating a tried change). No helper judges a gold label. The report view carries
`scoredOn` and `confirmed` (the Optimiser's second labeling of the held-out half: true, false, or
null when there was none) for the Scores helper. The texts have not been tried on real models yet.

Three **start tools** spend money (`apps/workflow/src/services/starts.ts`): `try_prompt` (prompt
agent: up to 5 eval examples with an unsaved draft, nothing saved), `score_version` and
`start_optimiser` (prompt and evaluation agents). They run at once, like every automatic start;
the user stops them from the page.

**Reads added in 1.0.0** (spec 6.4, phase 3), for every preset:
- `get_project_summary`: the steps done, the settings, the eval dataset in numbers (examples,
  gold-labeled, pending, removed) and the best version;
- `get_dataset_stats`: the label balance per value and half, rare and dominant values (counts
  only, so the held-out half stays unread);
- `search_examples`: examples whose title or text features contain the words, from the readable
  half only, optionally only unlabeled ones;
- `compare_versions`: which parts of two structured prompts differ, and their scores per value;
- `get_mismatch_summary`: the Mismatches tab in counts (to review, wrong in every version,
  reviewed, accuracy, top mix-ups), never which side is right.

**Reads added for the agent abilities** (issue #39, step 1), in `apps/workflow/src/services/agent-reads.ts`:
- `get_gates` (every helper): each step approved or not, what its Approve button waits for, and
  the numbers behind it, gold labels per half included;
- `get_running_work` (every helper): labeling, Optimiser runs, taking examples and data source
  imports that run now, how far each is, and where its Stop button is;
- `get_upload_result` (every helper): the last label uploads (refused rows by row number and
  reason, never their item ids, since one could be held out), what the item checks left out, and
  what the data source files skipped;
- `get_optimiser_run` (Prompt and Scores helpers): one run round by round: where each change
  started and why, the value it aimed at (`OptimiserRound.aimedAt`), the dry run, the outcome
  and what it means, and why the run stopped;
- `get_drafts` (Prompt helper): its drafts, discarded ones too, with their changes and reasons,
  so it can answer for a draft the user dropped and does not offer it again;
- `read_guide` (every helper): the product guide (`packages/domain/src/guide.ts`): the site's
  terms, pages and buttons, by topic or by a word people use.

**Reads for the skills** (step 2), also in `agent-reads.ts`; `get_mistakes` and `get_flips` lock
the halves like every read of examples:
- `get_mistakes` (Prompt helper): a scored version's prompt, its Macro-F1, weakest value and top
  mix-ups (counts) and up to 8 wrong answers, all on the optimiser half, with the model's reasons
  and people's comments. It is what Improve with AI read before.
- `get_flips` (Prompt and Scores helpers): two scored versions' scores and prompts, and the
  examples of the optimiser half the later one fixed and broke (up to 6 each), with both answers.
- `get_confusions` (Prompt and Scores helpers): the label's definitions, the mix-ups summed over
  every scored version (counts only) and the gold labels per value.
The front desk also reads `get_dataset_stats` and `search_examples` now, for labeling plans.

**Skills** (step 2, `apps/agents/src/skills.ts`). A skill is a written workflow for a whole task.
Each starts from a brief, one read tool the runtime calls with the skill's arguments, then asks the
helper again with the skill's instructions and answer shape and only the skill's tools. The skill
sees what the helper sees (the page's prompt, the feature catalogue for the Prompt helper, the
recent chat, attachments) plus its brief; a drafting skill works on the brief's prompt. A helper
runs one by answering `{"skill": {"name": ..., "args": {...}}}`; which helper may run which is
`PRESET_SKILLS` in `packages/domain/src/agent-guards.ts`, and the brief and tools go through the
tool host, so its guards hold. A skill the helper does not have, or a brief that fails, goes back
to the helper as a `skill_result` with the error. The turn's output lists the skills that ran
(`AgentTurnOutput.skills`).
- `improve_from_mistakes` (Prompt helper): Improve with AI. Reads `get_mistakes` and drafts a few
  wording changes, each with its reason, on the version it read (`baseVersionId`). The button
  starts a Prompt helper turn with intent `improve` that runs the skill directly; asking in the
  chat runs the same skill, so both give the same draft. The site writes the chat line from the
  draft, so the two always agree: "I made 2 changes to v4. Hover each mark to see why.", "I
  changed v4; the changes are marked in the editor." when the model listed none, or "I have no
  new change for v4." when the prompt is unchanged (then no draft). The model's answer has no
  "reply"; an optional "note" follows the line. The draft stays open in the editor of the version
  it was written from (`editorDraft`, `packages/domain/src/drafts.ts`) until Save closes it as
  approved or Discard as discarded, so `get_drafts` can recall a discarded one; the editor of
  another version leaves it alone.
- `diagnose_score_change` (Prompt and Scores helpers): why one version scored differently from
  another, from `get_flips`: the values that moved, the changed words and the examples behind them.
- `review_label_set` (Prompt helper): which values overlap and whether a catch-all is missing,
  from `get_confusions` and the prompt on the page (unsaved edits included). On Prompt Design
  before the first approval there is no saved label: `get_confusions` says so and the skill works
  from the page's prompt. Never paid.
- `plan_labeling` (front desk): which examples to label first, from `get_dataset_stats`, rare
  values first, with unlabeled items found by `search_examples` and listed by what they mention.
`AgentRuntimeContract.draftImprovement` is gone; the workflow's `improveWithAi` starts the turn and
returns when it is accepted, like a chat message.

**Helpers never pick a gold label** (G2): every helper's instructions say never to tell the user
which value an example should get, whether it has a gold label yet or not; they explain what the
definitions say and leave the choice to the user.

**Ability cases** (`apps/agents/abilities/*.json`, format in its README) hold what users ask and
what a good answer does: the tools it must and must not call, the skills it runs, and a checklist
for the reply.
`npm test` checks they are well formed; `apps/agents/scripts/run-abilities.ts` runs them against
a real model and reports the score.

**The holdout lock.** The first tool call that returns examples (`get_examples`,
`get_gold_labels`, `get_predictions`, `search_examples`, `try_prompt`, `get_mistakes`,
`get_flips`) and Auto Optimise call `lockHoldout`: the halves are balanced one last time and then fixed for good, so an
example a helper has read never moves into the scored half.

**Comments.** People's comments on an example (Gold Labels, both tabs) go to the Optimiser and
Improve with AI as `ExampleBrief.comments`, for optimiser-half examples only. The instructions
say to build them into the prompt's rules and never argue with them.

**The runtime** is built once (`createAgentRuntime` in `apps/agents/src/index.ts`) with the
model, a factory for a project's tools and the progress port; each call is plain data.
