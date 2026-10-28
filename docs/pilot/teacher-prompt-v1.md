# Pilot teacher prompt v1: content consumption value

The pilot project's teacher prompt as Evelyn provided it on 2026-10-26, kept as written, typos included (`resoning`); only list numbering and indentation were normalized. The demo's schema, samples and agent advice are derived from it.

Schema it implies:

| Field | Type | Values | Trained into student |
| --- | --- | --- | --- |
| `label` | single_select | Entertainment & Consumption · Experience & Decision-making · Discussion · Ecosystem issue | Yes |
| `summary` | aux | free text | No (teacher only) |
| `resoning` | aux | free text | No (teacher only) |

Known issues, to be shown as agent advice in the demo:

- The output section lists the label value as `娱乐Entertainment & Consumption`, which is not in the value set, so teacher outputs copying it would be invalid.
- The reasoning field is spelled `resoning`.
- The "judge strictly in order" steps lost their criteria (empty bullets) in this copy.

---

There is a content consumption experience classification task for you to do: from the perspective of the audience viewing this content, based on the content itself, identify the content's primary value type, and output one of the following four categories:

* Entertainment & Consumption
* Experience & Decision-making
* Discussion
* Ecosystem issue

## 1 Content understanding

I will provide you with the following information data for a post. You need to comprehensively understand, based on these inputs, what main idea the post author wants to express and what the creation purpose is.

1. Basic post information: Item Title, Description, OCR Text, Photo Images/Video Frame, ASR Text, Item POI, Item Create Time, Item publish country, Content Language
2. Post publisher information: Item Creator avatar image, Creator Nickname, Creator Bio
3. Post content understanding summary: Item Interest Point

Note: You must comprehensively and accurately understand the content as a whole. Do not judge based on only one word or one sentence and overgeneralize.

## 2 Core task

Determine what value users primarily obtain after fully consuming this piece of content.

1. Notes:
2. Do not classify based only on the title, cover, topic tags, or content format.
3. When the title's promise is inconsistent with the main body content, the actual main body content must prevail.
4. Judge the content by the content, not by the author; creator background is only auxiliary for judging the content. For example, an official account that sells products can also publish Experience/Decision-making content.
5. Please judge strictly in the following order:
6. First understand the actual main body content; do not merely trust the title or cover promise.
7. Determine whether it matches Ecosystem issue content:
   * Yes → Ecosystem issue.
8. Determine whether it matches Experience/Decision-making content:
   * Yes → Experience/Decision-making.
9. If not, determine whether it matches Discussion content:
   * Yes → Discussion.
10. If not, determine whether it matches Entertainment/Consumption content:
    * Yes → Entertainment/Consumption.

## 3 Definition of content consumption experience

Based on your understanding of the post, from the perspective of the audience viewing this post, select what you consider to be the main value of the content for the post's audience:

1. Experience/Decision-making: The content must be useful to others in making life decisions or interest decisions, and can solve problems or provide answers and information for others; or, by sharing real experiences and inspiration on a clear theme, it inspires the audience to take reproducible, specific actions, behaviors, or decisions. Judgment question: Can users extract transferable information from the content to use for "what to do, how to do it, what to choose, and what to avoid"? If the answer is "yes," and this constitutes the main delivery, classify it as Experience/Decision-making.
2. Notes:
3. If the information provided by the content is insufficient to be useful for others in making life decisions or to constitute action inspiration, it does not count as Experience/Decision-making.
4. "Experience/Decision-making" is not equivalent to tutorials, guides, or complete solutions. When the content does not provide a complete tutorial, advice, or method, but the audience can still obtain decision references/answers to questions/action inspiration/executable methods from the content, it also counts as Experience/Decision-making.
5. For shop-visit content, if it mainly expresses preferences, personal introductions to or evaluations of the shop, and does not include information such as discounts or purchase links, classify it as Experience/Decision-making.
6. Mere common sense, general-knowledge descriptions, or general statements do not count as Experience/Decision-making. Experience/Decision-making means that the audience can obtain action inspiration or specific methods from other people's or groups' experiences, experience sharing, or experiential sharing.
7. Content about emotional concepts, advice, methods, guidance, or interpretation of emotional relationships, even if it contains decision references/action inspiration/discussion points, is still considered mass emotional content and classified as Entertainment/Consumption.
8. Discussion: It does not matter whether the content itself develops a clear evaluative issue; as long as it simultaneously satisfies two conditions: a) from the real life experiences, interest experiences, or personal views shared in the content, a specific object, result, or phenomenon can be extracted; b) it can trigger specific-circle audiences to produce substantive comments based on the specific object. Judgment question: Does the content contain a specific object, result, or phenomenon that the audience can supplement with information/share experiences/comment on? If the answer is "yes," classify it as Discussion.
9. Notes:
10. Discussion content does not necessarily require the creator to argue, nor require an explicit viewpoint or an invitation for the audience to take sides, nor require a systematic viewpoint, nor require personal experience to have public relevance, social controversy, or profound conclusions. When the content is related to a specific interest community, or focuses on a specific experience group, and contains detailed life/interest experiences, practical issues, viewpoints, or experience sharing related to that specific interest community or experience group, classify it as Discussion.
11. Triggering substantive comments from specific-circle audiences means: a) If the audience is the general public, even if it can trigger substantive discussion, it does not count as Discussion. b) If it can only trigger generic comments, it also does not count as Discussion.
12. When a post contains reposted or quoted material created by others, you must first distinguish "quoted material" from "new expressions added by the current content poster." Classification can only be judged based on the new expressions added by the current content poster. Quoted material is only used to understand the content poster's creation theme and must not be used to judge classification. When the content only selects, excerpts, organizes, reposts, or retells third-party material, does not constitute the current content poster's independent expression, and has no effective new expression, directly stop the Discussion-category judgment.
13. Pure news or information, simply reposting news, retelling events, or listing facts, and only sharing event information—as long as the post creator has no newly added viewpoint of their own—then even if the content is only quoted material, it is classified as Entertainment/Consumption, not Discussion. Example 1: The post is a clip from a variety show. In the show, two hosts discuss their travel experience in Canada, but the post creator does not present their own viewpoint or a discussion point/theme they want to communicate with others; the caption merely states that the content is reposted or retold. It does not count as Discussion and is classified as Entertainment/Consumption. Example 2: The post is an interview clip. The guest shares their own viewpoint or starts a discussion, but the post creator does not publish their own viewpoint and merely reposts the interview content. This also belongs to program reposting and is classified as Entertainment/Consumption, not Discussion.
14. If the content raises a question, but the main body provides steps, methods, comparisons, or selection advice, it should be classified as Experience/Decision-making rather than Discussion; you should look at the main value category of the content body.
15. "It really happened" by itself is also insufficient to classify as Discussion; it must contain specific circumstances, experiences, choices, results, feelings, or confusions that enable the audience to produce responses with informational increment around the experience itself. If the audience's typical responses are mainly "haha," "so awkward," "so tragic," or "so touching," and they cannot further evaluate, explain, supplement, or exchange similar experiences → Entertainment/Consumption; if the audience can combine their own experiences or related knowledge to discuss "why did this happen," "is this handling reasonable," "I have encountered a similar situation," or "results may differ under different circumstances" → Discussion.
16. Life stories all belong to personal records and are classified as Entertainment/Consumption rather than Discussion. Content mainly about "what one person experienced and how they got to where they are today," even if it can trigger specific resonance and self-narration among specific experience groups, is still prioritized as a life story; only when the author organizes a common issue that can stand independently of personal experience as the main object of expression should it be classified as Discussion.
17. When content presents personal experiences through humor, jokes, reenactments, exaggerated performance, contrast editing, Vlogs, memes, or emotional expression, it cannot be directly classified as Entertainment/Consumption on that basis. Entertainment is only the form of expression. If the personal experience can trigger substantive comments from audiences with similar identities or interests, it is Discussion.
18. Questions or requests for help related to actual life or interests also count as Discussion. This includes but is not limited to: seeking life advice, looking for restaurants, shops, people, or housing, obtaining recommendations, consultation-type questions, and various questions about study or life.
19. All social/dating content counts as Entertainment/Consumption, not Discussion.
20. Entertainment/Consumption: The main value of the content occurs during viewing; the core is providing entertainment, fun, emotional satisfaction, aesthetic experience, plot immersion, companionship, novelty/curiosity, or light entertainment. Such content usually satisfies basic browsing, entertainment, or emotional consumption needs, but is relatively unlikely to trigger discussion among specific audience circles, nor can it provide the audience with clear decision support or action inspiration. Judgment question: If the performance, personal charisma, emotion, music, editing, and visual atmosphere are removed from the content, is the remaining information still sufficient for users to obtain executable methods, decision bases, or objects worth responding to? If the answer is "no," classify it as Entertainment/Consumption.
21. Typical content includes but is not limited to content that does not provide reproducible actions, judgment bases, or discussion that can be triggered among specific audience circles:
    * Mass-consumption humor, jokes, reversals, spoofs, challenges, imitation, memes, plots, short dramas, emotional stories, and character conflicts;
    * Mass emotional content, Lyrics Videos, Lipsync, all religion-related content, Quotes & Inspirations, special-effect videos (including using AI to display video effects), storytelling/personal statements/emotional character copy, and social/dating;
    * Music, dance, appearance, cute pets, scenery, and atmosphere display;
    * Film/TV, variety shows, TV programs, anime, game highlights, or mashups;
    * Unthemed casual shots, selfies, pure daily records, and pure personal display without reusable methods, judgment bases, or discussion subjects;
    * Titles that appear to be "tutorial/guide/How to" but whose actual main body is memeing, contrast, teasing, or humor;
    * Pure display or showing off of personal talents, abilities, appearance, achievements, highlights, etc., without providing reusable methods, judgment bases, or discussion subjects.
22. Notes:
    * Do not exclude Entertainment/Consumption just because the content contains a small amount of knowledge points, personal viewpoints, or a "tutorial" title; you must see whether such information constitutes the main value.
    * "Fake tutorials/clickbait memes" where the title is inconsistent with the actual content, if they mainly deliver laughs or contrast, are classified as Entertainment/Consumption.
    * Pure news/information, event progress explanations, oral event broadcasts, interviews or talk shows that do not provide reproducible actions or judgment bases/discussion points supporting life decisions are also classified as Entertainment/Consumption. Clips from entertainment media programs such as film/TV, variety shows, and interviews—regardless of whether they contain discussions by actors/program guests—as long as there is no expression of the post creator's own viewpoint, all count as Entertainment/Consumption. Content about mass social issues (such as content evaluating, advocating, arguing about, or mobilizing around government, political parties, elections, international conflicts, laws and policies, public governance, public event controversies, conflicts over the rights of mass groups, etc.) does not count as Discussion and counts as Entertainment/Consumption.
    * When content presents personal experiences through humor, jokes, reenactments, exaggerated performance, contrast editing, Vlogs, memes, or emotional expression, entertainment is only the form of expression and cannot be directly used to classify it as Entertainment/Consumption; instead, look at whether the personal experience itself still constitutes the main value.
    * When content can trigger experience exchange, discussion, and experience resonance among audiences in specific interest circles or specific identity circles, classify it as Discussion rather than Entertainment/Consumption.
23. Ecosystem issue: The content has obvious low quality, misleadingness, or ecosystem harm, including but not limited to: direct sales promotion of products or services, inducing clicks or interactions (Clickbait / Engagement Bait), clickbait, manipulating fans or traffic, adult nudity and sexual acts, and other content that harms user experience or the community ecosystem. Note: Direct sales promotion means that the content contains information directly leading to sales, such as discounts and purchase links.

## 4 Conflict adjudication rules

The key is to determine what value the audience mainly obtains from this content.

1. Entertainment form + method information
   If humor, plot, or Vlog is only the form of expression, but the main body delivers clear methods, steps, experience, comparisons, or pitfall-avoidance information, classify it as Experience/Decision-making. Examples:
   * Using a skit to demonstrate three scripts for refusing ineffective overtime → Experience/Decision-making
   * Explaining beginner callout skills in a game in a humorous way → Experience/Decision-making
   * Couple plot only provides laughs and no specific communication methods → Entertainment/Consumption
2. Personal experience + experience / viewpoint
   * The core is "what I did, what you can do, and how to avoid pitfalls" → Experience/Decision-making
   * The core is "what I experienced, how I view it, what my experience or feelings are, and what do you think" → Discussion
   * The core is story, emotion, or conflict → Entertainment/Consumption
3. Review / recommendation + viewpoint
   * Has parameters, comparison dimensions, applicable conditions, pros and cons, costs, or recommendation logic → Experience/Decision-making
   * Mainly expresses aesthetics, likes/dislikes, or value attitudes, and invites different opinions → Discussion
   * Mainly showing items, unboxing, display, or atmosphere experience → Entertainment/Consumption
4. Discussion + solution
   * Ultimately mainly delivers methods, checklists, scripts, or advice on "how it should be done" → Experience/Decision-making
   * Ultimately mainly delivers judgments, positions, or explanations on "how it should be viewed" → Discussion
5. Shop visit + experience / viewpoint
   * Mainly expresses preferences, personal introductions to or evaluations of the shop, and does not include information such as discounts or purchase links → Experience/Decision-making
   * Shop visit with information such as discounts or purchase links → Ecosystem issue
6. Entertainment form + personal experience
   When content presents personal experiences through humor, jokes, reenactments, exaggerated performance, contrast editing, Vlogs, memes, or emotional expression, entertainment is only the form of expression and cannot be directly used to classify it as Entertainment/Consumption; instead, look at whether the personal experience itself still constitutes the main value.
   * If the personal experience has been summarized or reviewed and provides transferable methods, experience, decision references, action inspiration, or pitfall-avoidance information, enabling the audience to use it for their own actions or choices → Experience/Decision-making
   * If the personal experience is sufficiently specific and contains clear events, circumstances, choices, results, feelings, confusions, or contradictions, and forms a space where audiences with similar experiences or relevant knowledge can evaluate, explain, supplement, share similar experiences, or propose different judgments → Discussion
   * If the core value of the personal experience comes from emotional venting, and the experience details are insufficient to support the audience in forming informationally incremental evaluations, explanations, or experience exchange → Entertainment/Consumption

## 5 Output result

Strictly output valid JSON in the following format, and it must contain the following 3 fields. Do not output conclusions that cannot be evaluated or processed, and do not output extra fields:

```json
{
"summary": "...",
"resoning": "...",
"label": "Entertainment & Consumption/Experience & Decision-making/Discussion/Ecosystem issue"
}
```

Field requirements:

1. "summary": Summarize what main idea the post author wants to express and what the creation purpose is.
2. "resoning": A string. Please provide a detailed reasoning chain and evidence, clarifying what main value the content actually delivers to users and why it is classified into this category rather than another category.
3. "label": A string. There is exactly one category. According to your reasoning analysis, select the final category from the following range: 娱乐Entertainment & Consumption/Experience & Decision-making/Discussion/Ecosystem issue.
