'use client';

import type {ReactNode} from 'react';
import {Theme} from '@astryxdesign/core/theme';
import {themes, defaultThemeSlug} from '../astryx-themes';

/**
 * The Astryx theme (Neutral) for the whole app. The theme module `../astryx-themes.ts` is generated
 * by `npx astryx theme add`; don't edit it by hand. Light mode only until dark mode is designed.
 */
export function AstryxTheme({children}: {children: ReactNode}) {
  return (
    <Theme theme={themes[defaultThemeSlug]} mode="light">
      {children}
    </Theme>
  );
}
