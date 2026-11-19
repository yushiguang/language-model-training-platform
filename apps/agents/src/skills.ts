import type {AgentPreset, AgentSkillName, AgentToolName, Msg} from '@yushiguang/sprint-contracts';
import {msg, PRESET_SKILLS} from '@yushiguang/sprint-domain';
import {PROMPT_SHAPE} from './presets.ts';

/**
 * Skills (#39, step 2): a written workflow a helper follows for a whole task. Each starts from a
 * brief (one read tool the runtime calls with the skill's arguments), adds its own instructions
 * and answer shape to the helper's, and may call only the tools it lists. Which helper may run
 * which skill is `PRESET_SKILLS` in `@yushiguang/sprint-domain`; the brief and the tools must be
 * that helper's tools too, so the tool host's guards hold for skills as for everything else.
 */
export interface Skill {
  name: AgentSkillName;
  /** When to use it, one line in the helper's list of skills. */
  when: string;
  /** Its arguments, as the helper is told. */
  args: string;
  /** The read tool the runtime calls first, with the skill's arguments. */
  brief: AgentToolName;
  /** Tools the skill may call after the brief. */
  tools: AgentToolName[];
  instructions: string;
  /** The answer shape. */
  shape: string;
  /** The live line while the brief is read. */
  working: (args: Record<string, unknown>) => Msg;
  /**
   * The answer is a draft of the brief's prompt (`brief.prompt`): wording only, with each change
   * and its reason, put on the editor of `brief.versionId`.
   */
  drafts?: boolean;
}

const version = (args: Record<string, unknown>) => (typeof args.version === 'string' && args.version ? args.version : null);

export const SKILLS: Record<AgentSkillName, Skill> = {
  improve_from_mistakes: {
    name: 'improve_from_mistakes',
    when: 'the user asks to improve a version or fix its mistakes (Improve with AI)',
    args: '{"version"?: a label like "v4" (default: the newest scored)}',
    brief: 'get_mistakes',
    tools: ['read_feature_info'],
    drafts: true,
    working: args => (version(args) ? msg('Reading the {version} mistakes…', {version: version(args)!}) : msg('Reading the mistakes…')),
    shape: `{"prompt": ${PROMPT_SHAPE}, "changes": [{"text": string, "reason": string}], "note"?: string}`,
    instructions: `"brief.prompt" is the version's structured prompt, and "brief.examples" holds a few of its wrong answers: the gold label, the model's answer, the features, and when there is one the model's own short "reason" for its answer. When the site could not read the model's reply, "invalid" says why (for example a value that is not in the labels). Read them to find what the prompt fails to say: the reason often shows which words the model leaned on, or which rule it misread. When people commented on an example, "comments" holds their words: it is their reading of what the label means, so build it into the prompt's rules and never argue with it.
- Change wording only here: definitions, rule groups, the task summary, and ticked features. Keep the label's key, its single or multi select and every value name exactly as they are; the site ignores any other change.
- Look for a pattern first: several mistakes with the same cause. Fix patterns before single cases.
- Write each fix as a general rule that would also be right for items you have not seen. When a value's own boundary is vague, too broad or missing an exclusion or exemption, refine that value's definition, keeping its list structure. When the mistakes come from the order of checks between two values that both match, or from how an input is read for every value, update or add the cross-value rule group. Never copy an example's text into the prompt, and never write a rule that only describes one example.
- Make a few targeted changes, not a rewrite. Keep what already works.
- You may tick or untick a feature when the mistakes point to it; read its description with read_feature_info first.
- Gold labels are the user's to judge, never yours. When an example's gold label looks odd against the value's own definition, write no rule to match it and work on the other mistakes; do not say which label is right or wrong.
- When the mistakes come from two values whose definitions overlap, sharpen those two definitions first, and say so in "note".
- The site writes the chat line ("I made 2 changes to v4…") from your changes. "note" is optional: one short line only when something needs saying beyond the changes, such as the overlap above or why nothing could be changed. Never repeat the reasons there.
- Give each change a one-line reason that cites the mistakes, for example "5 Complaints were read as Question", and cite examples by "externalId" where it helps. Each change's "text" quotes the words it adds, or the words it removes when it only removes, so the editor can put the reason on the right mark.`,
  },
  diagnose_score_change: {
    name: 'diagnose_score_change',
    when: 'the user asks why one version scored higher or lower than another',
    args: '{"a"?: the earlier version like "v4" (default: the parent of "b"), "b"?: the later version (default: the newest scored)}',
    brief: 'get_flips',
    tools: ['get_report'],
    working: () => msg('Comparing the answers of two versions…'),
    shape: '{"reply": string}',
    instructions: `"brief" holds both versions' scores (on the hidden part of the eval set), both structured prompts, and from the part helpers can read: the examples "b" fixed and the examples it broke, each with the gold label, both answers and the model's reasons.
- Say first how the score moved, per value where it moved most, from "brief.a.scores" and "brief.b.scores". Never calculate a score.
- Then find what in the prompt changed between "promptA" and "promptB", and tie it to the examples that flipped: quote the changed words and the reason the model gave. Cite examples by "id", at most three.
- When few examples flipped, or the scores rest on few examples, say the difference may be chance.
- Never say a gold label is wrong. Do not draft a prompt here; end with one line on what could fix the broken examples, and offer to draft it.`,
  },
  review_label_set: {
    name: 'review_label_set',
    when: 'the user asks whether the label\'s values are clear, overlap, or cover every item',
    args: '{}',
    brief: 'get_confusions',
    tools: [],
    working: () => msg('Reviewing the values…'),
    shape: '{"reply": string}',
    instructions: `"brief" holds the saved label with each value's definition, which values the scored versions read as which (counts summed over versions), and how many gold labels each value has. "prompt" is the prompt on the page, unsaved edits included: review its label, which may be newer than the saved one. Before the first prompt is approved, "brief.label" is null and nothing is scored: work from "prompt" alone. Nothing here costs anything; never start paid work in this skill.
- Find the pairs of values a real item could fit both of: from the definitions, and from mix-ups that come back in several versions. For each pair, quote the words that overlap and say what would tell them apart.
- On a single-select label, check there is a catch-all such as "Other" or "None" unless every item fits a named value; on a multi-select label, check the catch-all is marked to stand alone.
- Name values that are rare (too few gold labels to score fairly) or dominant.
- At most four findings, most important first. Do not draft a prompt here; offer to sharpen the definitions.`,
  },
  plan_labeling: {
    name: 'plan_labeling',
    when: 'the user asks which examples to label first, or how many more labels they need',
    args: '{}',
    brief: 'get_dataset_stats',
    tools: ['search_examples'],
    working: () => msg('Planning which examples to label…'),
    shape: '{"reply": string}',
    instructions: `"brief" is the label balance: gold labels per value and per half, which values are rare or dominant, and how many examples wait for a gold label. "prompt" holds each value's definition.
- Start with the rare values: for each, how many more gold labels it needs (at least 4 in all and 2 in each half).
- To find unlabeled examples worth labeling first, search for words from a rare value's definition with search_examples and "unlabeledOnly": true. List at most five item ids per value, as "examples that mention ...".
- Never say which value an example has or looks like: list them by what they mention, and leave the label to the user.
- When nothing is rare, say labeling the waiting examples in any order is fine and how many wait.`,
  },
};

/** A helper's skills, as its instructions list them; empty when it has none. */
export function skillBlurb(helper: AgentPreset): string {
  const names = PRESET_SKILLS[helper] ?? [];
  if (!names.length) return '';
  const list = names.map(n => `- ${n} ${SKILLS[n].args}: when ${SKILLS[n].when}`).join('\n');
  return `\nSkills are workflows for whole tasks. To run one, answer {"skill": {"name": string, "args": object}}; the skill reads what it needs and gives the answer. Your skills:\n${list}`;
}

/** Intents that run a skill directly (the page's button): Improve with AI. */
export const SKILL_INTENTS: Record<string, AgentSkillName> = {improve: 'improve_from_mistakes'};
