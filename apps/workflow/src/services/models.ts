import type {AddModelRequest, ModelSaveResult, TenantModel, TenantModelView, UpdateModelRequest} from '@yushiguang/sprint-contracts';
import {newId} from '@yushiguang/sprint-domain';
import {now, type Scope} from './app.ts';
import {tenantOf, withLock} from './sources.ts';

/**
 * Tenant models (docs/design/server.md, 9): the labeling models a tenant admin enters by hand.
 * Projects store a model's generated id; the gateway reads the models per tenant from the catalog
 * (`tenant_models`) and is told to read again after every change here. Every change holds the
 * tenant's models lock, as do the settings writes that pick a model, so a model is never removed
 * while a project is being pointed at it.
 */

const BUSY = 'The models are being changed. Try again in a minute.';
export const withModelsLock = <T>(w: Scope, fn: () => Promise<T>) => withLock(w, `models:${tenantOf(w)}`, fn, BUSY);

const byDefault = (a: TenantModel, b: TenantModel) => Number(b.default) - Number(a.default) || a.createdAt.localeCompare(b.createdAt);

/** How many of the tenant's projects use each model, by its id (their current settings). */
async function usage(w: Scope): Promise<Map<string, number>> {
  const projects = (await w.catalog.find('projects', {tenantId: tenantOf(w)})).filter(p => !p.deleting && p.setupVersionId);
  const setups = await w.catalog.findByIds('setup_versions', projects.map(p => p.setupVersionId!));
  const out = new Map<string, number>();
  for (const s of setups) for (const id of new Set(s.models.map(m => m.endpoint))) out.set(id, (out.get(id) ?? 0) + 1);
  return out;
}

const tenantModels = async (w: Scope) => (await w.catalog.find('tenant_models', {tenantId: tenantOf(w)})).sort(byDefault);

async function view(w: Scope, m: TenantModel): Promise<TenantModelView> {
  return {...m, usedBy: (await usage(w)).get(m.id) ?? 0};
}

/** The tenant's default model, or null when it has none (new projects then use the platform's first default). */
export async function defaultModel(w: Scope): Promise<TenantModel | null> {
  return (await tenantModels(w)).find(m => m.default) ?? null;
}

export async function listModels(w: Scope): Promise<TenantModelView[]> {
  const [list, used] = await Promise.all([tenantModels(w), usage(w)]);
  return list.map(m => ({...m, usedBy: used.get(m.id) ?? 0}));
}

/** The fields checked and cleaned, or what is wrong with them. */
function clean(f: {name: string; endpoint: string; qpm: number; tpm: number}): {error: string} | {name: string; endpoint: string; qpm: number; tpm: number} {
  const name = String(f.name ?? '').trim();
  const endpoint = String(f.endpoint ?? '').trim();
  if (!name) return {error: 'Give the model a name.'};
  if (!endpoint) return {error: 'Give the model its Endpoint.'};
  const whole = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && n > 0;
  if (!whole(f.qpm)) return {error: 'QPM must be a whole number above 0.'};
  if (!whole(f.tpm)) return {error: 'TPM must be a whole number above 0.'};
  return {name, endpoint, qpm: f.qpm, tpm: f.tpm};
}

const nameTaken = (list: TenantModel[], name: string, except?: string) => list.some(m => m.id !== except && m.name.toLowerCase() === name.toLowerCase());

/** After a change: the gateway in this process reads the tenant's models again, and pages refresh. */
async function changed(w: Scope, action: string, m: TenantModel, by: string) {
  w.gateway.forgetTenant(m.tenantId);
  w.emitChange(null);
  await w.catalog.audit(null, by, `model.${action}`, {modelId: m.id});
}

export async function addModel(w: Scope, req: AddModelRequest): Promise<ModelSaveResult> {
  const f = clean(req);
  if ('error' in f) return f;
  const user = await w.user();
  return withModelsLock(w, async () => {
    const list = await tenantModels(w);
    if (nameTaken(list, f.name)) return {error: 'A model with this name already exists.'};
    const at = now();
    const m: TenantModel = {id: newId('model'), tenantId: tenantOf(w), ...f, default: !list.some(x => x.default), createdAt: at, createdBy: user.name, updatedAt: at};
    await w.catalog.insert('tenant_models', m);
    await changed(w, 'add', m, user.name);
    return {model: {...m, usedBy: 0}};
  });
}

/** The tenant's own model, or null (missing and other tenants' models answer alike). */
async function own(w: Scope, modelId: string): Promise<TenantModel | null> {
  const m = await w.catalog.get('tenant_models', modelId);
  return m && m.tenantId === tenantOf(w) ? m : null;
}

export async function updateModel(w: Scope, req: UpdateModelRequest): Promise<ModelSaveResult> {
  const user = await w.user();
  return withModelsLock(w, async () => {
    const m = await own(w, req.modelId);
    if (!m) return {error: 'This model does not exist.'};
    const f = clean({name: req.name ?? m.name, endpoint: req.endpoint ?? m.endpoint, qpm: req.qpm ?? m.qpm, tpm: req.tpm ?? m.tpm});
    if ('error' in f) return f;
    if (nameTaken(await tenantModels(w), f.name, m.id)) return {error: 'A model with this name already exists.'};
    const next: TenantModel = {...m, ...f, updatedAt: now()};
    await w.catalog.patch('tenant_models', m.id, {...f, updatedAt: next.updatedAt});
    await changed(w, 'update', next, user.name);
    return {model: await view(w, next)};
  });
}

export async function removeModel(w: Scope, modelId: string): Promise<{error?: string}> {
  const user = await w.user();
  return withModelsLock(w, async () => {
    const m = await own(w, modelId);
    if (!m) return {error: 'This model does not exist.'};
    const used = (await usage(w)).get(m.id) ?? 0;
    if (used) return {error: used === 1 ? 'A project uses this model. Choose another model in its settings first.' : 'Projects use this model. Choose another model in their settings first.'};
    await w.catalog.remove('tenant_models', m.id);
    await changed(w, 'remove', m, user.name);
    return {};
  });
}

export async function setDefaultModel(w: Scope, modelId: string): Promise<ModelSaveResult> {
  const user = await w.user();
  return withModelsLock(w, async () => {
    const m = await own(w, modelId);
    if (!m) return {error: 'This model does not exist.'};
    const at = now();
    for (const x of await tenantModels(w)) if (x.default && x.id !== m.id) await w.catalog.patch('tenant_models', x.id, {default: false, updatedAt: at});
    if (!m.default) await w.catalog.patch('tenant_models', m.id, {default: true, updatedAt: at});
    const next = {...m, default: true, updatedAt: at};
    await changed(w, 'default', next, user.name);
    return {model: await view(w, next)};
  });
}
