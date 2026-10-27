'use client';

import {Heading, Text} from '@astryxdesign/core/Text';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {Step, Stepper} from '@astryxdesign/core/Stepper';
import {ArtifactModal} from '@/components/ArtifactModal';
import {ArtifactsMenu} from '@/components/ArtifactsMenu';
import {Conversation} from '@/components/Conversation';
import {ModelStatusDot} from '@/components/ModelStatus';
import {useLocale} from '@/i18n/LocaleProvider';
import {t} from '@/i18n/text';
import {MODELS} from '@/story/models';
import {useStory} from '@/story/StoryProvider';
import {RELEASED_STAGE, STAGES} from '@/story/videoTags';

/** The selected model: a header with its stage strip, the conversation, and artifacts opened over it. */
export function Workspace() {
  const {tr} = useLocale();
  const story = useStory();
  const model = MODELS.find(m => m.id === story.state.selectedModel) ?? MODELS[0];
  const stage = model.isScripted ? story.stage : (model.stage ?? 0);
  const status = model.isScripted ? story.status : (model.status ?? 'idle');

  return (
    <div className="workspace">
      <header className="workspace-header">
        <HStack gap={3} align="start" justify="between">
          <VStack gap={0.5} className="workspace-title">
            <HStack gap={3} align="center" wrap="wrap">
              <Heading level={1}>{tr(model.name)}</Heading>
              <ModelStatusDot status={status} isReleased={stage >= RELEASED_STAGE} hasLabel />
            </HStack>
            <Text type="supporting" color="secondary">
              {tr(model.task)}
            </Text>
          </VStack>
          {model.isScripted && <ArtifactsMenu />}
        </HStack>
        <div className="stage-strip">
          <Stepper
            activeStep={stage}
            density="compact"
            horizontalOptions={{minimumStepWidth: 112, collapsedVariant: 'withLabel'}}
            label={tr(t('Workflow stages', '流程阶段'))}>
            {STAGES.map((s, i) => (
              <Step
                key={s.name.en}
                step={i}
                label={tr(s.name)}
                description={s.isPlanned ? tr(t('Planned', '规划中')) : undefined}
                status={stage >= RELEASED_STAGE || i < stage ? 'success' : undefined}
              />
            ))}
          </Stepper>
        </div>
      </header>
      <section className="conversation" aria-label={tr(t('Conversation with the agent', '与智能体的对话'))}>
        <Conversation key={model.id} model={model} />
      </section>
      {model.isScripted && <ArtifactModal />}
    </div>
  );
}
