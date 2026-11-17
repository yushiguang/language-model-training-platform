'use client';

import {useEffect, useState, type ReactNode} from 'react';
import type {RuntimeInfo} from '@sprint/contracts';
import {getRuntimeInfo} from '@/backend-api';
import {Button, Icon} from '@/ui';
import {t} from '@/i18n';

/**
 * Who is signed in (2026-11-16 refinements, 1.1). Read once per page load and kept here, so a step
 * change or a language switch (which re-mounts the tree) shows the user's name at once, never an
 * empty avatar. A failed read is not kept: Retry reads again.
 */
let cached: RuntimeInfo | null = null;
let pending: Promise<RuntimeInfo> | null = null;

function loadRuntime(): Promise<RuntimeInfo> {
  if (cached) return Promise.resolve(cached);
  pending ??= getRuntimeInfo().then(
    info => (cached = info),
    e => {
      pending = null;
      throw e;
    },
  );
  return pending;
}

export function useRuntime(): {info: RuntimeInfo | null; error: string | null; retry: () => void} {
  const [info, setInfo] = useState<RuntimeInfo | null>(cached);
  const [error, setError] = useState<string | null>(null);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    if (info) return;
    let live = true;
    loadRuntime().then(
      i => live && setInfo(i),
      e => live && setError((e as Error)?.message || 'The sign-in service did not answer.'),
    );
    return () => {
      live = false;
    };
  }, [info, tries]);
  return {info, error, retry: () => (setError(null), setTries(n => n + 1))};
}

/**
 * Renders its children only once the signed-in user is known: the loading state until then, and
 * an error with Retry when nobody is signed in or the check failed. No page renders anonymously.
 */
export function SignedIn({children}: {children: ReactNode}) {
  const {info, error, retry} = useRuntime();
  if (info) return <>{children}</>;
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
