'use client';

import {useState, type ReactNode} from 'react';
import {Icon} from '@astryxdesign/core/Icon';
import {Check, ChevronDown, ChevronRight} from 'lucide-react';
import {DatasetStatus} from '@/components/DatasetStatus';
import {TRAIN_COMMAND, useTraining} from '@/components/training';
import {useLocale} from '@/i18n/LocaleProvider';
import {t, type T} from '@/i18n/text';
import {titleCase} from '@/i18n/titleCase';
import {FIELDS} from '@/mock/fields';
import {macroF1, PROMPT_RUNS} from '@/mock/metrics';
import {fmt2} from '@/mock/numbers';
import {CONFLICT_TOTALS, LABELING_POSTS} from '@/mock/posts';
import type {ModelSummary} from '@/story/models';
import {useStory} from '@/story/StoryProvider';
import type {Datasets} from '@/story/types';
import {RELEASED_STAGE, STAGES} from '@/story/videoTags';

type StepState = 'done' | 'current' | 'todo' | 'skipped';

const STATE_LABEL: Record<StepState, T> = {
  done: t('Done', '已完成'),
  current: t('Now', '进行中'),
  todo: t('Not started', '未开始'),
  skipped: t('Skipped', '已跳过'),
};

const conflictTotal = CONFLICT_TOTALS.primary_value + CONFLICT_TOTALS.format + CONFLICT_TOTALS.topics;

/** What each step of the scripted model shows when opened, worked out from where the story is. */
function useScriptedNotes(datasets: Datasets | null, trainingNote: ReactNode): Record<number, ReactNode> {
  const {tr} = useLocale();
  const story = useStory();
  const done = story.isResolved;
  const line = (text: T) => <p className="step-note">{tr(text)}</p>;
  const prompt = done('adv-2') ? 'v3' : done('adv-1') ? 'v2' : 'v1';
  const notes: Record<number, ReactNode> = {};

  if (story.isPanelAvailable('schema'))
    notes[0] = line(done('a-schema') ? t('V1 · confirmed · 3 label fields', 'V1 · 已确认 · 3 个标签字段') : t('V1 · draft · 3 label fields', 'V1 · 草稿 · 3 个标签字段'));
  if (datasets) notes[1] = <DatasetStatus datasets={datasets} />;
  else if (done('s-sample')) notes[1] = line(t('Sampling 50,000 posts', '正在抽样 50,000 条帖子'));
  else if (done('a-schema')) notes[1] = line(t('Choosing how to build it', '正在选择数据来源'));

  if (done('l-adj')) notes[2] = line(t(`1,000 posts · ${conflictTotal} disagreements resolved`, `1,000 条 · ${conflictTotal} 条分歧已裁决`));
  else if (done('pr-label')) notes[2] = line(t(`1,000 posts labeled · ${conflictTotal} disagreements to resolve`, `1,000 条已标注 · ${conflictTotal} 条分歧待裁决`));
  else if (story.isPanelAvailable('labeling')) {
    const mine = LABELING_POSTS.filter(id => story.state.myLabels[id]).length;
    notes[2] = line(t(`Labeling 1,000 posts · your share ${mine} / 5`, `标注 1,000 条 · 你的部分 ${mine} / 5`));
  }

  if (done('pr-v1')) {
    const run = PROMPT_RUNS[prompt];
    notes[3] = (
      <>
        <p className="step-note">{tr(done('a-teacher-gate') ? t(`Prompt ${prompt} · gate passed`, `Prompt ${prompt} · 已过门禁`) : t(`Prompt ${prompt} in use`, `使用 Prompt ${prompt}`))}</p>
        <dl className="step-facts">
          {FIELDS.map(f => (
            <div key={f.id}>
              <dt>{tr(f.name)}</dt>
              <dd>{fmt2(macroF1(run, f.id))}</dd>
            </div>
          ))}
        </dl>
      </>
    );
  } else if (story.isResolved('l-adj')) notes[3] = line(t('Running prompt v1 on the eval set', '正在评估集上运行 Prompt v1'));

  if (done('pr-batch')) notes[4] = line(t('46,000 rows · teacher, prompt v3', '46,000 行 · 教师模型，Prompt v3'));
  else if (done('a-cost')) notes[4] = line(t('Teacher labeling 49,000 posts', '教师模型正在标注 49,000 条'));

  notes[5] = trainingNote;
  if (story.stage >= RELEASED_STAGE) notes[6] = line(t('V1 released', 'V1 已发布'));
  else if (story.isPanelAvailable('gate')) notes[6] = line(t('Gate checks passed · waiting for your approval', '门禁检查已通过 · 等待你批准'));
  return notes;
}

/** The selected model's workflow, one step per row. Each step folds open to show its own status. */
export function WorkflowPanel({model}: {model: ModelSummary}) {
  const {tr} = useLocale();
  const story = useStory();
  const datasets = model.isScripted ? story.datasets : (model.datasets ?? null);
  const stage = model.isScripted ? story.stage : (model.stage ?? 0);
  const skipped = model.skippedStages ?? [];
  const training = useTraining(model, datasets);
  const [toggled, setToggled] = useState<Record<string, boolean>>({});

  const isTrained = model.isScripted ? story.isResolved('pr-train') : false;
  const isTraining = model.isScripted ? story.isResolved('a-train') && !isTrained : story.state.trainedModels.includes(model.id);
  const trainingNote = (
    <p className="step-note">
      {isTrained
        ? tr(t('3 runs · 46k rows is the best', '3 次训练 · 46k 行效果最好'))
        : isTraining
          ? tr(t('Training is running.', '正在训练。'))
          : training.offReason
            ? tr(training.offReason)
            : tr(t(`Ready. Type ${TRAIN_COMMAND} or ask the agent.`, `可以开始了。输入 ${TRAIN_COMMAND} 或让智能体开始。`))}
    </p>
  );
  const scripted = useScriptedNotes(datasets, trainingNote);
  const notes: Record<number, ReactNode> = model.isScripted
    ? scripted
    : {
        ...Object.fromEntries(
          Object.entries(model.stepNotes ?? {}).map(([i, text]) => [
            i,
            <p key={i} className="step-note">
              {tr(text!)}
            </p>,
          ]),
        ),
        ...(datasets ? {1: <DatasetStatus datasets={datasets} />} : {}),
        5: trainingNote,
      };

  return (
    <ol className="workflow" aria-label={tr(t('Workflow', '流程'))}>
      {STAGES.map((s, i) => {
        const state: StepState = skipped.includes(i) ? 'skipped' : stage >= RELEASED_STAGE || i < stage ? 'done' : i === stage ? 'current' : 'todo';
        const key = `${model.id}:${i}`;
        const isOpen = toggled[key] ?? i === stage;
        const note = notes[i];
        const name = titleCase(tr(s.name));
        return (
          <li key={s.name.en} className={`step step-${state}`} aria-current={state === 'current' ? 'step' : undefined}>
            <button type="button" className="step-head" aria-expanded={isOpen} onClick={() => setToggled(prev => ({...prev, [key]: !isOpen}))}>
              <span className="step-mark" aria-hidden>
                {state === 'done' ? <Icon icon={Check} size="xsm" color="inherit" /> : state === 'skipped' ? '–' : i + 1}
              </span>
              <span className="step-name">{name}</span>
              {s.isPlanned && <span className="step-tag">{tr(t('planned', '规划中'))}</span>}
              {/* Done and skipped show in the mark; only the current step says so in words. */}
              <span className="step-state">{state === 'current' ? tr(STATE_LABEL[state]) : ''}</span>
              <Icon icon={isOpen ? ChevronDown : ChevronRight} size="sm" color="inherit" />
            </button>
            {isOpen && <div className="step-body">{note ?? <p className="step-note step-empty">{tr(STATE_LABEL[state])}</p>}</div>}
          </li>
        );
      })}
    </ol>
  );
}
