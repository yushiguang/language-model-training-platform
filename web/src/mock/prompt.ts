/**
 * The full teacher prompt at each version. Versions have two parts: changes bump the minor number, and
 * the user can ask for a major one. v1.0 is docs/demo/video-tagging-prompt-v1.md; v1.1, v1.2 and v1.3
 * apply the agent's advice cards adv-1, adv-2 and adv-3 in story/videoTags.ts. Keep them in step.
 */
const V1 = `You are a content analyst for a short-video platform. Watch the post and tag it.

## Input
- Title and description
- Frames sampled from the video (up to 8)
- OCR: text shown on screen
- ASR: transcript of the speech
- Creator nickname and bio
- Country and language

## Fields

### 1. primary_value (pick exactly one)
What the viewer mainly gets from the post.
- Entertainment: fun, emotion, beauty or story, enjoyed while watching. Nothing usable is left afterwards.
- Practical: something the viewer can act on, such as how to do something, what to buy, where to go, or what to avoid.
- Discussion: the poster shares their own view or experience and invites others to respond.
- Ecosystem issue: spam, misleading claims, engagement bait, undisclosed ads or adult content.

Check in this order: Ecosystem issue, Practical, Discussion, Entertainment. Use the first one that fits.

### 2. format (pick exactly one)
How the video is made.
- Vlog: the creator films their own day or experience.
- Tutorial: step-by-step instructions.
- Review: the creator tries and judges a product, place or service.
- Skit: scripted or acted scene.
- Clip: an excerpt of a show, interview, game or another creator's video.
- Other

### 3. topics (pick 1 to 3)
What the post is about.
Food & drink, Travel, Home & renting, Work & money, Tech, Beauty & fashion, Pets & animals, Sports & fitness, Entertainment news, Other

## Rules
1. Judge the poster's own contribution. Words spoken by guests in a clip are not the poster's view.
2. If the post sells something without saying it is an ad, primary_value is Ecosystem issue.
3. Use Other only when nothing else fits.

## Output
Return JSON only:
{
  "summary": "one sentence about what happens in the video",
  "reasoning": "why each field has its value, in two to four sentences",
  "primary_value": "Entertainment | Practical | Discussion | Ecosystem",
  "format": "...",
  "topics": ["..."]
}`;

const V2 = V1.replace('"primary_value": "Entertainment | Practical | Discussion | Ecosystem",', '"primary_value": "Entertainment | Practical | Discussion | Ecosystem issue",');

export const DISCUSSION = '- Discussion: the poster shares their own view or experience and invites others to respond.';
export const DISCUSSION_FIX = `${DISCUSSION}\n  First check rule 1: a Clip with no comment from the poster is not Discussion.`;
export const TOPICS = '### 3. topics (pick 1 to 3)';

export const DISCUSSION_STRICT = '- Discussion: only when the poster gives their own view on camera and invites others to respond.';
export const TOPICS_FIX = '### 3. topics (pick 1 to 3; pick 1 unless the post clearly covers more)';

// v1.2 and v1.3 both tag fewer topics; they differ in how they keep guests' views out of Discussion.
const V3A = V2.replace(DISCUSSION, DISCUSSION_STRICT).replace(TOPICS, TOPICS_FIX);
const V3B = V2.replace(DISCUSSION, DISCUSSION_FIX).replace(TOPICS, TOPICS_FIX);

export type PromptId = 'v1.0' | 'v1.1' | 'v1.2' | 'v1.3';

export const PROMPT_TEXT: Record<PromptId, string> = {'v1.0': V1, 'v1.1': V2, 'v1.2': V3A, 'v1.3': V3B};

/** The version each one was made from. v1.3 starts again from v1.1, the best before v1.2's drop. */
export const PROMPT_PARENT: Record<PromptId, PromptId | null> = {'v1.0': null, 'v1.1': 'v1.0', 'v1.2': 'v1.1', 'v1.3': 'v1.1'};
export const PROMPT_ORDER: PromptId[] = ['v1.0', 'v1.1', 'v1.2', 'v1.3'];

/** The next version after the newest one: a minor bump by default, or a major one when asked. */
export function nextVersion(existing: string[], isMajor: boolean): string {
  const parts = existing.map(v => v.slice(1).split('.').map(Number));
  const major = Math.max(...parts.map(p => p[0]));
  if (isMajor) return `v${major + 1}.0`;
  return `v${major}.${Math.max(...parts.filter(p => p[0] === major).map(p => p[1])) + 1}`;
}
