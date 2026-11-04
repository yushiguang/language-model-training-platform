'use client';

import {useEffect, useState} from 'react';
import type {EndpointId, PromptVersion} from '@tsp/contracts';
import {predictionsFor, type ProjectState} from '@/backend-api';

/** Test examples that already have a model answer for this version, model and settings (reused, free). */
export function useLabeledTest(state: ProjectState, version: PromptVersion | undefined, endpoint: EndpointId | undefined): Set<string> {
  const [ids, setIds] = useState<Set<string>>(new Set());
  const settings = state.setup?.models.find(m => m.endpoint === endpoint);
  const key = `${version?.id}:${endpoint}:${state.testRuns.map(r => r.done).join(',')}`;
  useEffect(() => {
    if (!version || !settings) return setIds(new Set());
    let live = true;
    void predictionsFor(version.id, settings.endpoint, settings).then(m => {
      if (live) setIds(new Set(state.examples.filter(e => e.split === 'test' && m.has(e.id)).map(e => e.id)));
    });
    return () => {
      live = false;
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return ids;
}
