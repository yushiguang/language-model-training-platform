import type {MessageKey} from '@/i18n/messages';

export interface Stage {
  slug: string;
  titleKey: MessageKey;
  /** Depends on Platform S details that are not settled yet. */
  isPlanned?: boolean;
}

export const STAGES: Stage[] = [
  {slug: 'interview', titleKey: 'stage.interview'},
  {slug: 'dataset', titleKey: 'stage.dataset'},
  {slug: 'labeling', titleKey: 'stage.labeling'},
  {slug: 'tuning', titleKey: 'stage.tuning'},
  {slug: 'training-set', titleKey: 'stage.trainingSet'},
  {slug: 'training', titleKey: 'stage.training', isPlanned: true},
  {slug: 'release', titleKey: 'stage.release'},
];
