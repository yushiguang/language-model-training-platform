'use client';

import {Icon} from '@astryxdesign/core/Icon';
import {ArrowUpRight, FilePen, FilePlus2} from 'lucide-react';
import {PANEL_META} from '@/components/panels/panelMeta';
import {useLocale} from '@/i18n/LocaleProvider';
import {t} from '@/i18n/text';
import {useStory} from '@/story/StoryProvider';
import type {Item} from '@/story/types';

const ACTION = {
  created: {label: t('Created', '已创建'), icon: FilePlus2},
  updated: {label: t('Updated', '已更新'), icon: FilePen},
};

/**
 * A page the agent wrote, shown in the chat like an artifact: what it is, that it was
 * created or updated just now, and a way to open it over the chat.
 */
export function ArtifactCard({item}: {item: Extract<Item, {kind: 'artifact'}>}) {
  const {tr} = useLocale();
  const {openPanel} = useStory();
  const meta = PANEL_META[item.panel];
  const action = ACTION[item.action];
  const title = tr(item.title);

  return (
    <button
      type="button"
      className="artifact-card"
      onClick={() => openPanel(item.panel)}
      aria-label={`${title} · ${tr(action.label)} · ${tr(t('Open', '打开'))}`}>
      <span className="artifact-tile" aria-hidden>
        <Icon icon={meta.icon} size="md" color="inherit" />
      </span>
      <span className="artifact-text">
        <span className="artifact-title">{title}</span>
        <span className="artifact-meta">
          <span className={`write-pill write-pill-${item.action}`}>
            <Icon icon={action.icon} size="xsm" color="inherit" />
            {tr(action.label)}
          </span>
          <span className="artifact-detail">
            {tr(meta.kind)} · {tr(item.detail)}
          </span>
        </span>
      </span>
      <span className="artifact-open" aria-hidden>
        {tr(t('Open', '打开'))}
        <Icon icon={ArrowUpRight} size="sm" color="inherit" />
      </span>
    </button>
  );
}
