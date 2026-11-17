'use client';

import {useEffect, useState} from 'react';
import type {AgentProposal} from '@tsp/contracts';
import {closeProposal, openProposals, subscribeChanges, type ProjectState} from '@/backend-api';

/** The Prompt helper's open draft for this project, if any (the newest); it updates as drafts come and go. */
export function useOpenDraft(state: ProjectState): AgentProposal | null {
  const [open, setOpen] = useState<AgentProposal | null>(null);
  useEffect(() => {
    let alive = true;
    const check = () => void openProposals(state.project.id).then(list => alive && setOpen(list[0] ?? null));
    check();
    const off = subscribeChanges(check);
    return () => {
      alive = false;
      off();
    };
  }, [state.project.id]);
  return open;
}

/**
 * Loads the Prompt helper's latest open draft into the editor, where the user reviews and saves
 * it. Taking it into the page is what closes it: there is no Approve card in the chat.
 */
export function useAgentDrafts(state: ProjectState, apply: (d: AgentProposal['payload']) => void) {
  useEffect(() => {
    let alive = true;
    const check = async () => {
      const list = await openProposals(state.project.id);
      if (!alive || !list[0]) return;
      await closeProposal({projectId: state.project.id, proposalId: list[0].id, decision: 'approved'});
      apply(list[0].payload);
    };
    void check();
    const off = subscribeChanges(() => void check());
    return () => {
      alive = false;
      off();
    };
  }, [state.project.id]); // eslint-disable-line react-hooks/exhaustive-deps
}
