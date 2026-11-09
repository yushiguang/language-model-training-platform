'use client';

import {useRouter} from 'next/navigation';
import {Fragment, useEffect, useMemo, useRef, useState} from 'react';
import type {Answer, Example, LabelField} from '@tsp/contracts';
import {versionLabel} from '@tsp/domain';
import {Frame, ProjectPage} from '@/components/Shell';
import {useProject} from '@/components/ProjectContext';
import {approveNode, predictionsFor, saveGold, type ProjectState} from '@/backend-api';
import {Badge, Banner, Button, Card, Code, dateTime, Empty, Icon, num, PageHead, Tabs} from '@/ui';

type SetKey = 'eval' | 'test';

export default function GoldPage() {
  return (
    <ProjectPage node="gold" page={{label: 'Gold Labels', agent: 'front_desk', intent: 'answer', hint: "If an example doesn't fit any value, tell me and I'll bring in the schema agent.", context: {}}}>
      {({state}) => <Gold state={state} />}
    </ProjectPage>
  );
}

function Gold({state}: {state: ProjectState}) {
  const router = useRouter();
  const {href} = useProject();
  const sets = useMemo(() => ({eval: state.examples.filter(e => e.split === 'eval'), test: state.examples.filter(e => e.split === 'test')}), [state.examples]);
  const [tab, setTab] = useState<SetKey>('eval');
  const list = sets[tab];
  const firstOpen = (k: SetKey) => Math.max(0, sets[k].findIndex(e => !state.gold.has(e.id)));
  // Opens on the first example without a gold label; it stays put while labels save.
  const [pos, setPos] = useState<Record<SetKey, number>>(() => ({eval: firstOpen('eval'), test: firstOpen('test')}));
  const i = Math.min(pos[tab], Math.max(0, list.length - 1));
  const ex = list[i];
  const [showModel, setShowModel] = useState(true);
  const evalDone = state.facts.goldEvalDone >= sets.eval.length && sets.eval.length > 0;
  const move = (n: number) => setPos(p => ({...p, [tab]: n}));

  const head = (
    <PageHead
      title="Gold Labels"
      actions={
        <>
          {list.length > 0 && (
            <>
              <Button label="" ariaLabel="Previous" kind="ghost" icon="left" disabled={i === 0} onClick={() => move(i - 1)} />
              <span className="t-2" style={{fontSize: 13, minWidth: 56, textAlign: 'center'}}>
                {num(i + 1)} of {num(list.length)}
              </span>
              <Button label="" ariaLabel="Next" kind="ghost" icon="right" disabled={i >= list.length - 1} onClick={() => move(i + 1)} />
            </>
          )}
          <Button
            label="Next: Prompt Engineering"
            kind="primary"
            disabled={!evalDone}
            title={evalDone ? undefined : 'Label every eval example first. Gold labels on the test set are optional.'}
            onClick={async () => {
              await approveNode(state.project.id, 'gold');
              router.push(href('/prompt'));
            }}
          />
        </>
      }
    />
  );

  if (!state.snapshot?.split || !state.setup?.schema)
    return (
      <Frame head={<PageHead title="Gold Labels" />}>
        <Empty title="No examples to label yet" text="Split the dataset first, then label the eval set here." />
      </Frame>
    );

  return (
    <Frame head={head}>
      {state.staleGold.size > 0 && <Banner text={`The schema changed. ${num(state.staleGold.size)} labels were made under the old schema and need a quick re-check.`} />}
      <Tabs
        label="Sets"
        selected={tab}
        onSelect={setTab}
        items={[
          {key: 'eval', label: 'Eval set', count: `${num(state.facts.goldEvalDone)} / ${num(sets.eval.length)}`},
          {key: 'test', label: 'Test set', count: `${num(state.facts.goldTestDone)} / ${num(sets.test.length)}`},
        ]}
      />
      {ex ? (
        <div style={{display: 'grid', gridTemplateColumns: '520px 1fr', gap: 16, alignItems: 'start'}}>
          <ExampleCard ex={ex} n={i + 1} />
          <div className="col" style={{gap: 16}}>
            <ModelAnswer key={`m-${ex.id}`} state={state} ex={ex} shown={showModel} onToggle={() => setShowModel(s => !s)} />
            <YourAnswer key={`y-${ex.id}`} state={state} ex={ex} modelShown={showModel} />
          </div>
        </div>
      ) : (
        <Empty title="No examples in this set" text="Change the split on the Dataset page to add some." />
      )}
    </Frame>
  );
}

/**
 * The example with the features of its own type (design: media on top, one line per feature).
 * The media tile shows the item id only, as designed. `exampleMedia` (backend-api) already returns
 * the cover, frames or video from the platform's media source; showing them here waits for a design.
 */
function ExampleCard({ex, n}: {ex: Example; n: number}) {
  const f = (k: string) => {
    const v = ex.features[k];
    return (Array.isArray(v) ? v.join(', ') : (v ?? '')).trim();
  };
  const joined = (...parts: string[]) => parts.filter(Boolean).join(' · ');
  const posted = f('Create_Time');
  const rows: [string, string][] = (
    [
      ['Title', ex.title || f('Title')],
      ['Description', f('Description')],
      ['On-screen text', f('OCR_Text')],
      ['Speech', f('ASR')],
      ['Creator', joined(f('Creator_Nick_Name'), f('Creator_Bio'))],
      ['Hashtags', f('Hashtags')],
      ['Posted', posted ? dateTime(posted.replace(' ', 'T')) : ''],
      ['Country, language', joined(f('Country_Code'), f('Language'))],
      ['Place', joined(f('POI_Name'), f('POI_Info'))],
      ['Interest', f('Interest_V3')],
      ['Summary', f('Summary')],
    ] as [string, string][]
  ).filter(([, v]) => v);
  return (
    <Card title={`Example ${n}`}>
      <div className="media">
        <Icon name={ex.type === 'video' ? 'video' : 'image'} />
        <small>{ex.externalId}</small>
      </div>
      <div className="kv">
        {rows.map(([k, v]) => (
          <Fragment key={k}>
            <span>{k}</span>
            <span title={v}>{v}</span>
          </Fragment>
        ))}
      </div>
    </Card>
  );
}

function ModelAnswer({state, ex, shown, onToggle}: {state: ProjectState; ex: Example; shown: boolean; onToggle: () => void}) {
  const [found, setFound] = useState<{answer: Answer | null; invalid: string | null; label: string; endpoint: string} | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void (async () => {
      // The newest version that has an answer for this example, models in setup order.
      for (const v of [...state.versions].reverse())
        for (const m of state.setup!.models) {
          const p = (await predictionsFor(v.id, m.endpoint, m)).get(ex.id);
          if (p) {
            if (live) setFound({answer: p.answer, invalid: p.invalidReason, label: versionLabel(v), endpoint: state.endpoints.find(e => e.id === m.endpoint)?.name ?? m.endpoint});
            return;
          }
        }
      if (live) setFound(null);
    })();
    return () => {
      live = false;
    };
  }, [ex.id, state.versions.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const schema = state.setup!.schema!;
  // No model answer for this example (or still looking): no card at all (design, 2026-11-09).
  if (!found) return null;
  return (
    <Card
      title="Model answer"
      titleExtra={
        shown ? (
          <span className="t-3 one" style={{fontSize: 13}}>
            {found.endpoint} · prompt {found.label}
          </span>
        ) : undefined
      }
      actions={<Button label={shown ? 'Hide' : 'Show'} kind="ghost" size="sm" icon="eye" onClick={onToggle} />}
    >
      {!shown ? null : !found.answer ? (
        <span className="t-3 one" style={{fontSize: 13}} title={found.invalid ?? undefined}>
          The model&apos;s answer was invalid
        </span>
      ) : (
        <div className="col" style={{gap: 12}}>
          {schema.fields.map(fl => (
            <div key={fl.name} className="row" style={{gap: 12}}>
              <span style={{width: 128, flex: 'none'}}>
                <Code>{fl.name}</Code>
              </span>
              {(found.answer![fl.name] ?? []).map(v => (
                <span key={v} className="ch" style={{cursor: 'default', background: 'var(--bg-muted)', borderColor: 'transparent'}}>
                  {v}
                </span>
              ))}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

const kindText = (f: LabelField) => (f.kind === 'single' ? 'Single-select' : `Multi-select, ${f.min ?? 1} to ${f.max ?? f.values.length}`);
const same = (a: Answer, b: Answer) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

/** Picking values saves the answer as soon as every field has one (no Save button in the design). */
function YourAnswer({state, ex, modelShown}: {state: ProjectState; ex: Example; modelShown: boolean}) {
  const schema = state.setup!.schema!;
  const saved = state.gold.get(ex.id);
  const [answer, setAnswer] = useState<Answer>(saved?.answer ?? {});
  const savedRef = useRef(saved);
  savedRef.current = saved;
  const complete = schema.fields.every(f => (answer[f.name]?.length ?? 0) >= (f.kind === 'single' ? 1 : (f.min ?? 1)));
  const isSaved = !!saved && same(saved.answer, answer);

  useEffect(() => {
    if (!complete || (savedRef.current && same(savedRef.current.answer, answer))) return;
    const id = setTimeout(() => void saveGold(state.project.id, ex.id, state.setup!.schemaVersion, answer, modelShown), 300);
    return () => clearTimeout(id);
  }, [answer, complete]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (f: LabelField, value: string) => {
    const cur = answer[f.name] ?? [];
    if (f.kind === 'single') return setAnswer({...answer, [f.name]: [value]});
    const next = cur.includes(value) ? cur.filter(v => v !== value) : cur.length >= (f.max ?? 99) ? cur : [...cur, value];
    setAnswer({...answer, [f.name]: next});
  };
  return (
    <Card
      title="Your answer"
      titleExtra={
        isSaved ? (
          <span className="done-at" style={{margin: 0}}>
            <Badge text="Saved" tone="ok" />
          </span>
        ) : undefined
      }
    >
      <div className="col" style={{gap: 28}}>
        {schema.fields.map(f => (
          <div key={f.name} className="col" style={{gap: 10}}>
            <div className="row" style={{gap: 8}}>
              <Code>{f.name}</Code>
              <span className="t-3" style={{fontSize: 13}}>
                {kindText(f)}
              </span>
            </div>
            <div className="chs" role="group" aria-label={f.name}>
              {f.values.map(v => {
                const on = (answer[f.name] ?? []).includes(v.name);
                return (
                  <button key={v.name} type="button" className="ch" aria-pressed={on} title={v.definition} onClick={() => pick(f, v.name)}>
                    {on && <Icon name="check" />}
                    {v.name}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
