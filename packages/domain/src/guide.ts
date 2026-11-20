import {systemConfig} from './config.ts';

/**
 * The product guide the helpers read with `read_guide` (#39, A3): what the site's terms, pages and
 * buttons mean, in the pages' own words. English; the helpers answer in the user's language.
 * Facts that come from the configuration are read from it, so the guide never drifts from the site.
 */
export interface GuideTopic {
  title: string;
  /** Other words people use for it, for finding the topic. */
  aliases: string[];
  text: string;
}

export function productGuide(): Record<string, GuideTopic> {
  const {minEvalHard, minEvalRecommended, rareValueMinCount, rareValuePerHalfMin} = systemConfig().dataset;
  return {
    steps: {
      title: 'The four steps',
      aliases: ['workflow', 'next step', 'approve', 'step bar'],
      text: `A project goes through four steps, shown in the step bar: Prompt Design, Eval Dataset, Gold Labels and Prompt Tuning. Each step has an Approve button at the top right; it is unavailable until the step's condition is met, and the line under it says what is missing. Approving a step opens the next one. Earlier steps stay open for changes.`,
    },
    prompt_design: {
      title: 'Prompt Design',
      aliases: ['prompt', 'label', 'values', 'definitions', 'rule groups', 'features'],
      text: `Prompt Design holds the labeling prompt: a task summary, the ticked input features, one label (its key, single or multi select, and its values, each with a definition) and rule groups the user names. The site writes the input and output sections itself. Approve the first prompt to continue. Changing the label's values or its single or multi select changes the labels themselves: gold labels given before need checking again.`,
    },
    data_source: {
      title: 'Data Source',
      aliases: ['data sources', 'item ids', 'file of ids', 'sample data'],
      text: `Data Source lists the item-id files of the user's organization. A file is a CSV, JSONL or TXT file of item ids; blank, unreadable and repeated rows are counted and skipped. Each source keeps its items in one order, shuffled once when a file is added, and a dataset takes the next unused items, so two datasets never share an item. The sample data that ships with the site is a built-in source every organization has.`,
    },
    eval_dataset: {
      title: 'Eval Dataset',
      aliases: ['dataset', 'add examples', 'take examples', 'examples', 'feature missingness', 'missing features'],
      text: `Eval Dataset holds the examples the prompt is scored on. Add examples takes them from one or more data sources. Before an item's features are fetched, the site checks it: an item that no longer exists, whose creator is a minor, or that cannot be publicly recommended is left out, and items with no non-empty features are left out too; the "items left out" line counts them by reason. Feature missingness is recorded for the dataset and shown per feature so empty inputs are visible before tuning. The dataset needs at least ${minEvalHard} examples to continue; about ${minEvalRecommended} or more gold-labeled ones give a score worth reading. Examples can be removed with a reason and restored.`,
    },
    gold_labels: {
      title: 'Gold Labels',
      aliases: ['gold', 'labeling', 'upload labels', 'correct answer'],
      text: `Gold labels are the correct answers people give. They are the yardstick every prompt version is scored against, so only people judge them; the helpers never say which label is right. Label examples one by one on Gold Labels, or use Upload labels with a file of item ids and answers: rows for items not in the dataset are skipped, and answers that are not values of the label are refused with their row named. Label at least ${minEvalHard} examples, with at least 2 in each half, to continue.`,
    },
    halves: {
      title: 'The two halves of the eval set',
      aliases: ['held-out half', 'hidden half', 'optimiser half', 'holdout'],
      text: `The eval set is split in two halves. The helpers and the Optimiser learn only from the optimiser half; scores are measured on the held-out half, which no helper can read. A prompt tuned on the same examples it is graded on would look better than it really is. Halves are balanced by gold label until a helper or the Optimiser first reads examples; from then on every example keeps its half.`,
    },
    macro_f1: {
      title: 'Macro-F1 and the per-value scores',
      aliases: ['score', 'f1', 'macro f1', 'accuracy', 'precision', 'recall'],
      text: `Macro-F1 is the main score, from 0 to 1. It averages the F1 of each value, so every value counts the same: a rare value the model gets wrong pulls the score down as much as a common one. A value's F1 combines how often the model's choice of that value is right (precision) and how many of that value it finds (recall). Accuracy is the share of examples answered exactly right.`,
    },
    rough_reading: {
      title: 'A rough reading',
      aliases: ['rough', 'too few examples', 'not enough labels', 'rare value'],
      text: `A score from few gold-labeled examples moves a lot by chance. Below the project's minimum it is shown as a rough reading and gives no pass. A value is rare when it has fewer than ${rareValueMinCount} gold labels, or fewer than ${rareValuePerHalfMin} in a half: one miss moves Macro-F1 a lot, so add examples that show it.`,
    },
    pass_rule: {
      title: 'The pass rule',
      aliases: ['threshold', 'thresholds', 'pass', 'passes', 'invalid rate', 'project settings'],
      text: `The pass rule lives in Project Settings (the Settings button at the top): the scores a version must reach, such as Macro-F1, and the most invalid answers allowed. A version passes when its report meets every check. Project Settings also holds the labeling model; paid work does not start by itself before the settings are saved once.`,
    },
    invalid: {
      title: 'Invalid and filtered answers',
      aliases: ['invalid', 'filtered', 'safety filter', 'unreadable answer'],
      text: `An answer is invalid when the site cannot read it as a label, for example a value that is not in the label. An answer is filtered when the model's safety filter stopped it. Both are left out of the scores; a version with too many invalid answers fails the pass rule even with a good score.`,
    },
    versions: {
      title: 'Prompt versions',
      aliases: ['version', 'v1', 'v4.1', 'prompt tuning', 'save'],
      text: `Prompt Tuning lists every prompt version (v1, v2 and so on) with who made it, what changed and its scores. Saving a change makes a new version, which is scored by itself. Versions the Optimiser makes are numbered under the version it started from (v4.1, v4.2). Copy prompt takes a version's full prompt; Finish ends the project with it.`,
    },
    mismatches: {
      title: 'Mismatches',
      aliases: ['mismatch', 'disagree', 'review', 'wrong answers'],
      text: `The Mismatches tab on Gold Labels lists examples where a version's answer differs from the gold label. People review each one: keep the gold label, or change it when the gold label was wrong. Only people decide which side is right.`,
    },
    rebuild_scores: {
      title: 'Rebuild scores',
      aliases: ['rebuild', 'scores out of date', 'recalculate'],
      text: `When gold labels change after versions were scored, those scores are out of date. Rebuild scores on Prompt versions works them out again from the answers already saved; nothing is labeled again.`,
    },
    optimiser: {
      title: 'The Optimiser (Auto Optimise)',
      aliases: ['auto optimise', 'optimise', 'optimize', 'dry run', 'rounds'],
      text: `Auto Optimise runs the Optimiser: each round it writes one change to a version, aimed at that version's weakest value and largest mix-ups on the optimiser half. A dry run first tries the change on a few examples next to the version it came from; a change that does worse is dropped, one that does as well or better is scored on the eval set and kept. A pass is confirmed by labeling the held-out half a second time. A run ends when a version passes and is confirmed, after the rounds asked for, when it runs out of new ideas, or when the user presses Stop; Retry resumes a failed run.`,
    },
    improve_with_ai: {
      title: 'Improve with AI',
      aliases: ['improve', 'improve with ai', 'draft'],
      text: `Improve with AI asks the Prompt helper for a draft with a few changes, each with a reason taken from the version's mistakes on the optimiser half. The draft opens in the editor; nothing changes until the user saves it. Discard drops it.`,
    },
  };
}

/** One topic by name or alias, or null. */
export function findGuideTopic(ref: string): {name: string; topic: GuideTopic} | null {
  const norm = (s: string) => s.trim().toLowerCase().replace(/[_-]+/g, ' ');
  const q = norm(ref);
  if (!q) return null;
  const guide = productGuide();
  for (const [name, topic] of Object.entries(guide)) {
    if (norm(name) === q || norm(topic.title) === q || topic.aliases.some(a => norm(a) === q)) return {name, topic};
  }
  for (const [name, topic] of Object.entries(guide)) {
    if (norm(topic.title).includes(q) || topic.aliases.some(a => norm(a).includes(q) || q.includes(norm(a)))) return {name, topic};
  }
  return null;
}
