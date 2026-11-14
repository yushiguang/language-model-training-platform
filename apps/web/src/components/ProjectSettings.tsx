'use client';

import {createContext, useCallback, useContext, useRef, useState, type ReactNode} from 'react';
import {CUSTOM_START, DEFAULT_THRESHOLDS, systemConfig} from '@tsp/domain';
import type {Thresholds} from '@tsp/contracts';
import {renameProject, saveSettings, type ProjectState} from '@/backend-api';
import {t} from '@/i18n';
import {Button, Dialog, Field, Select, Switch, Table} from '@/ui';

/**
 * Project Settings (spec 1.0.0, 2.3; 1.1.0, 1.2): the project's name, the pass rule and the labeling model. They are not workflow
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
/** The checks of the pass rule (names and lines are catalog keys). */
const CHECKS: {key: Check; name: string; sub: string}[] = [
  {key: 'macroF1', name: 'Macro-F1', sub: 'Per field. Every value counts the same, so rare values matter.'},
  {key: 'valueF1', name: 'Value F1', sub: 'Per value. No single value may fall below this.'},
  {key: 'precision', name: 'Precision', sub: "Per value. How often the model's pick is right."},
  {key: 'recall', name: 'Recall', sub: 'Per value. How many of the true cases the model finds.'},
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
        <span key="n">
          <b>{t(c.name)}</b>
          <span className="set-sub">{t(c.sub)}</span>
        </span>,
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
      <span key="n">
        <b>{t('Invalid outputs')}</b>
        <span className="set-sub">{t('Answers the site could not read as labels. Always checked.')}</span>
      </span>,
      <Switch key="s" label={t('{check} on', {check: t('Invalid outputs')})} on locked />,
      <input key="v" className="input sm" style={{width: 72, textAlign: 'center', padding: '0 8px'}} aria-label={t('Invalid outputs limit')} disabled value={cap} readOnly />,
    ],
  };

  return (
    <Dialog
      title={t('Project Settings')}
      text={first ? t('Check these once before the first scoring run. You can change them later with Settings at the top.') : undefined}
      width={760}
      onClose={() => onDone(false)}
      actions={
        <>
          <Button label={t('Cancel')} onClick={() => onDone(false)} />
          <Button label={first ? t('Confirm') : t('Save')} kind="primary" disabled={!info || !name.trim()} onClick={save} />
        </>
      }
    >
      <Field label={t('Name')}>
        <input className="input" value={name} maxLength={nameMax} aria-invalid={!name.trim() || undefined} onChange={e => setName(e.target.value)} />
      </Field>
      <div className="col" style={{gap: 12}}>
        <h3>{t('Evaluation')}</h3>
        <div className="set-grid">
          <div className="col" style={{gap: 8}}>
            <span className="field-l">{t('Pass rule')}</span>
            <div className="opts" role="radiogroup" aria-label={t('Pass rule')}>
              <Rule title={t('Default')} sub={t('Every field reaches Macro-F1 {n}.', {n: DEFAULT_THRESHOLDS.macroF1.toFixed(2)})} checked={!custom} onSelect={() => setMode('default')} />
              <Rule title={t('Custom')} sub={t('You choose the checks and their thresholds.')} checked={custom} onSelect={() => setMode('custom')} />
            </div>
          </div>
          <div className="col set-checks" style={{gap: 8, minWidth: 0}}>
            <span className="field-l">{t('Checks')}</span>
            <Table cols={[{label: t('Check')}, {label: t('On'), kind: 'c'}, {label: t('Threshold'), kind: 'c'}]} widths={['auto', 72, 112]} rows={[...CHECKS.map(row), invalid]} />
          </div>
        </div>
      </div>
      <div className="col" style={{gap: 12}}>
        <h3>{t('Labeling model')}</h3>
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
        {info?.description && <span className="set-sub">{info.description}</span>}
      </div>
    </Dialog>
  );
}

/** A pass rule: its name, with what it means on the line below (no hover here, by design). */
function Rule({title, sub, checked, onSelect}: {title: string; sub: string; checked: boolean; onSelect: () => void}) {
  return (
    <div className="opt tall" role="radio" aria-checked={checked} tabIndex={0} onClick={onSelect} onKeyDown={e => (e.key === ' ' || e.key === 'Enter') && (e.preventDefault(), onSelect())}>
      <span className="radio" />
      <span>
        <b>{title}</b>
        <span className="set-sub">{sub}</span>
      </span>
    </div>
  );
}
