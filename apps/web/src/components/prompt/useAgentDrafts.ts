'use client';

import {useEffect} from 'react';
import type {FeatureSelection} from '@/core/types';
import {closeProposal, openProposals, subscribeChanges, type ProjectState} from '@/backend-api';

/** Loads the prompt agent's latest open draft into the editor, where the user reviews and saves it. */
export function useAgentDrafts(state: ProjectState, apply: (d: {template: string; features?: FeatureSelection; change?: string}) => void) {
  useEffect(() => {
    let alive = true;
    const check = async () => {
      const list = await openProposals(state.project.id, 'prompt');
      if (!alive || !list[0]) return;
      const payload = list[0].payload as {template?: string; features?: FeatureSelection; change?: string};
      await closeProposal(list[0], 'approved');
      if (payload.template) apply({template: payload.template, features: payload.features, change: payload.change});
    };
    void check();
    const off = subscribeChanges(() => void check());
    return () => {
      alive = false;
      off();
    };
  }, [state.project.id]); // eslint-disable-line react-hooks/exhaustive-deps
}
