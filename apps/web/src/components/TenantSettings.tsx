'use client';

import {useEffect, useMemo, useState} from 'react';
import {ClipboardDocumentIcon, Cog6ToothIcon, CpuChipIcon, MagnifyingGlassIcon, PencilSquareIcon, PlusIcon, TagIcon, TrashIcon, UserGroupIcon, UserPlusIcon, XMarkIcon, FingerPrintIcon} from '@heroicons/react/24/outline';
import type {Person, TenantDetail, TenantMemberView, TenantModelView, TenantRole} from '@yushiguang/sprint-contracts';
import {
  addModel,
  addTenantMembers,
  deleteTenant,
  listModels,
  listTenantMembers,
  removeModel,
  removeTenantMember,
  renameTenant,
  searchPeople,
  setDefaultModel,
  setTenantRole,
  updateModel,
} from '@/backend-api';
import {FormDialog, SettingsCard, SettingsDialog, SettingsRow} from '@/components/shell/dialogs';
import {ErrorLine} from '@/components/sources/dialogs';
import {forgetRuntime} from '@/components/session';
import {useGo} from '@/components/nav';
import {Avatar, Badge, Button, HStack, Icon, IconButton, NumberInput, Selector, Text, TextInput, Typeahead, VStack, type SearchableItem, type SearchSource} from '@/ui/astryx';
import {isAccessDenied, reportAccessDenied} from '@/ui';
import {t} from '@/i18n';

/**
 * Tenant settings (wireframes v346: W-TenantSettings, -Members, -Models, -ModelsAdd, -Delete;
 * #111), for tenant admins. General (the name, the id) and Members (add from the directory, change
 * roles, remove) are kept with Save; models are added, changed and removed at once, each with its
 * own form; Delete tenant asks for the name first. The tenant always keeps an admin.
 */
export type TenantSettingsTab = 'general' | 'members' | 'models' | 'delete';

/** Errors the server words for people come through translated; anything else says to try again. */
const said = (e: unknown) => {
  const msg = e instanceof Error ? e.message : '';
  return /^[A-Z][^{}<>\n]{0,160}\.$/.test(msg) ? t(msg) : t('Check your connection and try again.');
};

const LAST_ADMIN = "The last admin can't be changed. Make someone else an admin first.";

export function TenantSettings({tenant, me, tab: first = 'general', onClose, onChanged}: {tenant: TenantDetail; me: string | undefined; tab?: TenantSettingsTab; onClose: () => void; onChanged: () => void}) {
  const go = useGo();
  const [tab, setTab] = useState<TenantSettingsTab>(first);
  const [name, setName] = useState(tenant.name);
  const [members, setMembers] = useState<TenantMemberView[] | null>(null);
  const [models, setModels] = useState<TenantModelView[] | null>(null);
  // Member changes kept until Save: people to add, new roles, people to remove.
  const [adding, setAdding] = useState<Person[]>([]);
  const [roles, setRoles] = useState<Record<string, TenantRole>>({});
  const [removing, setRemoving] = useState<string[]>([]);
  const [error, setError] = useState<{field: 'name' | 'form'; text: string} | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadFailed, setLoadFailed] = useState<string | null>(null);

  const denied = (e: unknown) => {
    if (!isAccessDenied(e)) return false;
    onClose();
    reportAccessDenied(e.permission);
    return true;
  };
  const loadMembers = () => listTenantMembers().then(setMembers, e => setLoadFailed(said(e)));
  const loadModels = () => listModels().then(setModels, e => setLoadFailed(said(e)));
  useEffect(() => {
    void loadMembers();
    void loadModels();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Members as they will be after Save: removed ones gone, new ones in as members, roles changed.
  const shown = useMemo(() => {
    const list = (members ?? []).filter(m => !removing.includes(m.userId)).map(m => ({...m, role: roles[m.userId] ?? m.role, isNew: false}));
    const have = new Set(list.map(m => m.userId));
    for (const p of adding) if (!have.has(p.id)) list.push({userId: p.id, name: p.name, ...(p.email ? {email: p.email} : {}), role: roles[p.id] ?? 'member', isNew: true});
    return list;
  }, [members, adding, roles, removing]);
  const admins = shown.filter(m => m.role === 'admin').length;
  const memberChanges = adding.length + Object.keys(roles).length + removing.length;
  const renamed = name.trim().replace(/\s+/g, ' ') !== tenant.name;
  const dirty = renamed || memberChanges > 0;

  const save = async () => {
    if (renamed && !name.trim()) return setError({field: 'name', text: t('Enter a name. Spaces alone are not a name.')});
    setBusy(true);
    setError(null);
    try {
      if (renamed) {
        const r = await renameTenant({name});
        if (r.error) return setError({field: 'name', text: t(r.error)}), setTab('general');
        forgetRuntime();
      }
      // Adds first and removals last, so the tenant never goes without an admin on the way.
      const newAdmins = adding.filter(p => roles[p.id] === 'admin').map(p => p.id);
      const newMembers = adding.filter(p => roles[p.id] !== 'admin').map(p => p.id);
      for (const [ids, role] of [
        [newAdmins, 'admin'],
        [newMembers, 'member'],
      ] as const) {
        if (!ids.length) continue;
        const r = await addTenantMembers({userIds: [...ids], role});
        if (r.error) return setError({field: 'form', text: t(r.error)}), setTab('members');
      }
      const added = new Set(adding.map(p => p.id));
      const changes = Object.entries(roles).filter(([id]) => !added.has(id));
      // Promotions before demotions, for the same reason.
      changes.sort((a, b) => (a[1] === 'admin' ? -1 : 0) - (b[1] === 'admin' ? -1 : 0));
      for (const [userId, role] of changes) {
        const r = await setTenantRole({userId, role});
        if (r.error) return setError({field: 'form', text: t(r.error)}), setTab('members');
      }
      for (const userId of removing) {
        const r = await removeTenantMember({userId});
        if (r.error) return setError({field: 'form', text: t(r.error)}), setTab('members');
      }
      onChanged();
      onClose();
    } catch (e) {
      if (!denied(e)) setError({field: 'form', text: said(e)});
    } finally {
      setBusy(false);
    }
  };

  const heading: Record<TenantSettingsTab, [string, string?]> = {
    general: [t('General'), t('Only admins can change these.')],
    members: [t('Members'), t('Everyone here sees every project. Admins also manage members, models and data sources.')],
    models: [t('Models'), t('Models that projects in this tenant may label with.')],
    delete: [t('Delete tenant')],
  };
  const [title, sub] = heading[tab];

  return (
    <SettingsDialog<TenantSettingsTab>
      title={t('Tenant settings')}
      sections={[
        {
          title: t('Tenant'),
          items: [
            {key: 'general', label: t('General'), icon: Cog6ToothIcon},
            {key: 'members', label: t('Members'), icon: UserGroupIcon, ...(members ? {end: String(shown.length)} : {})},
            {key: 'models', label: t('Models'), icon: CpuChipIcon, ...(models ? {end: String(models.length)} : {})},
          ],
        },
        {items: [{key: 'delete', label: t('Delete tenant'), icon: TrashIcon}]},
      ]}
      selected={tab}
      onSelect={k => (setTab(k), setError(e => (e?.field === 'name' ? e : null)))}
      heading={title}
      sub={sub}
      onClose={onClose}
      footer={
        // Models and Delete save on their own buttons; Save shows there only for changes made elsewhere.
        tab === 'delete' || (tab === 'models' && !dirty) ? undefined : (
          <>
            <Button label={t('Cancel')} variant="ghost" onClick={onClose} />
            <Button label={t('Save')} variant="primary" isDisabled={!dirty} isLoading={busy} onClick={() => void save()} />
          </>
        )
      }
    >
      {loadFailed && <ErrorLine text={loadFailed} />}
      {tab === 'general' && <General id={tenant.id} name={name} onName={v => (setName(v), setError(null))} error={error?.field === 'name' ? error.text : null} />}
      {tab === 'members' && (
        <Members
          shown={shown}
          loading={!members}
          me={me}
          admins={admins}
          onAdd={p => (setAdding(a => (a.some(x => x.id === p.id) ? a : [...a, p])), setRemoving(r => r.filter(id => id !== p.id)))}
          onRole={(m, role) => {
            const original = members?.find(x => x.userId === m.userId)?.role ?? 'member';
            setRoles(r => {
              const next = {...r};
              if (role === original && !m.isNew) delete next[m.userId];
              else next[m.userId] = role;
              return next;
            });
          }}
          onRemove={m => {
            if (m.isNew) setAdding(a => a.filter(p => p.id !== m.userId));
            else setRemoving(r => [...r, m.userId]);
            setRoles(r => {
              const next = {...r};
              delete next[m.userId];
              return next;
            });
          }}
        />
      )}
      {tab === 'models' && <Models models={models} onChanged={() => (void loadModels(), onChanged())} onDenied={denied} />}
      {tab === 'delete' && (
        <DeleteTenant
          tenant={tenant}
          onDenied={denied}
          onDeleted={() => {
            forgetRuntime();
            void go('/');
          }}
        />
      )}
      {error?.field === 'form' && <ErrorLine text={error.text} />}
    </SettingsDialog>
  );
}

function General({id, name, onName, error}: {id: string; name: string; onName: (v: string) => void; error: string | null}) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(id).then(
      () => setCopied(true),
      () => undefined,
    );
    setTimeout(() => setCopied(false), 1600);
  };
  return (
    <SettingsCard title={t('Tenant')}>
      <SettingsRow
        icon={TagIcon}
        title={t('Name')}
        description={t('Shown in the top bar.')}
        control={<TextInput label={t('Tenant name')} isLabelHidden value={name} onChange={onName} status={error ? {type: 'error', message: error} : undefined} />}
      />
      <SettingsRow
        icon={FingerPrintIcon}
        title={t('Tenant ID')}
        description={t('Used by the permission platform and other services.')}
        controlWidth="auto"
        control={
          <HStack gap={2} vAlign="center">
            <Text type="body" hasTabularNumbers>
              {id}
            </Text>
            <IconButton label={t('Copy tenant ID')} tooltip={copied ? t('Copied') : t('Copy')} variant="ghost" size="sm" icon={<Icon icon={ClipboardDocumentIcon} size="sm" />} onClick={copy} />
          </HStack>
        }
      />
    </SettingsCard>
  );
}

type Shown = TenantMemberView & {isNew: boolean};
type PersonItem = SearchableItem<Person>;

function Members({
  shown,
  loading,
  me,
  admins,
  onAdd,
  onRole,
  onRemove,
}: {
  shown: Shown[];
  loading: boolean;
  me: string | undefined;
  admins: number;
  onAdd: (p: Person) => void;
  onRole: (m: Shown, role: TenantRole) => void;
  onRemove: (m: Shown) => void;
}) {
  const [picked, setPicked] = useState<PersonItem | null>(null);
  const inIt = useMemo(() => new Set(shown.map(m => m.userId)), [shown]);
  const source = useMemo<SearchSource<PersonItem>>(
    () => ({
      search: async q => (await searchPeople({query: q})).filter(p => !inIt.has(p.id)).map(p => ({id: p.id, label: p.name, auxiliaryData: p})),
      bootstrap: () => [],
    }),
    [inIt],
  );
  const add = () => {
    if (!picked?.auxiliaryData) return;
    onAdd(picked.auxiliaryData);
    setPicked(null);
  };
  const roleOptions = [
    {value: 'admin', label: t('Admin')},
    {value: 'member', label: t('Member')},
  ];
  return (
    <SettingsCard title={t('Members')}>
      <SettingsRow
        title={
          <HStack gap={2} vAlign="end">
            <div style={{flex: 1, minWidth: 0}}>
              <Typeahead<PersonItem>
                label={t('Add members')}
                placeholder={t('Search by name or email')}
                startIcon={MagnifyingGlassIcon}
                searchSource={source}
                value={picked}
                onChange={setPicked}
                renderItem={p => (
                  <HStack gap={2} vAlign="center">
                    <Avatar name={p.label} size="xsm" />
                    <VStack gap={0}>
                      <Text type="body">{p.label}</Text>
                      {p.auxiliaryData?.email && (
                        <Text type="supporting" color="secondary">
                          {p.auxiliaryData.email}
                        </Text>
                      )}
                    </VStack>
                  </HStack>
                )}
                emptySearchText={t('Nobody found.')}
              />
            </div>
            <Button label={t('Add')} variant="secondary" icon={<Icon icon={UserPlusIcon} size="sm" />} isDisabled={!picked} onClick={add} />
          </HStack>
        }
      />
      {loading ? (
        <SettingsRow title={<Text color="secondary">{t('Loading')}</Text>} />
      ) : (
        shown.map(m => {
          const last = m.role === 'admin' && admins === 1;
          return (
            <SettingsRow
              key={m.userId}
              start={<Avatar name={m.name} size="sm" />}
              title={
                <HStack gap={2} vAlign="center">
                  <Text type="label">{m.name}</Text>
                  {m.userId === me && <Badge variant="neutral" label={t('You')} />}
                  {m.isNew && <Badge variant="info" label={t('New')} />}
                </HStack>
              }
              description={m.email ?? undefined}
              controlWidth="auto"
              control={
                <HStack gap={2} vAlign="center">
                  <Selector
                    label={t("{name}'s role", {name: m.name})}
                    isLabelHidden
                    width={140}
                    options={roleOptions}
                    value={m.role}
                    onChange={v => onRole(m, v as TenantRole)}
                    isDisabled={last}
                    disabledMessage={last ? t(LAST_ADMIN) : undefined}
                  />
                  <span className="sp-hover-acts">
                    <IconButton
                      label={t('Remove {name}', {name: m.name})}
                      tooltip={last ? t(LAST_ADMIN) : t('Remove from tenant')}
                      variant="ghost"
                      size="sm"
                      isDisabled={last}
                      icon={<Icon icon={XMarkIcon} size="sm" />}
                      onClick={() => onRemove(m)}
                    />
                  </span>
                </HStack>
              }
            />
          );
        })
      )}
    </SettingsCard>
  );
}

const compact = (n: number) => (n >= 1_000_000 && n % 100_000 === 0 ? `${n / 1_000_000}M` : n >= 1_000 && n % 1_000 === 0 && n < 1_000_000 ? `${n / 1_000}K` : n.toLocaleString('en-US'));

/** Models (W-TenantSettings-Models, -ModelsAdd): each change saves at once. */
function Models({models, onChanged, onDenied}: {models: TenantModelView[] | null; onChanged: () => void; onDenied: (e: unknown) => boolean}) {
  // The form: a new model, or the one being edited.
  const [form, setForm] = useState<{id?: string; name: string; endpoint: string; qpm: number | null; tpm: number | null} | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (key: string, call: () => Promise<{error?: string}>, after?: () => void) => {
    setBusy(key);
    setError(null);
    try {
      const r = await call();
      if (r.error) return setError(t(r.error));
      after?.();
      onChanged();
    } catch (e) {
      if (!onDenied(e)) setError(said(e));
    } finally {
      setBusy(null);
    }
  };
  const submit = () => {
    if (!form) return;
    const fields = {name: form.name, endpoint: form.endpoint, qpm: form.qpm ?? 0, tpm: form.tpm ?? 0};
    void run('form', () => (form.id ? updateModel({modelId: form.id, ...fields}) : addModel(fields)), () => setForm(null));
  };

  return (
    <VStack gap={5}>
      {form && (
        <SettingsCard title={form.id ? t('Edit model') : t('New model')}>
          <VStack gap={4} padding={4}>
            <TextInput label={t('Model name')} placeholder={t('For example: gpt-5.6-terra')} value={form.name} onChange={v => setForm({...form, name: v})} hasAutoFocus />
            <TextInput label={t('Endpoint')} placeholder={t('For example: llm-gateway/labeling')} value={form.endpoint} onChange={v => setForm({...form, endpoint: v})} />
            <HStack gap={3}>
              <NumberInput label={t('Requests per minute (QPM)')} value={form.qpm} onChange={v => setForm({...form, qpm: v})} min={1} isIntegerOnly width="100%" />
              <NumberInput label={t('Tokens per minute (TPM)')} value={form.tpm} onChange={v => setForm({...form, tpm: v})} min={1} isIntegerOnly width="100%" />
            </HStack>
            <HStack gap={2} hAlign="end">
              <Button label={t('Cancel')} variant="ghost" onClick={() => (setForm(null), setError(null))} />
              <Button label={form.id ? t('Save model') : t('Add')} variant="primary" isLoading={busy === 'form'} onClick={submit} />
            </HStack>
          </VStack>
        </SettingsCard>
      )}
      <SettingsCard
        title={t('Models')}
        action={!form ? <Button label={t('Add model')} variant="secondary" size="sm" icon={<Icon icon={PlusIcon} size="sm" />} onClick={() => (setError(null), setForm({name: '', endpoint: '', qpm: null, tpm: null}))} /> : undefined}
      >
        {!models ? (
          <SettingsRow title={<Text color="secondary">{t('Loading')}</Text>} />
        ) : models.length === 0 ? (
          <SettingsRow icon={CpuChipIcon} title={t('No models yet')} description={t('Projects need a model before they can run.')} />
        ) : (
          models.map(m => (
            <SettingsRow
              key={m.id}
              icon={CpuChipIcon}
              title={
                <HStack gap={2} vAlign="center">
                  <Text type="label">{m.name}</Text>
                  {m.default && <Badge variant="neutral" label={t('Default')} />}
                </HStack>
              }
              description={`${m.endpoint} · ${compact(m.qpm)} QPM · ${compact(m.tpm)} TPM`}
              controlWidth="auto"
              control={
                <HStack gap={3} vAlign="center">
                  <Text type="supporting" color="secondary">
                    {m.usedBy === 1 ? t('1 project') : t('{n} projects', {n: m.usedBy})}
                  </Text>
                  <HStack gap={1} vAlign="center" className="sp-hover-acts">
                    {!m.default && <Button label={t('Set as default')} variant="ghost" size="sm" isLoading={busy === `default:${m.id}`} onClick={() => void run(`default:${m.id}`, () => setDefaultModel({modelId: m.id}))} />}
                    <IconButton
                      label={t('Edit {name}', {name: m.name})}
                      tooltip={t('Edit')}
                      variant="ghost"
                      size="sm"
                      icon={<Icon icon={PencilSquareIcon} size="sm" />}
                      onClick={() => (setError(null), setForm({id: m.id, name: m.name, endpoint: m.endpoint, qpm: m.qpm, tpm: m.tpm}))}
                    />
                    <IconButton
                      label={t('Remove {name}', {name: m.name})}
                      tooltip={m.usedBy ? t('Used by a project: change its model first') : t('Remove')}
                      variant="ghost"
                      size="sm"
                      isDisabled={m.usedBy > 0}
                      isLoading={busy === `remove:${m.id}`}
                      icon={<Icon icon={TrashIcon} size="sm" />}
                      onClick={() => void run(`remove:${m.id}`, () => removeModel({modelId: m.id}))}
                    />
                  </HStack>
                </HStack>
              }
            />
          ))
        )}
      </SettingsCard>
      {error && <ErrorLine text={error} />}
    </VStack>
  );
}

/** Delete tenant (W-TenantSettings-Delete): the button asks for the tenant's name first. */
function DeleteTenant({tenant, onDenied, onDeleted}: {tenant: TenantDetail; onDenied: (e: unknown) => boolean; onDeleted: () => void}) {
  const [asking, setAsking] = useState(false);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await deleteTenant({name: typed});
      if (r.error) return setError(t(r.error));
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
          title={t('Delete {name}', {name: tenant.name})}
          description={t('Removes every project, data source, label set and score in this tenant. This cannot be undone.')}
          controlWidth="auto"
          control={<Button label={t('Delete tenant')} variant="destructive" onClick={() => (setTyped(''), setError(null), setAsking(true))} />}
        />
      </SettingsCard>
      {asking && (
        <FormDialog
          title={t('Delete {name}?', {name: tenant.name})}
          width={480}
          onClose={() => setAsking(false)}
          footer={
            <>
              <Button label={t('Cancel')} variant="ghost" onClick={() => setAsking(false)} />
              <Button label={t('Delete tenant')} variant="destructive" isDisabled={typed.trim() !== tenant.name} isLoading={busy} onClick={() => void remove()} />
            </>
          }
        >
          <VStack gap={5}>
            <Text type="body" color="secondary">
              {t('Everyone in it loses access to its projects, data sources and models. This cannot be undone.')}
            </Text>
            <TextInput label={t('Type the tenant name to confirm')} value={typed} onChange={setTyped} hasAutoFocus />
            {error && <ErrorLine text={error} />}
          </VStack>
        </FormDialog>
      )}
    </>
  );
}
