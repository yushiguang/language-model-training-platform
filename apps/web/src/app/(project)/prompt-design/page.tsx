'use client';

import {useEffect, useState} from 'react';
import type {AgentProposal, PageContext, StructuredPrompt} from '@tsp/contracts';
import {ALL_KEYS, checkStructured, emptyStructuredPrompt, structuredEquals, versionLabel} from '@tsp/domain';
import {useGo} from '@/components/nav';
import {Frame, ProjectPage} from '@/components/Shell';
import {useProject} from '@/components/ProjectContext';
import {FullPromptButton, StructuredEditor} from '@/components/prompt/StructuredEditor';
import {useOpenDraft} from '@/components/prompt/useAgentDrafts';
import {approveNode, closeProposal, createVersion, featureInfo, track, type ProjectState} from '@/backend-api';
import {Badge, Button, Card, PageHead} from '@/ui';

const FIRST = 'Tell me what you want to label, or paste the prompt you use today. You can paste document links.';

/**
 * Step 1, Prompt Design (spec 1.0.0, 2.1 and 3.2): the user's idea becomes the first prompt. The
 * Prompt helper drafts it from a description or from a prompt the user already has; the draft
 * shows here, the user edits it and approves it as v1 with the button at the top right. After
 * that the page shows the newest version, and changes are made in the prompt editor.
 */
export default function PromptDesignPage() {
  const [page, setPage] = useState<PageContext>({label: 'Prompt Design', agent: 'prompt_agent', intent: 'draft_prompt', hint: FIRST, context: {}});
  return (
    <ProjectPage node="prompt_design" page={page} chatOpen>
      {({state}) => (state.versions.length ? <Approved state={state} setPage={setPage} /> : <Design state={state} setPage={setPage} />)}
    </ProjectPage>
  );
}

function useFeatureTips() {
  const [tips, setTips] = useState<Record<string, string>>({});
  useEffect(() => {
    void featureInfo(ALL_KEYS).then(info => setTips(Object.fromEntries(Object.entries(info).map(([k, i]) => [k, [i.description, i.goodFor, i.caveats].filter(Boolean).join(' ')]))));
  }, []);
  return tips;
}

function Design({state, setPage}: {state: ProjectState; setPage: (p: PageContext) => void}) {
  const open = useOpenDraft(state);
  const tips = useFeatureTips();
  const [draft, setDraft] = useState<StructuredPrompt>(emptyStructuredPrompt);
  // A new draft from the helper replaces what is on the page; the user's edits to it stay.
  const [loaded, setLoaded] = useState<string | null>(null);
  if (open && open.id !== loaded) {
    setLoaded(open.id);
    setDraft(open.payload.structured);
  }
  const issues = checkStructured(draft);
  const started = !structuredEquals(draft, emptyStructuredPrompt());

  useEffect(() => {
    setPage({label: 'Prompt Design', agent: 'prompt_agent', intent: draft.fields.length ? 'revise_prompt' : 'draft_prompt', hint: FIRST, context: {prompt: draft}});
  }, [JSON.stringify(draft)]); // eslint-disable-line react-hooks/exhaustive-deps

  // Approve is the user's act on the page: it saves v1 and closes the helper's draft.
  const approve = async () => {
    await createVersion({projectId: state.project.id, structured: draft, parentId: null, madeBy: open ? 'prompt_agent' : 'user', change: 'First prompt', kind: 'major'});
    if (open) await closeProposal({projectId: state.project.id, proposalId: open.id, decision: 'approved'});
  };
  const discard = async () => {
    if (open) await closeProposal({projectId: state.project.id, proposalId: open.id, decision: 'discarded'});
    setDraft(emptyStructuredPrompt());
  };

  const head = (
    <PageHead
      title="Prompt Design"
      actions={
        <>
          {open && (
            <span className="done-at" style={{margin: 0}}>
              <Badge text="AI draft" icon={false} />
            </span>
          )}
          <FullPromptButton prompt={draft} onOpen={() => track('full_prompt_opened', {})} onCopy={() => track('prompt_copied', {from: 'dialog'})} />
          {started && <Button label="Discard" kind="ghost" onClick={discard} />}
          <Button label="Approve" kind="primary" className={open && !issues.length ? 'btn-cue' : undefined} disabled={issues.length > 0} title={issues[0]?.message ?? 'Saves this prompt as v1'} onClick={approve} />
        </>
      }
    />
  );
  return (
    <Frame head={head} chat={{first: FIRST, placeholder: 'Describe your task, or paste your prompt'}}>
      {open && open.payload.unmapped.length > 0 && <NotCarriedOver draft={open} />}
      <StructuredEditor value={draft} onChange={setDraft} featureTips={tips} draft={!!open} />
    </Frame>
  );
}

/** What an imported prompt holds that the structured prompt has no place for: shown word for word, never dropped. */
function NotCarriedOver({draft}: {draft: AgentProposal}) {
  const list = draft.payload.unmapped;
  return (
    <Card ai title="Not carried over" titleExtra={<Badge text={`${list.length} ${list.length === 1 ? 'passage' : 'passages'}`} tone="warn" icon={false} />} style={{marginBottom: 16}}>
      <span className="t-2">These parts of your prompt have no place in the structured prompt. Move what matters into a definition or a rule.</span>
      <div className="col" style={{gap: 8}}>
        {list.map((t, i) => (
          <pre key={i} className="unmapped">
            {t}
          </pre>
        ))}
      </div>
    </Card>
  );
}

function Approved({state, setPage}: {state: ProjectState; setPage: (p: PageContext) => void}) {
  const go = useGo();
  const {href} = useProject();
  const tips = useFeatureTips();
  const v = state.versions[0];
  useEffect(() => {
    setPage({label: 'Prompt Design', agent: 'prompt_agent', intent: 'revise_prompt', hint: 'Ask me about this prompt, or tell me what to change.', context: {prompt: v.structured}});
  }, [v.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const next = async () => {
    if (!state.project.approvedNodes.includes('prompt_design')) await approveNode(state.project.id, 'prompt_design');
    await go(href('/dataset'));
  };
  return (
    <Frame
      head={
        <PageHead
          title="Prompt Design"
          actions={
            <>
              <span className="done-at" style={{margin: 0}}>
                <Badge text={`Approved as ${versionLabel(v)}`} tone="ok" />
              </span>
              <FullPromptButton prompt={v.structured} onOpen={() => track('full_prompt_opened', {})} onCopy={() => track('prompt_copied', {from: 'dialog'})} />
              <Button label="Edit prompt" href={href('/prompt/edit', {v: v.id})} />
              <Button label="Next: Eval Dataset" kind="primary" className={state.project.approvedNodes.includes('prompt_design') ? undefined : 'btn-cue'} onClick={next} />
            </>
          }
        />
      }
    >
      <StructuredEditor value={v.structured} onChange={() => undefined} readOnly featureTips={tips} />
    </Frame>
  );
}
