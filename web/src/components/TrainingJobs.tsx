'use client';

import {titleCase} from '@/i18n/titleCase';
import {useEffect, useState} from 'react';
import {ProgressBar} from '@astryxdesign/core/ProgressBar';
import {useLocale} from '@/i18n/LocaleProvider';
import {t, type T} from '@/i18n/text';
import {MODELS} from '@/story/models';
import {CARDS, useStory} from '@/story/StoryProvider';

interface Job {
  modelId: string;
  name: T;
  fraction: number;
  detail: T;
}

/** Training running across all models, under the models list. Each row opens its model. */
export function TrainingJobs() {
  const {tr} = useLocale();
  const story = useStory();
  const [now, setNow] = useState(() => Date.now());
  const start = story.state.progressStart['pr-train'];
  const isScriptedRunning = story.isResolved('a-train') && !story.isResolved('pr-train');

  useEffect(() => {
    if (!isScriptedRunning) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [isScriptedRunning]);

  const jobs: Job[] = [];
  if (isScriptedRunning) {
    const card = CARDS['pr-train'];
    const duration = card.type === 'progress' ? card.durationMs : 1;
    const fraction = start === undefined ? 0 : Math.min(0.99, (now - start) / duration);
    const run = Math.min(3, Math.floor(fraction * 3) + 1);
    jobs.push({
      modelId: 'video-tags',
      name: MODELS[0].name,
      fraction,
      detail: t(`Student 8B · run ${run} of 3`, `学生模型 8B · 第 ${run} / 3 次`),
    });
  }
  for (const id of story.state.trainedModels) {
    const model = MODELS.find(m => m.id === id)!;
    jobs.push({
      modelId: id,
      name: model.name,
      fraction: 0.08,
      detail: t('Student 1B · about 40 min left', '学生模型 1B · 约剩 40 分钟'),
    });
  }

  return (
    <div className="training-jobs" aria-label={tr(t('Training', '训练'))} role="group">
      <div className="training-jobs-title">{tr(t('Training', '训练'))}</div>
      {jobs.length === 0 ? (
        <div className="training-empty">{tr(t('No model is training', '没有正在训练的模型'))}</div>
      ) : (
        jobs.map(job => (
          <button key={job.modelId} type="button" className="training-job" onClick={() => story.selectModel(job.modelId)}>
            <span className="training-job-head">
              <span className="training-job-name">{titleCase(tr(job.name))}</span>
              <span className="training-job-pct">{Math.round(job.fraction * 100)}%</span>
            </span>
            <ProgressBar label={tr(job.name)} isLabelHidden value={job.fraction * 100} variant="accent" />
            <span className="training-job-detail">{tr(job.detail)}</span>
          </button>
        ))
      )}
    </div>
  );
}
