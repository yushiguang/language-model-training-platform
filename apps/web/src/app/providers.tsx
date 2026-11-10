'use client';

import {Suspense} from 'react';
import {NavWatcher} from '@/components/nav';
import {PageTelemetry} from '@/components/PageTelemetry';
import {UiProvider} from '@/ui';

export function Providers({children}: {children: React.ReactNode}) {
  return (
    <UiProvider>
      <PageTelemetry />
      <Suspense fallback={null}>
        <NavWatcher />
      </Suspense>
      {children}
    </UiProvider>
  );
}
