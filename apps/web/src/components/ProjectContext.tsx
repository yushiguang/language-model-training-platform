'use client';
import {systemConfig} from '@tsp/domain';

import {useSearchParams} from 'next/navigation';
import {createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode} from 'react';
import {loadProjectState, subscribeChanges, tick, type ProjectState} from '@/backend-api';


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
      // The workflow manager (2026-11-11): every change event, and the sweep below, runs one
      // check of what should be running (`tick`, built on `dueStarts`). Starts are keyed, so
      // running it often is safe. Every auto task also has a button to start it by hand.
      if (s) void tick({projectId});
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
      pending.current = setTimeout(() => void refresh(), systemConfig().ui.changeDebounceMs);
    });
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      off();
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  // While anything runs, read again every few seconds: a run in another tab, or one whose tab
  // closed, changes state without an event in this tab.
  const running = !!state && (state.runs.some(r => r.state === 'running') || state.optimisation.some(o => o.state === 'running'));
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => void refresh(), systemConfig().ui.activePollMs);
    return () => clearInterval(id);
  }, [running, refresh]);

  // The sweep: a change this tab never heard of (another tab, a closed page) is still picked up.
  useEffect(() => {
    if (!projectId) return;
    const id = setInterval(() => void refresh(), systemConfig().ui.sweepMs);
    return () => clearInterval(id);
  }, [projectId, refresh]);

  const href = useCallback((path: string, p?: Record<string, string | undefined>) => hrefFor(projectId, path, p), [projectId]);
  return <ProjectCtx.Provider value={{projectId, state, loading, error, refresh, href}}>{children}</ProjectCtx.Provider>;
}
