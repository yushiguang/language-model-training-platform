import type {PromptVersion} from '@tsp/contracts';

/** Versions are single numbers (v1, v2, v3 …), decided 2026-11-05. Older minor versions keep their dot. */
export const versionLabel = (v: Pick<PromptVersion, 'major' | 'minor'>) => (v.minor ? `v${v.major}.${v.minor}` : `v${v.major}`);

/**
 * Every save makes the next number (v13 after v12), whichever version it was edited from; nothing
 * is overwritten. `base` and `kind` are kept for older callers and no longer change the number.
 */
export function nextVersion(all: Pick<PromptVersion, 'major' | 'minor'>[], _base?: Pick<PromptVersion, 'major'> | null, _kind?: 'minor' | 'major'): {major: number; minor: number} {
  if (!all.length) return {major: 1, minor: 0};
  return {major: Math.max(...all.map(v => v.major)) + 1, minor: 0};
}

export const compareVersions = (a: Pick<PromptVersion, 'major' | 'minor'>, b: Pick<PromptVersion, 'major' | 'minor'>) => a.major - b.major || a.minor - b.minor;
