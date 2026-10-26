import {t, type T} from '@/i18n/text';

export type LabelId = 'entertainment' | 'experience' | 'discussion' | 'ecosystem';

export interface Label {
  id: LabelId;
  name: T;
  /** Categorical series color; fixed per label everywhere in the app. */
  color: string;
  definition: T;
  examples: T[];
  counterexamples: T[];
}

/** Order matches the confusion-matrix rows and columns in metrics.ts. */
export const LABELS: Label[] = [
  {
    id: 'entertainment',
    name: t('Entertainment & Consumption', '娱乐消费'),
    color: '#2a78d6',
    definition: t(
      'The value happens while watching: fun, emotion, beauty, plot or curiosity. Remove the performance and nothing usable is left.',
      '价值发生在观看当下：好笑、情绪、美感、剧情或新奇。去掉表演和氛围后，没有可用的信息。',
    ),
    examples: [t('A cat seeing snow for the first time', '猫第一次看到雪'), t('A reposted interview clip with no comment from the poster', '原样转发的访谈片段，发布者没有自己的观点')],
    counterexamples: [t('A skit that teaches three scripts for refusing overtime (Experience)', '用小品演示三种拒绝无效加班的话术（经验决策）')],
  },
  {
    id: 'experience',
    name: t('Experience & Decision-making', '经验决策'),
    color: '#eb6834',
    definition: t(
      'Viewers can take away what to do, how to do it, what to choose or what to avoid, from real experience or concrete information.',
      '观众能从真实经验或具体信息中，获得“做什么、怎么做、选什么、避开什么”。',
    ),
    examples: [t('3 mistakes I made renting my first apartment', '第一次租房踩过的 3 个坑'), t('A café visit with prices and honest ratings, no discount link', '探店：有价格和真实评价，没有优惠链接')],
    counterexamples: [t('General advice about relationships (Entertainment)', '泛泛的情感建议（娱乐消费）')],
  },
  {
    id: 'discussion',
    name: t('Discussion', '讨论'),
    color: '#1baf7a',
    definition: t(
      'The poster shares a specific experience, result or view that people in a particular circle can respond to with substance.',
      '发布者分享具体的经历、结果或观点，特定圈层的观众能据此给出有信息量的回应。',
    ),
    examples: [t('Night-shift nurses: did your hospital also cut breaks to 20 minutes?', '夜班护士们，你们医院也把休息缩短到 20 分钟了吗？')],
    counterexamples: [t('A reposted show clip where only the guests give views (Entertainment)', '转发节目片段，只有嘉宾在表达观点（娱乐消费）')],
  },
  {
    id: 'ecosystem',
    name: t('Ecosystem issue', '生态问题'),
    color: '#eda100',
    definition: t(
      'Low-quality or harmful content: direct sales with discounts or links, engagement bait, traffic manipulation, adult content.',
      '低质或有害内容：带折扣或链接的直接带货、诱导互动、刷量、成人内容。',
    ),
    examples: [t('“50% off today only, link in bio”', '“今天五折，链接在主页”'), t('“Comment YES and I’ll send you the list”', '“评论‘要’就发你清单”')],
    counterexamples: [t('A shop review without discounts or links (Experience)', '没有优惠和链接的探店评价（经验决策）')],
  },
];

export const LABEL_BY_ID = Object.fromEntries(LABELS.map(l => [l.id, l])) as Record<LabelId, Label>;

/** The prompt's judgment order: the first match wins. */
export const JUDGMENT_ORDER: LabelId[] = ['ecosystem', 'experience', 'discussion', 'entertainment'];
