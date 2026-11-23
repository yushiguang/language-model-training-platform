import type {PageId} from '@yushiguang/sprint-contracts';

/** Maps a URL path (with or without a base path) to a page. */
export function pageFromPath(path: string): PageId {
  const p = path.replace(/\.html$/, '').replace(/\/+$/, '');
  // A label set belongs to Gold Labels. The overview has no page view of its own yet: the agent reads the project list.
  if (/\/gold\/set$/.test(p)) return 'gold';
  const last = p.split('/').pop() ?? '';
  const map: Record<string, PageId> = {sources: 'sources', source: 'source', 'prompt-design': 'prompt_design', dataset: 'dataset', gold: 'gold', prompt: 'prompt'};
  return map[last] ?? 'projects';
}
