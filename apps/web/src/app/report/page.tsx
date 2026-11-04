'use client';

import {useRouter, useSearchParams} from 'next/navigation';
import {Suspense, useState} from 'react';
import {judge, pct} from '@tsp/domain';
import type {EndpointId} from '@tsp/contracts';
import {mixUpHelp, mixUpText, signed} from '@/components/mixups';
import {compareVersions, versionLabel} from '@tsp/domain';
import {ProjectPage} from '@/components/Shell';
import {useProject} from '@/components/ProjectContext';
import {MODEL_COLOR, ScoreChart} from '@/components/ScoreChart';
import {MADE_BY} from '@tsp/domain';
import {approveNode, type ProjectState} from '@/backend-api';
import {Badge, Button, Icon, money, StatusBadge, timeOf} from '@/ui';

export default function ReportPage() {
  return (
    <Suspense fallback={null}>
      <ReportRouter />
    </Suspense>
  );
}

function ReportRouter() {
  const q = useSearchParams();
  const vId = q.get('v') ?? '';
  const ep = (q.get('m') ?? 'A') as EndpointId;
  return (
    <ProjectPage node="prompt" page={{label: 'Eval report', agent: 'evaluation_agent', intent: 'explain_report', hint: 'Ask whether a score is good enough, or what the mix-ups mean.', context: {}}} wide>
      {({state}) => <Report state={state} vId={vId} ep={ep} />}
    </ProjectPage>
  );
}


function Report({state, vId, ep}: {state: ProjectState; vId: string; ep: EndpointId}) {
  const router = useRouter();
  const {href} = useProject();
  const version = state.versions.find(v => v.id === vId);
  const report = state.reports.find(r => r.promptVersionId === vId && r.endpoint === ep);
  const [tab, setTab] = useState(0);
  if (!version || !report) return <p>No report for this version yet. Reports appear when labeling on the eval set is done and the eval set has gold labels.</p>;
  const t = state.setup!.thresholds!;
  const evalCount = state.examples.filter(e => e.split === 'eval').length;
  const {checks} = judge(report.metrics, t, evalCount);
  const m = report.metrics;
  const sameCtx = state.reports.filter(r => r.endpoint === ep && r.contextId === report.contextId);
  const ordered = state.versions.filter(v => sameCtx.some(r => r.promptVersionId === v.id)).sort(compareVersions);
  const prevV = ordered[ordered.findIndex(v => v.id === vId) - 1];
  const prev = prevV && sameCtx.find(r => r.promptVersionId === prevV.id);
  const best = [...sameCtx].sort((a, b) => b.metrics.lowestField.macroF1 - a.metrics.lowestField.macroF1)[0];
  const bestV = state.versions.find(v => v.id === best.promptVersionId)!;
  const other = state.setup!.models.find(x => x.endpoint !== ep);
  const otherReport = other && state.reports.find(r => r.promptVersionId === vId && r.endpoint === other.endpoint && !r.archivedNow);
  const field = m.fields[tab];

  return (
    <>
      <div>
        <Button label="All prompt versions" variant="ghost" size="sm" icon={<Icon name="back" />} href={href('/prompt')} />
      </div>
      <div className="page-head">
        <span className="eyebrow">Prompt Engineering · report</span>
        <div className="row">
          <h1>
            {versionLabel(version)} on Model {ep}
          </h1>
          {report.archivedNow ? <Badge label="Archived" /> : <StatusBadge passed={report.passed} />}
        </div>
        <p className="muted">
          Scored on {m.n} eval examples the optimiser never saw · schema v{report.schemaVersion} · made by {MADE_BY[version.madeBy].toLowerCase() === 'you' ? 'you' : `the ${MADE_BY[version.madeBy].toLowerCase()}`} {timeOf(version.createdAt)}
        </p>
        {report.archivedNow && <p className="small muted">The schema or the eval labels changed after this report, so it can&apos;t be compared with new ones.</p>}
      </div>
      <div className="stats">
        {checks.slice(0, 3).map(c => (
          <div key={c.label} className="stat">
            <span className="small muted">{c.label}</span>
            <b>{c.actual}</b>
            <span className="small muted">
              {c.label.startsWith('Lowest field') ? `${m.lowestField.field} · ` : c.label.startsWith('Lowest value') && m.lowestValue ? `${m.lowestValue.value} · ` : c.label.startsWith('Invalid') ? `${m.invalid} of ${m.n} · ` : ''}
              needs {c.need.replace('≥ ', '').replace('≤ ', 'at most ')}
            </span>
          </div>
        ))}
        <div className="stat">
          <span className="small muted">Cost per 1,000 examples</span>
          <b>{money(m.costPer1000)}</b>
          {otherReport && (
            <span className="small muted">
              Model {other!.endpoint}: {money(otherReport.metrics.costPer1000)}
            </span>
          )}
        </div>
      </div>

      <div className="card tight">
        <div className="card-head">
          <h2>Fields</h2>
        </div>
        <table className="t">
          <thead>
            <tr>
              <th>Field</th>
              <th className="n">Macro-F1</th>
              <th className="n">Accuracy</th>
              <th className="n">{prevV ? `vs ${versionLabel(prevV)}` : 'vs previous'}</th>
              <th className="n">vs best ({versionLabel(bestV)})</th>
              <th>Threshold</th>
            </tr>
          </thead>
          <tbody>
            {m.fields.map(f => {
              const p = prev?.metrics.fields.find(x => x.field === f.field);
              const b = best.metrics.fields.find(x => x.field === f.field);
              const met = f.macroF1 >= t.macroF1;
              return (
                <tr key={f.field}>
                  <td className="mono">{f.field}</td>
                  <td className="n">
                    <b>{f.macroF1.toFixed(2)}</b>
                  </td>
                  <td className="n">{f.kind === 'multi' ? `exact set ${f.accuracy.toFixed(2)}` : f.accuracy.toFixed(2)}</td>
                  <td className="n">{p ? signed(f.macroF1 - p.macroF1) : '–'}</td>
                  <td className="n">{best.id === report.id ? 'best' : b ? signed(f.macroF1 - b.macroF1) : '–'}</td>
                  <td>
                    <StatusBadge passed={met} labels={['Met', 'Below']} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="card tight">
        <div className="card-head">
          <h2>Values</h2>
          <span className="row" role="tablist" style={{gap: 4}}>
            {m.fields.map((f, i) => (
              <Button key={f.field} label={f.field} size="sm" variant={i === tab ? 'primary' : 'ghost'} onClick={() => setTab(i)} />
            ))}
          </span>
        </div>
        <table className="t">
          <thead>
            <tr>
              <th>Value</th>
              <th className="n">Precision</th>
              <th className="n">Recall</th>
              <th className="n">F1</th>
              <th className="n">Examples</th>
            </tr>
          </thead>
          <tbody>
            {field.values.map(v => (
              <tr key={v.value}>
                <td>
                  {v.value} {t.valueF1 != null && v.support > 0 && v.f1 < t.valueF1 && <Badge label="Below" icon={<Icon name="down" size={12} />} />}
                </td>
                <td className="n">{v.precision.toFixed(2)}</td>
                <td className="n">{v.recall.toFixed(2)}</td>
                <td className="n">
                  <b>{v.f1.toFixed(2)}</b>
                </td>
                <td className="n">{v.support}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="small muted" style={{padding: '8px 12px'}}>
          Low precision means the model uses a value too often. Low recall means it misses it.
        </p>
      </div>

      <div className="card">
        <h2>Most common mix-ups</h2>
        {m.mixUps.length === 0 && <p className="muted">No mix-ups on the scored examples.</p>}
        {m.mixUps.slice(0, 6).map((mu, i) => (
          <div key={i} className="row" style={{borderTop: i ? '1px solid var(--line)' : undefined, paddingTop: i ? 10 : 0}}>
            <span className="col grow" style={{gap: 0}}>
              <b>{mixUpText(mu)}</b>
              <span className="small muted">
                {mu.field} · {mixUpHelp(mu)}
              </span>
            </span>
            <span className="muted">
              {mu.count} sample{mu.count > 1 ? 's' : ''}
            </span>
          </div>
        ))}
      </div>

      {ordered.length > 1 && (
        <div className="card">
          <div className="col" style={{gap: 0}}>
            <h2>Trend across versions</h2>
            <span className="small muted">Lowest field macro-F1 · schema v{report.schemaVersion} only (archived versions left out)</span>
          </div>
          <ScoreChart labels={ordered.map(versionLabel)} series={[{name: `Model ${ep}`, color: MODEL_COLOR[ep], values: ordered.map(v => sameCtx.find(r => r.promptVersionId === v.id)?.metrics.lowestField.macroF1 ?? null)}]} threshold={t.macroF1} />
        </div>
      )}

      {report.passed && (
        <div className="next">
          <Button
            label="Next step: Training Set"
            variant="primary"
            size="lg"
            icon={<Icon name="arrow" />}
            onClick={async () => {
              await approveNode(state.project.id, 'prompt');
              router.push(href('/training-set', {v: vId, m: ep}));
            }}
          />
          <span className="blocked">
            {versionLabel(version)} passes on Model {ep}
          </span>
        </div>
      )}
    </>
  );
}

