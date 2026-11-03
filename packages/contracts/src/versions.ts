import type {PromptVersion} from './types.ts';

export const versionLabel = (v: Pick<PromptVersion, 'major' | 'minor'>) => `v${v.major}.${v.minor}`;

/** Save makes the next minor in the edited version's major line; Save as starts the next major. Versions are never overwritten. */
export function nextVersion(all: Pick<PromptVersion, 'major' | 'minor'>[], base: Pick<PromptVersion, 'major'> | null, kind: 'minor' | 'major'): {major: number; minor: number} {
  if (!all.length) return {major: 1, minor: 0};
  const topMajor = Math.max(...all.map(v => v.major));
  if (kind === 'major' || !base) return {major: topMajor + 1, minor: 0};
  const inLine = all.filter(v => v.major === base.major);
  return {major: base.major, minor: Math.max(...inLine.map(v => v.minor)) + 1};
}

export const compareVersions = (a: Pick<PromptVersion, 'major' | 'minor'>, b: Pick<PromptVersion, 'major' | 'minor'>) => a.major - b.major || a.minor - b.minor;
