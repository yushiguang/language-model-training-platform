'use client';

import {EmptyState} from '@astryxdesign/core/EmptyState';
import {Heading} from '@astryxdesign/core/Heading';
import {HStack} from '@astryxdesign/core/Layout';
import {Icon} from '@astryxdesign/core/Icon';
import {IconButton} from '@astryxdesign/core/IconButton';
import {Lock, Maximize2, Minimize2, X} from 'lucide-react';
import {useLocale} from '@/i18n/LocaleProvider';
import {t} from '@/i18n/text';
import {useStory} from '@/story/StoryProvider';
import type {PanelId} from '@/story/types';
import {EfficiencyPanel} from './EfficiencyPanel';
import {EvalReportPanel} from './EvalReportPanel';
import {GatePanel} from './GatePanel';
import {LabelingPanel} from './LabelingPanel';
import {PANEL_META} from './panelMeta';
import {PromptDiffPanel} from './PromptDiffPanel';
import {RunsPanel} from './RunsPanel';
import {SamplesPanel} from './SamplesPanel';
import {SchemaPanel} from './SchemaPanel';
import {TrainingSetPanel} from './TrainingSetPanel';

const PANELS: Record<PanelId, () => React.ReactNode> = {
  schema: SchemaPanel,
  samples: SamplesPanel,
  labeling: LabelingPanel,
  evalReport: EvalReportPanel,
  promptDiff: PromptDiffPanel,
  trainingSet: TrainingSetPanel,
  runs: RunsPanel,
  gate: GatePanel,
  efficiency: EfficiencyPanel,
};

/** The floating workspace panel beside the chat, opened from a link or card the agent sends. */
export function PanelHost({panel}: {panel: PanelId}) {
  const {tr} = useLocale();
  const {state, closePanel, toggleExpanded, isPanelAvailable} = useStory();
  const meta = PANEL_META[panel];
  const Body = PANELS[panel];
  const isExpanded = state.isPanelExpanded;

  return (
    <aside className="panel" aria-label={tr(meta.title)}>
      <header className="panel-header">
        <HStack gap={2} align="center">
          <Icon icon={meta.icon} size="sm" color="secondary" />
          <Heading level={2}>{tr(meta.title)}</Heading>
        </HStack>
        <HStack gap={0.5} align="center">
          <IconButton
            className="panel-expand"
            label={tr(isExpanded ? t('Show the chat', '显示对话') : t('Expand to full width', '展开到全宽'))}
            icon={<Icon icon={isExpanded ? Minimize2 : Maximize2} size="sm" />}
            variant="ghost"
            size="sm"
            onClick={toggleExpanded}
          />
          <IconButton label={tr(t('Close panel', '关闭面板'))} icon={<Icon icon={X} size="sm" />} variant="ghost" size="sm" onClick={closePanel} />
        </HStack>
      </header>
      <div className="panel-body" key={panel}>
        {isPanelAvailable(panel) ? (
          <Body />
        ) : (
          <EmptyState icon={<Icon icon={Lock} size="lg" color="secondary" />} title={tr(t('Not ready yet', '尚未就绪'))} description={tr(meta.lockedHint)} />
        )}
      </div>
    </aside>
  );
}
