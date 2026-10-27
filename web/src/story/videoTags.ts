import {t} from '@/i18n/text';
import {LABEL_BY_ID} from '@/mock/fields';
import {
  invalidRate,
  LEARNING_CURVE,
  LABELING,
  macroF1,
  PROMPT_RUNS,
  RELEASE_GATE,
  TEACHER_GATE,
  TEST_RUNS,
  valueScores,
  weakestLabel,
} from '@/mock/metrics';
import {fmt2, pct} from '@/mock/numbers';
import {CONFLICT_TOTALS} from '@/mock/posts';
import type {Step} from './types';

/** Workflow stages shown in the stage strip. Index 5 depends on Platform S, which is not integrated yet. */
export const STAGES = [
  {name: t('Requirement', '定义需求')},
  {name: t('Dataset', '数据集')},
  {name: t('Human labeling', '人工标注')},
  {name: t('Teacher tuning', '教师调优')},
  {name: t('Training set', '训练集')},
  {name: t('Train & evaluate', '训练与评估'), isPlanned: true},
  {name: t('Release gate', '发布门禁')},
];

export const RELEASED_STAGE = STAGES.length;

// Numbers the agent quotes, computed from src/mock/metrics.ts so the chat and the pages agree.
const {v1, v2, v3} = PROMPT_RUNS;
const scoreOf = (run: typeof v1, field: 'primary_value' | 'format' | 'topics', id: string) => valueScores(run, field).find(s => s.id === id)!;
const v1Weakest = weakestLabel(v1);
const v1EcoInvalid = v1.primary_value.invalid[3];
const v1Invalid = v1.primary_value.invalid.reduce((a, b) => a + b, 0);
const v2DiscPrecision = scoreOf(v2, 'primary_value', 'discussion').precision;
const v2EntAsDisc = v2.primary_value.matrix[0][2];
const topicTags = (run: typeof v1) => run.topics.reduce((a, [tp, fp]) => a + tp + fp, 0) / 600;
const goldTags = v2.topics.reduce((a, [tp, , fn]) => a + tp + fn, 0) / 600;
const conflictTotal = CONFLICT_TOTALS.primary_value + CONFLICT_TOTALS.format + CONFLICT_TOTALS.topics;
const curveEnd = LEARNING_CURVE[LEARNING_CURVE.length - 1];
const curvePrev = LEARNING_CURVE[LEARNING_CURVE.length - 2];
const lateGain = Math.max(...(['primary_value', 'format', 'topics'] as const).map(f => curveEnd.f1[f] - curvePrev.f1[f]));
const studentShare = curveEnd.f1.primary_value / macroF1(v3);
const test = {
  student: {p: macroF1(TEST_RUNS.student), f: macroF1(TEST_RUNS.student, 'format'), t: macroF1(TEST_RUNS.student, 'topics')},
  teacher: {p: macroF1(TEST_RUNS.teacher), f: macroF1(TEST_RUNS.teacher, 'format'), t: macroF1(TEST_RUNS.teacher, 'topics')},
};
const studentWeakest = weakestLabel(TEST_RUNS.student);

/**
 * The scripted conversation for the "Video tags" model. Prompt text lives in
 * docs/demo/video-tagging-prompt-v1.md; every number is computed above.
 */
export const VIDEO_TAGS_STEPS: Step[] = [
  {
    stage: 0,
    waitFor: 'q-repost',
    items: [
      {
        kind: 'user',
        text: t(
          'I need a model that tags short videos with three fields: the main value for viewers, the format, and one to three topics. Our ops team already has a teacher prompt for it.',
          '我需要一个给短视频打标签的模型，三个字段：对观众的主要价值、视频形式，以及 1 到 3 个话题。运营团队已经有一份教师 Prompt。',
        ),
      },
      {
        kind: 'agent',
        tools: [
          {name: 'read_prompt', target: t('video-tagging-prompt-v1.md', 'video-tagging-prompt-v1.md'), duration: '0.4s'},
          {name: 'draft_schema', target: t('3 fields · 20 values', '3 个字段 · 20 个取值'), duration: '2.6s'},
        ],
        text: t(
          'I read the prompt and drafted **schema v1**: three label fields, with a definition for every value, examples for primary value, and the prompt’s judgment order and rules. `summary` and `reasoning` stay teacher-only, so the student won’t learn them.\n\nOne case is ambiguous, so I need your call before you confirm it.',
          '我读了 Prompt，起草了 **Schema v1**：三个标签字段，每个取值都有定义，主要价值还附有示例，并保留了 Prompt 里的判断顺序和规则。`summary` 和 `reasoning` 只给教师模型用，学生模型不学。\n\n有一个情况有歧义，确认前需要你来定。',
        ),
      },
      {kind: 'artifact', panel: 'schema', action: 'created', title: t('Schema v1', 'Schema v1'), detail: t('3 fields · 20 values', '3 个字段 · 20 个取值')},
      {
        kind: 'card',
        card: {
          type: 'question',
          id: 'q-repost',
          title: t('A reposted interview where the poster adds no comment of their own: which primary value?', '原样转发的访谈，发布者没有补充自己的观点，主要价值应该是哪一类？'),
          body: t(
            'The guests share views, so it can look like Discussion. Rule 1 of your prompt says only the poster’s own contribution counts.',
            '访谈嘉宾在表达观点，看起来像“讨论”。但你的 Prompt 第 1 条规定只看发布者自己的贡献。',
          ),
          options: [
            {id: 'entertainment', label: t('Entertainment', '娱乐')},
            {id: 'discussion', label: t('Discussion', '讨论')},
          ],
          recommended: 'entertainment',
          reason: t('Rule 1: words spoken by guests in a clip are not the poster’s view.', '依据第 1 条：片段里嘉宾说的话不算发布者的观点。'),
        },
      },
    ],
  },
  {
    stage: 0,
    waitFor: 'a-schema',
    items: [
      {kind: 'choice', cardId: 'q-repost'},
      {
        kind: 'reply',
        cardId: 'q-repost',
        replies: {
          entertainment: t(
            'Thanks. I added it to Entertainment as an example and to Discussion as a counterexample. The schema is ready for your sign-off.',
            '好的。我把它加进了“娱乐”的正例和“讨论”的反例。Schema 可以确认了。',
          ),
          discussion: t(
            'Noted: reposted interviews count as Discussion. That contradicts rule 1, so I flagged the rule for you to update. The schema is ready for your sign-off.',
            '已记录：转发的访谈算“讨论”。这和第 1 条矛盾，我已标记出来等你修改。Schema 可以确认了。',
          ),
        },
      },
      {kind: 'artifact', panel: 'schema', action: 'updated', title: t('Schema v1', 'Schema v1'), detail: t('Added your ruling as an example', '已把你的裁决加为示例')},
      {
        kind: 'card',
        card: {
          type: 'approval',
          id: 'a-schema',
          title: t('Confirm schema v1', '确认 Schema v1'),
          rows: [
            {label: t('Label fields', '标签字段'), value: t('primary_value · format · topics', 'primary_value · format · topics')},
            {label: t('Field types', '字段类型'), value: t('single · single · multi (1 to 3)', '单选 · 单选 · 多选（1 到 3 个）')},
            {label: t('Teacher-only fields', '仅教师模型字段'), value: 'summary, reasoning'},
          ],
          approve: t('Confirm schema', '确认 Schema'),
          panel: 'schema',
        },
      },
    ],
  },
  {
    stage: 1,
    waitFor: 'a-sampling',
    items: [
      {kind: 'choice', cardId: 'a-schema'},
      {kind: 'system', text: t('Schema v1 confirmed', 'Schema v1 已确认')},
      {
        kind: 'agent',
        tools: [
          {name: 'sample_posts', target: t('last 30 days · 23 countries', '近 30 天 · 23 个国家'), duration: '41s'},
          {name: 'extract_features', target: t('frames, OCR, ASR', '抽帧、OCR、ASR'), duration: '18m'},
          {name: 'find_near_duplicates', target: t('50,000 posts', '50,000 条帖子'), duration: '2m'},
        ],
        text: t(
          'Next, the dataset. I sampled **50,000 posts** from the last 30 days across 23 countries and extracted frames, OCR and ASR for each. 6% were near-duplicates, so I grouped them to keep each group in one split. I also split by creator, so no creator appears in both training and test.',
          '接下来是数据集。我从近 30 天、23 个国家的内容里抽样了 **50,000 条帖子**，并为每条抽取了视频帧、OCR 和 ASR。其中 6% 是近似重复，我把它们分组，保证同组只落在一个划分里。我还按作者划分，同一作者不会同时出现在训练集和测试集。',
        ),
      },
      {kind: 'artifact', panel: 'samples', action: 'created', title: t('Dataset snapshot ds-1', '数据快照 ds-1'), detail: t('50,000 posts · 3 splits', '50,000 条帖子 · 3 个划分')},
      {
        kind: 'card',
        card: {
          type: 'approval',
          id: 'a-sampling',
          title: t('Approve the sampling plan', '批准抽样方案'),
          rows: [
            {label: t('Source', '来源'), value: t('Posts published in the last 30 days', '近 30 天发布的帖子')},
            {label: t('Sampling', '抽样'), value: t('Stratified by country and format', '按国家和内容形式分层')},
            {label: t('Splits', '划分'), value: t('Train 49,000 · eval 600 · test 400', '训练 49,000 · 评估 600 · 测试 400')},
          ],
          approve: t('Approve plan', '批准方案'),
          panel: 'samples',
        },
      },
    ],
  },
  {
    stage: 2,
    waitFor: 'l-label',
    items: [
      {kind: 'choice', cardId: 'a-sampling'},
      {
        kind: 'agent',
        tools: [{name: 'create_labeling_task', target: t('1,000 posts · 3 fields · 3 labelers', '1,000 条 · 3 个字段 · 3 位标注员'), duration: '0.8s'}],
        text: t(
          'I created a labeling task for the eval and test splits: **1,000 posts**, each labeled on all three fields by two of Lin, Mei and Ravi, so we can measure agreement. Labeling is blind; the teacher’s answer stays hidden unless you reveal it.',
          '我为评估集和测试集建了标注任务：**1,000 条帖子**，每条由 Lin、Mei、Ravi 中的两人标注全部三个字段，用来衡量一致性。标注是盲标的，教师模型的答案默认隐藏，除非你主动查看。',
        ),
      },
      {kind: 'artifact', panel: 'labeling', action: 'created', title: t('Labeling task', '标注任务'), detail: t('1,000 posts · your share: 5', '1,000 条 · 你的部分：5 条')},
      {
        kind: 'card',
        card: {
          type: 'link',
          id: 'l-label',
          title: t('Your share: label 5 posts', '你的任务：标注 5 条帖子'),
          description: t('About 3 minutes. Each post shows frames, title, OCR and ASR, with the field definitions beside it.', '大约 3 分钟。每条帖子展示视频帧、标题、OCR 和 ASR，旁边附有字段定义。'),
          panel: 'labeling',
          cta: t('Start labeling', '开始标注'),
          skip: t('Skip for now', '先跳过'),
          doneLabel: t('I labeled my 5 posts', '我标完了 5 条'),
        },
      },
    ],
  },
  {
    stage: 2,
    waitFor: 'pr-label',
    items: [
      {kind: 'choice', cardId: 'l-label'},
      {kind: 'agent', text: t('Thanks. Mei and Ravi are labeling the rest.', '谢谢。Mei 和 Ravi 正在标剩下的部分。')},
      {
        kind: 'card',
        card: {type: 'progress', id: 'pr-label', title: t('Labeling the eval and test splits', '标注评估集和测试集'), total: 1000, unit: t('posts', '条'), durationMs: 4000},
      },
    ],
  },
  {
    stage: 2,
    waitFor: 'l-adj',
    items: [
      {
        kind: 'card',
        card: {
          type: 'result',
          id: 'r-agree',
          title: t('Labeling finished', '标注完成'),
          stats: [
            {label: t('Agreement · primary value', 'Agreement (α) · 主要价值'), value: fmt2(LABELING.alpha.primary_value)},
            {label: t('Agreement · format', 'Agreement (α) · 形式'), value: fmt2(LABELING.alpha.format)},
            {label: t('Agreement · topics', 'Agreement (α) · 话题'), value: fmt2(LABELING.alpha.topics)},
            {label: t('Disagreements', '分歧'), value: String(conflictTotal)},
          ],
          note: t(
            'Agreement is Krippendorff’s alpha. Most primary-value disagreements are personal stories told as vlogs, and reposted clips. Most topic disagreements are a second topic that one labeler added.',
            'Agreement 用 Krippendorff’s alpha 衡量。主要价值的分歧大多来自用 vlog 讲的个人经历和转发的片段；话题的分歧大多是某位标注员多加了一个话题。',
          ),
        },
      },
      {
        kind: 'artifact',
        panel: 'adjudication',
        action: 'created',
        title: t('Disagreements', '分歧裁决'),
        detail: t(`${conflictTotal} disagreements · a suggestion for each`, `${conflictTotal} 条分歧 · 每条都有建议`),
      },
      {
        kind: 'card',
        card: {
          type: 'link',
          id: 'l-adj',
          title: t(`Resolve ${conflictTotal} disagreements`, `裁决 ${conflictTotal} 条分歧`),
          description: t(
            'I suggested an answer for each one, with the rule it rests on. Review them on the disagreements page, or accept all my suggestions.',
            '我为每条分歧给出了建议答案，并注明依据的规则。你可以在分歧页面逐条查看，也可以直接接受全部建议。',
          ),
          panel: 'adjudication',
          cta: t('Review disagreements', '查看分歧'),
          skip: t('Accept all suggestions', '接受全部建议'),
          doneLabel: t('I resolved the disagreements', '我裁决完了分歧'),
        },
      },
    ],
  },
  {
    stage: 3,
    waitFor: 'pr-v1',
    items: [
      {kind: 'choice', cardId: 'l-adj'},
      {
        kind: 'agent',
        tools: [{name: 'derive_gold_labels', target: t('2 labels per post + adjudication', '每条 2 份标注 + 裁决'), duration: '0.3s'}],
        text: t(
          '**Gold labels v1** are ready: 600 eval posts and 400 test posts. The test split is now sealed, and I only ever see its totals.\n\nNow I’ll run the teacher on the eval split with your prompt as **v1**.',
          '**金标 v1** 已就绪：评估集 600 条，测试集 400 条。测试集现已封存，我只能看到汇总指标。\n\n现在我用你的 Prompt 作为 **v1**，在评估集上运行教师模型。',
        ),
      },
      {
        kind: 'card',
        card: {type: 'progress', id: 'pr-v1', title: t('Teacher on the eval split · prompt v1', '教师模型 · 评估集 · Prompt v1'), total: 600, unit: t('posts', '条'), durationMs: 3500},
      },
    ],
  },
  {
    stage: 3,
    waitFor: 'adv-1',
    items: [
      {kind: 'artifact', panel: 'evalReport', action: 'created', title: t('Eval report · prompt v1', '评估报告 · Prompt v1'), detail: t('3 fields on 600 posts', '600 条帖子 · 3 个字段')},
      {
        kind: 'card',
        card: {
          type: 'result',
          id: 'r-v1',
          title: t('Prompt v1 results', 'Prompt v1 结果'),
          stats: [
            {label: t('Macro-F1 · primary value', 'macro-F1 · 主要价值'), value: fmt2(macroF1(v1))},
            {label: t('Invalid outputs', 'Invalid outputs'), value: pct(invalidRate(v1), 1)},
            {label: t(`Weakest: ${LABEL_BY_ID[v1Weakest.id].name.en}`, `最弱：${LABEL_BY_ID[v1Weakest.id].name.zh}`), value: fmt2(v1Weakest.f1)},
          ],
          panel: 'evalReport',
        },
      },
      {
        kind: 'card',
        card: {
          type: 'advice',
          id: 'adv-1',
          title: t('Name the values exactly in the output section', '在输出部分写准确的取值'),
          diagnosis: t(
            `${v1Invalid} outputs (${pct(invalidRate(v1), 1)}) were invalid, and ${v1EcoInvalid} of them wrote “Ecosystem”: that’s how the output section names it, but the field defines “Ecosystem issue”. That is why Ecosystem scores only ${fmt2(v1Weakest.f1)}.`,
            `${v1Invalid} 条输出（${pct(invalidRate(v1), 1)}）无效，其中 ${v1EcoInvalid} 条写的是“Ecosystem”：输出部分是这么写的，但字段定义的取值是“Ecosystem issue”。这就是生态问题只有 ${fmt2(v1Weakest.f1)} 的原因。`,
          ),
          removed: ['"primary_value": "Entertainment | Practical | Discussion | Ecosystem",'],
          added: ['"primary_value": "Entertainment | Practical | Discussion | Ecosystem issue",'],
          from: 'v1',
          to: 'v2',
          measures: [{kind: 'macro', field: 'primary_value'}, {kind: 'value', field: 'primary_value', value: 'ecosystem'}, {kind: 'invalid'}],
        },
      },
    ],
  },
  {
    stage: 3,
    waitFor: 'adv-2',
    items: [
      {kind: 'choice', cardId: 'adv-1'},
      {
        kind: 'agent',
        tools: [
          {name: 'create_prompt_version', target: t('v2', 'v2'), duration: '0.2s'},
          {name: 'cluster_errors', target: t('Discussion · topics', '讨论 · 话题'), duration: '6s'},
        ],
        text: t(
          `Adopted as **prompt v2**. Invalid outputs are down to ${pct(invalidRate(v2), 1)}, and Ecosystem rose to ${fmt2(scoreOf(v2, 'primary_value', 'ecosystem').f1)}. Two things still miss the gate, so I looked at their errors.`,
          `已采纳，生成 **Prompt v2**。无效输出降到 ${pct(invalidRate(v2), 1)}，生态问题升到 ${fmt2(scoreOf(v2, 'primary_value', 'ecosystem').f1)}。还有两处没过门禁，我分析了它们的错误。`,
        ),
      },
      {kind: 'artifact', panel: 'promptDiff', action: 'created', title: t('Prompt v2', 'Prompt v2'), detail: t('Full prompt, editable', 'Prompt 全文，可编辑')},
      {kind: 'artifact', panel: 'evalReport', action: 'updated', title: t('Eval report · prompt v2', '评估报告 · Prompt v2'), detail: t('Re-scored on 600 posts', '在 600 条上重新评估')},
      {
        kind: 'card',
        card: {
          type: 'advice',
          id: 'adv-2',
          title: t('Check the poster’s own view before Discussion, and tag fewer topics', '判断“讨论”前先看发布者自己的观点，并少打话题'),
          diagnosis: t(
            `Discussion precision is ${fmt2(v2DiscPrecision)}: ${v2EntAsDisc} Entertainment posts were tagged Discussion, mostly clips where only the guests give views. Rule 1 covers this but sits far from the field. Topics has the opposite problem: the teacher adds ${topicTags(v2).toFixed(1)} topics per post where people add ${goldTags.toFixed(1)}.`,
            `“讨论”的 Precision 只有 ${fmt2(v2DiscPrecision)}：${v2EntAsDisc} 条娱乐被标成了讨论，大多是只有嘉宾在表达观点的片段。第 1 条规则覆盖了这种情况，但离字段定义太远。话题的问题正相反：教师模型平均每条打 ${topicTags(v2).toFixed(1)} 个话题，而人工只打 ${goldTags.toFixed(1)} 个。`,
          ),
          removed: ['- Discussion: the poster shares their own view or experience and invites others to respond.', '### 3. topics (pick 1 to 3)'],
          added: [
            '- Discussion: the poster shares their own view or experience and invites others to respond.',
            '  First check rule 1: a Clip with no comment from the poster is not Discussion.',
            '### 3. topics (pick 1 to 3; pick 1 unless the post clearly covers more)',
          ],
          from: 'v2',
          to: 'v3',
          measures: [{kind: 'macro', field: 'primary_value'}, {kind: 'value', field: 'primary_value', value: 'discussion'}, {kind: 'macro', field: 'topics'}],
        },
      },
    ],
  },
  {
    stage: 3,
    waitFor: 'a-teacher-gate',
    items: [
      {kind: 'choice', cardId: 'adv-2'},
      {
        kind: 'agent',
        text: t(
          `Adopted as **prompt v3**. Discussion F1 rose from ${fmt2(scoreOf(v2, 'primary_value', 'discussion').f1)} to ${fmt2(scoreOf(v3, 'primary_value', 'discussion').f1)} and topics from ${fmt2(macroF1(v2, 'topics'))} to ${fmt2(macroF1(v3, 'topics'))}. The teacher now passes the quality gate on all three fields.`,
          `已采纳，生成 **Prompt v3**。“讨论”的 F1 从 ${fmt2(scoreOf(v2, 'primary_value', 'discussion').f1)} 升到 ${fmt2(scoreOf(v3, 'primary_value', 'discussion').f1)}，话题从 ${fmt2(macroF1(v2, 'topics'))} 升到 ${fmt2(macroF1(v3, 'topics'))}。教师模型现在三个字段都通过了质量门禁。`,
        ),
      },
      {kind: 'artifact', panel: 'promptDiff', action: 'updated', title: t('Prompt v3', 'Prompt v3'), detail: t('3 lines changed', '修改 3 行')},
      {kind: 'artifact', panel: 'evalReport', action: 'updated', title: t('Eval report · prompt v3', '评估报告 · Prompt v3'), detail: t('Re-scored on 600 posts', '在 600 条上重新评估')},
      {
        kind: 'card',
        card: {
          type: 'approval',
          id: 'a-teacher-gate',
          title: t('Teacher-quality gate', '教师质量门禁'),
          checks: [
            {label: t(`Primary value macro-F1 ≥ ${TEACHER_GATE.macroF1.primary_value}`, `主要价值 macro-F1 ≥ ${TEACHER_GATE.macroF1.primary_value}`), value: fmt2(macroF1(v3)), pass: true},
            {label: t(`Every primary value ≥ ${fmt2(TEACHER_GATE.labelF1)}`, `每个主要价值 ≥ ${fmt2(TEACHER_GATE.labelF1)}`), value: t(`lowest ${fmt2(weakestLabel(v3).f1)}`, `最低 ${fmt2(weakestLabel(v3).f1)}`), pass: true},
            {label: t(`Format macro-F1 ≥ ${TEACHER_GATE.macroF1.format}`, `形式 macro-F1 ≥ ${TEACHER_GATE.macroF1.format}`), value: fmt2(macroF1(v3, 'format')), pass: true},
            {label: t(`Topics macro-F1 ≥ ${fmt2(TEACHER_GATE.macroF1.topics)}`, `话题 macro-F1 ≥ ${fmt2(TEACHER_GATE.macroF1.topics)}`), value: fmt2(macroF1(v3, 'topics')), pass: true},
            {label: t('Invalid outputs ≤ 1%', 'Invalid outputs ≤ 1%'), value: pct(invalidRate(v3), 1), pass: true},
          ],
          approve: t('Pass the gate', '通过门禁'),
          panel: 'evalReport',
        },
      },
    ],
  },
  {
    stage: 4,
    waitFor: 'a-cost',
    items: [
      {kind: 'choice', cardId: 'a-teacher-gate'},
      {kind: 'system', text: t('Teacher-quality gate passed', '教师质量门禁已通过')},
      {
        kind: 'agent',
        tools: [{name: 'run_pilot', target: t('500 posts vs. gold labels', '500 条 vs. 金标'), duration: '3m'}],
        text: t(
          'Next, the teacher labels the **49,000 training posts**. I ran a 500-post pilot first. It matches your gold labels on primary value **91%** of the time, so the full run is worth paying for.',
          '接下来由教师模型标注 **49,000 条训练帖子**。我先跑了 500 条试点，主要价值与金标的一致率为 **91%**，值得跑全量。',
        ),
      },
      {
        kind: 'card',
        card: {
          type: 'approval',
          id: 'a-cost',
          title: t('Approve training-set generation', '批准生成训练集'),
          rows: [
            {label: t('Posts', '帖子'), value: '49,000'},
            {label: t('Mode', '模式'), value: t('Batch · about 50% of the online price', '批量 · 约为在线价格的 50%')},
            {label: t('Estimated cost', '预估费用'), value: '$410'},
            {label: t('Estimated time', '预计耗时'), value: t('about 5 h', '约 5 小时')},
            {label: t('Prompt', 'Prompt'), value: 'v3'},
          ],
          approve: t('Approve cost', '批准费用'),
        },
      },
    ],
  },
  {
    stage: 4,
    waitFor: 'pr-batch',
    items: [
      {kind: 'choice', cardId: 'a-cost'},
      {
        kind: 'card',
        card: {type: 'progress', id: 'pr-batch', title: t('Teacher batch job · prompt v3', '教师模型批量任务 · Prompt v3'), total: 49000, unit: t('posts', '条'), durationMs: 5000},
      },
    ],
  },
  {
    stage: 5,
    waitFor: 'pr-train',
    items: [
      {
        kind: 'agent',
        tools: [
          {name: 'filter_invalid', target: t('−147 rows', '−147 行'), duration: '1s'},
          {name: 'deduplicate', target: t('−2,641 rows', '−2,641 行'), duration: '40s'},
          {name: 'decontaminate', target: t('−212 rows overlapping eval/test', '−212 行与评估/测试集重叠'), duration: '25s'},
        ],
        text: t(
          'The training set is ready: **46,000 rows**. I removed invalid outputs, near-duplicates and posts that overlap eval or test, then capped Entertainment and raised Ecosystem issue to a minimum share.\n\nTraining runs on Platform S, which isn’t connected yet, so the results from here on are illustrative.',
          '训练集已就绪：**46,000 行**。我去掉了无效输出、近似重复和与评估/测试集重叠的帖子，并限制了娱乐的占比、把生态问题提到最低占比。\n\n训练在 Platform S 上进行，目前还没接通，所以接下来的结果是示意数据。',
        ),
      },
      {kind: 'artifact', panel: 'trainingSet', action: 'created', title: t('Training set ts-1', '训练集 ts-1'), detail: t('46,000 rows · prompt v3', '46,000 行 · Prompt v3')},
      {
        kind: 'card',
        card: {type: 'progress', id: 'pr-train', title: t('Training student 8B · 10k / 30k / 46k', '训练学生模型 8B · 10k / 30k / 46k'), total: 3, unit: t('runs', '次'), durationMs: 4500},
      },
    ],
  },
  {
    stage: 5,
    waitFor: 'q-more',
    items: [
      {kind: 'artifact', panel: 'runs', action: 'created', title: t('Training runs', '训练记录'), detail: t('3 runs · 10k / 30k / 46k', '3 次 · 10k / 30k / 46k')},
      {
        kind: 'card',
        card: {
          type: 'result',
          id: 'r-runs',
          title: t('Training finished', '训练完成'),
          stats: [
            {label: t('46k · primary value on eval', '46k · 评估集主要价值'), value: fmt2(curveEnd.f1.primary_value)},
            {label: t('Gain from 30k to 46k', '30k 到 46k 的提升'), value: `≤ ${fmt2(lateGain)}`},
            {label: t('Student vs. teacher', '学生 vs. 教师'), value: pct(studentShare)},
          ],
          note: t('More data barely helps now, so I’d stop at 46k.', '再加数据收益很小了，建议停在 46k。'),
          panel: 'runs',
        },
      },
      {
        kind: 'card',
        card: {
          type: 'question',
          id: 'q-more',
          title: t('Stop at 46k and take it to the release gate?', '停在 46k，进入发布门禁？'),
          options: [
            {id: 'stop', label: t('Stop at 46k', '停在 46k')},
            {id: 'more', label: t('Generate 100k more (+$840, +9 h)', '再生成 10 万条（+$840，+9 小时）')},
          ],
          recommended: 'stop',
          reason: t(`Every field gained ${fmt2(lateGain)} or less from 30k to 46k.`, `从 30k 到 46k，每个字段的提升都不超过 ${fmt2(lateGain)}。`),
        },
      },
    ],
  },
  {
    stage: 6,
    waitFor: 'a-release',
    items: [
      {kind: 'choice', cardId: 'q-more'},
      {
        kind: 'reply',
        cardId: 'q-more',
        replies: {
          stop: t('Taking the 46k run to the release gate.', '用 46k 这一版进入发布门禁。'),
          more: t('In a real project I’d launch that job now. For this demo, let’s take the 46k run to the release gate.', '在真实项目里我会马上启动这个任务。演示里我们先用 46k 这一版进入发布门禁。'),
        },
      },
      {
        kind: 'agent',
        tools: [{name: 'evaluate', target: t('sealed test split · 400 posts', '封存测试集 · 400 条'), duration: '2m'}],
        text: t(
          `On the sealed **test split** (400 posts), the student scores macro-F1 **${fmt2(test.student.p)}** on primary value, ${fmt2(test.student.f)} on format and ${fmt2(test.student.t)} on topics, against the teacher’s ${fmt2(test.teacher.p)}, ${fmt2(test.teacher.f)} and ${fmt2(test.teacher.t)}. Every field clears its minimum; the weakest label is ${LABEL_BY_ID[studentWeakest.id].name.en} at ${fmt2(studentWeakest.f1)}.`,
          `在封存的**测试集**（400 条）上，学生模型的 macro-F1：主要价值 **${fmt2(test.student.p)}**、形式 ${fmt2(test.student.f)}、话题 ${fmt2(test.student.t)}；教师模型分别为 ${fmt2(test.teacher.p)}、${fmt2(test.teacher.f)}、${fmt2(test.teacher.t)}。每个字段都过了最低线，最弱的标签是“${LABEL_BY_ID[studentWeakest.id].name.zh}”，${fmt2(studentWeakest.f1)}。`,
        ),
      },
      {kind: 'artifact', panel: 'gate', action: 'created', title: t('Release gate report', '发布门禁报告'), detail: t('Student 8B · 400 test posts', '学生模型 8B · 400 条测试帖子')},
      {
        kind: 'card',
        card: {
          type: 'approval',
          id: 'a-release',
          title: t('Release gate · student 8B', '发布门禁 · 学生模型 8B'),
          checks: [
            {label: t(`Primary value ≥ ${RELEASE_GATE.macroF1.primary_value}`, `主要价值 ≥ ${RELEASE_GATE.macroF1.primary_value}`), value: fmt2(test.student.p), pass: true},
            {label: t(`Format ≥ ${RELEASE_GATE.macroF1.format}`, `形式 ≥ ${RELEASE_GATE.macroF1.format}`), value: fmt2(test.student.f), pass: true},
            {label: t(`Topics ≥ ${RELEASE_GATE.macroF1.topics}`, `话题 ≥ ${RELEASE_GATE.macroF1.topics}`), value: fmt2(test.student.t), pass: true},
            {label: t('Regression vs. current model', '相对线上模型的回退'), value: t('none · first model', '无 · 首个模型'), pass: true},
          ],
          approve: t('Approve release', '批准发布'),
          panel: 'gate',
        },
      },
    ],
  },
  {
    stage: 7,
    items: [
      {kind: 'choice', cardId: 'a-release'},
      {kind: 'system', text: t('Video tags v1 released', '视频标签 v1 已发布')},
      {
        kind: 'agent',
        text: t(
          'Released. From your first message to an approved model took **6 working days** and about **14 hours** of human time, mostly labeling, with no engineer hours. Today the same job takes about 4 weeks and 40 engineer hours.\n\nA shadow run and an A/B test come next. They’re planned for after the MVP.',
          '已发布。从你的第一条消息到模型通过审批，用了 **6 个工作日**，人工时间约 **14 小时**（主要是标注），工程师时间为零。现在同样的事大约需要 4 周和 40 个工程师小时。\n\n接下来是影子运行和 A/B 实验，计划在 MVP 之后上线。',
        ),
      },
      {kind: 'artifact', panel: 'efficiency', action: 'created', title: t('Efficiency report', '效率对比'), detail: t('6 working days vs. 4 weeks today', '6 个工作日 vs. 现在的 4 周')},
    ],
  },
];
