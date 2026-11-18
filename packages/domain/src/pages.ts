import type {PageId} from '@yushiguang/sprint-contracts';

/** Maps a URL path (with or without a base path) to a page. */
export function pageFromPath(path: string): PageId {
  const p = path.replace(/\.html$/, '').replace(/\/+$/, '');
  if (/\/prompt\/edit$/.test(p)) return 'prompt_edit';
  const last = p.split('/').pop() ?? '';
  const map: Record<string, PageId> = {'prompt-design': 'prompt_design', dataset: 'dataset', gold: 'gold', prompt: 'prompt'};
  return map[last] ?? 'projects';
}
