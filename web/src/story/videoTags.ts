import {t} from '@/i18n/text';
import {LABEL_BY_ID} from '@/mock/fields';
import {invalidRate, LEARNING_CURVE, LABELING, macroF1, PROMPT_RUNS, RELEASE_GATE, SPLITS, TEACHER_GATE, TEST_RUNS, TRAINING_SET, valueScores, weakestLabel} from '@/mock/metrics';
import {fmt2, pct} from '@/mock/numbers';
import {CONFLICT_TOTALS} from '@/mock/posts';
import type {Step} from './types';

/** Workflow stages shown in the side panel. Training depends on Platform S, which is not integrated yet. */
export const STAGES = [
  {name: t('Schema', 'Schema')},
  {name: t('Dataset', '数据集')},
  {name: t('Gold labels', '金标')},
  {name: t('Teacher prompt', '教师 Prompt')},
  {name: t('Training set', '训练集')},
  {name: t('Training', '训练'), isPlanned: true},
  {name: t('Release', '发布')},
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
  student: {
    p: macroF1(TEST_RUNS.student),
    f: macroF1(TEST_RUNS.student, 'format'),
    t: macroF1(TEST_RUNS.student, 'topics'),
  },
  teacher: {
    p: macroF1(TEST_RUNS.teacher),
    f: macroF1(TEST_RUNS.teacher, 'format'),
    t: macroF1(TEST_RUNS.teacher, 'topics'),
  },
};
const studentWeakest = weakestLabel(TEST_RUNS.student);
const num = (n: number) => n.toLocaleString('en-US');

const HUMAN_GOLD = t('Human gold labels', '人工金标');
const NO_LABELS = {
  train: {total: SPLITS.train, labeled: 0},
  eval: {total: SPLITS.eval, labeled: 0},
  test: {total: SPLITS.test, labeled: 0},
};
const GOLD = {
  ...NO_LABELS,
  eval: {total: SPLITS.eval, labeled: SPLITS.eval, source: HUMAN_GOLD},
  test: {total: SPLITS.test, labeled: SPLITS.test, source: HUMAN_GOLD},
};

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
          {
            name: 'read_prompt',
            target: t('video-tagging-prompt-v1.md', 'video-tagging-prompt-v1.md'),
            duration: '0.4s',
          },
          {
            name: 'draft_schema',
            target: t('3 fields · 20 values', '3 个字段 · 20 个取值'),
            duration: '2.6s',
          },
        ],
        text: t(
          'I read the prompt and drafted the **schema**: three label fields with a definition for every value, plus the prompt’s rules. `summary` and `reasoning` stay teacher-only, so the student won’t learn them.\n\nOne case is ambiguous, so I need your call before you confirm it.',
          '我读了 Prompt，起草了 **Schema**：三个标签字段，每个取值都有定义，并保留了 Prompt 里的规则。`summary` 和 `reasoning` 只给教师模型用，学生模型不学。\n\n有一个情况有歧义，确认前需要你来定。',
        ),
      },
      {
        kind: 'artifact',
        panel: 'schema',
        action: 'created',
        title: t('Schema', 'Schema'),
        version: 'v1',
        detail: t('3 label fields', '3 个标签字段'),
      },
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
      {
        kind: 'artifact',
        panel: 'schema',
        action: 'updated',
        title: t('Schema', 'Schema'),
        version: 'v1',
        detail: t('Added your ruling as an example', '已把你的裁决加为示例'),
      },
      {
        kind: 'card',
        card: {
          type: 'approval',
          id: 'a-schema',
          title: t('Confirm the schema', '确认 Schema'),
          approve: t('Confirm schema', '确认 Schema'),
          panel: 'schema',
        },
      },
    ],
  },
  {
    stage: 1,
    waitFor: 'q-dataset',
    items: [
      {kind: 'choice', cardId: 'a-schema'},
      {kind: 'system', text: t('Schema v1 confirmed', 'Schema v1 已确认')},
      {
        kind: 'agent',
        text: t(
          'Next, the dataset. You can upload a CSV of posts, with or without labels, or I can sample recent posts for you. Either way, the rows go through the same steps afterwards.\n\nYou have no labeled data for this task yet, so I recommend sampling: it matches what the model will see online.',
          '接下来是数据集。你可以上传帖子的 CSV（带不带标签都行），也可以让我从近期帖子里抽样。无论哪种，之后的处理步骤都一样。\n\n这个任务你还没有标注数据，所以我建议抽样：它和模型上线后看到的内容一致。',
        ),
      },
      {
        kind: 'card',
        card: {
          type: 'question',
          id: 'q-dataset',
          title: t('How do you want to build the dataset?', '数据集怎么来？'),
          options: [
            {id: 'upload', label: t('Upload a CSV', '上传 CSV')},
            {id: 'sample', label: t('Sample automatically', '自动抽样')},
          ],
          recommended: 'sample',
          reason: t('No labeled data exists for this task, and recent posts match live traffic.', '这个任务还没有标注数据，近期帖子也和线上流量一致。'),
        },
      },
    ],
  },
  {
    stage: 1,
    waitFor: 's-sample',
    items: [
      {kind: 'choice', cardId: 'q-dataset'},
      {
        kind: 'reply',
        cardId: 'q-dataset',
        replies: {
          sample: t('Here are the sampling settings I suggest. Change anything you like.', '这是我建议的抽样设置，可以随意修改。'),
          upload: t(
            'Uploading isn’t part of this demo, so let’s sample instead. An uploaded file would go through exactly the same steps. Here are the sampling settings I suggest.',
            '上传不在这个演示范围内，我们改用抽样。上传的文件会走完全相同的步骤。这是我建议的抽样设置。',
          ),
        },
      },
      {
        kind: 'card',
        card: {
          type: 'settings',
          id: 's-sample',
          title: t('Sampling settings', '抽样设置'),
          fields: [
            {
              id: 'posts',
              label: t('Number of posts', '帖子数量'),
              kind: 'number',
              value: SPLITS.pool,
              min: 1000,
              max: 500_000,
              step: 1000,
            },
            {
              id: 'window',
              label: t('Published in', '发布时间'),
              kind: 'select',
              value: '30',
              options: [
                {id: '7', label: t('Last 7 days', '近 7 天')},
                {id: '30', label: t('Last 30 days', '近 30 天')},
                {id: '90', label: t('Last 90 days', '近 90 天')},
              ],
            },
            {
              id: 'countries',
              label: t('Countries', '国家'),
              kind: 'select',
              value: 'all',
              options: [
                {id: 'all', label: t('All 23 countries', '全部 23 个国家')},
                {id: 'top5', label: t('Top 5 by traffic', '流量前 5 的国家')},
              ],
            },
            {
              id: 'stratify',
              label: t('Stratify by', '分层依据'),
              kind: 'select',
              value: 'country-format',
              options: [
                {
                  id: 'country-format',
                  label: t('Country and format', '国家和形式'),
                },
                {id: 'country', label: t('Country', '国家')},
                {id: 'none', label: t('None', '不分层')},
              ],
            },
          ],
          submit: t('Start sampling', '开始抽样'),
        },
      },
    ],
  },
  {
    stage: 1,
    waitFor: 'pr-sample',
    items: [
      {kind: 'choice', cardId: 's-sample'},
      {
        kind: 'agent',
        tools: [
          {
            name: 'sample_posts',
            target: t('last 30 days · 23 countries', '近 30 天 · 23 个国家'),
            duration: '41s',
          },
        ],
        text: t(
          'Sampling now. For each post I also extract frames, OCR and ASR, and group near-duplicates so each group stays in one split.',
          '正在抽样。我会同时为每条帖子抽取视频帧、OCR 和 ASR，并把近似重复的帖子分组，保证同组只落在一个划分里。',
        ),
      },
      {
        kind: 'card',
        card: {
          type: 'progress',
          id: 'pr-sample',
          title: t('Sampling posts', '抽样帖子'),
          total: SPLITS.pool,
          unit: t('posts', '条'),
          durationMs: 3500,
        },
      },
    ],
  },
  {
    stage: 1,
    waitFor: 's-split',
    items: [
      {
        kind: 'artifact',
        panel: 'samples',
        action: 'created',
        title: t('Dataset', '数据集'),
        version: 'v1',
        detail: t(`${num(SPLITS.pool)} posts`, `${num(SPLITS.pool)} 条帖子`),
      },
      {
        kind: 'agent',
        text: t(
          `**${num(SPLITS.pool)} posts** sampled from ${SPLITS.countries} countries and ${SPLITS.languages} languages. ${pct(SPLITS.nearDuplicateShare)} were near-duplicates, now grouped.\n\nNext, how to split them. I suggest ${num(SPLITS.eval)} posts for eval and ${num(SPLITS.test)} for test, labeled by people, and the rest for training, labeled by the teacher. Splitting by creator keeps any creator out of both training and test.`,
          `已抽样 **${num(SPLITS.pool)} 条帖子**，覆盖 ${SPLITS.countries} 个国家、${SPLITS.languages} 种语言。其中 ${pct(SPLITS.nearDuplicateShare)} 是近似重复，已分组。\n\n接下来是怎么划分。我建议评估集 ${num(SPLITS.eval)} 条、测试集 ${num(SPLITS.test)} 条，由人工标注；其余作为训练集，由教师模型标注。按作者划分，同一作者不会同时出现在训练集和测试集。`,
        ),
      },
      {
        kind: 'card',
        card: {
          type: 'settings',
          id: 's-split',
          title: t('Split the dataset', '划分数据集'),
          fields: [
            {
              id: 'eval',
              label: t('Eval', '评估集'),
              kind: 'number',
              value: SPLITS.eval,
              min: 100,
              max: 5000,
              step: 50,
            },
            {
              id: 'test',
              label: t('Test', '测试集'),
              kind: 'number',
              value: SPLITS.test,
              min: 100,
              max: 5000,
              step: 50,
            },
            {
              id: 'train',
              label: t('Train', '训练集'),
              kind: 'computed',
              compute: v => num(SPLITS.pool - Number(v.eval) - Number(v.test)),
            },
            {
              id: 'by',
              label: t('Keep together', '保持在同一划分'),
              kind: 'select',
              value: 'creator',
              options: [
                {
                  id: 'creator',
                  label: t('Same creator and near-duplicates', '同一作者和近似重复'),
                },
                {
                  id: 'random',
                  label: t('Nothing (random split)', '不限制（随机划分）'),
                },
              ],
            },
          ],
          submit: t('Create splits', '创建划分'),
          panel: 'samples',
        },
      },
    ],
  },
  {
    stage: 2,
    waitFor: 'q-order',
    datasets: NO_LABELS,
    items: [
      {kind: 'choice', cardId: 's-split'},
      {
        kind: 'artifact',
        panel: 'samples',
        action: 'updated',
        title: t('Dataset', '数据集'),
        version: 'v1',
        detail: t('Split into train, eval and test', '已划分训练、评估、测试集'),
      },
      {
        kind: 'agent',
        text: t(
          'The splits are ready; you can follow them under Dataset in the workflow on the left. Training can start once the training set has labels.\n\n**Next, I recommend gold labels for eval and test.** They are how we’ll measure the teacher prompt and the student, so they should come from people.\n\nOne choice first. The labeling page can show the teacher’s answer for a post, but only after a teacher prompt has run on it. You already have a prompt from your ops team, so I can run it on the 1,000 posts first. Labeling stays blind: people see the teacher’s answer only if they ask for it.',
          '划分已完成，可以在左侧流程的“数据集”里查看。训练集有标签后才能开始训练。\n\n**下一步，我建议给评估集和测试集做金标。** 我们要靠它们衡量教师 Prompt 和学生模型，所以应该由人来标。\n\n先要做个选择。标注页面可以展示教师模型对帖子的答案，但前提是教师 Prompt 已经在这些帖子上运行过。你已经有运营团队的 Prompt，我可以先在这 1,000 条上运行它。标注仍然是盲标的：只有标注员主动查看时才会看到教师的答案。',
        ),
      },
      {
        kind: 'card',
        card: {
          type: 'question',
          id: 'q-order',
          title: t('Label first, or run the teacher prompt first?', '先标注，还是先运行教师 Prompt？'),
          options: [
            {id: 'label', label: t('Label first', '先标注')},
            {id: 'prompt', label: t('Run the prompt first', '先运行 Prompt')},
          ],
          recommended: 'prompt',
          reason: t('Your prompt already exists, and labelers then can compare with the teacher when they’re stuck.', '你已经有 Prompt，标注员遇到难题时可以对照教师模型的答案。'),
        },
      },
    ],
  },
  {
    stage: 2,
    waitFor: 'l-label',
    items: [
      {kind: 'choice', cardId: 'q-order'},
      {
        kind: 'reply',
        cardId: 'q-order',
        replies: {
          prompt: t(
            'I ran your prompt as **v1** on the 1,000 eval and test posts. Its scores come once people have labeled them.',
            '我已用你的 Prompt 作为 **v1** 在 1,000 条评估和测试帖子上运行。等人工标完后才有它的分数。',
          ),
          label: t(
            'Labeling first, so the labeling page won’t show the teacher’s answer. I’ll run your prompt once the gold labels are in.',
            '先标注，所以标注页面不会展示教师模型的答案。金标完成后我再运行你的 Prompt。',
          ),
        },
      },
      {
        kind: 'agent',
        tools: [
          {
            name: 'create_labeling_task',
            target: t('1,000 posts · 3 fields · 3 labelers', '1,000 条 · 3 个字段 · 3 位标注员'),
            duration: '0.8s',
          },
        ],
        text: t(
          'I created a labeling task: **1,000 posts**, each labeled on all three fields by two of Lin, Mei and Ravi.',
          '我建了标注任务：**1,000 条帖子**，每条由 Lin、Mei、Ravi 中的两人标注全部三个字段。',
        ),
      },
      {
        kind: 'artifact',
        panel: 'labeling',
        action: 'created',
        title: t('Labeling task', '标注任务'),
        detail: t('1,000 posts · your share: 5', '1,000 条 · 你的部分：5 条'),
      },
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
      {
        kind: 'agent',
        text: t('Thanks. Mei and Ravi are labeling the rest.', '谢谢。Mei 和 Ravi 正在标剩下的部分。'),
      },
      {
        kind: 'card',
        card: {
          type: 'progress',
          id: 'pr-label',
          title: t('Labeling the eval and test splits', '标注评估集和测试集'),
          total: 1000,
          unit: t('posts', '条'),
          durationMs: 4000,
        },
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
            {
              label: t('Agreement · primary value', 'Agreement (α) · 主要价值'),
              value: fmt2(LABELING.alpha.primary_value),
            },
            {
              label: t('Agreement · format', 'Agreement (α) · 形式'),
              value: fmt2(LABELING.alpha.format),
            },
            {
              label: t('Agreement · topics', 'Agreement (α) · 话题'),
              value: fmt2(LABELING.alpha.topics),
            },
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
    datasets: GOLD,
    items: [
      {kind: 'choice', cardId: 'l-adj'},
      {
        kind: 'agent',
        tools: [
          {
            name: 'derive_gold_labels',
            target: t('2 labels per post + adjudication', '每条 2 份标注 + 裁决'),
            duration: '0.3s',
          },
        ],
        text: t(
          '**Gold labels** are ready for 600 eval posts and 400 test posts. The test split is now sealed, and I only ever see its totals.\n\n**Next, I recommend checking the teacher prompt** on the eval split before it labels 49,000 training posts. I’m running your prompt as **v1**.',
          '**金标**已就绪：评估集 600 条，测试集 400 条。测试集现已封存，我只能看到汇总指标。\n\n**下一步，我建议先检验教师 Prompt**，再让它标注 49,000 条训练帖子。我正用你的 Prompt 作为 **v1** 在评估集上运行。',
        ),
      },
      {
        kind: 'card',
        card: {
          type: 'progress',
          id: 'pr-v1',
          title: t('Teacher on the eval split · prompt v1', '教师模型 · 评估集 · Prompt v1'),
          total: 600,
          unit: t('posts', '条'),
          durationMs: 3500,
        },
      },
    ],
  },
  {
    stage: 3,
    waitFor: 'adv-1',
    items: [
      {
        kind: 'artifact',
        panel: 'evalReport',
        action: 'created',
        title: t('Eval report', '评估报告'),
        detail: t('Prompt v1 on 600 eval posts', 'Prompt v1 · 600 条评估帖子'),
      },
      {
        kind: 'card',
        card: {
          type: 'result',
          id: 'r-v1',
          title: t('Prompt v1 results', 'Prompt v1 结果'),
          stats: [
            {
              label: t('Macro-F1 · primary value', 'macro-F1 · 主要价值'),
              value: fmt2(macroF1(v1)),
            },
            {
              label: t('Invalid outputs', 'Invalid outputs'),
              value: pct(invalidRate(v1), 1),
            },
            {
              label: t(`Weakest: ${LABEL_BY_ID[v1Weakest.id].name.en}`, `最弱：${LABEL_BY_ID[v1Weakest.id].name.zh}`),
              value: fmt2(v1Weakest.f1),
            },
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
          {
            name: 'create_prompt_version',
            target: t('v2', 'v2'),
            duration: '0.2s',
          },
          {
            name: 'cluster_errors',
            target: t('Discussion · topics', '讨论 · 话题'),
            duration: '6s',
          },
        ],
        text: t(
          `Adopted as **prompt v2**. Invalid outputs are down to ${pct(invalidRate(v2), 1)}, and Ecosystem rose to ${fmt2(scoreOf(v2, 'primary_value', 'ecosystem').f1)}. Two things still miss the gate, so I looked at their errors.`,
          `已采纳，生成 **Prompt v2**。无效输出降到 ${pct(invalidRate(v2), 1)}，生态问题升到 ${fmt2(scoreOf(v2, 'primary_value', 'ecosystem').f1)}。还有两处没过门禁，我分析了它们的错误。`,
        ),
      },
      {
        kind: 'artifact',
        panel: 'promptDiff',
        action: 'created',
        title: t('Prompt', 'Prompt'),
        version: 'v2',
        detail: t('Full prompt, editable', 'Prompt 全文，可编辑'),
      },
      {
        kind: 'artifact',
        panel: 'evalReport',
        action: 'updated',
        title: t('Eval report', '评估报告'),
        detail: t('Prompt v2, re-scored on 600 posts', 'Prompt v2 · 在 600 条上重新评估'),
      },
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
          measures: [
            {kind: 'macro', field: 'primary_value'},
            {kind: 'value', field: 'primary_value', value: 'discussion'},
            {kind: 'macro', field: 'topics'},
          ],
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
      {
        kind: 'artifact',
        panel: 'promptDiff',
        action: 'updated',
        title: t('Prompt', 'Prompt'),
        version: 'v3',
        detail: t('3 lines changed', '修改 3 行'),
      },
      {
        kind: 'artifact',
        panel: 'evalReport',
        action: 'updated',
        title: t('Eval report', '评估报告'),
        detail: t('Prompt v3, re-scored on 600 posts', 'Prompt v3 · 在 600 条上重新评估'),
      },
      {
        kind: 'card',
        card: {
          type: 'approval',
          id: 'a-teacher-gate',
          title: t('Teacher-quality gate', '教师质量门禁'),
          checks: [
            {
              label: t(`Primary value macro-F1 ≥ ${TEACHER_GATE.macroF1.primary_value}`, `主要价值 macro-F1 ≥ ${TEACHER_GATE.macroF1.primary_value}`),
              value: fmt2(macroF1(v3)),
              pass: true,
            },
            {
              label: t(`Every primary value ≥ ${fmt2(TEACHER_GATE.labelF1)}`, `每个主要价值 ≥ ${fmt2(TEACHER_GATE.labelF1)}`),
              value: t(`lowest ${fmt2(weakestLabel(v3).f1)}`, `最低 ${fmt2(weakestLabel(v3).f1)}`),
              pass: true,
            },
            {
              label: t(`Format macro-F1 ≥ ${TEACHER_GATE.macroF1.format}`, `形式 macro-F1 ≥ ${TEACHER_GATE.macroF1.format}`),
              value: fmt2(macroF1(v3, 'format')),
              pass: true,
            },
            {
              label: t(`Topics macro-F1 ≥ ${fmt2(TEACHER_GATE.macroF1.topics)}`, `话题 macro-F1 ≥ ${fmt2(TEACHER_GATE.macroF1.topics)}`),
              value: fmt2(macroF1(v3, 'topics')),
              pass: true,
            },
            {
              label: t('Invalid outputs ≤ 1%', 'Invalid outputs ≤ 1%'),
              value: pct(invalidRate(v3), 1),
              pass: true,
            },
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
      {
        kind: 'system',
        text: t('Teacher-quality gate passed', '教师质量门禁已通过'),
      },
      {
        kind: 'agent',
        tools: [
          {
            name: 'run_pilot',
            target: t('500 posts vs. gold labels', '500 条 vs. 金标'),
            duration: '3m',
          },
        ],
        text: t(
          '**Next, I recommend letting the teacher label the 49,000 training posts.** I ran a 500-post pilot first. It matches your gold labels on primary value **91%** of the time, so the full run is worth paying for.',
          '**下一步，我建议让教师模型标注 49,000 条训练帖子。** 我先跑了 500 条试点，主要价值与金标的一致率为 **91%**，值得跑全量。',
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
            {
              label: t('Mode', '模式'),
              value: t('Batch · about 50% of the online price', '批量 · 约为在线价格的 50%'),
            },
            {label: t('Estimated cost', '预估费用'), value: '$410'},
            {
              label: t('Estimated time', '预计耗时'),
              value: t('about 5 h', '约 5 小时'),
            },
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
        card: {
          type: 'progress',
          id: 'pr-batch',
          title: t('Teacher batch job · prompt v3', '教师模型批量任务 · Prompt v3'),
          total: 49000,
          unit: t('posts', '条'),
          durationMs: 5000,
        },
      },
    ],
  },
  {
    stage: 4,
    waitFor: 'a-train',
    datasets: {
      ...GOLD,
      train: {
        total: TRAINING_SET.finalRows,
        labeled: TRAINING_SET.finalRows,
        source: t('Teacher, prompt v3', '教师模型，Prompt v3'),
      },
    },
    items: [
      {
        kind: 'agent',
        tools: [
          {
            name: 'filter_invalid',
            target: t('−147 rows', '−147 行'),
            duration: '1s',
          },
          {
            name: 'deduplicate',
            target: t('−2,641 rows', '−2,641 行'),
            duration: '40s',
          },
          {
            name: 'decontaminate',
            target: t('−212 rows overlapping eval/test', '−212 行与评估/测试集重叠'),
            duration: '25s',
          },
        ],
        text: t(
          'The training set is ready: **46,000 rows**. I removed invalid outputs, near-duplicates and posts that overlap eval or test, then capped Entertainment and raised Ecosystem issue to a minimum share.\n\nTrain, eval and test all have labels, so you can train any time with `/train`. **I recommend training now:** three runs on 10k, 30k and 46k rows, to see whether more data still helps. Training runs on Platform S, which isn’t connected yet, so the results from here on are illustrative.',
          '训练集已就绪：**46,000 行**。我去掉了无效输出、近似重复和与评估/测试集重叠的帖子，并限制了娱乐的占比、把生态问题提到最低占比。\n\n训练、评估、测试集都有了标签，随时可以用 `/train` 开始训练。**我建议现在开始训练：** 分别用 10k、30k、46k 行跑三次，看更多数据是否还有帮助。训练在 Platform S 上进行，目前还没接通，所以接下来的结果是示意数据。',
        ),
      },
      {
        kind: 'artifact',
        panel: 'trainingSet',
        action: 'created',
        title: t('Training set', '训练集'),
        version: 'v1',
        detail: t('46,000 rows · prompt v3', '46,000 行 · Prompt v3'),
      },
      {
        kind: 'card',
        card: {
          type: 'approval',
          id: 'a-train',
          title: t('Train student 8B', '训练学生模型 8B'),
          rows: [
            {
              label: t('Runs', '训练次数'),
              value: t('10k · 30k · 46k rows', '10k · 30k · 46k 行'),
            },
            {
              label: t('Platform', '平台'),
              value: t('Platform S (planned)', 'Platform S（规划中）'),
            },
          ],
          approve: t('Train model', '训练模型'),
          panel: 'trainingSet',
        },
      },
    ],
  },
  {
    stage: 5,
    waitFor: 'pr-train',
    items: [
      {kind: 'choice', cardId: 'a-train'},
      {
        kind: 'card',
        card: {
          type: 'progress',
          id: 'pr-train',
          title: t('Training student 8B · 10k / 30k / 46k', '训练学生模型 8B · 10k / 30k / 46k'),
          total: 3,
          unit: t('runs', '次'),
          durationMs: 4500,
        },
      },
    ],
  },
  {
    stage: 5,
    waitFor: 'q-more',
    items: [
      {
        kind: 'artifact',
        panel: 'runs',
        action: 'created',
        title: t('Training runs', '训练记录'),
        detail: t('3 runs · 10k / 30k / 46k', '3 次 · 10k / 30k / 46k'),
      },
      {
        kind: 'card',
        card: {
          type: 'result',
          id: 'r-runs',
          title: t('Training finished', '训练完成'),
          stats: [
            {
              label: t('46k · primary value on eval', '46k · 评估集主要价值'),
              value: fmt2(curveEnd.f1.primary_value),
            },
            {
              label: t('Gain from 30k to 46k', '30k 到 46k 的提升'),
              value: `≤ ${fmt2(lateGain)}`,
            },
            {
              label: t('Student vs. teacher', '学生 vs. 教师'),
              value: pct(studentShare),
            },
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
            {
              id: 'more',
              label: t('Generate 100k more (+$840, +9 h)', '再生成 10 万条（+$840，+9 小时）'),
            },
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
        tools: [
          {
            name: 'evaluate',
            target: t('sealed test split · 400 posts', '封存测试集 · 400 条'),
            duration: '2m',
          },
        ],
        text: t(
          `On the sealed **test split** (400 posts), the student scores macro-F1 **${fmt2(test.student.p)}** on primary value, ${fmt2(test.student.f)} on format and ${fmt2(test.student.t)} on topics, against the teacher’s ${fmt2(test.teacher.p)}, ${fmt2(test.teacher.f)} and ${fmt2(test.teacher.t)}. Every field clears its minimum; the weakest label is ${LABEL_BY_ID[studentWeakest.id].name.en} at ${fmt2(studentWeakest.f1)}.`,
          `在封存的**测试集**（400 条）上，学生模型的 macro-F1：主要价值 **${fmt2(test.student.p)}**、形式 ${fmt2(test.student.f)}、话题 ${fmt2(test.student.t)}；教师模型分别为 ${fmt2(test.teacher.p)}、${fmt2(test.teacher.f)}、${fmt2(test.teacher.t)}。每个字段都过了最低线，最弱的标签是“${LABEL_BY_ID[studentWeakest.id].name.zh}”，${fmt2(studentWeakest.f1)}。`,
        ),
      },
      {
        kind: 'artifact',
        panel: 'gate',
        action: 'created',
        title: t('Release gate report', '发布门禁报告'),
        detail: t('Student 8B · 400 test posts', '学生模型 8B · 400 条测试帖子'),
      },
      {
        kind: 'card',
        card: {
          type: 'approval',
          id: 'a-release',
          title: t('Release gate · student 8B', '发布门禁 · 学生模型 8B'),
          checks: [
            {
              label: t(`Primary value ≥ ${RELEASE_GATE.macroF1.primary_value}`, `主要价值 ≥ ${RELEASE_GATE.macroF1.primary_value}`),
              value: fmt2(test.student.p),
              pass: true,
            },
            {
              label: t(`Format ≥ ${RELEASE_GATE.macroF1.format}`, `形式 ≥ ${RELEASE_GATE.macroF1.format}`),
              value: fmt2(test.student.f),
              pass: true,
            },
            {
              label: t(`Topics ≥ ${RELEASE_GATE.macroF1.topics}`, `话题 ≥ ${RELEASE_GATE.macroF1.topics}`),
              value: fmt2(test.student.t),
              pass: true,
            },
            {
              label: t('Regression vs. current model', '相对线上模型的回退'),
              value: t('none · first model', '无 · 首个模型'),
              pass: true,
            },
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
      {
        kind: 'system',
        text: t('Video tags v1 released', '视频标签 v1 已发布'),
      },
      {
        kind: 'agent',
        text: t(
          'Released. From your first message to an approved model took **6 working days** and about **14 hours** of human time, mostly labeling, with no engineer hours. Today the same job takes about 4 weeks and 40 engineer hours.\n\nA shadow run and an A/B test come next. They’re planned for after the MVP.',
          '已发布。从你的第一条消息到模型通过审批，用了 **6 个工作日**，人工时间约 **14 小时**（主要是标注），工程师时间为零。现在同样的事大约需要 4 周和 40 个工程师小时。\n\n接下来是影子运行和 A/B 实验，计划在 MVP 之后上线。',
        ),
      },
      {
        kind: 'artifact',
        panel: 'efficiency',
        action: 'created',
        title: t('Efficiency report', '效率对比'),
        detail: t('6 working days vs. 4 weeks today', '6 个工作日 vs. 现在的 4 周'),
      },
    ],
  },
];
