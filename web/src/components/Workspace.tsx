'use client';

import {ArtifactModal} from '@/components/ArtifactModal';
import {ArtifactsMenu} from '@/components/ArtifactsMenu';
import {Conversation} from '@/components/Conversation';
import {DatasetStatus} from '@/components/DatasetStatus';
import {TrainButton} from '@/components/TrainButton';
import {WorkflowSteps} from '@/components/WorkflowSteps';
import {useLocale} from '@/i18n/LocaleProvider';
import {t} from '@/i18n/text';
import {MODELS} from '@/story/models';
import {useStory} from '@/story/StoryProvider';

/**
 * The selected model: a header with what it is, where its workflow stands and the state of
 * its three datasets, then the conversation, and artifacts opened over it.
 */
export function Workspace() {
  const {tr} = useLocale();
  const story = useStory();
  const model = MODELS.find(m => m.id === story.state.selectedModel) ?? MODELS[0];
  const stage = model.isScripted ? story.stage : (model.stage ?? 0);
  const datasets = model.isScripted ? story.datasets : (model.datasets ?? null);

  return (
    <div className="workspace">
      <header className="workspace-header">
        <div className="ws-row">
          <div className="ws-title">
            <h1>{tr(model.name)}</h1>
            <span className="ws-desc" title={tr(model.task)}>
              {tr(model.task)}
            </span>
          </div>
          <div className="ws-actions">
            <DatasetStatus datasets={datasets} canOpen={model.isScripted === true} />
            <TrainButton model={model} datasets={datasets} />
            {model.isScripted && <ArtifactsMenu />}
          </div>
        </div>
        <WorkflowSteps stage={stage} skipped={model.skippedStages} />
      </header>
      <section className="conversation" aria-label={tr(t('Conversation with the agent', '与智能体的对话'))}>
        <Conversation key={model.id} model={model} />
      </section>
      {model.isScripted && <ArtifactModal />}
    </div>
  );
}
