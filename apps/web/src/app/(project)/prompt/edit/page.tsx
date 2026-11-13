'use client';

import {useGo} from '@/components/nav';
import {useSearchParams} from 'next/navigation';
import {Suspense, useEffect, useMemo, useState} from 'react';
import type {PageContext, PromptVersion, StructuredPrompt} from '@tsp/contracts';
import {ALL_KEYS, canScore, checkStructured, MADE_BY, nextVersion, sameSignature, signatureOf, structuredChangeSummary, structuredEquals, versionLabel} from '@tsp/domain';
import {Frame, ProjectPage} from '@/components/Shell';
import {useProject} from '@/components/ProjectContext';
import {FullPromptButton, StructuredEditor} from '@/components/prompt/StructuredEditor';
import {useAgentDrafts} from '@/components/prompt/useAgentDrafts';
import {createVersion, featureInfo, scoreVersion, track, type ProjectState} from '@/backend-api';
import {Badge, Banner, Button, Empty, num, PageHead} from '@/ui';

export default function EditPage() {
  return (
    <Suspense fallback={null}>
      <EditRouter />
    </Suspense>
  );
}

function EditRouter() {
  const q = useSearchParams();
  const vId = q.get('v');
  const view = q.get('view') === '1';
  const [page, setPage] = useState<PageContext>({label: 'Prompt', agent: 'prompt_agent', intent: 'revise_prompt', context: {}});
  return (
    <ProjectPage node="prompt" page={page}>
      {({state}) => {
        const v = state.versions.find(x => x.id === vId) ?? state.versions[0];
        return v ? (
          <Edit key={`${v.id}${view}`} state={state} version={v} readOnly={view} setPage={setPage} />
        ) : (
          <Frame head={<PageHead title="Prompt" />}>
            <Empty title="No prompt version yet" text="Write the first prompt on Prompt Design." />
          </Frame>
        );
      }}
    </ProjectPage>
  );
}

/** View or edit a version. Saving makes the next number (Save: minor, Save as vN: major) and never overwrites one. */
function Edit({state, version, readOnly, setPage}: {state: ProjectState; version: PromptVersion; readOnly: boolean; setPage: (p: PageContext) => void}) {
  const go = useGo();
  const {href} = useProject();
  const base = version.structured;
  const [draft, setDraft] = useState<StructuredPrompt>(base);
  const [change, setChange] = useState('');
  const [madeBy, setMadeBy] = useState<'user' | 'prompt_agent'>('user');
  const [helperChanges, setHelperChanges] = useState<{text: string; reason: string}[]>([]);
  const issues = useMemo(() => checkStructured(draft), [draft]);
  const dirty = !structuredEquals(draft, base);
  // Save (main): the next minor of this version's major (v2 -> v2.1). Save as vN: the next major.
  const reserved = state.optimisation.map(o => o.major ?? 0);
  const nextMinor = versionLabel(nextVersion(state.versions, version, 'minor'));
  const nextMajor = versionLabel(nextVersion(state.versions, version, 'major', {reserved}));
  const fromHelper = madeBy === 'prompt_agent' && dirty;
  // Change marks. With edits: against the opened version, with the helper's reasons on its draft.
  // With none, on an Optimiser version: against its parent, with the round's change.
  const parent = version.parentId ? state.versions.find(x => x.id === version.parentId) : undefined;
  const round = useMemo(() => {
    for (const run of state.optimisation) for (const r of run.history) if (r.versionId === version.id) return r;
    return undefined;
  }, [state.optimisation, version.id]);
  const fromParent = !readOnly && !dirty && version.madeBy === 'optimiser' && parent ? parent : undefined;
  const against = readOnly ? undefined : dirty ? base : fromParent?.structured;
  const reasons = dirty ? (fromHelper ? helperChanges : []) : fromParent ? [{text: version.change, reason: version.change}] : [];
  // New field or value names change what gold labels mean (spec 3.1): say so before the save.
  const signatureChanged = dirty && !sameSignature(signatureOf(draft), signatureOf(base));
  const goldCount = Object.keys(state.gold).length;
  const [tips, setTips] = useState<Record<string, string>>({});
  useEffect(() => {
    void featureInfo(ALL_KEYS).then(info => setTips(Object.fromEntries(Object.entries(info).map(([k, i]) => [k, [i.description, i.goodFor, i.caveats].filter(Boolean).join(' ')]))));
  }, []);

  useEffect(() => {
    setPage({
      label: `Prompt ${versionLabel(version)}`,
      agent: 'prompt_agent',
      intent: 'revise_prompt',
      hint: 'Ask me what this version changed, or tell me what to fix and I will draft the change here.',
      context: {prompt: draft, unsaved: dirty, version: {label: versionLabel(version), madeBy: MADE_BY[version.madeBy], change: version.change}},
    });
  }, [version.id, JSON.stringify(draft), dirty]); // eslint-disable-line react-hooks/exhaustive-deps
  useAgentDrafts(state, d => {
    if (readOnly) return;
    setDraft(d.structured);
    setChange(d.change ?? '');
    setHelperChanges(d.changes ?? []);
    setMadeBy('prompt_agent');
  });

  // A failed save shows the page's red banner with Retry (the Button reports it).
  const save = async (kind: 'minor' | 'major') => {
    const v = await createVersion({projectId: state.project.id, structured: draft, parentId: version.id, madeBy, change: change || structuredChangeSummary(base, draft), kind});
    // Saving is the user's start: the new version is scored right away, once scores can be made
    // (enough gold labels, and Project Settings confirmed; spec 2.5). A change to the label fields
    // or values leaves no gold labels to score on until they are re-checked.
    if (state.facts.settingsConfirmed && canScore(state.facts) && !signatureChanged) void scoreVersion({projectId: state.project.id, promptVersionId: v.id}).catch(() => undefined);
    await go(href('/prompt'));
  };
  const discard = () => {
    setDraft(base);
    setChange('');
    setHelperChanges([]);
    setMadeBy('user');
  };

  const blocked = !dirty || issues.length > 0;
  const full = <FullPromptButton prompt={draft} onOpen={() => track('full_prompt_opened', {})} onCopy={() => track('prompt_copied', {from: 'dialog'})} />;
  const actions = readOnly ? (
    <>
      {full}
      <Button label="Edit prompt" kind="primary" href={href('/prompt/edit', {v: version.id})} />
    </>
  ) : (
    <>
      {dirty ? (
        <span className="done-at" style={{margin: 0}}>
          <Badge text={fromHelper ? 'Draft from Prompt helper' : 'Unsaved changes'} tone="warn" icon={false} />
        </span>
      ) : (
        fromParent && (
          <span className="done-at" style={{margin: 0}}>
            <Badge text={`Changes from ${versionLabel(fromParent)}`} tone="gray" icon={false} />
          </span>
        )
      )}
      {full}
      {dirty && <Button label="Discard" kind="ghost" onClick={discard} />}
      <Button label={`Save as ${nextMajor}`} disabled={blocked} title={issues[0]?.message ?? `New major version ${nextMajor}`} onClick={() => save('major')} />
      <Button label="Save" kind="primary" className={fromHelper && !blocked ? 'btn-cue' : undefined} disabled={blocked} title={issues[0]?.message ?? `Saves as ${nextMinor}`} onClick={() => save('minor')} />
    </>
  );
  return (
    <Frame head={<PageHead title={`Prompt ${versionLabel(version)}`} back={{label: 'Prompt Tuning', href: href('/prompt')}} actions={actions} />}>
      {signatureChanged && (
        <Banner
          text={goldCount ? `This changes the label fields or values. After you save, ${num(goldCount)} gold ${goldCount === 1 ? 'label needs' : 'labels need'} a re-check and earlier scores no longer count.` : 'This changes the label fields or values. Earlier scores no longer count after you save.'}
          style={{margin: '0 0 16px'}}
        />
      )}
      <StructuredEditor value={draft} onChange={setDraft} readOnly={readOnly} base={against} reasons={reasons} reasonPrefix={!dirty && fromParent ? (round ? `Optimiser, round ${round.round}: ` : 'Optimiser: ') : ''} featureTips={tips} />
    </Frame>
  );
}
