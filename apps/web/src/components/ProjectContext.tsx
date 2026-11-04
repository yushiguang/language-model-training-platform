'use client';

import {useSearchParams} from 'next/navigation';
import {createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode} from 'react';
import {loadProjectState, subscribeChanges, type ProjectState} from '@/backend-api';

interface Ctx {
  projectId: string;
  state: ProjectState | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** Builds a link inside this project. */
  href: (path: string, params?: Record<string, string | undefined>) => string;
}

const ProjectCtx = createContext<Ctx | null>(null);

export function useProject(): Ctx {
  const c = useContext(ProjectCtx);
  if (!c) throw new Error('useProject outside ProjectProvider');
  return c;
}

export function hrefFor(projectId: string, path: string, params: Record<string, string | undefined> = {}) {
  const q = new URLSearchParams({p: projectId});
  for (const [k, v] of Object.entries(params)) if (v != null) q.set(k, v);
  return `${path}${path.endsWith('/') ? '' : '/'}?${q.toString()}`;
}

/** Loads the project named by ?p= and reloads whenever a service writes. */
export function ProjectProvider({children}: {children: ReactNode}) {
  const params = useSearchParams();
  const projectId = params.get('p') ?? '';
  const [state, setState] = useState<ProjectState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    try {
      const s = await loadProjectState(projectId);
      setState(s);
      setError(s ? null : 'This project does not exist.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    setLoading(true);
    void refresh();
    const off = subscribeChanges(() => {
      if (pending.current) clearTimeout(pending.current);
      pending.current = setTimeout(() => void refresh(), 120);
    });
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      off();
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  const href = useCallback((path: string, p?: Record<string, string | undefined>) => hrefFor(projectId, path, p), [projectId]);
  return <ProjectCtx.Provider value={{projectId, state, loading, error, refresh, href}}>{children}</ProjectCtx.Provider>;
}
