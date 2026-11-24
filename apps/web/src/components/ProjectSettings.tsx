'use client';

import {createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode} from 'react';
import {Cog6ToothIcon, CpuChipIcon, EyeIcon, MagnifyingGlassIcon, TagIcon, TrashIcon, UserGroupIcon, UserPlusIcon, XMarkIcon} from '@heroicons/react/24/outline';
import {DEFAULT_THRESHOLDS, systemConfig} from '@yushiguang/sprint-domain';
import type {ProjectEditor, TenantMemberView, Thresholds} from '@yushiguang/sprint-contracts';
import {addProjectEditors, deleteProject, listProjectEditors, listTenantMembers, removeProjectEditor, renameProject, saveSettings, type NewProjectThresholds, type ProjectState} from '@/backend-api';
import {FormDialog, SettingsCard, SettingsDialog as Frame, SettingsRow} from '@/components/shell/dialogs';
import {ErrorLine} from '@/components/sources/dialogs';
import {ThresholdFields} from '@/components/thresholds';
import {tenantHref} from '@/components/ProjectContext';
import {useGo} from '@/components/nav';
import {useRuntime} from '@/components/session';
import {Avatar, Badge, Button, HStack, Icon, IconButton, Selector, Text, TextInput, Typeahead, VStack, type SearchableItem, type SearchSource} from '@/ui/astryx';
import {dateTime, isAccessDenied, reportAccessDenied} from '@/ui';
import {t} from '@/i18n';

/**
 * Project Settings (wireframes v346: W-ProjectSettings, -People, -Delete; #118): General (the
 * name, the labeling model, the three thresholds), Members (who can view and who can edit) and
 * Delete project, in the same settings dialog as the tenant's. They are not workflow steps: the
 * Settings button opens the dialog at any time, and a project whose settings were never confirmed
 * gets it once by itself before its first paid run.
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

type Tab = 'general' | 'members' | 'delete';

/** Errors the server words for people come through translated; anything else says to try again. */
const said = (e: unknown) => {
  const msg = e instanceof Error ? e.message : '';
  return /^[A-Z][^{}<>\n]{0,160}\.$/.test(msg) ? t(msg) : t('Check your connection and try again.');
};

/** The saved pass rule as the three thresholds the page edits. */
function shownThresholds(th: Thresholds | null | undefined): NewProjectThresholds {
  if (!th || th.mode !== 'custom') return {macroF1: DEFAULT_THRESHOLDS.macroF1, precision: null, recall: null};
  return {macroF1: th.macroF1, precision: th.precision ?? null, recall: th.recall ?? null};
}

/** The three thresholds back as a pass rule: the defaults stay the default; Value F1, no longer shown, keeps what it had. */
function savedThresholds(v: NewProjectThresholds, was: Thresholds | null | undefined): Thresholds {
  const d = DEFAULT_THRESHOLDS;
  const valueF1 = was?.mode === 'custom' ? was.valueF1 : null;
  if (v.macroF1 === d.macroF1 && v.precision == null && v.recall == null && valueF1 == null) return d;
  return {...d, mode: 'custom', macroF1: v.macroF1, valueF1, precision: v.precision, recall: v.recall};
}

function SettingsDialog({state, first, onDone}: {state: ProjectState; first: boolean; onDone: (saved: boolean) => void}) {
  const go = useGo();
  const {info} = useRuntime();
  const p = state.project;
  const s = state.setup;
  const [tab, setTab] = useState<Tab>('general');
  const [name, setName] = useState(p.name);
  const model = s?.models[0];
  const [endpoint, setEndpoint] = useState<string>(model?.endpoint ?? state.endpoints[0]?.id ?? '');
  const startThresholds = useMemo(() => shownThresholds(s?.thresholds), [s]);
  const [thresholds, setThresholds] = useState<NewProjectThresholds>(startThresholds);
  const [editors, setEditors] = useState<ProjectEditor[] | null>(null);
  const [members, setMembers] = useState<TenantMemberView[]>([]);
  const [adding, setAdding] = useState<TenantMemberView[]>([]);
  const [removing, setRemoving] = useState<string[]>([]);
  const [error, setError] = useState<{field: 'name' | 'form'; text: string} | null>(null);
  const [busy, setBusy] = useState(false);
  const nameMax = systemConfig().project.nameMaxChars;

  useEffect(() => {
    listProjectEditors({projectId: p.id}).then(setEditors, e => setError({field: 'form', text: said(e)}));
    listTenantMembers().then(setMembers, () => undefined);
  }, [p.id]);

  const creator = editors?.find(e => e.creator);
  const shown = useMemo(() => {
    const list: (ProjectEditor & {isNew?: boolean})[] = (editors ?? []).filter(e => !removing.includes(e.userId));
    for (const m of adding) if (!list.some(e => e.userId === m.userId)) list.push({userId: m.userId, name: m.name, ...(m.email ? {email: m.email} : {}), creator: false, addedAt: null, isNew: true});
    return list;
  }, [editors, adding, removing]);
  const sameThresholds = JSON.stringify(thresholds) === JSON.stringify(startThresholds);
  const renamed = name.trim().replace(/\s+/g, ' ') !== p.name;
  // A rename alone saves no settings, so the Overview's activity shows only the rename.
  const ruleChanged = endpoint !== (model?.endpoint ?? '') || !sameThresholds;
  const settingsChanged = renamed || ruleChanged;
  const dirty = first || settingsChanged || adding.length > 0 || removing.length > 0;
  const info2 = state.endpoints.find(e => e.id === endpoint);

  const denied = (e: unknown) => {
    if (!isAccessDenied(e)) return false;
    onDone(false);
    reportAccessDenied(e.permission, undefined, {id: p.id, name: p.name});
    return true;
  };

  const save = async () => {
    if (!name.trim()) return setError({field: 'name', text: t('Enter a name. Spaces alone are not a name.')}), setTab('general');
    if (!info2) return setError({field: 'form', text: t('This model is not available.')}), setTab('general');
    setBusy(true);
    setError(null);
    try {
      if (renamed) await renameProject({projectId: p.id, name});
      if (first || ruleChanged)
        await saveSettings({
          projectId: p.id,
          thresholds: savedThresholds(thresholds, s?.thresholds),
          model: {endpoint: info2.id, maxOutputTokens: model?.maxOutputTokens ?? 1024, temperature: info2.supportsTemperature ? (model?.temperature ?? 0) : null},
        });
      if (adding.length) {
        const r = await addProjectEditors({projectId: p.id, userIds: adding.map(m => m.userId)});
        if (r.error) return setError({field: 'form', text: t(r.error)}), setTab('members');
      }
      for (const userId of removing) {
        const r = await removeProjectEditor({projectId: p.id, userId});
        if (r.error) return setError({field: 'form', text: t(r.error)}), setTab('members');
      }
      onDone(true);
    } catch (e) {
      if (!denied(e)) setError({field: 'form', text: said(e)});
    } finally {
      setBusy(false);
    }
  };

  const heading: Record<Tab, [string, string?]> = {
    general: [t('General'), t('Only people who can edit this project can change these.')],
    members: [t('Members'), creator ? t('{name} created this project and can always edit it.', {name: creator.name}) : undefined],
    delete: [t('Delete project'), t('Anyone who can edit this project can delete it.')],
  };
  const [title, sub] = heading[tab];

  return (
    <Frame<Tab>
      title={t('Project settings')}
      sections={[
        {
          title: t('Project'),
          items: [
            {key: 'general', label: t('General'), icon: Cog6ToothIcon},
            {key: 'members', label: t('Members'), icon: UserGroupIcon, ...(editors ? {end: String(shown.length)} : {})},
          ],
        },
        ...(first ? [] : [{items: [{key: 'delete' as const, label: t('Delete project'), icon: TrashIcon}]}]),
      ]}
      selected={tab}
      onSelect={k => (setTab(k), setError(e => (e?.field === 'name' ? e : null)))}
      heading={title}
      sub={sub}
      onClose={() => onDone(false)}
      footer={
        tab === 'delete' ? undefined : (
          <>
            <Button label={t('Cancel')} variant="ghost" onClick={() => onDone(false)} />
            <Button label={first ? t('Confirm') : t('Save')} variant="primary" isDisabled={!dirty} isLoading={busy} onClick={() => void save()} />
          </>
        )
      }
    >
      {tab === 'general' && (
        <VStack gap={5}>
          <SettingsCard title={t('Project')}>
            <SettingsRow
              icon={TagIcon}
              title={t('Name')}
              control={
                <TextInput
                  label={t('Name')}
                  isLabelHidden
                  value={name}
                  onChange={v => (setName(v.slice(0, nameMax)), setError(null))}
                  status={error?.field === 'name' ? {type: 'error', message: error.text} : undefined}
                />
              }
            />
            <SettingsRow
              icon={CpuChipIcon}
              title={t('Labeling model')}
              description={t('One model per project.')}
              control={<Selector label={t('Model')} isLabelHidden options={state.endpoints.map(e => ({value: e.id as string, label: e.name}))} value={endpoint} onChange={setEndpoint} />}
            />
          </SettingsCard>
          <ThresholdFields value={thresholds} onChange={setThresholds} />
        </VStack>
      )}
      {tab === 'members' && (
        <Editors
          tenant={info?.tenant?.name ?? ''}
          shown={shown}
          loading={!editors}
          members={members}
          onAdd={m => (setAdding(a => (a.some(x => x.userId === m.userId) ? a : [...a, m])), setRemoving(r => r.filter(id => id !== m.userId)))}
          onRemove={e => (e.isNew ? setAdding(a => a.filter(m => m.userId !== e.userId)) : setRemoving(r => [...r, e.userId]))}
        />
      )}
      {tab === 'delete' && (
        <DeleteProject
          project={p}
          onDenied={denied}
          onDeleted={() => {
            onDone(false);
            void go(tenantHref());
          }}
        />
      )}
      {error?.field === 'form' && <ErrorLine text={error.text} />}
    </Frame>
  );
}

type MemberItem = SearchableItem<TenantMemberView>;

/** Members (W-ProjectSettings-People): everyone in the tenant views; editors are listed, added and removed. */
function Editors({
  tenant,
  shown,
  loading,
  members,
  onAdd,
  onRemove,
}: {
  tenant: string;
  shown: (ProjectEditor & {isNew?: boolean})[];
  loading: boolean;
  members: TenantMemberView[];
  onAdd: (m: TenantMemberView) => void;
  onRemove: (e: ProjectEditor & {isNew?: boolean}) => void;
}) {
  const [picked, setPicked] = useState<MemberItem | null>(null);
  const source = useMemo<SearchSource<MemberItem>>(() => {
    const ids = new Set(shown.map(e => e.userId));
    return {
      search: q => {
        const s = q.trim().toLowerCase();
        return members
          .filter(m => !ids.has(m.userId) && (m.name.toLowerCase().includes(s) || (m.email ?? '').toLowerCase().includes(s)))
          .map(m => ({id: m.userId, label: m.name, auxiliaryData: m}));
      },
      bootstrap: () => [],
    };
  }, [members, shown]);
  const add = () => {
    if (!picked?.auxiliaryData) return;
    onAdd(picked.auxiliaryData);
    setPicked(null);
  };
  return (
    <VStack gap={5}>
      <SettingsCard title={t('Who can view')}>
        <SettingsRow icon={EyeIcon} title={t('Everyone in {tenant}', {tenant})} description={t('Open the project and read every page.')} />
      </SettingsCard>
      <SettingsCard title={t('Who can edit')}>
        <SettingsRow
          title={
            <HStack gap={2} vAlign="end">
              <div style={{flex: 1, minWidth: 0}}>
                <Typeahead<MemberItem>
                  label={t('Add people')}
                  placeholder={t('Search by name or email')}
                  startIcon={MagnifyingGlassIcon}
                  searchSource={source}
                  value={picked}
                  onChange={setPicked}
                  renderItem={m => (
                    <HStack gap={2} vAlign="center">
                      <Avatar name={m.label} size="xsm" />
                      <VStack gap={0}>
                        <Text type="body">{m.label}</Text>
                        {m.auxiliaryData?.email && (
                          <Text type="supporting" color="secondary">
                            {m.auxiliaryData.email}
                          </Text>
                        )}
                      </VStack>
                    </HStack>
                  )}
                  emptySearchText={t('Nobody found in this tenant.')}
                />
              </div>
              <Button label={t('Add')} variant="secondary" icon={<Icon icon={UserPlusIcon} size="sm" />} isDisabled={!picked} onClick={add} />
            </HStack>
          }
        />
        {loading ? (
          <SettingsRow title={<Text color="secondary">{t('Loading')}</Text>} />
        ) : (
          shown.map(e => (
            <SettingsRow
              key={e.userId}
              start={<Avatar name={e.name} size="sm" />}
              title={
                <HStack gap={2} vAlign="center">
                  <Text type="label">{e.name}</Text>
                  {e.creator && <Badge variant="neutral" label={t('Project creator')} />}
                  {e.isNew && <Badge variant="info" label={t('New')} />}
                </HStack>
              }
              description={e.creator ? t('Created this project') : e.addedAt ? t('Added {when}', {when: dateTime(e.addedAt)}) : (e.email ?? undefined)}
              controlWidth="auto"
              control={
                e.creator ? undefined : (
                  <span className="sp-hover-acts">
                    <IconButton label={t('Remove {name}', {name: e.name})} tooltip={t('Remove')} variant="ghost" size="sm" icon={<Icon icon={XMarkIcon} size="sm" />} onClick={() => onRemove(e)} />
                  </span>
                )
              }
            />
          ))
        )}
      </SettingsCard>
    </VStack>
  );
}

/** Delete project (W-ProjectSettings-Delete): the button asks for the project's name first. */
function DeleteProject({project, onDenied, onDeleted}: {project: {id: string; name: string}; onDenied: (e: unknown) => boolean; onDeleted: () => void}) {
  const [asking, setAsking] = useState(false);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteProject({projectId: project.id});
      onDeleted();
    } catch (e) {
      if (!onDenied(e)) setError(said(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <SettingsCard danger>
        <SettingsRow
          icon={TrashIcon}
          title={t('Delete {name}', {name: project.name})}
          description={t('Its prompt versions, datasets, label sets and scores are removed. Data sources stay. This cannot be undone.')}
          controlWidth="auto"
          control={<Button label={t('Delete project')} variant="destructive" onClick={() => (setTyped(''), setError(null), setAsking(true))} />}
        />
      </SettingsCard>
      {asking && (
        <FormDialog
          title={t('Delete {name}?', {name: project.name})}
          width={480}
          onClose={() => setAsking(false)}
          footer={
            <>
              <Button label={t('Cancel')} variant="ghost" onClick={() => setAsking(false)} />
              <Button label={t('Delete project')} variant="destructive" isDisabled={typed !== project.name} isLoading={busy} onClick={() => void remove()} />
            </>
          }
        >
          <VStack gap={5}>
            <Text type="body" color="secondary">
              {t('Its prompt versions, datasets, label sets and scores are removed. Data sources stay. This cannot be undone.')}
            </Text>
            <TextInput label={t('Type the project name to confirm')} value={typed} onChange={setTyped} hasAutoFocus />
            {error && <ErrorLine text={error} />}
          </VStack>
        </FormDialog>
      )}
    </>
  );
}
