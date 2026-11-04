'use client';

import {useRouter} from 'next/navigation';
import {useEffect, useMemo, useState} from 'react';
import type {Answer, Example, Prediction} from '@tsp/contracts';
import {versionLabel} from '@tsp/domain';
import {ExampleView} from '@/components/ExampleView';
import {NotYet} from '@/components/NotYet';
import {ProjectPage} from '@/components/Shell';
import {FieldCard} from '@/components/SchemaView';
import {useProject} from '@/components/ProjectContext';
import {
  getRuntimeInfo,
  importBundledGold,
  predictionsFor,
  saveGold,
  skipGold,
  uploadGoldFile,
  type ProjectState,
} from '@/backend-api';
import {Badge, Button, Icon, Note, num, Progress} from '@/ui';

export default function GoldPage() {
  return (
    <ProjectPage node="gold" page={{label: 'Gold Labels', agent: 'front_desk', intent: 'answer', hint: "If an example doesn't fit any value, tell me and I'll bring in the schema agent.", context: {}}}>
      {({state, href}) => (state.snapshot?.split ? <Gold state={state} /> : <NotYet text="Split the dataset first." to={href('/dataset')} />)}
    </ProjectPage>
  );
}

function Gold({state}: {state: ProjectState}) {
  const router = useRouter();
  const {href} = useProject();
  const [tab, setTab] = useState<'label' | 'upload'>('label');
  const evalEx = state.examples.filter(e => e.split === 'eval');
  const testEx = state.examples.filter(e => e.split === 'test');
  const queue = useMemo(() => [...evalEx, ...testEx], [state.examples]); // eslint-disable-line react-hooks/exhaustive-deps
  const firstOpen = Math.max(0, queue.findIndex(e => !state.gold.has(e.id)));
  const [index, setIndex] = useState<number | null>(null);
  const i = index ?? firstOpen;
  const ex = queue[i];
  const evalDone = state.facts.goldEvalDone;
  const skip = async () => {
    await skipGold(state.project.id);
    router.push(href('/prompt'));
  };

  return (
    <>
      {state.staleGold.size > 0 && (
        <div className="banner" role="status">
          <Icon name="alert" />
          <span className="grow">
            <b>The schema changed.</b> {num(state.staleGold.size)} labels were made under the old schema and need a quick re-check; your old answer stays as a hint.
          </span>
        </div>
      )}
      <div className="page-head">
        <h1>Gold Labels</h1>
        <p className="muted">Give the correct answer for each example. Prompt scores start once the eval set is done. The test set can be labeled any time.</p>
      </div>
      <div className="row" role="tablist">
        <Button label="Label here" variant={tab === 'label' ? 'primary' : 'ghost'} onClick={() => setTab('label')} />
        <Button label="Upload labels" variant={tab === 'upload' ? 'primary' : 'ghost'} onClick={() => setTab('upload')} />
      </div>
      <div className="stats" style={{gridTemplateColumns: '1fr 1fr'}}>
        <div className="card" style={{gap: 6}}>
          <span className="row" style={{gap: 6}}>
            <b>Eval set</b>
            <span className="small muted">needed before scoring</span>
            <span className="right">{evalDone === evalEx.length ? <Badge tone="success" label="Done" icon={<Icon name="check" size={12} />} /> : null}</span>
          </span>
          <span className="row">
            <Progress value={evalDone} max={evalEx.length} />
            <span className="small">
              {evalDone} / {evalEx.length}
            </span>
          </span>
        </div>
        <div className="card" style={{gap: 6}}>
          <span className="row" style={{gap: 6}}>
            <b>Test set</b>
            <span className="small muted">any time · for testing the model you train</span>
          </span>
          <span className="row">
            <Progress value={state.facts.goldTestDone} max={testEx.length} />
            <span className="small">
              {state.facts.goldTestDone} / {testEx.length}
            </span>
          </span>
        </div>
      </div>
      {tab === 'upload' ? (
        <Upload state={state} />
      ) : ex ? (
        <Labeler key={ex.id} state={state} ex={ex} position={i} queue={queue} onMove={setIndex} />
      ) : (
        <Note>Every example has a gold label.</Note>
      )}
      <div className="next">
        <Button label={evalDone === evalEx.length ? 'Next step: Prompt Engineering' : 'Skip for now: Prompt Engineering'} variant={evalDone === evalEx.length ? 'primary' : 'secondary'} size="lg" icon={<Icon name="arrow" />} onClick={skip} />
        <span className="blocked">{evalDone === evalEx.length ? 'Scores can start now.' : 'Scores start when the eval set is labeled. You can come back any time.'}</span>
      </div>
    </>
  );
}

function Labeler({state, ex, position, queue, onMove}: {state: ProjectState; ex: Example; position: number; queue: Example[]; onMove: (i: number) => void}) {
  const schema = state.setup!.schema!;
  const saved = state.gold.get(ex.id);
  const hint = state.staleGold.get(ex.id);
  const [answer, setAnswer] = useState<Answer>(saved?.answer ?? {});
  const [revealed, setRevealed] = useState(false);
  const [model, setModel] = useState<{pred: Prediction; label: string; endpoint: string} | null | undefined>(undefined);
  const inEval = ex.split === 'eval';
  const nInSet = queue.filter(e => e.split === ex.split).length;
  const posInSet = queue.filter(e => e.split === ex.split).findIndex(e => e.id === ex.id) + 1;

  useEffect(() => {
    if (!revealed) return;
    void (async () => {
      for (const v of state.versions)
        for (const m of state.setup!.models) {
          const p = (await predictionsFor(v.id, m.endpoint, m)).get(ex.id);
          if (p) return setModel({pred: p, label: versionLabel(v), endpoint: m.endpoint});
        }
      setModel(null);
    })();
  }, [revealed, ex.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (field: string, value: string) => {
    const f = schema.fields.find(x => x.name === field)!;
    const cur = answer[field] ?? [];
    if (f.kind === 'single') return setAnswer({...answer, [field]: [value]});
    const next = cur.includes(value) ? cur.filter(v => v !== value) : cur.length >= (f.max ?? 99) ? cur : [...cur, value];
    setAnswer({...answer, [field]: next});
  };
  const complete = schema.fields.every(f => (answer[f.name]?.length ?? 0) >= (f.kind === 'single' ? 1 : (f.min ?? 1)));
  const save = async () => {
    await saveGold(state.project.id, ex.id, state.setup!.schemaVersion, answer, revealed);
    const nextOpen = queue.findIndex((e, k) => k > position && !state.gold.has(e.id));
    onMove(nextOpen === -1 ? Math.min(position + 1, queue.length - 1) : nextOpen);
  };

  return (
    <>
      <div className="card">
        <div className="row">
          <h2>
            Example {posInSet}
          </h2>
          <span className="muted">
            of {nInSet} in the {inEval ? 'eval' : 'test'} set
          </span>
          <span className="right row" style={{gap: 6}}>
            <Button label="Previous" variant="ghost" size="sm" disabled={position === 0} onClick={() => onMove(position - 1)} />
            <Button label="Next" variant="ghost" size="sm" disabled={position >= queue.length - 1} onClick={() => onMove(position + 1)} />
          </span>
        </div>
        <ExampleView ex={ex} />
      </div>
      <div className="card">
        <div className="row">
          <h2>Model answer</h2>
          {revealed && model && (
            <span className="small muted">
              Model {model.endpoint} · prompt {model.label}
            </span>
          )}
          <span className="right">{revealed ? <Button label="Hide" variant="ghost" size="sm" onClick={() => setRevealed(false)} /> : <Button label="Show model answer" size="sm" onClick={() => setRevealed(true)} />}</span>
        </div>
        {!revealed ? (
          <p className="small muted">Hidden so it doesn&apos;t sway your answer. Your reveal is recorded.</p>
        ) : model === undefined ? (
          <p className="small muted">Loading…</p>
        ) : model === null ? (
          <p className="small muted">No model answer yet. It appears after a prompt version is labeled on the eval set.</p>
        ) : model.pred.answer ? (
          <div className="col">
            <div className="row" style={{gap: 6}}>
              {Object.values(model.pred.answer)
                .flat()
                .map(v => (
                  <Badge key={v} label={v} />
                ))}
            </div>
            <p className="small muted">{tryField(model.pred.output, 'reasoning')}</p>
          </div>
        ) : (
          <p className="small muted">The model&apos;s answer was invalid: {model.pred.invalidReason}</p>
        )}
      </div>
      <div className="card">
        <div className="row">
          <h2>Your answer</h2>
          {saved && <Badge tone="success" label="Saved" icon={<Icon name="check" size={12} />} />}
          {hint && !saved && <span className="small muted">Old answer (before the schema changed): {Object.values(hint.answer).flat().join(', ')}</span>}
        </div>
        {schema.fields.map(f => (
          <FieldCard key={f.name} field={f} picked={answer[f.name] ?? []} onPick={v => pick(f.name, v)} />
        ))}
        <p className="small muted">Doesn&apos;t fit any value? Ask the schema agent in the assistant.</p>
        <div className="row">
          <Button label={saved ? 'Save changes and next' : 'Save and next'} variant="primary" size="lg" disabled={!complete} onClick={save} />
          {!complete && <span className="blocked">Answer every field to save.</span>}
        </div>
      </div>
    </>
  );
}

function tryField(json: string, key: string): string {
  try {
    return String(JSON.parse(json)[key] ?? '');
  } catch {
    return '';
  }
}

function Upload({state}: {state: ProjectState}) {
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hasBundled, setHasBundled] = useState(false);
  useEffect(() => {
    getRuntimeInfo().then(info => setHasBundled(info.hasBundledGold));
  }, []);
  const showResult = (r: {saved: number; skipped: number}) => {
    setMsg(`Saved ${r.saved} labels.${r.skipped ? ` ${r.skipped} rows didn't match an eval or test example or the schema, and were skipped.` : ''}`);
  };
  const fromFile = async (f: File) => {
    setBusy(true);
    try {
      showResult(await uploadGoldFile(state.project.id, state.setup!.schema!, state.setup!.schemaVersion, state.examples, f));
    } finally {
      setBusy(false);
    }
  };
  const fromBundled = async () => {
    setBusy(true);
    try {
      showResult(await importBundledGold(state.project.id, state.setup!.schema!, state.setup!.schemaVersion, state.examples));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card">
      <h2>Upload labels</h2>
      <p className="muted">
        A JSONL file, one line per example: <code>{'{"externalId": "…", "answer": {"field": ["value"]}}'}</code>. Values must match the schema. Train examples are skipped.
      </p>
      <div className="row">
        <label className="row" style={{border: '1.5px dashed var(--line-2)', borderRadius: 12, padding: '12px 20px', cursor: 'pointer'}}>
          <Icon name="upload" />
          <span>Choose a file</span>
          <input type="file" className="sr-only" accept=".jsonl,.json" disabled={busy} onChange={e => e.target.files?.[0] && void fromFile(e.target.files[0])} />
        </label>
        {hasBundled && <Button label="Use the answers that came with the examples" disabled={busy} onClick={fromBundled} />}
      </div>
      {msg && <Note>{msg}</Note>}
    </div>
  );
}
