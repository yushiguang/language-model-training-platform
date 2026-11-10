import type {PromptVersion} from '@tsp/contracts';

/** v3 for a major version, v3.2 for a minor one. */
export const versionLabel = (v: Pick<PromptVersion, 'major' | 'minor'>) => (v.minor ? `v${v.major}.${v.minor}` : `v${v.major}`);

/**
 * Two-level numbers (decided 2026-11-09). "Save" makes the next minor under the parent's major
 * (v3.2 → v3.3; v2 → v2.1); "Save as new version" makes the next major (v5). An Optimiser run
 * reserves one major when it starts and numbers its changes as minors under it (v4.1, v4.2…), so
 * `inMajor` names that major and `reserved` keeps a user's new major from taking it.
 * A first version (no parent) is always a major. Nothing is ever overwritten.
 */
export function nextVersion(
  all: Pick<PromptVersion, 'major' | 'minor'>[],
  base?: Pick<PromptVersion, 'major'> | null,
  kind: 'minor' | 'major' = 'major',
  opts: {inMajor?: number; reserved?: number[]} = {},
): {major: number; minor: number} {
  const top = Math.max(0, ...all.map(v => v.major), ...(opts.reserved ?? []));
  const major = opts.inMajor ?? (kind === 'minor' && base ? base.major : null);
  if (major == null) return {major: top + 1, minor: 0};
  return {major, minor: Math.max(0, ...all.filter(v => v.major === major).map(v => v.minor)) + 1};
}

export const compareVersions = (a: Pick<PromptVersion, 'major' | 'minor'>, b: Pick<PromptVersion, 'major' | 'minor'>) => a.major - b.major || a.minor - b.minor;
