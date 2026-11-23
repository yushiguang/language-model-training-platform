import type {OptimisationRun, PromptVersion} from '@yushiguang/sprint-contracts';

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

/**
 * A version as the pages show it (wireframes v346, decided 2026-11-21): flat numbers, one per
 * major. The two-level numbers stay in the records, and map onto the flat ones like this:
 *
 * - A save over a version is the next minor of its major, so the card keeps its number and shows
 *   the newest save (the edit overwrites the version in the UI; every save stays in the records).
 * - An Optimiser run reserves a major: its card shows the best try it kept, or nothing yet. Its
 *   tries (the run's minors) are never cards of their own. A save over its result is a minor of
 *   that major too, and the card shows the save from then on.
 */
export interface ShownVersion {
  major: number;
  /** `v3`. */
  label: string;
  /** What the card shows; null for an Optimiser run that has kept no try yet. */
  version: PromptVersion | null;
  /** The Optimiser run that owns this major, if one does. */
  run: OptimisationRun | null;
}

/** The versions as the pages show them, newest number first. */
export function shownVersions(versions: PromptVersion[], runs: OptimisationRun[]): ShownVersion[] {
  const majors = new Set<number>([...versions.map(v => v.major), ...runs.map(r => r.major).filter(m => m != null)]);
  const out: ShownVersion[] = [];
  for (const major of majors) {
    const run = runs.find(r => r.major === major) ?? null;
    const inMajor = versions.filter(v => v.major === major).sort((a, b) => b.minor - a.minor);
    const saved = inMajor.find(v => v.madeBy !== 'optimiser');
    let version = saved ?? null;
    if (!version && run) {
      const kept = (run.history ?? []).filter(h => h.outcome === 'kept' && h.versionId && h.score != null).sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
      version = (kept && inMajor.find(v => v.id === kept.versionId)) ?? null;
    }
    // A major with no run and no save of a person (older records): its newest version.
    if (!version && !run) version = inMajor[0] ?? null;
    out.push({major, label: `v${major}`, version, run});
  }
  return out.sort((a, b) => b.major - a.major);
}

/** The shown version a version belongs to (its major). */
export const shownVersionOf = (shown: ShownVersion[], v: Pick<PromptVersion, 'major'>) => shown.find(s => s.major === v.major) ?? null;
