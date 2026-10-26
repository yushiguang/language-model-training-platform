import {t, type T} from '@/i18n/text';
import type {LabelId} from './labels';

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
  gold: LabelId;
  teacher: LabelId;
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
    gold: 'experience',
    teacher: 'experience',
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
    gold: 'experience',
    teacher: 'experience',
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
    gold: 'discussion',
    teacher: 'discussion',
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
    gold: 'entertainment',
    teacher: 'entertainment',
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
    gold: 'discussion',
    teacher: 'discussion',
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
    gold: 'entertainment',
    teacher: 'entertainment',
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
    gold: 'ecosystem',
    teacher: 'ecosystem',
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
    gold: 'entertainment',
    teacher: 'discussion',
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
    gold: 'experience',
    teacher: 'experience',
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
    gold: 'discussion',
    teacher: 'discussion',
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
    gold: 'ecosystem',
    teacher: 'ecosystem',
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
    gold: 'discussion',
    teacher: 'entertainment',
    hue: 160,
  },
];

export const POST_BY_ID = Object.fromEntries(POSTS.map(p => [p.id, p])) as Record<string, Post>;

/** The posts Lin labels in the labeling panel. */
export const LABELING_POSTS = ['p03', 'p06', 'p09', 'p11', 'p05'];

/** The disagreement Lin resolves in the chat. */
export const DISAGREEMENT = {
  postId: 'p12',
  votes: [
    {labeler: 'Mei', label: 'discussion' as LabelId},
    {labeler: 'Ravi', label: 'entertainment' as LabelId},
  ],
};
