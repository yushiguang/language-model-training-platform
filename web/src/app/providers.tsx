'use client';

import Link from 'next/link';
import {Theme} from '@astryxdesign/core/theme';
import {LinkProvider} from '@astryxdesign/core/Link';
import {neutralTheme} from '@astryxdesign/theme-neutral/built';
import {LocaleProvider} from '@/i18n/LocaleProvider';

export function Providers({children}: {children: React.ReactNode}) {
  return (
    <Theme theme={neutralTheme}>
      <LinkProvider component={Link}>
        <LocaleProvider>{children}</LocaleProvider>
      </LinkProvider>
    </Theme>
  );
}
