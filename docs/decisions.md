# Decisions

Product and design decisions behind the MVP, newest first. Each line says what was decided and,
where it matters, why. The code follows these; change a line here when a decision changes.

## 2026-11-11

- **Invalid and filtered answers are left out of scores** (acceptance R4-6). They are counted on
  their own next to the score. A version passes only when at most 1% of its answers are invalid
  (or the project's own limit). Why: an unreadable answer is a format problem, not a wrong label,
  and it must not pass a version on a technicality either.
- **"Score" stays as the label**, with the real metric in small grey text next to it (R4-1).
- **A mismatch review belongs to a gold label and a version** (Evelyn). "Compare with" is one
  picker for the whole Gold Labels page; To review and Reviewed are for the picked version. A
  review can be reopened; a changed label then goes back to what it was (R4-5).
- **The labeler can say why** on Mismatches (R4-4). The note goes to the Optimiser and Improve with
  AI as the person's own reading of the label, for optimiser-half examples only. The helpers build
  it into the prompt and never argue with it.
- **Max rounds is asked in the Auto Optimise dialog**, with the start version (R4-3).
- **No helper sees the held-out half of the eval set** (review finding 3). Not the Assistant, the
  Labels, Prompt or Scores helper, nor the Optimiser: no example, gold label or model answer from
  it. They may read scores and counts built on it. Users still see every example on the pages.
  Why: the held-out half scores every version, and a helper that read it could write prompts that
  fit those examples, so the score would no longer say how the prompt does on new data.
- **The Optimiser reads why the model answered as it did.** The site adds one line after every
  labeling prompt asking the model for a short "reason" (one sentence) before its values. The
  reason is kept with each answer and given to the Optimiser and Improve with AI with the wrong
  examples. It is never a label and never in the exported files. Why: GEPA works best when the
  optimiser sees the trace, not only the result and the score.
- **Invalid reasons go to the helpers too** ("Not valid JSON", a value that is not in the labels);
  answers the safety filter stopped are left out, since no prompt can fix them.
- **The Optimiser's pool is every scored version**, not only its own run: the start version, the
  run's kept versions, and any other version with a current score on the model. The user's own
  versions and earlier runs may hold rules the best version lacks.
- **Gold labels are judged by people only.** No helper says a gold label is right or wrong. A
  helper that meets a label that looks odd against its definition writes no rule for it and moves
  on; people review such labels on the Mismatches tab.
- **The helpers' instructions were rewritten** (`apps/agents/src/presets.ts`): each helper is told
  why its job matters, what good output looks like, and what it must not do. The user's job is
  business knowledge and gold labels; tuning prompts is the site's job.
- **A score from fewer than about 50 examples is called a rough reading** by the Scores helper.
- **The report helpers read says whether a pass was confirmed** (`confirmed`: true, false, or
  null when there was no second labeling). The Scores helper never recommends a version whose
  pass was not confirmed.

## 2026-11-10: MVP review

- **Real eval sets have 1,000 to 3,000 examples.** Small sets are for tests only, so the minimum
  eval size stays as it is. Two needs follow, not in the MVP: uploading gold labels, and labeling
  in a worker outside the browser tab.
- **A pass is confirmed before the training set starts.** The held-out half is labeled a second
  time with the same version and settings, and both labelings must pass. The test set is not
  used for this.
- **Mismatches on Gold Labels.** The user can see where a version's answers differ from their
  gold labels, keep their label or change it. This is part of making good gold labels, not
  prompt work: tuning prompts stays the Optimiser's job. The helpers point to it after the first
  score and when Auto Optimise ends without a pass, give counts only and never say which side is
  right. Every decision is recorded.
- **Gold Labels picks the version to compare with.** Default: the best scored version.
- **Document links.** The helpers read linked documents through a document interface; the
  internal build connects the real document service.
- **Merging.** The stacked pull requests are merged in order.

## 2026-11-09

- **One labeling model per project.** Comparing models comes later.
- **The Optimiser is GEPA**, ported to TypeScript: a dry run on a small batch, a pool of
  candidates, merges. Every round makes a visible version and report; the user starts it, sets
  the most rounds, and can stop it.
- **The platform is called Sprint.**

## 2026-11-06

- **Every paid task starts by itself**, with no cost limit and no Approve card: the cost can't be
  predicted and the goal is speed. Every task has a Stop button.
- **All user input goes through Ask AI** (text or document links); pages have no input cards.
  Internal video is not a supported input type in the MVP.
- **The coded site must look exactly like the canvas.** What can't match is recorded in
  docs/ui-gaps.md and discussed after coding.
- **Test set threshold** for the MVP: 5 examples.

## 2026-11-05

- **Never show estimated time or cost to users.**
- **Defaults go straight into the input boxes**, prefilled and editable; no "Use N" buttons.

## 2026-11-04

- **Hover text has a dashed underline**; explanatory text is one short line, details on hover.
- **Two browsers labeling the same version can pay twice.** Accepted for the MVP.
- **Rate limits** (QPM, TPM) are enforced in llm-gateway per endpoint; chat and labeling use
  separate endpoints; reasoning tokens count in TPM.
- **Agents are hand-written, no framework**, all on the reasoning model. They read a page view
  built by the backend and read tools only; changes are proposals the user approves.
- **Outputs** are a labeled training set and a test set (test gold labels optional).
- **Images** go inline as content parts; labels are never sent to the labeling model.

## 2026-10-29

- **The MVP is training-set production only**, as a website with the agent built in (not an
  agent chat), with a fixed workflow and gates. Gold labels may be skipped.
- **UI terms are plain** (for example "Optimiser", "Score"); precise terms go in hovers and
  design docs.
