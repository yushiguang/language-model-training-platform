'use client';

import {useEffect, useState, useSyncExternalStore, type ReactNode} from 'react';
import type {RuntimeInfo} from '@yushiguang/sprint-contracts';
import {currentTenant, getRuntimeInfo, rememberTenant} from '@/backend-api';
import {useRouter} from 'next/navigation';
import {Button, Icon} from '@/ui';
import {t} from '@/i18n';

/**
 * Who is signed in (2026-11-16 refinements, 1.1). Read once per page load and kept here, so a step
 * change or a language switch (which re-mounts the tree) shows the user's name at once, never an
 * empty avatar. Kept per tenant (#94): opening another tenant reads it again. A failed read is not
 * kept: Retry reads again.
 */
let cached: {tenant: string | undefined; info: RuntimeInfo} | null = null;
let pending: {tenant: string | undefined; info: Promise<RuntimeInfo>} | null = null;

const fresh = () => (cached && cached.tenant === currentTenant() ? cached.info : null);

function loadRuntime(): Promise<RuntimeInfo> {
  const tenant = currentTenant();
  if (cached && cached.tenant === tenant) return Promise.resolve(cached.info);
  if (!pending || pending.tenant !== tenant) {
    const info = getRuntimeInfo().then(
      i => ((cached = {tenant, info: i}), i),
      e => {
        pending = null;
        throw e;
      },
    );
    pending = {tenant, info};
  }
  return pending!.info;
}

/** Forgets the runtime info, so the next page reads it again (a tenant was created or renamed). */
export function forgetRuntime(): void {
  cached = null;
  pending = null;
}

/** Told after every move to another page (`NavWatcher`): the address may name another tenant. */
const moved = new Set<() => void>();
export function pageMoved(): void {
  for (const l of moved) l();
}
const onMove = (l: () => void) => (moved.add(l), () => void moved.delete(l));

export function useRuntime(): {info: RuntimeInfo | null; error: string | null; retry: () => void} {
  // The page's tenant, read again after every move: another tenant's page reads the info again.
  const tenant = useSyncExternalStore(onMove, currentTenant, () => undefined);
  const [got, setGot] = useState<{tenant: string | undefined; info: RuntimeInfo} | null>(cached);
  const info = got && got.tenant === tenant ? got.info : fresh();
  const [error, setError] = useState<string | null>(null);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    if (info) return;
    let live = true;
    loadRuntime().then(
      i => live && setGot({tenant, info: i}),
      e => live && setError((e as Error)?.message || 'The sign-in service did not answer.'),
    );
    return () => {
      live = false;
    };
  }, [info, tenant, tries]);
  return {info, error, retry: () => (setError(null), setTries(n => n + 1))};
}

/**
 * Renders its children only once the signed-in user is known: the loading state until then, and
 * an error with Retry when nobody is signed in or the check failed. No page renders anonymously.
 */
export function SignedIn({children, inTenant}: {children: ReactNode; inTenant?: boolean}) {
  const {info, error, retry} = useRuntime();
  const router = useRouter();
  // A page of a tenant the caller is not in (#94): forget it here and go home, where their own are.
  const outside = !!inTenant && !!info && !info.tenant;
  useEffect(() => {
    if (!outside) return;
    rememberTenant(null);
    forgetRuntime();
    router.replace('/');
  }, [outside, router]);
  if (info && !outside) return <>{children}</>;
  if (error)
    return (
      <div className="k app b">
        <div className="empty" role="alert">
          <h2>{t('We could not confirm who you are')}</h2>
          <p>{t('Sign in again, then retry. {why}', {why: t(error)})}</p>
          <p>
            <Button label={t('Retry')} kind="primary" onClick={retry} />
          </p>
        </div>
      </div>
    );
  return (
    <div className="k app b">
      <div className="loading" role="status" aria-label={t('Loading')}>
        <Icon name="ring" />
      </div>
    </div>
  );
}
