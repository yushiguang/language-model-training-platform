import {useSyncExternalStore} from 'react';
import type {PermissionPoint} from '@yushiguang/sprint-contracts';

/**
 * A call was refused for a missing permission point (`AccessDeniedError`, `code: 'forbidden'`):
 * the page shows the "insufficient access" dialog instead of an error banner. The shell mounts the
 * dialog; any button or page reports here.
 */
let denied: PermissionPoint | null = null;
const listeners = new Set<() => void>();
const set = (p: PermissionPoint | null) => {
  denied = p;
  for (const l of listeners) l();
};

/** True when `e` is a refusal for a missing permission point. */
export const isAccessDenied = (e: unknown): e is {code: 'forbidden'; permission: PermissionPoint} => (e as {code?: unknown})?.code === 'forbidden';

export const reportAccessDenied = (permission: PermissionPoint) => set(permission);
export const clearAccessDenied = () => set(null);

export function useAccessDenied(): PermissionPoint | null {
  return useSyncExternalStore(
    l => (listeners.add(l), () => void listeners.delete(l)),
    () => denied,
    () => null,
  );
}
