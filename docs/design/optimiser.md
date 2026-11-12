# Optimiser design: Auto Optimise and Improve with AI

Status: built in 0.x (as of 2026-11-12). The 1.0.0 spec moves the loop into its own app
(`apps/optimiser`) and makes it edit structured prompts; see "What 1.0.0 changes" at the end.

The Optimiser improves a labeling prompt against the user's gold labels. It is GEPA (the
reflective prompt optimiser from the DSPy project), ported to TypeScript. In the UI it is only
ever called "Optimiser" and its button "Auto Optimise"; "GEPA" appears in design docs only.

## Why this design

- **Not a black box.** Every change the Optimiser tries is an ordinary prompt version with an
  ordinary report, the same things a user makes by hand. Users can watch a run, stop it, open any
  version and carry on from it.
- **Cheap screening.** A change is first labeled on a few examples (the dry run) and is paid for
  on the whole eval set only when it does better there.
- **A pool, not one "best so far".** A version that fixes a hard case can be a good parent even
  when its average is lower, so every version that is best on at least one example stays in play.
- **An honest score.** The eval set is split 50/50. The Optimiser learns from one half; the score
  users see, and pass or fail, come from the held-out half, which no helper ever reads. A pass is
  confirmed by labeling the held-out half a second time.
- **Rounds are the only budget.** The site never shows or limits cost or time. The user sets Max
  rounds (default 10) when starting and can press Stop at any time.
- **Started by the user.** Scoring a saved version starts by itself; the Optimiser never does.

## GEPA terms in Sprint

| GEPA term | In Sprint |
| --- | --- |
| Candidate | A prompt version (prompt text plus ticked features) |
| Rollout / metric call | One labeling call: one example labeled with one version |
| Pareto set | The optimiser half of the eval set, scored example by example |
| Feedback minibatch | The dry run: half of the optimiser half, at most 20 examples |
| Reflection | The Prompt helper reads the mistakes, their gold labels and the model's reasons, and writes one change |
| Merge | The Prompt helper combines two versions that win on different examples |
| Budget | Max rounds, set by the user when they start the run |

## What each change leaves behind

| Outcome | In the versions list | Report |
| --- | --- | --- |
| Did better in the dry run, then fully labeled | A normal minor version, tagged Optimiser | A full report, the same as a user's version |
| Tied the dry run on different examples | Labeled in full and kept in the pool | A full report; counts as a wasted round |
| Did worse in the dry run | A minor version with a Dropped tag in place of its score | A small report on the dry-run examples only |
| Failed the Checks or repeated an earlier change | Not a version (nothing was labeled) | One line in the run's history |

## How a run works (as built)

One run
improves the prompt on the project's one labeling model, for up to the user's Max rounds
(default 10). The pure parts are in `packages/domain/src/gepa.ts`; the loop is
`apps/bff/src/services/optimiser.ts`.

- **Versions.** A run reserves the next major number when it starts; every change it tries is the
  next minor of that major (v3.1, v3.2…). The editor's Save (the main button) makes the next minor
  of the version's own major; Save as vN makes the next major, written without ".0"
  (2026-11-10). The catalog assigns every number.
- **Change marks.** The editor diffs word by word (`diffWords` in `packages/domain/src/template.ts`)
  and gives each change a reason with `withReasons`: the helper's change that shares its words, or
  for an Optimiser version, the round's change line. The marks are drawn under the text box; the
  editor finds the mark under the pointer with `elementsFromPoint` to show the hover.
- **Start version.** A run starts from the version selected in the list (the page asks first when
  a better minor of the same major exists); an agent's start uses the best scored version.
- **Pool and parent.** The pool is the start version, the run's kept versions, and every other
  version with a current score on the model (2026-11-11), each scored per example on the optimiser
  half of the eval set (share of fields right). Round 1 always changes the start version (R5-7).
  Later parents are drawn from the Pareto front (versions best on at least one example and not
  dominated), weighted by how many examples each is best on; the round keeps that count
  (`parentWins`) so the panel can say why. After every 2 kept versions, two front versions that
  each win examples the other misses are merged instead.
- **A round.** The agent runtime writes one change from the parent's mix-ups and up to 8 of its
  wrong examples (`ExampleBrief`: gold, the model's answer, text features cut to about 300
  characters; optimiser half only, never the held-out half; a merge gets up to 4 examples each
  version wins). It may tick or untick a feature after reading feature descriptions with
  `read_feature_info` → the editor's Checks run (a failing or repeated change is dropped,
  unlabeled) → the change is saved and **dry-run** on half of the optimiser half, at most 20
  examples, picked at random (review finding 7), up to half of them from the examples that hold
  the parent's weakest value (in the gold label or the parent's answer) → it goes on only when it
  gets more fields right than the parent on them, the parent's weakest field counting double
  (`compareDryRun`, review finding 5), or ties it while being right on different examples (R5-6:
  `tied`, labeled in full and kept in the pool, but a wasted round; 2 ties in a row end the run) → it is labeled on the whole eval set (the dry run's
  answers are reused) and scored on the held-out half. `setOptimiserRandom` fixes the random picks
  in tests.
- **Confirming a pass** (decided 2026-11-10, review finding 6). A version that passes is not used
  yet: the held-out half is labeled a second time with the same version and settings (`pass: 2`
  in `ModelSettings`, so the answers are saved apart from the first labeling) and scored again
  (`confirmScore`). Only when both pass does the run end and the training and test sets start. A
  pass the second labeling does not confirm stays a kept version, shows "Not confirmed" in the
  Optimiser panel (`OptimiserRound.confirm`), and the run goes on.
- **Ends** when a version passes and the pass is confirmed (the Prompt step is approved and the training and test sets
  start with it, test examples without gold included), at Max rounds, after 3 wasted rounds in a
  row, on Stop, or when a step fails 3 times in a row: the run shows Failed with the step and the
  error, and nothing else starts until the user presses Retry, which goes on from that step. A
  run whose page closed shows Paused with Resume.
- **The record.** `OptimisationRun.history` holds every round (parent, change, outcome, dry-run
  counts, score); versions stay immutable, and the Versions list derives its Optimiser, Dropped
  and Running tags from it.

**The Optimiser's pool** (decided 2026-11-11) is the start version, the run's kept versions and
every other version with a current report on the model, so a parent or a merge side can be a
version the user wrote or an earlier run made.

## Improve with AI (semi-auto)

Improve with AI is the same reflection, one step at a time and under the user's hand. The Prompt
helper reads the selected version's mistakes on the optimiser half (the same wrong examples the
Optimiser reads) and opens the prompt editor with a draft. It may propose several changes at
once. Added text is marked green and removed text is a small red space; hovering a mark shows
what changed and the helper's reason. Nothing is labeled until the user saves, and the draft
never saves itself. A saved draft is the user's own version and is scored like any other
(`improveWithAi` in `apps/bff/src/services/agents.ts`).

## What 1.0.0 changes

From [the 1.0.0 spec](../specs/2026-11-12-v1.0.0-workflow-and-ddd-spec.md): the loop moves out of
the bff into `apps/optimiser` behind `OptimiserContract`; changes edit a structured prompt
(value definitions and general rules) instead of free template text; human comments on
optimiser-half examples replace the single "Why" note; the run no longer starts a training set
after a pass, because batch labeling becomes a separate project kind; the thresholds named above
move into `SystemConfig`.
