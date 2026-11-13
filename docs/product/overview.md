# Product overview

Sprint is a platform where product and operations people produce a task model quickly: a strong
"teacher" model labels data with a carefully tuned prompt, and a small "student" model is trained
on those labels. The name says the goal: sprint from a business need to a model.

This doc says what the product is for and how its parts divide the work. It replaces the earlier
product design docs (2026-10-26 and 2026-10-29), which described plans the build has since left
behind. Rules that were decided along the way are in [../decisions.md](../decisions.md), newest
first.

## Who it is for

Users know their business well and are usually not machine-learning experts. They should give
two things only: what the labels mean, and high-quality gold labels. Tuning prompts, scoring and
running models is the platform's job. The long-term aim is fully automatic training from those
two inputs.

## What sets it apart

1. **Prompt tuning done by the platform.** Users used to tune labeling prompts on their own
   machines with a local agent. Sprint runs an optimiser against a shared, versioned eval set,
   and every step it takes is visible as an ordinary prompt version with an ordinary report.
2. **Evaluation people can trust and act on.** Code computes the scores; a helper explains them
   and recommends one next step; a person decides. The scores come from examples no helper has
   read.

## How the work is divided

| Who | Does | Never does |
| --- | --- | --- |
| Code | Runs the workflow: order, gates, thresholds, versions, scores, what starts by itself | Makes judgment calls |
| Helpers (agents in Ask AI) | Judgment inside a step: draft labels, write and improve prompts, explain scores | Save, approve, move the workflow, judge a gold label, read the held-out half |
| People | Business knowledge, gold labels, approvals | Tune prompts by hand unless they want to |

It is a website with a fixed workflow and helpers built into each page, not an agent chat. The
reasoning is in [design-principles.md](design-principles.md).

## Versions

| Version | Scope | Status |
| --- | --- | --- |
| 0.x (the MVP line) | Training-set production in one browser tab, on stand-in services or the internal platform's adapters. Workflow: Setup, Dataset, Gold Labels, Prompt Engineering, Training Set | Built; replaced by 1.0.0 |
| 1.0.0 | Prompt Tuning project: Prompt Design, Eval Dataset, Gold Labels, Prompt Tuning. Structured prompts, dataset governance, service contracts ready for RPC | Specified in [../specs/](../specs/). Phases 1 and 2 of 4 are built (contracts, structured prompts and the four steps) and described by [../architecture.md](../architecture.md); dataset governance, comments and motion are not built yet |
| Later | Batch Labeling project (large-scale labeling with a tuned prompt), then student training, evaluation, release and monitoring | Contracts for batch labeling are designed in 1.0.0; the rest is not designed here |

### Why 1.0.0 changes the workflow

Using 0.x showed four problems, and the 1.0.0 spec answers each:

- Asking for an abstract label schema before the user had written down their idea or seen data
  was backwards. Labels and prompt now start together in **Prompt Design**.
- A small prompt-tuning dataset and a very large production dataset are different jobs. Tying
  them together with an eval/test/train split caused mistakes. They become two project kinds.
- A rare label value with one or two examples drags the headline score down and starves the
  optimiser. The **Eval Dataset** page shows label balance and lets users add or prune examples.
- The backend will be split into services that talk over strict interfaces, so business logic
  is separated from transport and storage now.

## Ideas that hold across versions

- **Evaluation context.** A score is comparable only with scores from the same label
  definitions, eval examples, gold labels, checks and model settings. When something that can
  move a score changes, older reports are archived, and scores are rebuilt from saved answers
  when the user asks.
- **The eval set has two halves.** The optimiser and the helpers learn from one half. The score
  users see comes from the other, which stays hidden from every helper.
- **Macro-F1 per field is the main score** (shown as "Score"), with a default pass mark of 0.80.
  Invalid answers are counted apart and capped at 1%. Small eval sets give a rough reading only;
  real ones hold 1,000 to 3,000 examples.
- **Versions are never overwritten.** Prompt versions are numbered major.minor; an optimiser run
  takes one major number and its changes are the minors.
- **Paid work starts by itself, and can always be stopped.** The site never shows estimated time
  or cost. The optimiser is the exception: the user starts it and sets its rounds.
- **One labeling model per project.** Comparing models comes later.
- **Prompts are built from example features.** An example is a video or a photo-and-text post,
  and the prompt says which of its features the model sees. Images go to the model as images.

## Words

The UI uses plain words; design docs may use the precise ones.

| In the UI | Precise term |
| --- | --- |
| Optimiser, Auto Optimise | GEPA (reflective prompt optimisation) |
| Score | Macro-F1 of a field; the big number is the lowest field's |
| Helper (Assistant, Prompt helper, Scores helper) | Agent preset |
| Gold label | Human ground-truth label |
| Dry run | GEPA feedback minibatch |
| Labeling model | Teacher model |
| Eval set | Evaluation dataset, split into an optimiser half and a held-out half |
