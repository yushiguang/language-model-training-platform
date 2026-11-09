'use client';

import {useRouter, useSearchParams} from 'next/navigation';
import {Suspense, useEffect, useMemo, useState} from 'react';
import type {PageContext, PromptVersion} from '@tsp/contracts';
import {ALL_KEYS, diffLines, diffSummary, MADE_BY, nextVersion, versionLabel} from '@tsp/domain';
import {Frame, ProjectPage} from '@/components/Shell';
import {useProject} from '@/components/ProjectContext';
import {useChecks, Workbench, type Draft} from '@/components/prompt/Workbench';
import {useAgentDrafts} from '@/components/prompt/useAgentDrafts';
import {createVersion, featureInfo, scoreVersion, type ProjectState} from '@/backend-api';
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
  const types = useMemo(() => [...new Set(state.examples.map(e => e.type))], [state.examples]);
  const check = useChecks(draft, state.setup?.schema, types);
  const diff = useMemo(() => diffLines(version.template, draft.template), [version.template, draft.template]);
  const sum = diffSummary(diff);
  const dirty = draft.template !== base.template || JSON.stringify(draft.features) !== JSON.stringify(base.features);
  // Save: the next minor of this version's major (v2 -> v2.1). Save as new version: the next major.
  const reserved = state.optimisation.map(o => o.major ?? 0);
  const nextMinor = versionLabel(nextVersion(state.versions, version, 'minor'));
  const fromHelper = madeBy === 'prompt_agent' && dirty;
  // A helper's draft: the lines it added are marked green.
  const added = useMemo(() => {
    if (!fromHelper) return undefined;
    const out = new Set<number>();
    let line = 0;
    for (const d of diff) {
      if (d.kind === 'add') out.add(line);
      if (d.kind !== 'del') line++;
    }
    return out;
  }, [diff, fromHelper]);
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
      context: {schema: state.setup?.schema, template: draft.template, version: {label: versionLabel(version), madeBy: MADE_BY[version.madeBy], change: version.change}},
    });
  }, [version.id, draft.template]); // eslint-disable-line react-hooks/exhaustive-deps
  useAgentDrafts(state, d => {
    if (readOnly) return;
    setDraft(cur => ({...cur, template: d.template, features: d.features ?? cur.features}));
    setChange(d.change ?? '');
    setMadeBy('prompt_agent');
  });

  // A failed save shows the page's red banner with Retry (the Button reports it).
  const save = async (kind: 'minor' | 'major') => {
    const summary = change || (sum.added || sum.removed ? `${sum.added} line${sum.added === 1 ? '' : 's'} added, ${sum.removed} removed` : 'Features changed');
    const v = await createVersion(state.project.id, {...draft, parent: version, madeBy, change: summary, kind, schema: state.setup!.schema!, schemaVersion: state.setup!.schemaVersion});
    // Saving is the user's start: the new version is scored right away.
    void scoreVersion(state.project.id, v);
    router.push(href('/prompt'));
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
          <Badge text={fromHelper ? 'Draft from Prompt helper' : 'Unsaved changes'} tone="warn" icon={false} />
        </span>
      )}
      {dirty && <Button label="Discard" kind="ghost" onClick={discard} />}
      <Button label="Save as new version" disabled={!dirty || check.errors.length > 0} title={check.errors.length ? 'Fix the errors in Checks first' : `Saves as v${Math.max(0, ...state.versions.map(x => x.major), ...reserved) + 1}`} onClick={() => save('major')} />
      <Button label={`Save as ${nextMinor}`} kind="primary" disabled={!dirty || check.errors.length > 0} title={check.errors.length ? 'Fix the errors in Checks first' : undefined} onClick={() => save('minor')} />
    </>
  );
  return (
    <Frame head={<PageHead title={`Prompt ${versionLabel(version)}`} back={{label: 'Prompt versions', href: href('/prompt')}} actions={actions} />}>
      <Workbench draft={draft} onChange={setDraft} check={check} readOnly={readOnly} added={added} featureTips={tips} />
    </Frame>
  );
}
