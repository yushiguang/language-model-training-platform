import type {PageId} from '@tsp/contracts';

/** Maps a URL path (with or without a base path) to a page. */
export function pageFromPath(path: string): PageId {
  const p = path.replace(/\.html$/, '').replace(/\/+$/, '');
  if (/\/prompt\/edit$/.test(p)) return 'prompt_edit';
  if (/\/prompt\/compare$/.test(p)) return 'compare';
  const last = p.split('/').pop() ?? '';
  const map: Record<string, PageId> = {setup: 'setup', dataset: 'dataset', gold: 'gold', prompt: 'prompt', report: 'report', 'training-set': 'training'};
  return map[last] ?? 'projects';
}
