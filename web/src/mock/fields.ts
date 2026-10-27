import {t, type T} from '@/i18n/text';

/**
 * The label fields of the demo's teacher prompt (docs/demo/video-tagging-prompt-v1.md):
 * two single-select fields and one multi-select field.
 */
export type FieldId = 'primary_value' | 'format' | 'topics';
export type LabelId = 'entertainment' | 'practical' | 'discussion' | 'ecosystem';
export type FormatId = 'vlog' | 'tutorial' | 'review' | 'skit' | 'clip' | 'other';
export type TopicId = 'food' | 'travel' | 'home' | 'work' | 'tech' | 'beauty' | 'pets' | 'sports' | 'news' | 'other';

export interface FieldValue {
  id: string;
  name: T;
  /** Categorical series color; only primary_value values have one, fixed everywhere in the app. */
  color?: string;
  definition?: T;
  examples?: T[];
  counterexamples?: T[];
}

export interface Field {
  id: FieldId;
  name: T;
  kind: 'single' | 'multi';
  /** For multi-select fields: how many values a post may have. */
  range?: [number, number];
  description: T;
  values: FieldValue[];
}

/** primary_value, in matrix order (metrics.ts rows and columns follow it). */
export const LABELS: (FieldValue & {id: LabelId; color: string; definition: T; examples: T[]; counterexamples: T[]})[] = [
  {
    id: 'entertainment',
    name: t('Entertainment', '娱乐'),
    color: '#2a78d6',
    definition: t('Fun, emotion, beauty or story, enjoyed while watching. Nothing usable is left afterwards.', '好笑、情绪、美感或剧情，在观看当下获得，看完没有可用的东西。'),
    examples: [t('A cat sees snow for the first time', '猫第一次看到雪'), t('A clip of a celebrity interview, reposted without comment', '原样转发的明星访谈片段')],
    counterexamples: [t('A skit that teaches three ways to refuse overtime (Practical)', '用小品演示三种拒绝加班的说法（实用）')],
  },
  {
    id: 'practical',
    name: t('Practical', '实用'),
    color: '#eb6834',
    definition: t('Something the viewer can act on: how to do something, what to buy, where to go, or what to avoid.', '观众能拿来用的东西：怎么做、买什么、去哪里、避开什么。'),
    examples: [t('5 tips for a 12-hour flight with a toddler', '带娃坐 12 小时飞机的 5 条建议'), t('A café review with prices and honest ratings', '有价格和真实评分的咖啡店探店')],
    counterexamples: [t('General advice about relationships with no specifics (Entertainment)', '没有具体内容的泛泛情感建议（娱乐）')],
  },
  {
    id: 'discussion',
    name: t('Discussion', '讨论'),
    color: '#1baf7a',
    definition: t('The poster shares their own view or experience and invites others to respond.', '发布者分享自己的观点或经历，并邀请别人回应。'),
    examples: [t('Night-shift nurses: did your hospital also cut breaks to 20 minutes?', '夜班护士们，你们医院也把休息缩短到 20 分钟了吗？')],
    counterexamples: [t('A show clip where only the guests give views (Entertainment)', '只有嘉宾在表达观点的节目片段（娱乐）')],
  },
  {
    id: 'ecosystem',
    name: t('Ecosystem issue', '生态问题'),
    color: '#eda100',
    definition: t('Spam, misleading claims, engagement bait, undisclosed ads or adult content.', '垃圾内容、误导性说法、诱导互动、未声明的广告或成人内容。'),
    examples: [t('“50% off today only, link in bio”', '“今天五折，链接在主页”'), t('“Comment YES and I’ll send you the list”', '“评论‘要’就发你清单”')],
    counterexamples: [t('A shop review that discloses the free sample it got (Practical)', '声明了收到免费样品的探店评价（实用）')],
  },
];

export const FORMATS: (FieldValue & {id: FormatId})[] = [
  {id: 'vlog', name: t('Vlog', 'Vlog'), definition: t('The creator films their own day or experience.', '创作者拍摄自己的日常或经历。')},
  {id: 'tutorial', name: t('Tutorial', '教程'), definition: t('Step-by-step instructions.', '分步骤的教学。')},
  {id: 'review', name: t('Review', '测评'), definition: t('The creator tries and judges a product, place or service.', '创作者体验并评价产品、地点或服务。')},
  {id: 'skit', name: t('Skit', '短剧'), definition: t('A scripted or acted scene.', '有剧本或表演的情景。')},
  {id: 'clip', name: t('Clip', '片段'), definition: t('An excerpt of a show, interview, game or another creator’s video.', '节目、访谈、比赛或他人视频的片段。')},
  {id: 'other', name: t('Other', '其他'), definition: t('None of the above.', '以上都不是。')},
];

export const TOPICS: (FieldValue & {id: TopicId})[] = [
  {id: 'food', name: t('Food & drink', '美食饮品')},
  {id: 'travel', name: t('Travel', '旅行')},
  {id: 'home', name: t('Home & renting', '居家租房')},
  {id: 'work', name: t('Work & money', '工作理财')},
  {id: 'tech', name: t('Tech', '科技')},
  {id: 'beauty', name: t('Beauty & fashion', '美妆时尚')},
  {id: 'pets', name: t('Pets & animals', '宠物动物')},
  {id: 'sports', name: t('Sports & fitness', '运动健身')},
  {id: 'news', name: t('Entertainment news', '娱乐资讯')},
  {id: 'other', name: t('Other', '其他')},
];

export const FIELDS: Field[] = [
  {
    id: 'primary_value',
    name: t('Primary value', '主要价值'),
    kind: 'single',
    description: t('What the viewer mainly gets from the post.', '观众从帖子里主要获得什么。'),
    values: LABELS,
  },
  {
    id: 'format',
    name: t('Format', '形式'),
    kind: 'single',
    description: t('How the video is made.', '视频是怎么拍的。'),
    values: FORMATS,
  },
  {
    id: 'topics',
    name: t('Topics', '话题'),
    kind: 'multi',
    range: [1, 3],
    description: t('What the post is about. Pick 1 to 3.', '帖子关于什么，选 1 到 3 个。'),
    values: TOPICS,
  },
];

export const FIELD_BY_ID = Object.fromEntries(FIELDS.map(f => [f.id, f])) as Record<FieldId, Field>;
export const LABEL_BY_ID = Object.fromEntries(LABELS.map(l => [l.id, l])) as Record<LabelId, (typeof LABELS)[number]>;

export function valueOf(field: FieldId, id: string): FieldValue {
  return FIELD_BY_ID[field].values.find(v => v.id === id)!;
}

/** The prompt's judgment order for primary_value: the first match wins. */
export const JUDGMENT_ORDER: LabelId[] = ['ecosystem', 'practical', 'discussion', 'entertainment'];

/** The prompt's general rules, numbered as in the prompt. */
export const RULES: T[] = [
  t('Judge the poster’s own contribution. Words spoken by guests in a clip are not the poster’s view.', '只看发布者自己的贡献。片段里嘉宾说的话不算发布者的观点。'),
  t('If the post sells something without saying it is an ad, primary value is Ecosystem issue.', '如果帖子在卖东西却没声明是广告，主要价值为生态问题。'),
  t('Use Other only when nothing else fits.', '只有在都不符合时才用“其他”。'),
];
