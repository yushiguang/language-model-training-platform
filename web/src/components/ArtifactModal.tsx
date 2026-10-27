'use client';

import {titleCase} from '@/i18n/titleCase';
import {useEffect, useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {Dialog} from '@astryxdesign/core/Dialog';
import {Icon} from '@astryxdesign/core/Icon';
import {IconButton} from '@astryxdesign/core/IconButton';
import {ProgressBar} from '@astryxdesign/core/ProgressBar';
import {Info, SquareArrowOutUpRight, X} from 'lucide-react';
import {AdjudicationPanel} from '@/components/panels/AdjudicationPanel';
import {EfficiencyPanel} from '@/components/panels/EfficiencyPanel';
import {EvalReportPanel} from '@/components/panels/EvalReportPanel';
import {GatePanel} from '@/components/panels/GatePanel';
import {LabelingPanel} from '@/components/panels/LabelingPanel';
import {PANEL_META} from '@/components/panels/panelMeta';
import {PromptDiffPanel} from '@/components/panels/PromptDiffPanel';
import {RunsPanel} from '@/components/panels/RunsPanel';
import {SamplesPanel} from '@/components/panels/SamplesPanel';
import {SchemaPanel} from '@/components/panels/SchemaPanel';
import {TrainingSetPanel} from '@/components/panels/TrainingSetPanel';
import {useMediaQuery} from '@/components/useMediaQuery';
import {VersionTag} from '@/components/VersionTag';
import {useLocale} from '@/i18n/LocaleProvider';
import {t} from '@/i18n/text';
import {LABELING_POSTS} from '@/mock/posts';
import {useStory} from '@/story/StoryProvider';
import type {PanelId} from '@/story/types';

const PANELS: Record<PanelId, () => React.ReactNode> = {
  schema: SchemaPanel,
  samples: SamplesPanel,
  labeling: LabelingPanel,
  adjudication: AdjudicationPanel,
  evalReport: EvalReportPanel,
  promptDiff: PromptDiffPanel,
  trainingSet: TrainingSetPanel,
  runs: RunsPanel,
  gate: GatePanel,
  efficiency: EfficiencyPanel,
};

/**
 * An artifact opened over the chat, like a Claude artifact. Every page also has its own
 * full page in the product; the demo only says where it would be.
 */
export function ArtifactModal() {
  const {tr} = useLocale();
  const {state, artifacts, closePanel} = useStory();
  const isNarrow = useMediaQuery('(max-width: 640px)');
  const [hasPageNote, setHasPageNote] = useState(false);
  const panel = state.panel;
  const entry = artifacts.find(a => a.panel === panel);

  useEffect(() => setHasPageNote(false), [panel]);

  if (!panel || !entry) return null;
  const meta = PANEL_META[panel];
  const Body = PANELS[panel];
  const title = titleCase(tr(entry.title));

  return (
    <Dialog
      isOpen
      onOpenChange={isOpen => !isOpen && closePanel()}
      width="min(1120px, calc(100vw - 48px))"
      maxHeight="calc(100dvh - 48px)"
      variant={isNarrow ? 'fullscreen' : 'standard'}
      purpose="info"
      padding={0}
      aria-label={entry.version ? `${title} ${entry.version.toUpperCase()}` : title}
      className="artifact-dialog">
      <div className="artifact-modal">
        <header className="artifact-modal-header">
          <span className="artifact-tile" aria-hidden>
            <Icon icon={meta.icon} size="md" color="inherit" />
          </span>
          <div className="artifact-modal-heading">
            <h2 className="artifact-modal-title">
              {title}
              <VersionTag version={entry.version} />
            </h2>
          </div>
          {panel === 'labeling' && <LabelingProgress />}
          <div className="artifact-modal-actions">
            <Button
              className="only-wide"
              label={tr(t('Open full page', '打开完整页面'))}
              variant="secondary"
              size="sm"
              icon={<Icon icon={SquareArrowOutUpRight} size="sm" />}
              onClick={() => setHasPageNote(v => !v)}
            />
            <IconButton
              className="only-narrow"
              label={tr(t('Open full page', '打开完整页面'))}
              variant="ghost"
              size="sm"
              icon={<Icon icon={SquareArrowOutUpRight} size="sm" />}
              onClick={() => setHasPageNote(v => !v)}
            />
            <IconButton label={tr(t('Close', '关闭'))} variant="ghost" size="sm" icon={<Icon icon={X} size="sm" />} onClick={closePanel} />
          </div>
        </header>
        {hasPageNote && (
          <div className="page-note" role="status">
            <span className="icon-slot">
              <Icon icon={Info} size="sm" color="secondary" />
            </span>
            <span>
              {tr(t('Full pages come after the demo. In the product, this opens at ', '完整页面会在演示之后实现。在正式产品里，它会在这个地址打开：'))}
              <code>/models/video-tags/{meta.path}</code>
            </span>
          </div>
        )}
        <div className="artifact-modal-body" key={panel}>
          <Body />
        </div>
      </div>
    </Dialog>
  );
}

/** How far the user's labeling share has come, kept in the header so it stays visible while labeling. */
function LabelingProgress() {
  const {tr} = useLocale();
  const {state} = useStory();
  const done = LABELING_POSTS.filter(id => state.myLabels[id]).length;
  const label = tr(t(`${done} / ${LABELING_POSTS.length} labeled`, `已标注 ${done} / ${LABELING_POSTS.length}`));
  return (
    <div className="header-progress">
      <span className="labeling-count">{label}</span>
      <ProgressBar label={label} isLabelHidden value={(done / LABELING_POSTS.length) * 100} variant={done === LABELING_POSTS.length ? 'success' : 'accent'} />
    </div>
  );
}
