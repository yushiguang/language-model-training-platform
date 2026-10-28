import {t, type T} from '@/i18n/text';
import type {FieldId, FormatId, LabelId, TopicId} from './fields';

export interface Labels {
  primary_value: LabelId;
  format: FormatId;
  topics: TopicId[];
}

/** Everything the teacher writes for a post (prompt v1): the label fields plus two teacher-only fields. */
export interface TeacherOutput extends Labels {
  summary: T;
  reasoning: T;
}

export interface Post {
  id: string;
  /** BCP 47 tag of the post's own language; post text is shown as written. */
  lang: string;
  country: T;
  title: string;
  ocr: string;
  asr: string;
  creator: {nickname: string; bio: string};
  /** One line in the UI language, so every viewer can follow a post in any language. */
  gloss: T;
  /** Human gold labels, after adjudication. */
  gold: Labels;
  teacher: TeacherOutput;
  /** Hue for the placeholder video frames. */
  hue: number;
}

export const POSTS: Post[] = [
  {
    id: 'p01',
    lang: 'es',
    country: t('Mexico', '墨西哥'),
    title: '3 errores que cometí al rentar mi primer depa en CDMX',
    ocr: 'ERROR #1: no revisar la presión del agua',
    asr: 'Nadie me dijo que pidiera el contrato antes de pagar el depósito…',
    creator: {nickname: 'vivir.en.cdmx', bio: 'Mudanzas, rentas y vida en la ciudad'},
    gloss: t('Three mistakes from renting a first apartment, with what to check instead.', '第一次租房踩的三个坑，以及应该检查什么。'),
    gold: {primary_value: 'practical', format: 'vlog', topics: ['home']},
    teacher: {
      primary_value: 'practical',
      format: 'tutorial',
      topics: ['home', 'work'],
      summary: t('A renter lists three mistakes from her first lease in Mexico City and what to check instead.', '租客列出在墨西哥城第一次租房犯的三个错误，以及应该检查什么。'),
      reasoning: t('Viewers can act on the checklist, so Practical. She walks through steps to check, so Tutorial. About renting, and the deposit touches money.', '观众可以照着清单做，所以是实用。她按步骤讲要检查什么，所以是教程。话题是租房，押金也涉及钱。'),
    },
    hue: 18,
  },
  {
    id: 'p02',
    lang: 'zh',
    country: t('Singapore', '新加坡'),
    title: '带娃坐 12 小时飞机，我总结了这 5 条',
    ocr: '第 3 条最重要：提前选好靠墙位',
    asr: '耳压的问题，起飞的时候一定要让孩子喝水或者吃东西……',
    creator: {nickname: '小满妈妈', bio: '两个娃，常年飞来飞去'},
    gloss: t('Five tips for a 12-hour flight with a toddler.', '带幼儿坐 12 小时飞机的五条建议。'),
    gold: {primary_value: 'practical', format: 'tutorial', topics: ['travel']},
    teacher: {
      primary_value: 'practical',
      format: 'tutorial',
      topics: ['travel'],
      summary: t('A parent gives five tips for a 12-hour flight with a toddler.', '一位家长分享带幼儿坐 12 小时飞机的五条建议。'),
      reasoning: t('Concrete tips the viewer can follow, given as numbered steps. Only about travel.', '具体可执行的建议，按编号分步骤讲。话题只有旅行。'),
    },
    hue: 205,
  },
  {
    id: 'p03',
    lang: 'en',
    country: t('United States', '美国'),
    title: 'My landlord kept my whole deposit for "wear and tear". Is this normal in Texas?',
    ocr: '$1,850 deposit → $0 returned',
    asr: 'They sent photos of a scuffed wall and a carpet that was already eight years old…',
    creator: {nickname: 'rentingintx', bio: 'First-time renter, Austin'},
    gloss: t('A renter asks whether keeping a full deposit for normal wear is allowed.', '租客询问房东以正常损耗为由扣下全部押金是否合理。'),
    gold: {primary_value: 'discussion', format: 'vlog', topics: ['home']},
    teacher: {
      primary_value: 'discussion',
      format: 'vlog',
      topics: ['home', 'work'],
      summary: t('A first-time renter says the landlord kept the whole deposit and asks whether that is normal in Texas.', '第一次租房的人说房东扣下了全部押金，问在德州这样是否正常。'),
      reasoning: t('The poster shares her own experience and asks others to respond, so Discussion. Filmed by herself. About renting and money.', '发布者分享自己的经历并邀请别人回应，所以是讨论。自己拍摄。话题是租房和钱。'),
    },
    hue: 140,
  },
  {
    id: 'p04',
    lang: 'id',
    country: t('Indonesia', '印度尼西亚'),
    title: 'POV: kamu anak kos di tanggal tua',
    ocr: 'menu hari ke-27: mie instan edisi spesial',
    asr: '(musik) …dan ini adalah makan malam mewah saya',
    creator: {nickname: 'anakkos.official', bio: 'Hiburan receh setiap hari'},
    gloss: t('A comedy skit about a student eating instant noodles at the end of the month.', '搞笑短剧：月底的租房学生只能吃泡面。'),
    gold: {primary_value: 'entertainment', format: 'skit', topics: ['food']},
    teacher: {
      primary_value: 'entertainment',
      format: 'skit',
      topics: ['food'],
      summary: t('A comedy skit about a student eating instant noodles at the end of the month.', '搞笑短剧：月底的学生只能吃泡面。'),
      reasoning: t('Acted for laughs with nothing to take away. About food.', '为了好笑而表演，没有可带走的信息。话题是食物。'),
    },
    hue: 48,
  },
  {
    id: 'p05',
    lang: 'ar',
    country: t('Saudi Arabia', '沙特阿拉伯'),
    title: 'بعد سنتين من العمل الهجين: ما الذي تغيّر فعلاً في فريقي؟',
    ocr: 'يومان في المكتب · ثلاثة من المنزل',
    asr: 'الاجتماعات أصبحت أقصر، لكن الموظفين الجدد يتعلمون أبطأ…',
    creator: {nickname: 'nora.manages', bio: 'مديرة منتج في الرياض'},
    gloss: t('A manager shares what changed after two years of hybrid work and asks for others’ experience.', '一位经理分享两年混合办公后团队的变化，并邀请大家交流经验。'),
    gold: {primary_value: 'discussion', format: 'vlog', topics: ['work']},
    teacher: {
      primary_value: 'discussion',
      format: 'vlog',
      topics: ['work'],
      summary: t('A manager shares what changed after two years of hybrid work and asks for others’ experience.', '一位经理分享两年混合办公后的变化，并邀请大家交流经验。'),
      reasoning: t('Her own experience with an explicit question to viewers, so Discussion. About work.', '她自己的经历，并明确向观众提问，所以是讨论。话题是工作。'),
    },
    hue: 280,
  },
  {
    id: 'p06',
    lang: 'ja',
    country: t('Japan', '日本'),
    title: '猫が初めて雪を見た日',
    ocr: 'はじめての雪',
    asr: '（猫の鳴き声）あ、触った！',
    creator: {nickname: 'mochi_no_hibi', bio: '白猫もちの日常'},
    gloss: t('A cat sees snow for the first time.', '猫第一次看到雪。'),
    gold: {primary_value: 'entertainment', format: 'vlog', topics: ['pets']},
    teacher: {
      primary_value: 'entertainment',
      format: 'vlog',
      topics: ['pets', 'travel'],
      summary: t('A white cat touches snow for the first time.', '一只白猫第一次碰到雪。'),
      reasoning: t('Enjoyed while watching, nothing to act on. The owner films her own cat. About pets, with snow as the setting.', '观看当下的乐趣，没有可执行的内容。主人拍自己的猫。话题是宠物，雪是场景。'),
    },
    hue: 190,
  },
  {
    id: 'p07',
    lang: 'pt-BR',
    country: t('Brazil', '巴西'),
    title: 'Promoção relâmpago: 50% OFF só hoje, link na bio',
    ocr: 'CUPOM: HOJE50',
    asr: 'Corre que acaba à meia-noite!',
    creator: {nickname: 'achadinhos.br', bio: 'Ofertas todos os dias'},
    gloss: t('A flash sale with a coupon code and a purchase link.', '限时五折促销，带优惠码和购买链接。'),
    gold: {primary_value: 'ecosystem', format: 'other', topics: ['beauty']},
    teacher: {
      primary_value: 'ecosystem',
      format: 'review',
      topics: ['beauty', 'other'],
      summary: t('A flash sale with a coupon code and a purchase link, not marked as an ad.', '限时促销，带优惠码和购买链接，没有标注广告。'),
      reasoning: t('Rule 2: it sells without saying it is an ad, so Ecosystem issue. The products shown are cosmetics.', '依据第 2 条：在卖东西却没声明是广告，所以是生态问题。展示的商品是化妆品。'),
    },
    hue: 330,
  },
  {
    id: 'p08',
    lang: 'en',
    country: t('United Kingdom', '英国'),
    title: 'reposting this interview because it’s iconic',
    ocr: '"I never wanted to be famous"',
    asr: 'Host: So what changed after the first album? Guest: Honestly, everything…',
    creator: {nickname: 'popculture.daily', bio: 'clips you missed'},
    gloss: t('A reposted celebrity interview with no comment from the poster.', '原样转发的明星访谈，发布者没有补充自己的观点。'),
    gold: {primary_value: 'entertainment', format: 'clip', topics: ['news']},
    teacher: {
      primary_value: 'discussion',
      format: 'clip',
      topics: ['news'],
      summary: t('A reposted celebrity interview; the guest talks about fame after the first album.', '转发的明星访谈，嘉宾谈第一张专辑后的成名经历。'),
      reasoning: t('The guest shares strong views, so Discussion. It is an excerpt of an interview, so Clip.', '嘉宾表达了鲜明的观点，所以是讨论。这是访谈的节选，所以是片段。'),
    },
    hue: 0,
  },
  {
    id: 'p09',
    lang: 'zh',
    country: t('China', '中国'),
    title: '第一次来这家咖啡店：手冲一般，甜点绝了，人均 68',
    ocr: '柠檬塔 ★★★★★ · 耶加雪菲 ★★★',
    asr: '位子不多，周末最好十点前到……',
    creator: {nickname: '成都喝咖啡', bio: '每周探一家'},
    gloss: t('A café visit with prices, ratings and when to go; no discounts or links.', '咖啡店探店：有价格、评分和建议到店时间，没有优惠或链接。'),
    gold: {primary_value: 'practical', format: 'review', topics: ['food']},
    teacher: {
      primary_value: 'practical',
      format: 'review',
      topics: ['food', 'travel'],
      summary: t('A café visit with prices, ratings for each item and the best time to go.', '咖啡店探店：有价格、各单品评分和建议到店时间。'),
      reasoning: t('Viewers learn what to order and when to go, so Practical. The creator judges a place, so Review. About food, and visiting a city.', '观众知道该点什么、何时去，所以是实用。创作者在评价一个地方，所以是测评。话题是美食，也涉及出行。'),
    },
    hue: 28,
  },
  {
    id: 'p10',
    lang: 'en',
    country: t('Philippines', '菲律宾'),
    title: 'Night shift nurses: did your hospital also cut the break to 20 minutes?',
    ocr: '12-hr shift · 20-min break',
    asr: 'We used to get an hour. Now it’s twenty minutes and you eat standing up…',
    creator: {nickname: 'nurse.ana.rn', bio: 'ICU nurse, Manila'},
    gloss: t('A nurse describes a shortened break and asks other nurses about theirs.', '护士讲述休息时间被缩短，并询问其他护士的情况。'),
    gold: {primary_value: 'discussion', format: 'vlog', topics: ['work']},
    teacher: {
      primary_value: 'discussion',
      format: 'vlog',
      topics: ['work'],
      summary: t('A nurse says her break was cut to 20 minutes and asks other nurses about theirs.', '护士说休息时间被缩短到 20 分钟，并询问其他护士的情况。'),
      reasoning: t('Her own experience and a direct question to her peers, so Discussion. About work.', '她自己的经历，并直接向同行提问，所以是讨论。话题是工作。'),
    },
    hue: 220,
  },
  {
    id: 'p11',
    lang: 'es',
    country: t('Spain', '西班牙'),
    title: 'Comenta "SÍ" y te mando la lista completa',
    ocr: 'LISTA SECRETA 👇',
    asr: 'Solo para los que comenten en los próximos cinco minutos…',
    creator: {nickname: 'trucos.virales', bio: 'Sígueme para más'},
    gloss: t('Engagement bait: comment to receive a "secret list".', '诱导互动：评论才能拿到“秘密清单”。'),
    gold: {primary_value: 'ecosystem', format: 'other', topics: ['other']},
    teacher: {
      primary_value: 'ecosystem',
      format: 'other',
      topics: ['other'],
      summary: t('The creator asks viewers to comment “SÍ” to receive a “secret list”.', '创作者让观众评论“SÍ”来领取“秘密清单”。'),
      reasoning: t('Engagement bait, so Ecosystem issue. No clear format or topic, so Other for both.', '诱导互动，所以是生态问题。形式和话题都不明确，所以都是其他。'),
    },
    hue: 300,
  },
  {
    id: 'p12',
    lang: 'zh',
    country: t('Malaysia', '马来西亚'),
    title: '被房东催搬家的第三天（vlog）',
    ocr: '合约还有四个月',
    asr: '他说要卖房，给我两个星期……我查了一下，其实合约里写的是提前两个月通知。',
    creator: {nickname: '阿杰在吉隆坡', bio: '普通上班族的日常'},
    gloss: t('A vlog about a landlord demanding early move-out, with contract details renters can weigh in on.', 'vlog：房东要求提前搬走，附合同细节，租客们可以讨论。'),
    gold: {primary_value: 'discussion', format: 'vlog', topics: ['home']},
    teacher: {
      primary_value: 'entertainment',
      format: 'vlog',
      topics: ['home', 'work'],
      summary: t('A tenant films day three of being pushed to move out early, with details from the lease.', '租客记录被房东催着提前搬走的第三天，并提到合同细节。'),
      reasoning: t('A personal vlog told as a story, so Entertainment. About renting and money.', '以讲故事方式呈现的个人 vlog，所以是娱乐。话题是租房和钱。'),
    },
    hue: 160,
  },
];

export const POST_BY_ID = Object.fromEntries(POSTS.map(p => [p.id, p])) as Record<string, Post>;

/** The posts the PM labels in the labeling task. */
export const LABELING_POSTS = ['p03', 'p06', 'p09', 'p11', 'p05'];

/** A labeler disagreement on one field of one post. Values are arrays so multi-select fields fit. */
export interface Conflict {
  id: string;
  postId: string;
  field: FieldId;
  mei: string[];
  ravi: string[];
  suggestion: string[];
  reason: T;
}

/** Disagreements across the 1,000 double-labeled posts. The page shows a sample; the rest are counted. */
export const CONFLICT_TOTALS: Record<FieldId, number> = {primary_value: 96, format: 41, topics: 77};

export const CONFLICTS: Conflict[] = [
  {
    id: 'c01',
    postId: 'p12',
    field: 'primary_value',
    mei: ['discussion'],
    ravi: ['entertainment'],
    suggestion: ['discussion'],
    reason: t('It’s told as a vlog, but the lease details invite other renters to respond. The form doesn’t decide.', '虽然是 vlog 形式，但合同细节会引来其他租客回应。形式不决定类别。'),
  },
  {
    id: 'c02',
    postId: 'p08',
    field: 'primary_value',
    mei: ['entertainment'],
    ravi: ['discussion'],
    suggestion: ['entertainment'],
    reason: t('Rule 1: the views belong to the guest, and the poster adds nothing.', '依据第 1 条：观点来自嘉宾，发布者没有补充。'),
  },
  {
    id: 'c03',
    postId: 'p09',
    field: 'topics',
    mei: ['food'],
    ravi: ['food', 'travel'],
    suggestion: ['food'],
    reason: t('The post is about the café. Visiting a city is the setting, not a topic.', '帖子讲的是咖啡店，去哪座城市只是背景，不是话题。'),
  },
  {
    id: 'c04',
    postId: 'p07',
    field: 'primary_value',
    mei: ['ecosystem'],
    ravi: ['practical'],
    suggestion: ['ecosystem'],
    reason: t('Rule 2: it sells with a coupon and a link, and it isn’t marked as an ad.', '依据第 2 条：带优惠码和链接在卖货，且没有标注广告。'),
  },
  {
    id: 'c05',
    postId: 'p01',
    field: 'format',
    mei: ['vlog'],
    ravi: ['tutorial'],
    suggestion: ['vlog'],
    reason: t('She tells her own story; the tips come out of it rather than being taught step by step.', '她在讲自己的经历，建议来自经历，而不是分步骤教学。'),
  },
  {
    id: 'c06',
    postId: 'p03',
    field: 'topics',
    mei: ['home'],
    ravi: ['home', 'work'],
    suggestion: ['home'],
    reason: t('The deposit is part of renting. One topic fits.', '押金是租房的一部分，一个话题就够了。'),
  },
  {
    id: 'c07',
    postId: 'p10',
    field: 'primary_value',
    mei: ['discussion'],
    ravi: ['practical'],
    suggestion: ['discussion'],
    reason: t('She asks other nurses about their breaks; there’s nothing to act on yet.', '她在问其他护士的情况，还没有可执行的内容。'),
  },
  {
    id: 'c08',
    postId: 'p02',
    field: 'format',
    mei: ['tutorial'],
    ravi: ['vlog'],
    suggestion: ['tutorial'],
    reason: t('Five numbered tips, given as steps.', '五条编号建议，按步骤给出。'),
  },
  {
    id: 'c09',
    postId: 'p06',
    field: 'topics',
    mei: ['pets'],
    ravi: ['pets', 'travel'],
    suggestion: ['pets'],
    reason: t('Snow is the setting; the post is about the cat.', '雪只是场景，帖子讲的是猫。'),
  },
  {
    id: 'c10',
    postId: 'p05',
    field: 'format',
    mei: ['vlog'],
    ravi: ['other'],
    suggestion: ['vlog'],
    reason: t('She talks to the camera about her own team, which is a vlog.', '她对着镜头讲自己团队的事，属于 vlog。'),
  },
  {
    id: 'c11',
    postId: 'p04',
    field: 'topics',
    mei: ['food'],
    ravi: ['food', 'work'],
    suggestion: ['food'],
    reason: t('The joke is about noodles at month’s end; money is only the backdrop.', '笑点在月底吃泡面，钱只是背景。'),
  },
  {
    id: 'c12',
    postId: 'p11',
    field: 'topics',
    mei: ['other'],
    ravi: ['other', 'beauty'],
    suggestion: ['other'],
    reason: t('No product is shown, so nothing beyond Other fits.', '没有展示任何商品，所以只有“其他”。'),
  },
];
