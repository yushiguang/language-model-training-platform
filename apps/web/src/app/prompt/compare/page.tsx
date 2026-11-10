'use client';

import {useSearchParams} from 'next/navigation';
import {Suspense} from 'react';
import {diffLines, diffSummary} from '@/core/template';
import type {EndpointId} from '@/core/types';
import {versionLabel} from '@/core/versions';
import {mixUpKey, mixUpText, signed} from '@/components/mixups';
import {ProjectPage} from '@/components/Shell';
import {useProject} from '@/components/ProjectContext';
import type {ProjectState} from '@/backend-api';
import {Button, Icon, StatusBadge} from '@/ui';

export default function ComparePage() {
  return (
    <Suspense fallback={null}>
      <CompareRouter />
    </Suspense>
  );
}

function CompareRouter() {
  const q = useSearchParams();
  const a = {v: q.get('a') ?? '', m: (q.get('am') ?? 'A') as EndpointId};
  const b = {v: q.get('b') ?? '', m: (q.get('bm') ?? 'A') as EndpointId};
  return (
    <ProjectPage node="prompt" assistant="docked" wide page={{label: 'Compare two scores', agent: 'front_desk', intent: 'answer', hint: 'Ask what changed between the two.', context: {}}}>
      {({state}) => <Compare state={state} a={a} b={b} />}
    </ProjectPage>
  );
}

/** Two versions on one model, or one version on two models: fields, mix-ups, values and prompt changes. */
function Compare({state, a, b}: {state: ProjectState; a: {v: string; m: EndpointId}; b: {v: string; m: EndpointId}}) {
  const {href} = useProject();
  const va = state.versions.find(v => v.id === a.v);
  const vb = state.versions.find(v => v.id === b.v);
  const ra = state.reports.find(r => r.promptVersionId === a.v && r.endpoint === a.m);
  const rb = state.reports.find(r => r.promptVersionId === b.v && r.endpoint === b.m);
  if (!va || !vb || !ra || !rb) return <p>Pick two scored versions on the versions page.</p>;
  // Older first, so "change" reads left to right.
  const [x, y, rx, ry] = va.createdAt <= vb.createdAt ? [va, vb, ra, rb] : [vb, va, rb, ra];
  const nx = a.m === b.m ? versionLabel(x) : `${versionLabel(x)} · Model ${rx.endpoint}`;
  const ny = a.m === b.m ? versionLabel(y) : `${versionLabel(y)} · Model ${ry.endpoint}`;
  const comparable = rx.contextId === ry.contextId;
  const d = diffLines(x.template, y.template);
  const sum = diffSummary(d);
  const mixKeys = [...new Set([...rx.metrics.mixUps, ...ry.metrics.mixUps].map(mixUpKey))];
  const mix = mixKeys
    .map(k => ({k, mx: rx.metrics.mixUps.find(m => mixUpKey(m) === k), my: ry.metrics.mixUps.find(m => mixUpKey(m) === k)}))
    .sort((p, q) => (q.mx?.count ?? 0) + (q.my?.count ?? 0) - (p.mx?.count ?? 0) - (p.my?.count ?? 0))
    .slice(0, 6);
  const values = rx.metrics.fields
    .flatMap(f => f.values.map(v => ({field: f.field, value: v.value, a: v.f1, b: ry.metrics.fields.find(g => g.field === f.field)?.values.find(w => w.value === v.value)?.f1 ?? 0})))
    .sort((p, q) => Math.abs(q.b - q.a) - Math.abs(p.b - p.a))
    .slice(0, 5);

  return (
    <>
      <div>
        <Button label="All prompt versions" variant="ghost" size="sm" icon={<Icon name="back" />} href={href('/prompt')} />
      </div>
      <div className="page-head">
        <span className="eyebrow">Prompt Engineering · compare</span>
        <h1>
          {a.m === b.m ? `${versionLabel(x)} and ${versionLabel(y)} on Model ${a.m}` : `${nx} and ${ny}`}
        </h1>
      </div>
      <div className="stats">
        {[
          [nx, rx],
          [ny, ry],
        ].map(([n, r]) => (
          <div key={n as string} className="stat">
            <span className="small muted">{n as string}</span>
            <span className="row" style={{gap: 6}}>
              <b>{(r as typeof rx).metrics.lowestField.macroF1.toFixed(2)}</b>
              <StatusBadge passed={(r as typeof rx).passed} />
            </span>
          </div>
        ))}
        <div className="stat">
          <span className="small muted">Change</span>
          <b>{signed(ry.metrics.lowestField.macroF1 - rx.metrics.lowestField.macroF1)}</b>
        </div>
      </div>
      <p className="small muted">{comparable ? 'Same eval set and labels, so the scores are comparable.' : 'These were scored on different eval labels or schemas, so compare them with care.'}</p>

      <div className="card tight">
        <div className="card-head">
          <h2>Fields</h2>
        </div>
        <table className="t">
          <thead>
            <tr>
              <th>Field</th>
              <th className="n">{nx}</th>
              <th className="n">{ny}</th>
              <th className="n">Change</th>
            </tr>
          </thead>
          <tbody>
            {rx.metrics.fields.map(f => {
              const g = ry.metrics.fields.find(z => z.field === f.field)!;
              return (
                <tr key={f.field}>
                  <td className="mono">{f.field}</td>
                  <td className="n">{f.macroF1.toFixed(2)}</td>
                  <td className="n">{g.macroF1.toFixed(2)}</td>
                  <td className="n">
                    <b>{signed(g.macroF1 - f.macroF1)}</b>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="card tight">
        <div className="card-head">
          <h2>Mix-ups</h2>
        </div>
        <table className="t">
          <thead>
            <tr>
              <th>Mix-up</th>
              <th>Field</th>
              <th className="n">{nx}</th>
              <th className="n">{ny}</th>
            </tr>
          </thead>
          <tbody>
            {mix.map(({k, mx, my}) => (
              <tr key={k}>
                <td>{mixUpText((mx ?? my)!)}</td>
                <td className="mono">{(mx ?? my)!.field}</td>
                <td className="n">{mx?.count ?? 0}</td>
                <td className="n">{my?.count ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card tight">
        <div className="card-head">
          <h2>Values that changed most</h2>
        </div>
        <table className="t">
          <thead>
            <tr>
              <th>Value</th>
              <th>Field</th>
              <th className="n">{nx}</th>
              <th className="n">{ny}</th>
              <th className="n">Change</th>
            </tr>
          </thead>
          <tbody>
            {values.map(v => (
              <tr key={`${v.field}|${v.value}`}>
                <td>{v.value}</td>
                <td className="mono">{v.field}</td>
                <td className="n">{v.a.toFixed(2)}</td>
                <td className="n">{v.b.toFixed(2)}</td>
                <td className="n">
                  <b>{signed(v.b - v.a)}</b>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="col">
        <div className="row">
          <h2>Prompt changes</h2>
          <span className="small muted">
            {versionLabel(x)} → {versionLabel(y)} · {sum.removed} line{sum.removed === 1 ? '' : 's'} removed, {sum.added} added
          </span>
        </div>
        <div className="diff">
          {sum.added + sum.removed === 0 ? (
            <span className="muted">Same prompt.</span>
          ) : (
            d
              .filter((l, i, arr) => l.kind !== 'same' || arr.slice(Math.max(0, i - 1), i + 2).some(z => z.kind !== 'same'))
              .map((l, i) => (
                <span key={i} className={l.kind === 'same' ? '' : l.kind} style={{display: 'block'}}>
                  {l.text || ' '}
                </span>
              ))
          )}
        </div>
      </div>
    </>
  );
}
