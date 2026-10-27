/**
 * The full teacher prompt at each version. v1 is docs/demo/video-tagging-prompt-v1.md; v2 and v3 apply
 * the agent's two advice cards (adv-1, adv-2 in story/videoTags.ts), so keep the three in step.
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

const V2 = V1.replace(
  '"primary_value": "Entertainment | Practical | Discussion | Ecosystem",',
  '"primary_value": "Entertainment | Practical | Discussion | Ecosystem issue",',
);

const V3 = V2.replace(
  '- Discussion: the poster shares their own view or experience and invites others to respond.',
  '- Discussion: the poster shares their own view or experience and invites others to respond.\n  First check rule 1: a Clip with no comment from the poster is not Discussion.',
).replace('### 3. topics (pick 1 to 3)', '### 3. topics (pick 1 to 3; pick 1 unless the post clearly covers more)');

export const PROMPT_TEXT = {v1: V1, v2: V2, v3: V3} as const;
