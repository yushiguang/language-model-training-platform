import {Repo} from '../data/repo';
import {getPlatform} from '../platform/config';
import type {Platform} from '../platform/interfaces';

export interface App {
  repo: Repo;
  platform: Platform;
  user: () => Promise<{id: string; name: string}>;
}

let app: App | null = null;

export function getApp(): App {
  if (app) return app;
  const platform = getPlatform();
  let user: Promise<{id: string; name: string}> | null = null;
  app = {repo: new Repo(platform.sql), platform, user: () => (user ??= platform.identity.currentUser())};
  return app;
}

export const now = () => new Date().toISOString();

/** Tiny event bus so pages refresh when a background run writes something. */
type Listener = () => void;
const listeners = new Set<Listener>();
export const onChange = (fn: Listener) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
export const emitChange = () => listeners.forEach(fn => fn());
