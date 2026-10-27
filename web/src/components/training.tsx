'use client';

import {useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {CheckboxInput} from '@astryxdesign/core/CheckboxInput';
import {Dialog} from '@astryxdesign/core/Dialog';
import {Icon} from '@astryxdesign/core/Icon';
import {TriangleAlert} from 'lucide-react';
import {IconLine} from '@/components/cards/CardFrame';
import {useLocale} from '@/i18n/LocaleProvider';
import {t, type T} from '@/i18n/text';
import {titleCase} from '@/i18n/titleCase';
import type {ModelSummary} from '@/story/models';
import {useStory} from '@/story/StoryProvider';
import type {Datasets} from '@/story/types';

/** The command that starts training from the chat. */
export const TRAIN_COMMAND = '/train';

export function isTrainCommand(text: string): boolean {
  return /^\/train\b/i.test(text.trim());
}

const isReady = (s: {total: number; labeled: number} | undefined) => Boolean(s && s.total > 0 && s.labeled === s.total);

export interface Training {
  /** Why training can't start now; null when it can. */
  offReason: T | null;
  /** Labeled sets that are missing; training without them needs a warning and a second confirmation. */
  missing: T[];
  /** Starts training. From the chat, pass the command so the chat echoes it. */
  start: (viaCommand?: boolean) => void;
}

/**
 * Whether a model can train now. Training needs a labeled training set; eval and test are
 * recommended, not required.
 */
export function useTraining(model: ModelSummary, datasets: Datasets | null): Training {
  const story = useStory();
  let offReason: T | null = null;
  if (model.isScripted) {
    if (!datasets) offReason = t('There is no dataset yet.', '还没有数据集。');
    else if (!isReady(datasets.train))
      offReason = t('The training set has no labels yet. The teacher labels it once its prompt passes the quality gate.', '训练集还没有标签。教师 Prompt 通过质量门禁后，由教师模型标注。');
    else if (story.isResolved('a-train')) offReason = story.isResolved('pr-train') ? t('Student 8B is trained.', '学生模型 8B 已训练完成。') : t('Training is running.', '正在训练。');
    else if (story.awaitedCardId !== 'a-train') offReason = t('The agent is still preparing the training set.', '智能体还在准备训练集。');
  } else if (story.state.trainedModels.includes(model.id)) offReason = t('Training is running.', '正在训练。');
  else if (model.trainOffReason) offReason = model.trainOffReason;

  const missing = [!isReady(datasets?.eval) && t('eval', '评估集'), !isReady(datasets?.test) && t('test', '测试集')].filter(Boolean) as T[];
  const start = (viaCommand = false) => {
    if (model.isScripted) story.resolve('a-train', viaCommand ? 'command' : 'approve');
    else story.trainNow(model.id);
  };
  return {offReason, missing, start};
}

/** The second confirmation: what training without eval and test costs, and a box to tick before going ahead. */
export function TrainWarning({missing, onCancel, onConfirm}: {missing: T[]; onCancel: () => void; onConfirm: () => void}) {
  const {tr} = useLocale();
  const [isUnderstood, setIsUnderstood] = useState(false);
  const sets = missing.map(m => tr(m)).join(tr(t(' or ', '或')));
  const title = titleCase(tr(t('Train without eval and test sets?', '在没有评估集和测试集的情况下训练？')));
  return (
    <Dialog isOpen onOpenChange={isOpen => !isOpen && onCancel()} width="min(480px, calc(100vw - 32px))" purpose="required" padding={0} aria-label={title}>
      <div className="confirm-dialog">
        <IconLine className="confirm-title" icon={<Icon icon={TriangleAlert} size="md" color="warning" />}>
          {title}
        </IconLine>
        <p className="page-text">
          {tr(
            t(
              `Not recommended. There is no labeled ${sets} set, so nobody can measure how often this model is wrong, and the release gate can’t run. Use this only when you need a model fast, for example to stop a compliance risk, and add eval and test sets as soon as you can.`,
              `不建议这样做。目前没有已标注的${sets}，无法衡量这个模型错得有多频繁，发布门禁也无法运行。只在急需模型时使用，比如要拦截合规风险，并尽快补上评估集和测试集。`,
            ),
          )}
        </p>
        <CheckboxInput
          label={tr(t('I understand this model can’t be measured until eval and test sets exist', '我了解在有评估集和测试集之前，这个模型无法被衡量'))}
          value={isUnderstood}
          onChange={setIsUnderstood}
        />
        <div className="card-actions confirm-actions">
          <Button label={tr(t('Cancel', '取消'))} variant="ghost" onClick={onCancel} />
          <Button label={tr(t('Train anyway', '仍然训练'))} variant="destructive" isDisabled={!isUnderstood} onClick={onConfirm} />
        </div>
      </div>
    </Dialog>
  );
}
