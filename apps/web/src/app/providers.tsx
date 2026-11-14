'use client';

import {Suspense} from 'react';
import {NavWatcher} from '@/components/nav';
import {PageTelemetry} from '@/components/PageTelemetry';
import {track} from '@/backend-api';
import {LocaleProvider} from '@/i18n';
import {UiProvider} from '@/ui';

const localeChanged = (locale: 'en' | 'zh') => track('locale_changed', {locale});

const stable = (
  <>
    <PageTelemetry />
    <Suspense fallback={null}>
      <NavWatcher />
    </Suspense>
  </>
);

export function Providers({children}: {children: React.ReactNode}) {
  return (
    <LocaleProvider keep={stable} onChange={localeChanged}>
      <UiProvider>{children}</UiProvider>
    </LocaleProvider>
  );
}
