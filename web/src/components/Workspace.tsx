'use client';

import {DropdownMenu} from '@astryxdesign/core/DropdownMenu';
import {Heading, Text} from '@astryxdesign/core/Text';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {Step, Stepper} from '@astryxdesign/core/Stepper';
import {Conversation} from '@/components/Conversation';
import {ModelStatusDot} from '@/components/ModelStatus';
import {PanelHost} from '@/components/panels/PanelHost';
import {PANEL_META, PANEL_ORDER} from '@/components/panels/panelMeta';
import {useLocale} from '@/i18n/LocaleProvider';
import {t} from '@/i18n/text';
import {RELEASED_STAGE, STAGES} from '@/story/contentValue';
import {MODELS} from '@/story/models';
import {useStory} from '@/story/StoryProvider';

/** The selected model: a header with its stage strip, the conversation, and the floating workspace panel. */
export function Workspace() {
  const {tr} = useLocale();
  const story = useStory();
  const model = MODELS.find(m => m.id === story.state.selectedModel) ?? MODELS[0];
  const stage = model.isScripted ? story.stage : (model.stage ?? 0);
  const status = model.isScripted ? story.status : (model.status ?? 'idle');
  const {panel, isPanelExpanded} = story.state;

  return (
    <div className="workspace">
      <header className="workspace-header">
        <HStack gap={3} align="center" justify="between" wrap="wrap">
          <VStack gap={0.5}>
            <HStack gap={2} align="center">
              <Heading level={1}>
                {tr(model.name)}
              </Heading>
              <ModelStatusDot status={status} isReleased={stage >= RELEASED_STAGE} hasLabel />
            </HStack>
            <Text type="supporting" color="secondary">
              {tr(model.task)}
            </Text>
          </VStack>
          {model.isScripted && (
            <DropdownMenu
              button={{label: tr(t('Workspace', '工作区')), variant: 'secondary', size: 'sm'}}
              alignment="end"
              items={PANEL_ORDER.map(id => ({
                label: tr(PANEL_META[id].title),
                icon: PANEL_META[id].icon,
                isDisabled: !story.isPanelAvailable(id),
                description: story.isPanelAvailable(id) ? undefined : tr(PANEL_META[id].lockedHint),
                onClick: () => story.openPanel(id),
              }))}
            />
          )}
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
      <div className={isPanelExpanded ? 'split split-expanded' : 'split'}>
        <section className="conversation" aria-label={tr(t('Conversation with the agent', '与智能体的对话'))}>
          <Conversation key={model.id} model={model} />
        </section>
        {panel && model.isScripted && <PanelHost panel={panel} />}
      </div>
    </div>
  );
}
