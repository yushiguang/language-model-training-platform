'use client';

import {usePathname} from 'next/navigation';
import {AppShell} from '@astryxdesign/core/AppShell';
import {TopNav} from '@astryxdesign/core/TopNav';
import {SideNav, SideNavHeading, SideNavItem, SideNavSection} from '@astryxdesign/core/SideNav';
import {SegmentedControl, SegmentedControlItem} from '@astryxdesign/core/SegmentedControl';
import {Badge} from '@astryxdesign/core/Badge';
import {HStack} from '@astryxdesign/core/HStack';
import {Text} from '@astryxdesign/core/Text';
import {useLocale} from '@/i18n/LocaleProvider';
import type {Locale} from '@/i18n/messages';
import {STAGES} from '@/mock/stages';

export function Shell({children}: {children: React.ReactNode}) {
  const {locale, setLocale, t} = useLocale();
  const pathname = usePathname();

  const topNav = (
    <TopNav
      heading={
        <HStack gap={2} align="center">
          <Text weight="bold">{t('app.title')}</Text>
          <Badge label={t('app.demoBanner')} />
        </HStack>
      }
      endContent={
        <SegmentedControl label={t('lang.label')} size="sm" value={locale} onChange={v => setLocale(v as Locale)}>
          <SegmentedControlItem value="en" label="EN" />
          <SegmentedControlItem value="zh-CN" label="中文" />
        </SegmentedControl>
      }
    />
  );

  const sideNav = (
    <SideNav header={<SideNavHeading heading={t('app.title')} subheading={t('app.subtitle')} />}>
      <SideNavSection title={t('nav.projects')} isHeaderHidden>
        <SideNavItem label={t('nav.projects')} href="/" isSelected={pathname === '/'} />
        <SideNavItem label={t('nav.efficiency')} href="/efficiency/" isSelected={pathname.startsWith('/efficiency')} />
      </SideNavSection>
      <SideNavSection title={t('nav.workflow')}>
        {STAGES.map((stage, i) => (
          <SideNavItem
            key={stage.slug}
            label={`${i + 1}. ${t(stage.titleKey)}`}
            href={`/project/${stage.slug}/`}
            isSelected={pathname.startsWith(`/project/${stage.slug}`)}
            endContent={stage.isPlanned ? <Badge label={t('stage.planned')} /> : undefined}
          />
        ))}
      </SideNavSection>
    </SideNav>
  );

  return (
    <AppShell topNav={topNav} sideNav={sideNav} contentPadding={6}>
      {children}
    </AppShell>
  );
}
