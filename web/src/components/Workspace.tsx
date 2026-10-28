'use client';

import {titleCase} from '@/i18n/titleCase';
import {ArtifactModal} from '@/components/ArtifactModal';
import {ArtifactsMenu} from '@/components/ArtifactsMenu';
import {Conversation} from '@/components/Conversation';
import {useLocale} from '@/i18n/LocaleProvider';
import {t} from '@/i18n/text';
import {MODELS} from '@/story/models';
import {useStory} from '@/story/StoryProvider';

/** The selected model: its name and artifacts, the conversation, and artifacts opened over it. Its workflow lives in the side panel. */
export function Workspace() {
  const {tr} = useLocale();
  const story = useStory();
  const model = MODELS.find(m => m.id === story.state.selectedModel) ?? MODELS[0];

  return (
    <div className="workspace">
      <header className="workspace-header">
        <h1>{titleCase(tr(model.name))}</h1>
        {model.isScripted && <ArtifactsMenu />}
      </header>
      <section className="conversation" aria-label={tr(t('Conversation with the agent', '与智能体的对话'))}>
        <Conversation key={model.id} model={model} />
      </section>
      {model.isScripted && <ArtifactModal />}
    </div>
  );
}
