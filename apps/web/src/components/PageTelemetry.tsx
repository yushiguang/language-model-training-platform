'use client';

import {usePathname} from 'next/navigation';
import {useEffect} from 'react';
import {pageViewed} from '@/backend-api';

/** Reports each route change: page views, the page in the telemetry context, time on page. */
export function PageTelemetry() {
  const pathname = usePathname();
  useEffect(() => {
    pageViewed(pathname, window.location.search);
  }, [pathname]);
  return null;
}
