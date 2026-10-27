'use client';

import {Icon} from '@astryxdesign/core/Icon';
import {Check} from 'lucide-react';
import {useLocale} from '@/i18n/LocaleProvider';
import {t} from '@/i18n/text';
import {RELEASED_STAGE, STAGES} from '@/story/videoTags';

/** Where the model's workflow stands: every step named in full, done ones ticked, the current one marked. */
export function WorkflowSteps({stage, skipped = []}: {stage: number; skipped?: number[]}) {
  const {tr} = useLocale();
  return (
    <ol className="flow" aria-label={tr(t('Workflow', '流程'))}>
      {STAGES.map((s, i) => {
        const state = skipped.includes(i) ? 'skipped' : stage >= RELEASED_STAGE || i < stage ? 'done' : i === stage ? 'current' : 'todo';
        return (
          <li key={s.name.en} className={`flow-step flow-${state}`} aria-current={state === 'current' ? 'step' : undefined}>
            <span className="flow-mark" aria-hidden>
              {state === 'done' ? <Icon icon={Check} size="xsm" color="inherit" /> : state === 'skipped' ? '–' : i + 1}
            </span>
            <span className="flow-name">{tr(s.name)}</span>
            {s.isPlanned && <span className="flow-planned">{tr(t('planned', '规划中'))}</span>}
            {state === 'skipped' && <span className="flow-planned">{tr(t('skipped', '已跳过'))}</span>}
            {state === 'done' && <span className="visually-hidden">{tr(t('(done)', '（已完成）'))}</span>}
          </li>
        );
      })}
    </ol>
  );
}
