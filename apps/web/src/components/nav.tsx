'use client';

import {usePathname, useRouter, useSearchParams} from 'next/navigation';
import {useEffect} from 'react';

/**
 * Navigation that a button can wait on (R3-5): `go(href)` resolves once the new page is on screen,
 * so the clicked button keeps its spinner (and its group stays locked) until then, instead of
 * stopping when the request returns and leaving the user looking at a page that does nothing.
 */
const waiting: (() => void)[] = [];
const here = () => (typeof location === 'undefined' ? '' : location.pathname + location.search);

export function useGo(): (href: string) => Promise<void> {
  const router = useRouter();
  return href =>
    new Promise<void>(resolve => {
      const target = new URL(href, location.href);
      if (target.pathname + target.search === here()) return resolve();
      waiting.push(resolve);
      // Never leave a button spinning forever if the route never changes.
      setTimeout(resolve, 15000);
      router.push(href);
    });
}

/** Mounted once: resolves every waiting `go` when the path or query changes. */
export function NavWatcher() {
  const path = usePathname();
  const q = useSearchParams();
  useEffect(() => {
    for (const r of waiting.splice(0)) r();
  }, [path, q]);
  return null;
}
