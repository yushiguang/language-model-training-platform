export type Locale = 'en' | 'zh-CN';

const en = {
  'app.title': 'Model Studio',
  'app.subtitle': 'Train task models by talking to an agent',
  'app.demoBanner': 'Demo with made-up data',
  'lang.label': 'Language',
  'nav.projects': 'Projects',
  'nav.efficiency': 'Efficiency',
  'nav.workflow': 'Workflow',
  'stage.interview': 'Define requirement',
  'stage.dataset': 'Dataset',
  'stage.labeling': 'Human labeling',
  'stage.tuning': 'Teacher tuning',
  'stage.trainingSet': 'Training set',
  'stage.training': 'Train & evaluate',
  'stage.release': 'Release gate',
  'stage.planned': 'Planned',
  'common.comingNext': 'This screen is being built.',
  'projects.heading': 'Projects',
  'projects.new': 'New project',
} as const;

export type MessageKey = keyof typeof en;

const zh: Record<MessageKey, string> = {
  'app.title': '模型工坊',
  'app.subtitle': '和智能体对话，训练任务模型',
  'app.demoBanner': '演示版，数据均为虚构',
  'lang.label': '语言',
  'nav.projects': '项目',
  'nav.efficiency': '效率',
  'nav.workflow': '流程',
  'stage.interview': '定义需求',
  'stage.dataset': '数据集',
  'stage.labeling': '人工标注',
  'stage.tuning': '教师调优',
  'stage.trainingSet': '训练集',
  'stage.training': '训练与评估',
  'stage.release': '发布门禁',
  'stage.planned': '规划中',
  'common.comingNext': '此页面正在建设中。',
  'projects.heading': '项目',
  'projects.new': '新建项目',
};

export const messages: Record<Locale, Record<MessageKey, string>> = {en, 'zh-CN': zh};
