'use client';

import {useRouter, useSearchParams} from 'next/navigation';
import {Suspense, useEffect, useMemo, useState} from 'react';
import {diffLines, diffSummary} from '@/core/template';
import {nextVersion, versionLabel} from '@/core/versions';
import type {PromptVersion} from '@/core/types';
import {ProjectPage} from '@/components/Shell';
import {useProject} from '@/components/ProjectContext';
import {useChecks, Workbench, type Draft} from '@/components/prompt/Workbench';
import {useAgentDrafts} from '@/components/prompt/useAgentDrafts';
import type {PageContext} from '@/services/agents';
import {MADE_BY, createVersion} from '@/services/prompts';
import type {ProjectState} from '@/services/projects';
import {scoreVersion} from '@/services/work';
import {Button, Icon, Note, StatusBadge, timeOf} from '@/ui';

export default function EditPage() {
  return (
    <Suspense fallback={null}>
      <EditRouter />
    </Suspense>
  );
}

function EditRouter() {
  const vId = useSearchParams().get('v');
  const [page, setPage] = useState<PageContext>({label: 'Prompt', agent: 'prompt_agent', intent: 'revise_prompt', context: {}});
  return (
    <ProjectPage node="prompt" assistant="docked" wide page={page}>
      {({state}) => {
        const v = state.versions.find(x => x.id === vId) ?? state.versions[0];
        return v ? <Edit key={v.id} state={state} version={v} setPage={setPage} /> : <p>No prompt version yet.</p>;
      }}
    </ProjectPage>
  );
}

/** View any version and edit it. Save makes the next minor version, Save as the next major one; nothing is overwritten. */
function Edit({state, version, setPage}: {state: ProjectState; version: PromptVersion; setPage: (p: PageContext) => void}) {
  const router = useRouter();
  const {href} = useProject();
  const base: Draft = {template: version.template, features: version.features, images: version.images};
  const [draft, setDraft] = useState<Draft>(base);
  const [change, setChange] = useState('');
  const [madeBy, setMadeBy] = useState<'user' | 'prompt_agent'>('user');
  const [saved, setSaved] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const types = useMemo(() => [...new Set(state.examples.map(e => e.type))], [state.examples]);
  const check = useChecks(draft, state.setup?.schema, types);
  const diff = useMemo(() => diffLines(version.template, draft.template), [version.template, draft.template]);
  const sum = diffSummary(diff);
  const dirty = draft.template !== base.template || JSON.stringify(draft.features) !== JSON.stringify(base.features) || draft.images.length !== base.images.length;
  const isCurrent = state.versions[0].id === version.id;
  const t = state.setup?.thresholds;
  const nextMinor = versionLabel(nextVersion(state.versions, version, 'minor'));
  const nextMajor = versionLabel(nextVersion(state.versions, version, 'major'));

  useEffect(() => {
    setPage({
      label: `Prompt ${versionLabel(version)}`,
      agent: 'prompt_agent',
      intent: 'revise_prompt',
      hint: 'Ask me what any version changed, or tell me what to fix and I will draft the change here.',
      context: {schema: state.setup?.schema, template: draft.template, version: {label: versionLabel(version), madeBy: MADE_BY[version.madeBy], change: version.change}},
    });
  }, [version.id, draft.template]); // eslint-disable-line react-hooks/exhaustive-deps
  useAgentDrafts(state, d => {
    setDraft(cur => ({...cur, template: d.template}));
    setChange(d.change ?? '');
    setMadeBy('prompt_agent');
  });

  const save = async (kind: 'minor' | 'major') => {
    setErr(null);
    try {
      const summary = change || (sum.added || sum.removed ? `${sum.added} line${sum.added === 1 ? '' : 's'} added, ${sum.removed} removed` : 'Features changed');
      const v = await createVersion(state.project.id, state.versions, {...draft, parent: version, madeBy, change: summary, kind, schema: state.setup!.schema!, schemaVersion: state.setup!.schemaVersion});
      void scoreVersion(state.project.id, v);
      setSaved(`Saved as ${versionLabel(v)} · scoring on ${state.setup!.models.length > 1 ? 'both models' : `Model ${state.setup!.models[0].endpoint}`}`);
      setTimeout(() => router.push(href('/prompt')), 900);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <>
      <div>
        <Button label="All prompt versions" variant="ghost" size="sm" icon={<Icon name="back" />} href={href('/prompt')} />
      </div>
      <div className="page-head">
        <span className="eyebrow">Prompt Engineering · step 1 of 2</span>
        <h1>Prompt</h1>
        <p className="muted">Edit the version shown, then save it as a new version.</p>
      </div>
      <div className="row">
        <label className="sr-only" htmlFor="ver">
          Version
        </label>
        <select id="ver" className="text-input" value={version.id} onChange={e => router.push(href('/prompt/edit', {v: e.target.value}))}>
          {state.versions.map(v => (
            <option key={v.id} value={v.id}>
              {versionLabel(v)}
              {v.id === state.versions[0].id ? ' · current' : ''}
            </option>
          ))}
        </select>
        <span className="muted">
          made by {MADE_BY[version.madeBy]} · {timeOf(version.createdAt)}
        </span>
        {t &&
          state.setup!.models.map(m => {
            const r = state.reports.find(x => x.promptVersionId === version.id && x.endpoint === m.endpoint && !x.archivedNow);
            return r ? (
              <span key={m.endpoint} className="row" style={{gap: 6}}>
                · Model {m.endpoint} <b>{r.metrics.lowestField.macroF1.toFixed(2)}</b> <StatusBadge passed={r.passed} />
              </span>
            ) : null;
          })}
      </div>
      {version.change && <p className="small muted">What changed: {version.change}</p>}
      <Workbench draft={draft} onChange={setDraft} check={check} hint={dirty ? <span className="small" style={{fontWeight: 500}}>Unsaved changes · {sum.removed} line{sum.removed === 1 ? '' : 's'} removed, {sum.added} added</span> : undefined} />
      {dirty && sum.added + sum.removed > 0 && (
        <div className="col">
          <h3>Changes from {versionLabel(version)}</h3>
          <div className="diff">
            {diff
              .filter((l, i, a) => l.kind !== 'same' || a.slice(Math.max(0, i - 2), i + 3).some(x => x.kind !== 'same'))
              .map((l, i) => (
                <span key={i} className={l.kind === 'same' ? '' : l.kind} style={{display: 'block'}}>
                  {l.kind === 'add' ? '+ ' : l.kind === 'del' ? '− ' : '  '}
                  {l.text || ' '}
                </span>
              ))}
          </div>
          {madeBy === 'prompt_agent' && <p className="small muted">Drafted by the prompt agent{change ? `: ${change}` : ''}. Review it, then save.</p>}
        </div>
      )}
      <div className="next">
        <Button label="Save" variant="primary" size="lg" disabled={!dirty || check.errors.length > 0} onClick={() => save('minor')} />
        <Button label={`Save as ${nextMajor}`} size="lg" disabled={!dirty || check.errors.length > 0} onClick={() => save('major')} />
        {dirty && <Button label="Discard" variant="ghost" size="lg" onClick={() => (setDraft(base), setChange(''), setMadeBy('user'))} />}
        <span className="blocked">{saved ?? (check.errors.length ? `Fix ${check.errors.length} error${check.errors.length > 1 ? 's' : ''} in Checks to save.` : dirty ? `Save makes ${nextMinor}. Save as ${nextMajor} starts a new major version.` : isCurrent ? 'This is the current version.' : 'Edit this version to save a new one from it.')}</span>
      </div>
      {err && <Note tone="error">{err}</Note>}
    </>
  );
}
