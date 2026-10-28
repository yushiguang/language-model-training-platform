# Demo teacher prompt: short-video tagging (v1)

A simplified, made-up prompt for the frontend demo. It replaces the pilot prompt on screen so the demo can show **several label fields**, including a multi-select one. Prompt v1 below is what the PM pastes in at the start of the story. It contains two deliberate flaws for the agent to find later; they are listed at the end and are not part of the prompt.

## Prompt v1

```text
You are a content analyst for a short-video platform. Watch the post and tag it.

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
}
```

## Schema the agent derives from it

| Field | Type | Values | Student learns it |
|---|---|---|---|
| `primary_value` | single-select | Entertainment, Practical, Discussion, Ecosystem issue | yes |
| `format` | single-select | Vlog, Tutorial, Review, Skit, Clip, Other | yes |
| `topics` | multi-select, 1 to 3 | 10 topics | yes |
| `summary` | text | | no, teacher only |
| `reasoning` | text | | no, teacher only |

How each field is scored in the demo: macro-F1 for the two single-select fields, and per-topic F1 plus exact-set match for `topics`.

## Deliberate flaws (for the agent's advice, not shown as part of the prompt)

1. **Value mismatch.** The output section says `Ecosystem`, but the field defines `Ecosystem issue`. The teacher copies the output line and about 4% of outputs fail validation. Advice 1 fixes the output line to list the exact values. This mirrors the pilot prompt's "娱乐Entertainment" problem.
2. **Rule 1 is too far from the field it governs.** The teacher tags clips of interviews as Discussion because the guests give views, so Discussion precision is low. Advice 2 moves the check into the judgment order: "Before Discussion, check that the poster added their own view; a Clip with no added comment is not Discussion." It also adds a counterexample.

A third, smaller story the agent can tell for the multi-select field: the teacher over-tags (`topics` has 3 values when 1 fits), so precision on topics is low. The advice is "tag 1 topic unless the post clearly covers more", which raises topic precision without hurting recall much.

## Why this prompt

- It shows three kinds of fields: two single-select and one multi-select, as Evelyn asked on 2026-10-27.
- Every value is easy to judge from a screenshot of a video, so demo viewers don't need training.
- It keeps the pilot's two most convincing advice stories, so the existing conversation script carries over.
