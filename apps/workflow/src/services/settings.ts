import type {ModelSettings, ProjectSettings, Schema, SetupVersion, Thresholds} from '@yushiguang/sprint-contracts';
import {DEFAULT_THRESHOLDS, sameSignature, signatureOf} from '@yushiguang/sprint-domain';
import type {Scope} from './app.ts';
import {getProject} from './projects.ts';
import {defaultModel, withModelsLock} from './models.ts';
import {tenantOf} from './sources.ts';

/**
 * Project Settings and the label signature (spec 1.0.0, 2.3 and 3.1). Both are kept as immutable
 * setup versions: one record holds the labels answers are checked against, the pass rule and the
 * labeling model. `schemaVersion` bumps only when the label signature changes (field or value
 * names, kind, bounds); a new definition, pass rule or model never touches gold labels.
 */

/**
 * A new project's settings: the tenant's default model (docs/design/server.md, 9), else the
 * platform's first default model, and the default pass rule.
 */
export async function defaultSettings(w: Scope): Promise<ProjectSettings> {
  const own = await defaultModel(w);
  if (own) return {thresholds: DEFAULT_THRESHOLDS, model: {endpoint: own.id, maxOutputTokens: 1024, temperature: null}};
  const ep = w.gateway.labelingEndpoints()[0];
  if (!ep) throw new Error('No labeling model is available.');
  return {thresholds: DEFAULT_THRESHOLDS, model: {endpoint: ep.id, maxOutputTokens: 1024, temperature: ep.supportsTemperature ? 0 : null}};
}

async function currentSetup(w: Scope, projectId: string): Promise<{prev: SetupVersion | null; settingsConfirmed: boolean}> {
  const project = await getProject(w, projectId);
  if (!project) throw new Error('Project not found');
  return {prev: project.setupVersionId ? await w.catalog.get('setup_versions', project.setupVersionId) : null, settingsConfirmed: !!project.settingsConfirmed};
}

async function writeSetup(w: Scope, projectId: string, prev: SetupVersion | null, next: {schema: Schema | null; schemaVersion: number; thresholds: Thresholds; models: ModelSettings[]}): Promise<SetupVersion> {
  const {catalog, user} = w;
  const setup = await catalog.createSetupVersion({
    projectId,
    schemaVersion: next.schemaVersion,
    task: prev?.task ?? '',
    schema: next.schema,
    thresholds: next.thresholds,
    models: next.models,
    steps: {schema: !!next.schema, evaluation: true, models: true},
    createdBy: (await user()).name,
  });
  await catalog.patch('projects', projectId, {setupVersionId: setup.id});
  return setup;
}

/** The first setup version of a new project: default settings, no labels yet. */
export async function initSettings(w: Scope, projectId: string): Promise<SetupVersion> {
  // Under the tenant's models lock: the default model is not removed while the project takes it.
  return withModelsLock(w, async () => {
    const d = await defaultSettings(w);
    return writeSetup(w, projectId, null, {schema: null, schemaVersion: 0, thresholds: d.thresholds, models: [d.model]});
  });
}

/** Saves Project Settings. Saving is also the confirmation asked for before the first paid run. */
export async function saveSettings(w: Scope, projectId: string, s: ProjectSettings): Promise<void> {
  const {catalog, user, gateway} = w;
  const clamp = (x: number | null | undefined) => (x == null ? null : Math.min(1, Math.max(0, x)));
  const thresholds: Thresholds =
    s.thresholds.mode === 'default'
      ? DEFAULT_THRESHOLDS
      : {...DEFAULT_THRESHOLDS, mode: 'custom', macroF1: clamp(s.thresholds.macroF1) ?? DEFAULT_THRESHOLDS.macroF1, valueF1: clamp(s.thresholds.valueF1), precision: clamp(s.thresholds.precision), recall: clamp(s.thresholds.recall)};
  // One of the tenant's own models (read now, not from a cache) or a platform default. The check
  // and the write hold the tenant's models lock, so the model chosen is not removed in between;
  // the current setup is read under it too, so a label change saved meanwhile is kept.
  const {model, settingsConfirmed} = await withModelsLock(w, async () => {
    const {prev, settingsConfirmed} = await currentSetup(w, projectId);
    const own = await catalog.get('tenant_models', s.model.endpoint);
    const ep = own && own.tenantId === tenantOf(w) ? {id: own.id, supportsTemperature: false} : gateway.labelingEndpoints().find(e => e.id === s.model.endpoint);
    if (!ep) throw new Error('This model is not available.');
    const m: ModelSettings = {endpoint: ep.id, maxOutputTokens: Math.max(1, Math.round(s.model.maxOutputTokens) || 1024), temperature: ep.supportsTemperature ? (s.model.temperature ?? 0) : null};
    await writeSetup(w, projectId, prev, {schema: prev?.schema ?? null, schemaVersion: prev?.schemaVersion ?? 0, thresholds, models: [m]});
    return {model: m, settingsConfirmed};
  });
  await catalog.patch('projects', projectId, {settingsConfirmed: true});
  await catalog.audit(projectId, (await user()).name, 'settings.save', {mode: thresholds.mode, endpoint: model.endpoint});
  w.tm.event('settings_saved', {mode: thresholds.mode, first_confirm: !settingsConfirmed});
  w.tm.event('thresholds_saved', {mode: thresholds.mode, changed: ''});
  w.emitChange(projectId);
}

/**
 * Called when a version is saved: keeps the labels (with their newest wording) on the setup
 * version, and bumps `schemaVersion` when the label signature changed. Returns the setup version
 * the new prompt version belongs to.
 */
export async function syncLabels(w: Scope, projectId: string, labels: Schema, opts: {wording: boolean}): Promise<SetupVersion> {
  // Under the tenant's models lock, like every setup write: the model the new setup version
  // carries over is never removed in between, and a settings save never writes over it.
  return withModelsLock(w, () => syncLabelsLocked(w, projectId, labels, opts));
}

async function syncLabelsLocked(w: Scope, projectId: string, labels: Schema, opts: {wording: boolean}): Promise<SetupVersion> {
  const {catalog} = w;
  const {prev} = await currentSetup(w, projectId);
  const d = prev ? null : await defaultSettings(w);
  const before = prev?.schema ?? null;
  const changed = !before || !sameSignature(signatureOf({label: before}), signatureOf({label: labels}));
  if (prev && !changed && (!opts.wording || JSON.stringify(before) === JSON.stringify(labels))) return prev;
  const schemaVersion = (prev?.schemaVersion ?? 0) + (changed ? 1 : 0);
  const stale = changed && before ? (await catalog.find('gold_labels', {projectId})).filter(g => g.schemaVersion === prev!.schemaVersion).length : 0;
  const next = await writeSetup(w, projectId, prev, {schema: labels, schemaVersion, thresholds: prev?.thresholds ?? d!.thresholds, models: prev?.models.length ? prev.models : [d!.model]});
  if (changed) w.tm.event('signature_changed', {fields: 1, values: labels.values.length, schema_version: schemaVersion, gold_labels_needing_recheck: stale});
  return next;
}
