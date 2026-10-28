'use client';

import {titleCase} from '@/i18n/titleCase';
import {DropdownMenu} from '@astryxdesign/core/DropdownMenu';
import {Icon} from '@astryxdesign/core/Icon';
import {Layers3} from 'lucide-react';
import {GateTag} from '@/components/GateTag';
import {PANEL_META} from '@/components/panels/panelMeta';
import {useLocale} from '@/i18n/LocaleProvider';
import {t} from '@/i18n/text';
import {useStory} from '@/story/StoryProvider';

/** Every artifact the agent has written for this model, newest state of each, in the order they were created. */
export function ArtifactsMenu() {
  const {tr} = useLocale();
  const {artifacts, openPanel} = useStory();
  const label = `${tr(t('Artifacts', '产出物'))} · ${artifacts.length}`;

  return (
    <DropdownMenu
      button={{
        label,
        variant: 'secondary',
        size: 'sm',
        icon: <Icon icon={Layers3} size="sm" />,
        isDisabled: artifacts.length === 0,
      }}
      alignment="end"
      menuWidth={340}
      menuMaxHeight={560}
      header={<div className="menu-header">{tr(t('Written by the agent for this model', '智能体为这个模型生成的内容'))}</div>}
      items={artifacts.map(a => ({
        id: a.ref ? `${a.panel}:${a.ref}` : a.panel,
        label: a.version ? `${titleCase(tr(a.title))} · ${a.version.toUpperCase()}` : titleCase(tr(a.title)),
        icon: PANEL_META[a.panel].icon,
        description: `${tr(PANEL_META[a.panel].kind)} · ${tr(a.detail)}`,
        endContent: a.gate !== undefined ? <GateTag passed={a.gate} /> : a.writes > 1 ? <span className="menu-updated">{tr(t('Updated', '已更新'))}</span> : undefined,
        onClick: () => openPanel(a.panel, a.ref),
      }))}
    />
  );
}
