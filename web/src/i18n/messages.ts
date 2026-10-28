export type Locale = 'en' | 'zh-CN';

const en = {
  'app.title': 'Language Model Training Platform',
  'app.subtitle': 'Train task models by talking to an agent',
  'app.demoBanner': 'Demo · made-up data',
  'lang.label': 'Language',
  'nav.models': 'Models',
  'nav.newModel': 'New model',
  'nav.newModelHint': 'Not part of this demo',
  'nav.restart': 'Restart demo',
  'nav.waiting': 'need you',
} as const;

export type MessageKey = keyof typeof en;

const zh: Record<MessageKey, string> = {
  'app.title': '模型训练平台',
  'app.subtitle': '和智能体对话，训练任务模型',
  'app.demoBanner': '演示版 · 数据均为虚构',
  'lang.label': '语言',
  'nav.models': '模型',
  'nav.newModel': '新建模型',
  'nav.newModelHint': '本演示不包含此功能',
  'nav.restart': '重新开始演示',
  'nav.waiting': '个待处理',
};

export const messages: Record<Locale, Record<MessageKey, string>> = {en, 'zh-CN': zh};
