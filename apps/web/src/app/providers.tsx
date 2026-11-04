'use client';

import Link from 'next/link';
import {Theme} from '@astryxdesign/core/theme';
import {LinkProvider} from '@astryxdesign/core/Link';
import {neutralTheme} from '@astryxdesign/theme-neutral/built';
import {PageTelemetry} from '@/components/PageTelemetry';

export function Providers({children}: {children: React.ReactNode}) {
  return (
    <Theme theme={neutralTheme} mode="light">
      <LinkProvider component={Link}>
        <PageTelemetry />
        {children}
      </LinkProvider>
    </Theme>
  );
}
