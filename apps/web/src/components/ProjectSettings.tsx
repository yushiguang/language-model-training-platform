'use client';

import {createContext, useCallback, useContext, useRef, useState, type ReactNode} from 'react';
import {CUSTOM_START, DEFAULT_THRESHOLDS, systemConfig} from '@tsp/domain';
import type {Thresholds} from '@tsp/contracts';
import {renameProject, saveSettings, type ProjectState} from '@/backend-api';
import {t} from '@/i18n';
import {Button, Dialog, Field, Seg, Select, Switch, Table} from '@/ui';

/**
 * Project Settings (spec 1.0.0, 2.3; 1.1.0, 1.2; 2026-11-16 refinements, 3): the project's name,
 * the pass rule (Default or Custom, switched beside the Evaluation heading) and the labeling
 * model, in three sections set apart by a line and space. They are not workflow
 * steps: a new project starts from defaults, the Settings button at the top opens this dialog at
 * any time, and it opens once by itself before the first paid run so the user confirms them.
 */
interface Settings {
  /** Opens the dialog. */
  open: () => void;
  /**
   * Resolves true when the settings are confirmed: at once when they already are, else after the
   * user saves the dialog. False when the user closes it (the paid work then does not start).
   */
  confirmed: () => Promise<boolean>;
}
const Ctx = createContext<Settings>({open: () => undefined, confirmed: async () => true});
export const useSettings = () => useContext(Ctx);

export function SettingsProvider({state, children}: {state: ProjectState | null; children: ReactNode}) {
  const [shown, setShown] = useState<{first: boolean} | null>(null);
  const waiting = useRef<((ok: boolean) => void)[]>([]);
  const ok = state?.facts.settingsConfirmed ?? false;
  const settle = (v: boolean) => {
    for (const r of waiting.current.splice(0)) r(v);
    setShown(null);
  };
  const open = useCallback(() => setShown({first: false}), []);
  const confirmed = useCallback(
    () =>
      ok
        ? Promise.resolve(true)
        : new Promise<boolean>(resolve => {
            waiting.current.push(resolve);
            setShown({first: true});
          }),
    [ok],
  );
  return (
    <Ctx.Provider value={{open, confirmed}}>
      {children}
      {shown && state && <SettingsDialog state={state} first={shown.first || !ok} onDone={settle} />}
    </Ctx.Provider>
  );
}

type Mode = 'default' | 'custom';
type Check = 'macroF1' | 'valueF1' | 'precision' | 'recall';
/** The checks of the pass rule (names are catalog keys). Names only, no explanation line (2026-11-16). */
const CHECKS: {key: Check; name: string}[] = [
  {key: 'macroF1', name: 'Macro-F1'},
  {key: 'valueF1', name: 'Value F1'},
  {key: 'precision', name: 'Precision'},
  {key: 'recall', name: 'Recall'},
];

function SettingsDialog({state, first, onDone}: {state: ProjectState; first: boolean; onDone: (saved: boolean) => void}) {
  const s = state.setup;
  const saved = s?.thresholds ?? DEFAULT_THRESHOLDS;
  const [mode, setMode] = useState<Mode>(saved.mode === 'custom' ? 'custom' : 'default');
  const start = saved.mode === 'custom' ? saved : null;
  const [on, setOn] = useState<Record<Check, boolean>>({macroF1: true, valueF1: start?.valueF1 != null, precision: start?.precision != null, recall: start?.recall != null});
  const [val, setVal] = useState<Record<Check, string>>({
    macroF1: (start?.macroF1 ?? DEFAULT_THRESHOLDS.macroF1).toFixed(2),
    valueF1: (start?.valueF1 ?? CUSTOM_START.valueF1).toFixed(2),
    precision: (start?.precision ?? CUSTOM_START.precision).toFixed(2),
    recall: (start?.recall ?? CUSTOM_START.recall).toFixed(2),
  });
  const eps = state.endpoints;
  const model = s?.models[0];
  const [ep, setEp] = useState(model?.endpoint ?? eps[0]?.id);
  const info = eps.find(e => e.id === ep);
  const [tokens, setTokens] = useState(String(model?.maxOutputTokens ?? 1024));
  const [temp, setTemp] = useState(String(model?.temperature ?? 0));
  const custom = mode === 'custom';
  const [name, setName] = useState(state.project.name);
  const nameMax = systemConfig().project.nameMaxChars;
  const cap = `≤ ${+(100 * systemConfig().evaluation.invalidRateCap).toFixed(1)}%`;

  const save = async () => {
    if (!info || !name.trim()) return;
    if (name.trim() !== state.project.name) await renameProject({projectId: state.project.id, name});
    const n = (k: Check) => (on[k] ? Math.min(1, Math.max(0, parseFloat(val[k]) || 0)) : null);
    const thresholds: Thresholds = custom ? {...DEFAULT_THRESHOLDS, mode: 'custom', macroF1: n('macroF1') ?? DEFAULT_THRESHOLDS.macroF1, valueF1: n('valueF1'), precision: n('precision'), recall: n('recall')} : DEFAULT_THRESHOLDS;
    await saveSettings({projectId: state.project.id, thresholds, model: {endpoint: info.id, maxOutputTokens: parseInt(tokens) || 1024, temperature: info.supportsTemperature ? parseFloat(temp) || 0 : null}});
    onDone(true);
  };

  // Default shows the exact thresholds it uses, locked; Custom unlocks them (feedback 5).
  const row = (c: (typeof CHECKS)[number]) => {
    const isOn = custom ? on[c.key] : c.key === 'macroF1';
    return {
      key: c.key,
      cells: [
        <b key="n">{t(c.name)}</b>,
        <Switch key="s" label={t('{check} on', {check: t(c.name)})} on={isOn} locked={!custom || c.key === 'macroF1'} onChange={v => setOn({...on, [c.key]: v})} />,
        <input
          key="v"
          className="input sm"
          style={{width: 72, textAlign: 'center', padding: '0 8px'}}
          aria-label={t('{check} threshold', {check: t(c.name)})}
          disabled={!custom}
          value={custom ? val[c.key] : c.key === 'macroF1' ? DEFAULT_THRESHOLDS.macroF1.toFixed(2) : '–'}
          onChange={e => {
            setVal({...val, [c.key]: e.target.value});
            if (c.key !== 'macroF1') setOn({...on, [c.key]: true});
          }}
        />,
      ],
    };
  };
  const invalid = {
    key: 'invalid',
    cells: [
      <b key="n">{t('Invalid outputs')}</b>,
      <Switch key="s" label={t('{check} on', {check: t('Invalid outputs')})} on locked />,
      <input key="v" className="input sm" style={{width: 72, textAlign: 'center', padding: '0 8px'}} aria-label={t('Invalid outputs limit')} disabled value={cap} readOnly />,
    ],
  };

  return (
    <Dialog
      title={t('Project Settings')}
      width={760}
      onClose={() => onDone(false)}
      actions={
        <>
          <Button label={t('Cancel')} onClick={() => onDone(false)} />
          <Button label={first ? t('Confirm') : t('Save')} kind="primary" disabled={!info || !name.trim()} onClick={save} />
        </>
      }
    >
      <div className="set-secs">
        <section className="set-sec">
          <h3 id="set-name">{t('Name')}</h3>
          <input className="input" value={name} maxLength={nameMax} aria-labelledby="set-name" aria-invalid={!name.trim() || undefined} onChange={e => setName(e.target.value)} />
        </section>
        <section className="set-sec set-checks">
          <div className="set-sec-h">
            <h3 id="set-eval">{t('Evaluation')}</h3>
            <Seg
              label={t('Pass rule')}
              value={mode}
              options={[
                {value: 'default', label: t('Default')},
                {value: 'custom', label: t('Custom')},
              ]}
              onChange={setMode}
            />
          </div>
          <Table cols={[{label: t('Check')}, {label: t('On'), kind: 'c'}, {label: t('Threshold'), kind: 'c'}]} widths={['auto', 72, 112]} rows={[...CHECKS.map(row), invalid]} />
        </section>
        <section className="set-sec">
          <h3 id="set-model">{t('Labeling model')}</h3>
          <div className="row" style={{gap: 16, alignItems: 'flex-end'}}>
            <Select label={t('Model')} value={ep ?? ''} options={eps.map(e => ({value: e.id as string, label: e.name}))} onChange={v => setEp(v as typeof ep)} />
            <Field label={t('Max output tokens')}>
              <input className="input" value={tokens} onChange={e => setTokens(e.target.value.replace(/\D/g, ''))} />
            </Field>
            {info?.supportsTemperature ? (
              <Field label={t('Temperature')}>
                <input className="input" value={temp} onChange={e => setTemp(e.target.value)} />
              </Field>
            ) : (
              <Field label={t('Temperature')} off>
                <input className="input" value={t('Not supported')} readOnly disabled />
              </Field>
            )}
          </div>
        </section>
      </div>
    </Dialog>
  );
}
