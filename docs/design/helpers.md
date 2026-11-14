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
| Prompt helper | `prompt_agent` | Drafts the structured prompt (label fields, values, definitions, rules, input features) from a description, imports a pasted prompt, revises and explains prompts |
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

## How it works (as built)

Agents never read the DOM. When the user sends a message, the assistant panel says where the user
is (path and URL parameters), and the bff builds that page's **page view** from the same saved data
the page shows (`apps/bff/src/services/page-views.ts`). The view goes with every turn, together
with the page's unsaved edits. To see more, an agent calls **read tools** (other pages, versions,
reports, examples, gold labels, predictions, prompt checks), like a coding agent reading files in
a repo: up to 4 calls per turn, each one logged, nothing changed. Changes stay proposals the user
approves on the page. All presets use the reasoning model. A question gets an answer and never a
proposal: the answer shapes make "prompt" optional, a reply with "question" (one
short question when the request is unclear) proposes nothing, and neither does a prompt equal to
the one on the page. Improve with AI reads the same wrong examples as the Optimiser.

**The structured prompt.** A helper's draft is a whole `StructuredPrompt` under the "prompt" key
(task summary, features, fields with values and definitions, general rules), read by
`readStructured`; helpers never write the compiled text. After the first approval the helper says
what comes next ("v1 is saved. Next, click ..."). When the user pastes an existing prompt (intent
`import_prompt`), the helper sorts it into the parts and returns every passage that has no place,
word for word, as `unmapped`; the page lists them under "Not carried over". Improve with AI and the
Optimiser may change wording only: the runtime keeps the field and value names of the version they
started from (`rewordOnly`), and a rule for one field goes into that field's tie-break rules.

**Images.** Wrong examples (`ExampleBrief.images`, up to 2 per example from the image features)
go to the helpers as image content parts after the text, for Improve with AI and the Optimiser. A relative sample URL is not resolved for the model; the stand-in data uses them,
real items carry absolute URLs.

**Document links.** Helpers read a document link the user pastes with the `read_doc` tool
(front desk, Prompt helper). The bff reads it through `Platform.documents`
(`DocumentSource`, `packages/contracts/src/platform-api.ts`); the text is cut at 20,000
characters. The public build's stand-in (`noDocuments`) opens nothing, so the helper says the
link can't be opened here and asks for the pasted text. The internal build plugs in the real
document service (docs/handover/integration.md, "Document links").

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
- `try_prompt`, Improve with AI (its mistakes, mix-ups and wrong examples come
  from `scoreOnOptimiserHalf`) and the Optimiser read the optimiser half only.
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

Three **start tools** spend money (`apps/bff/src/services/starts.ts`): `try_prompt` (prompt
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
- `compare_versions`: which parts of two structured prompts differ, and their scores per field;
- `get_mismatch_summary`: the Mismatches tab in counts (to review, wrong in every version,
  reviewed, accuracy per field, top mix-ups), never which side is right.

**The holdout lock.** The first tool call that returns examples (`get_examples`,
`get_gold_labels`, `get_predictions`, `search_examples`, `try_prompt`), Improve with AI and Auto
Optimise call `lockHoldout`: the halves are balanced one last time and then fixed for good, so an
example a helper has read never moves into the scored half.

**Comments.** People's comments on an example (Gold Labels, both tabs) go to the Optimiser and
Improve with AI as `ExampleBrief.comments`, for optimiser-half examples only. The instructions
say to build them into the prompt's rules and never argue with them.

**The runtime** is built once (`createAgentRuntime` in `apps/agents/src/index.ts`) with the
model, a factory for a project's tools and the progress port; each call is plain data.
