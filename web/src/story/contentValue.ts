import {t} from '@/i18n/text';
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

/**
 * The scripted conversation for the "Content value" model. Every number here is
 * derived from src/mock/metrics.ts; keep them in step when either changes.
 */
export const CONTENT_VALUE_STEPS: Step[] = [
  {
    stage: 0,
    waitFor: 'q-repost',
    items: [
      {
        kind: 'user',
        text: t(
          'I need a model that sorts posts by the main value they give viewers: entertainment, experience and decision-making, discussion, or ecosystem issues. Our ops team already has a teacher prompt for it.',
          '我需要一个模型，按内容给观众的主要价值给帖子分类：娱乐消费、经验决策、讨论，或生态问题。运营团队已经有一份教师 Prompt。',
        ),
      },
      {
        kind: 'agent',
        tools: [
          {name: 'read_prompt', target: t('teacher-prompt-v1.md', 'teacher-prompt-v1.md'), duration: '0.4s'},
          {name: 'draft_schema', target: t('1 field · 4 labels', '1 个字段 · 4 个标签'), duration: '2.1s'},
        ],
        text: t(
          'Got it. I read the prompt and drafted **one field with four labels**, each with a definition, examples and counterexamples, plus the prompt’s judgment order. `summary` and `reasoning` stay teacher-only, so the student won’t learn them. [Open schema v1](#panel-schema)\n\nOne rule is ambiguous, so I need your call before you confirm it.',
          '收到。我读了 Prompt，起草了**一个字段、四个标签**，每个标签都有定义、正例和反例，并保留了 Prompt 里的判断顺序。`summary` 和 `reasoning` 只给教师模型用，学生模型不学。[打开 Schema v1](#panel-schema)\n\n有一条规则有歧义，确认前需要你来定。',
        ),
      },
      {
        kind: 'card',
        card: {
          type: 'question',
          id: 'q-repost',
          title: t(
            'A reposted interview where the poster adds no comment of their own: which label?',
            '原样转发的访谈，发布者没有补充自己的观点，应该标成哪一类？',
          ),
          body: t(
            'The guests share views, so it can look like Discussion. Your prompt says only the poster’s own new expression counts.',
            '访谈嘉宾在表达观点，看起来像“讨论”。但你的 Prompt 规定只看发布者自己新增的表达。',
          ),
          options: [
            {id: 'entertainment', label: t('Entertainment & Consumption', '娱乐消费')},
            {id: 'discussion', label: t('Discussion', '讨论')},
          ],
          recommended: 'entertainment',
          reason: t(
            'Rules 12 and 13 of your prompt: quoted material without new expression is Entertainment.',
            '依据 Prompt 第 12、13 条：没有新增表达的引用内容属于娱乐消费。',
          ),
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
            '好的。我把它加进了“娱乐消费”的正例和“讨论”的反例。Schema 可以确认了。',
          ),
          discussion: t(
            'Noted: reposted interviews count as Discussion. That contradicts rules 12 and 13, so I flagged them for you to update. The schema is ready for your sign-off.',
            '已记录：转发的访谈算“讨论”。这和 Prompt 第 12、13 条矛盾，我已标记出来等你修改。Schema 可以确认了。',
          ),
        },
      },
      {
        kind: 'card',
        card: {
          type: 'approval',
          id: 'a-schema',
          title: t('Confirm schema v1', '确认 Schema v1'),
          rows: [
            {label: t('Field', '字段'), value: t('label · single choice', 'label · 单选')},
            {label: t('Labels', '标签'), value: '4'},
            {label: t('Teacher-only fields', '仅教师模型字段'), value: 'summary, reasoning'},
            {label: t('Judgment order', '判断顺序'), value: t('Ecosystem → Experience → Discussion → Entertainment', '生态问题 → 经验决策 → 讨论 → 娱乐消费')},
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
      {
        kind: 'card',
        card: {
          type: 'result',
          id: 'r-dataset',
          title: t('Dataset snapshot ds-1', '数据快照 ds-1'),
          stats: [
            {label: t('Train · teacher labels', '训练 · 教师标注'), value: '49,000'},
            {label: t('Eval · human labels', '评估 · 人工标注'), value: '600'},
            {label: t('Test · human labels, sealed', '测试 · 人工标注，封存'), value: '400'},
            {label: t('Languages', '语言'), value: '31'},
          ],
          panel: 'samples',
        },
      },
      {
        kind: 'card',
        card: {
          type: 'approval',
          id: 'a-sampling',
          title: t('Approve the sampling plan', '批准抽样方案'),
          rows: [
            {label: t('Source', '来源'), value: t('Posts published in the last 30 days', '近 30 天发布的帖子')},
            {label: t('Sampling', '抽样'), value: t('Stratified by country and format', '按国家和内容形式分层')},
            {label: t('Expected mix', '预估分布'), value: t('Ent 58% · Exp 22% · Disc 12% · Eco 8%', '娱乐 58% · 经验 22% · 讨论 12% · 生态 8%')},
          ],
          approve: t('Approve plan', '批准方案'),
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
        tools: [{name: 'create_labeling_task', target: t('1,000 posts · 3 labelers', '1,000 条 · 3 位标注员'), duration: '0.8s'}],
        text: t(
          'I created a labeling task for **Lin, Mei and Ravi**: 1,000 posts for the eval and test splits, with 20% labeled by all three so we can measure agreement. Labeling is blind, and the teacher’s answer stays hidden unless you reveal it.',
          '我给 **Lin、Mei 和 Ravi** 建了标注任务：评估集和测试集共 1,000 条，其中 20% 由三人都标，用来衡量一致性。标注是盲标的，教师模型的答案默认隐藏，除非你主动查看。',
        ),
      },
      {
        kind: 'card',
        card: {
          type: 'link',
          id: 'l-label',
          title: t('Your share: label 5 posts', '你的任务：标注 5 条帖子'),
          description: t(
            'About 3 minutes. Each post shows frames, title, OCR and ASR, with the label definitions beside it.',
            '大约 3 分钟。每条帖子展示视频帧、标题、OCR 和 ASR，旁边附有标签定义。',
          ),
          panel: 'labeling',
          cta: t('Start labeling', '开始标注'),
          skip: t('Skip for now', '先跳过'),
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
    waitFor: 'q-adj',
    items: [
      {
        kind: 'card',
        card: {
          type: 'result',
          id: 'r-agree',
          title: t('Labeling finished', '标注完成'),
          stats: [
            {label: t('Agreement (Krippendorff’s alpha)', '一致性（Krippendorff’s alpha）'), value: '0.71'},
            {label: t('Disagreements for you', '待你裁决的分歧'), value: '3'},
            {label: t('Discussion vs. Entertainment', '讨论 vs. 娱乐消费'), value: '64%'},
          ],
          note: t(
            'Most disagreements are personal stories told as vlogs. Is the story the point, or does it give others something specific to respond to?',
            '大部分分歧来自用 vlog 讲述的个人经历：重点是故事本身，还是给了别人可以具体回应的东西？',
          ),
        },
      },
      {
        kind: 'card',
        card: {
          type: 'question',
          id: 'q-adj',
          title: t('Mei and Ravi disagree on this post. Which label is right?', 'Mei 和 Ravi 对这条帖子意见不一致，哪个标签是对的？'),
          postId: 'p12',
          showVotes: true,
          options: [
            {id: 'discussion', label: t('Discussion', '讨论')},
            {id: 'entertainment', label: t('Entertainment & Consumption', '娱乐消费')},
          ],
          recommended: 'discussion',
          reason: t(
            'Rule 17: the vlog form doesn’t decide. The contract details give other renters something specific to respond to.',
            '依据第 17 条：vlog 只是形式。合同细节让其他租客可以给出具体回应。',
          ),
        },
      },
    ],
  },
  {
    stage: 3,
    waitFor: 'pr-v1',
    items: [
      {kind: 'choice', cardId: 'q-adj'},
      {
        kind: 'reply',
        cardId: 'q-adj',
        replies: {
          discussion: t('Recorded as Discussion. The other two disagreements were settled the same way.', '已记录为“讨论”。另外两条分歧也按同样的思路处理了。'),
          entertainment: t(
            'Recorded as Entertainment. Rule 17 says the form doesn’t decide, so I added this post to the examples to make your reading explicit.',
            '已记录为“娱乐消费”。第 17 条说形式不决定类别，所以我把这条加进了示例，明确你的判断。',
          ),
        },
      },
      {
        kind: 'agent',
        tools: [{name: 'derive_gold_labels', target: t('majority vote + adjudication', '多数投票 + 裁决'), duration: '0.3s'}],
        text: t(
          '**Gold labels v1** are ready: 600 eval posts and 400 test posts. The test split is now sealed, and I only ever see its totals.\n\nNow I’ll run the teacher on the eval split with your prompt as **v1**.',
          '**金标 v1** 已就绪：评估集 600 条，测试集 400 条。测试集现已封存，我只能看到汇总指标。\n\n现在我用你的 Prompt 作为 **v1**，在评估集上运行教师模型。',
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
        kind: 'card',
        card: {
          type: 'result',
          id: 'r-v1',
          title: t('Prompt v1 results', 'Prompt v1 结果'),
          stats: [
            {label: t('Macro-F1', '宏平均 F1'), value: '0.71'},
            {label: t('Invalid outputs', '无效输出'), value: '3.8%'},
            {label: t('Weakest label: Discussion', '最弱标签：讨论'), value: '0.55'},
          ],
          panel: 'evalReport',
        },
      },
      {
        kind: 'card',
        card: {
          type: 'advice',
          id: 'adv-1',
          title: t('Fix the label list in the output section', '修正输出部分的标签列表'),
          diagnosis: t(
            '23 outputs (3.8%) were invalid. They copied “娱乐Entertainment & Consumption” from the output instructions. That isn’t one of the four labels, so those posts count as wrong.',
            '23 条输出（3.8%）无效：它们照抄了输出说明里的“娱乐Entertainment & Consumption”，这不在四个标签之内，所以都算错。',
          ),
          removed: ['select the final category from: 娱乐Entertainment & Consumption/Experience & Decision-making/Discussion/Ecosystem issue.'],
          added: ['select exactly one of: "Entertainment & Consumption", "Experience & Decision-making", "Discussion", "Ecosystem issue".'],
          from: 'v1',
          to: 'v2',
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
          {name: 'cluster_errors', target: t('Discussion · 77 errors', '讨论 · 77 个错误'), duration: '6s'},
        ],
        text: t(
          'Adopted as **prompt v2**. Invalid outputs are down to 0.2%. Discussion is still the weakest label, so I looked at its errors.',
          '已采纳，生成 **Prompt v2**。无效输出降到 0.2%。“讨论”仍是最弱的标签，我分析了它的错误。',
        ),
      },
      {
        kind: 'card',
        card: {
          type: 'advice',
          id: 'adv-2',
          title: t('Check for the poster’s own view before Discussion', '判断“讨论”前，先确认发布者有没有自己的观点'),
          diagnosis: t(
            'Discussion precision is 0.48: 30 Entertainment posts were labeled Discussion, and 19 of them are reposted interviews or show clips where only the guests give views. Rules 12 and 13 cover this, but they sit deep in section 3. I moved the check into the judgment order and added two counterexamples.',
            '“讨论”的精确率只有 0.48：30 条娱乐消费被标成了讨论，其中 19 条是转发的访谈或节目片段，只有嘉宾在表达观点。第 12、13 条已经覆盖这种情况，但藏在第 3 部分深处。我把这一步检查移进了判断顺序，并补了两个反例。',
          ),
          removed: ['9. If not, determine whether it matches Discussion content:'],
          added: [
            '9. If not, first check: did the poster add their own view or experience? If not, skip Discussion.',
            '10. Otherwise, determine whether it matches Discussion content:',
            '    Counterexamples: a reposted interview; a show clip where only the guests talk → Entertainment.',
          ],
          from: 'v2',
          to: 'v3',
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
          'Adopted as **prompt v3**. Discussion F1 rose from 0.58 to 0.66, and no other label dropped. The teacher now clears the quality gate. [Compare prompt versions](#panel-promptDiff)',
          '已采纳，生成 **Prompt v3**。“讨论”的 F1 从 0.58 升到 0.66，其他标签都没有下降。教师模型现在通过了质量门禁。[对比 Prompt 版本](#panel-promptDiff)',
        ),
      },
      {
        kind: 'card',
        card: {
          type: 'approval',
          id: 'a-teacher-gate',
          title: t('Teacher-quality gate', '教师质量门禁'),
          checks: [
            {label: t('Macro-F1 ≥ 0.75', '宏平均 F1 ≥ 0.75'), value: '0.77', pass: true},
            {label: t('Every label F1 ≥ 0.60', '每个标签 F1 ≥ 0.60'), value: t('lowest 0.66', '最低 0.66'), pass: true},
            {label: t('Invalid outputs ≤ 1%', '无效输出 ≤ 1%'), value: '0.2%', pass: true},
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
          'Next, the teacher labels the **49,000 training posts**. I ran a 500-post pilot first. It matches your gold labels **91%** of the time, so the full run is worth paying for.',
          '接下来由教师模型标注 **49,000 条训练帖子**。我先跑了 500 条试点，与金标的一致率为 **91%**，值得跑全量。',
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
          'The training set is ready: **46,000 rows**. I removed invalid outputs, near-duplicates and posts that overlap eval or test, then capped Entertainment and raised Ecosystem to a minimum share. [Preview the training set](#panel-trainingSet)\n\nTraining runs on Platform S, which isn’t connected yet, so the results from here on are illustrative.',
          '训练集已就绪：**46,000 行**。我去掉了无效输出、近似重复和与评估/测试集重叠的帖子，并限制了娱乐消费的占比、把生态问题提到最低占比。[预览训练集](#panel-trainingSet)\n\n训练在 Platform S 上进行，目前还没接通，所以接下来的结果是示意数据。',
        ),
      },
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
        kind: 'card',
        card: {
          type: 'result',
          id: 'r-runs',
          title: t('Training finished', '训练完成'),
          stats: [
            {label: t('46k run · macro-F1 on eval', '46k · 评估集宏平均 F1'), value: '0.75'},
            {label: t('Gain from 30k to 46k', '30k 到 46k 的提升'), value: '≤ 0.02'},
            {label: t('Student vs. teacher', '学生 vs. 教师'), value: '97%'},
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
          reason: t('Every label gained 0.02 or less from 30k to 46k.', '从 30k 到 46k，每个标签的提升都不超过 0.02。'),
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
          more: t(
            'In a real project I’d launch that job now. For this demo, let’s take the 46k run to the release gate.',
            '在真实项目里我会马上启动这个任务。演示里我们先用 46k 这一版进入发布门禁。',
          ),
        },
      },
      {
        kind: 'agent',
        tools: [{name: 'evaluate', target: t('sealed test split · 400 posts', '封存测试集 · 400 条'), duration: '2m'}],
        text: t(
          'On the sealed **test split** (400 posts), the student scores macro-F1 **0.74**, against the teacher’s 0.77. Every label clears its minimum. Discussion is the closest call at 0.62. [Open the gate report](#panel-gate)',
          '在封存的**测试集**（400 条）上，学生模型宏平均 F1 为 **0.74**，教师模型为 0.77。每个标签都过了最低线，最接近的是“讨论”，0.62。[打开门禁报告](#panel-gate)',
        ),
      },
      {
        kind: 'card',
        card: {
          type: 'approval',
          id: 'a-release',
          title: t('Release gate · student 8B', '发布门禁 · 学生模型 8B'),
          checks: [
            {label: t('Macro-F1 ≥ 0.72', '宏平均 F1 ≥ 0.72'), value: '0.74', pass: true},
            {label: t('Every label F1 ≥ 0.60', '每个标签 F1 ≥ 0.60'), value: t('lowest 0.62', '最低 0.62'), pass: true},
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
      {kind: 'system', text: t('Content value v1 released', '内容价值 v1 已发布')},
      {
        kind: 'agent',
        text: t(
          'Released. From your first message to an approved model took **6 working days** and about **14 hours** of human time, mostly labeling, with no engineer hours. Today the same job takes about 4 weeks and 40 engineer hours. [See the comparison](#panel-efficiency)\n\nA shadow run and an A/B test come next. They’re planned for after the MVP.',
          '已发布。从你的第一条消息到模型通过审批，用了 **6 个工作日**，人工时间约 **14 小时**（主要是标注），工程师时间为零。现在同样的事大约需要 4 周和 40 个工程师小时。[查看对比](#panel-efficiency)\n\n接下来是影子运行和 A/B 实验，计划在 MVP 之后上线。',
        ),
      },
    ],
  },
];
