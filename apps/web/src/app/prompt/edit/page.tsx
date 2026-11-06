'use client';

import {useRouter, useSearchParams} from 'next/navigation';
import {Suspense, useEffect, useMemo, useState} from 'react';
import type {PageContext, PromptVersion} from '@tsp/contracts';
import {diffLines, diffSummary, MADE_BY, nextVersion, versionLabel} from '@tsp/domain';
import {Frame, ProjectPage} from '@/components/Shell';
import {useProject} from '@/components/ProjectContext';
import {useChecks, Workbench, type Draft} from '@/components/prompt/Workbench';
import {useAgentDrafts} from '@/components/prompt/useAgentDrafts';
import {createVersion, scoreVersion, type ProjectState} from '@/backend-api';
import {Badge, Button, Empty, PageHead} from '@/ui';

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
            <Empty title="No prompt version yet" text="Write the first prompt on Prompt Engineering." />
          </Frame>
        );
      }}
    </ProjectPage>
  );
}

/** View or edit a version. Saving makes the next number and never overwrites one. */
function Edit({state, version, readOnly, setPage}: {state: ProjectState; version: PromptVersion; readOnly: boolean; setPage: (p: PageContext) => void}) {
  const router = useRouter();
  const {href} = useProject();
  const base: Draft = {template: version.template, features: version.features, images: version.images};
  const [draft, setDraft] = useState<Draft>(base);
  const [change, setChange] = useState('');
  const [madeBy, setMadeBy] = useState<'user' | 'prompt_agent'>('user');
  const [err, setErr] = useState<string | null>(null);
  const types = useMemo(() => [...new Set(state.examples.map(e => e.type))], [state.examples]);
  const check = useChecks(draft, state.setup?.schema, types);
  const sum = diffSummary(diffLines(version.template, draft.template));
  const dirty = draft.template !== base.template || JSON.stringify(draft.features) !== JSON.stringify(base.features);
  const next = versionLabel(nextVersion(state.versions, version, 'major'));

  useEffect(() => {
    setPage({
      label: `Prompt ${versionLabel(version)}`,
      agent: 'prompt_agent',
      intent: 'revise_prompt',
      hint: 'Ask me what this version changed, or tell me what to fix and I will draft the change here.',
      context: {schema: state.setup?.schema, template: draft.template, version: {label: versionLabel(version), madeBy: MADE_BY[version.madeBy], change: version.change}},
    });
  }, [version.id, draft.template]); // eslint-disable-line react-hooks/exhaustive-deps
  useAgentDrafts(state, d => {
    if (readOnly) return;
    setDraft(cur => ({...cur, template: d.template, features: d.features ?? cur.features}));
    setChange(d.change ?? '');
    setMadeBy('prompt_agent');
  });

  const save = async () => {
    setErr(null);
    try {
      const summary = change || (sum.added || sum.removed ? `${sum.added} line${sum.added === 1 ? '' : 's'} added, ${sum.removed} removed` : 'Features changed');
      const v = await createVersion(state.project.id, {...draft, parent: version, madeBy, change: summary, kind: 'major', schema: state.setup!.schema!, schemaVersion: state.setup!.schemaVersion});
      // Saving is the user's start: the new version is scored right away.
      void scoreVersion(state.project.id, v);
      router.push(href('/prompt'));
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const discard = () => {
    setDraft(base);
    setChange('');
    setMadeBy('user');
  };

  const actions = readOnly ? (
    <Button label="Edit prompt" kind="primary" href={href('/prompt/edit', {v: version.id})} />
  ) : (
    <>
      {dirty && (
        <span className="done-at" style={{margin: 0}}>
          <Badge text="Unsaved changes" tone="warn" icon={false} />
        </span>
      )}
      {dirty && <Button label="Discard" kind="ghost" onClick={discard} />}
      <Button label={`Save as ${next}`} kind="primary" disabled={!dirty || check.errors.length > 0} title={err ?? (check.errors.length ? 'Fix the errors in Checks first' : undefined)} onClick={save} />
    </>
  );
  return (
    <Frame head={<PageHead title={`Prompt ${versionLabel(version)}`} back={{label: 'Prompt versions', href: href('/prompt')}} actions={actions} />}>
      <Workbench draft={draft} onChange={setDraft} check={check} readOnly={readOnly} />
    </Frame>
  );
}
