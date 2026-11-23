import type {Project} from '@yushiguang/sprint-contracts';

/**
 * The projects this browser opened most recently, newest first (the project switch menu's
 * Recent). Kept in local storage: a convenience only, so an unreadable store just means none.
 */
const KEY = 'sprint-recent-projects';
const KEEP = 20;

function read(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function rememberProject(id: string) {
  try {
    localStorage.setItem(KEY, JSON.stringify([id, ...read().filter(x => x !== id)].slice(0, KEEP)));
  } catch {
    // private mode: nothing is remembered
  }
}

/** `list` ordered by when each was last opened here (`current` first), then the rest as listed. */
export function recentProjects(list: Project[], current: string): Project[] {
  const order = [current, ...read().filter(x => x !== current)];
  const rank = (p: Project) => {
    const i = order.indexOf(p.id);
    return i < 0 ? order.length : i;
  };
  return list.map((p, i) => ({p, i})).sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i).map(x => x.p);
}
