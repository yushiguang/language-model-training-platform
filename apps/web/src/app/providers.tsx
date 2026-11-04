'use client';

import {PageTelemetry} from '@/components/PageTelemetry';
import {UiProvider} from '@/ui';

export function Providers({children}: {children: React.ReactNode}) {
  return (
    <UiProvider>
      <PageTelemetry />
      {children}
    </UiProvider>
  );
}
