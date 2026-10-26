'use client';

import {AppShell} from '@astryxdesign/core/AppShell';
import {Badge} from '@astryxdesign/core/Badge';
import {Button} from '@astryxdesign/core/Button';
import {HStack} from '@astryxdesign/core/HStack';
import {Icon} from '@astryxdesign/core/Icon';
import {IconButton} from '@astryxdesign/core/IconButton';
import {SegmentedControl, SegmentedControlItem} from '@astryxdesign/core/SegmentedControl';
import {SideNav, SideNavItem, SideNavSection} from '@astryxdesign/core/SideNav';
import {Text} from '@astryxdesign/core/Text';
import {TopNav} from '@astryxdesign/core/TopNav';
import {Boxes, RotateCcw} from 'lucide-react';
import {ModelStatusDot} from '@/components/ModelStatus';
import {useLocale} from '@/i18n/LocaleProvider';
import type {Locale} from '@/i18n/messages';
import {RELEASED_STAGE} from '@/story/contentValue';
import {MODELS, type ModelStatus} from '@/story/models';
import {useStory} from '@/story/StoryProvider';

/** Top bar plus the models list. Each model is a conversation with the agent, like a project. */
export function Shell({children}: {children: React.ReactNode}) {
  const {locale, setLocale, t, tr} = useLocale();
  const story = useStory();

  const modelState = (id: string): {status: ModelStatus; stage: number} => {
    const model = MODELS.find(m => m.id === id)!;
    return model.isScripted ? {status: story.status, stage: story.stage} : {status: model.status ?? 'idle', stage: model.stage ?? 0};
  };
  const waitingCount = MODELS.filter(m => modelState(m.id).status === 'waiting').length;

  const topNav = (
    <TopNav
      heading={
        <HStack gap={2} align="center">
          <Text weight="bold">{t('app.title')}</Text>
          <span className="only-wide">
            <Badge label={t('app.demoBanner')} variant="info" />
          </span>
        </HStack>
      }
      endContent={
        <HStack gap={2} align="center">
          <Button
            className="only-wide"
            label={t('nav.restart')}
            variant="ghost"
            size="sm"
            icon={<Icon icon={RotateCcw} size="sm" />}
            onClick={story.restart}
          />
          <IconButton
            className="only-narrow"
            label={t('nav.restart')}
            variant="ghost"
            size="sm"
            icon={<Icon icon={RotateCcw} size="sm" />}
            onClick={story.restart}
          />
          <SegmentedControl label={t('lang.label')} size="sm" value={locale} onChange={v => setLocale(v as Locale)}>
            <SegmentedControlItem value="en" label="EN" />
            <SegmentedControlItem value="zh-CN" label="中文" />
          </SegmentedControl>
        </HStack>
      }
    />
  );

  const sideNav = (
    <SideNav>
      <SideNavSection title={waitingCount > 0 ? `${t('nav.models')} · ${waitingCount} ${t('nav.waiting')}` : t('nav.models')}>
        {MODELS.map(model => {
          const {status, stage} = modelState(model.id);
          return (
            <SideNavItem
              key={model.id}
              label={tr(model.name)}
              icon={Boxes}
              isSelected={story.state.selectedModel === model.id}
              onClick={() => story.selectModel(model.id)}
              endContent={<ModelStatusDot status={status} isReleased={stage >= RELEASED_STAGE} />}
            />
          );
        })}
        <SideNavItem label={t('nav.newModel')} isDisabled endContent={<Text type="supporting" color="secondary">{t('nav.newModelHint')}</Text>} />
      </SideNavSection>
    </SideNav>
  );

  return (
    <AppShell topNav={topNav} sideNav={sideNav} contentPadding={0} height="fill">
      {children}
    </AppShell>
  );
}
