'use client';

import {useEffect, useState} from 'react';
import type {AgentProposal} from '@yushiguang/sprint-contracts';
import {editorDraft} from '@yushiguang/sprint-domain';
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
 * Loads the Prompt helper's open draft of this version into the editor, where the user reviews
 * it. The draft stays open while it is on the page: Save closes it as approved and Discard as
 * discarded (`closeDraft`), so the helper can recall a discarded draft (#39, T8). A draft written
 * from another version is left for that version's editor, and a read-only view takes none.
 */
export function useAgentDrafts(state: ProjectState, versionId: string, enabled: boolean, apply: (d: AgentProposal) => void) {
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let taken: string | null = null;
    const check = async () => {
      const list = await openProposals(state.project.id);
      const d = editorDraft(list, versionId);
      if (!alive || !d || d.id === taken) return;
      taken = d.id;
      apply(d);
    };
    void check();
    const off = subscribeChanges(() => void check());
    return () => {
      alive = false;
      off();
    };
  }, [state.project.id, versionId, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Closes the draft the editor took: approved when the user saved it, discarded on Discard. */
export async function closeDraft(projectId: string, proposalId: string | null, decision: 'approved' | 'discarded') {
  if (proposalId) await closeProposal({projectId, proposalId, decision});
}
