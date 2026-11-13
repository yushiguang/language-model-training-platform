import type {ModelSettings, ProjectSettings, Schema, SetupVersion, Thresholds} from '@tsp/contracts';
import {DEFAULT_THRESHOLDS, sameSignature, signatureOf} from '@tsp/domain';
import {emitChange, getApp, tm} from './app.ts';
import {getProject} from './projects.ts';

/**
 * Project Settings and the label signature (spec 1.0.0, 2.3 and 3.1). Both are kept as immutable
 * setup versions: one record holds the labels answers are checked against, the pass rule and the
 * labeling model. `schemaVersion` bumps only when the label signature changes (field or value
 * names, kind, bounds); a new definition, pass rule or model never touches gold labels.
 */

/** A new project's settings: the first active endpoint and the default pass rule. */
export function defaultSettings(): ProjectSettings {
  const ep = getApp().gateway.labelingEndpoints()[0];
  if (!ep) throw new Error('No labeling model is available.');
  return {thresholds: DEFAULT_THRESHOLDS, model: {endpoint: ep.id, maxOutputTokens: 1024, temperature: ep.supportsTemperature ? 0 : null}};
}

async function currentSetup(projectId: string): Promise<{prev: SetupVersion | null; settingsConfirmed: boolean}> {
  const project = await getProject(projectId);
  if (!project) throw new Error('Project not found');
  return {prev: project.setupVersionId ? await getApp().catalog.get('setup_versions', project.setupVersionId) : null, settingsConfirmed: !!project.settingsConfirmed};
}

async function writeSetup(projectId: string, prev: SetupVersion | null, next: {schema: Schema | null; schemaVersion: number; thresholds: Thresholds; models: ModelSettings[]}): Promise<SetupVersion> {
  const {catalog, user} = getApp();
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
export async function initSettings(projectId: string): Promise<SetupVersion> {
  const d = defaultSettings();
  return writeSetup(projectId, null, {schema: null, schemaVersion: 0, thresholds: d.thresholds, models: [d.model]});
}

/** Saves Project Settings. Saving is also the confirmation asked for before the first paid run. */
export async function saveSettings(projectId: string, s: ProjectSettings): Promise<void> {
  const {catalog, user, gateway} = getApp();
  const {prev, settingsConfirmed} = await currentSetup(projectId);
  const ep = gateway.labelingEndpoints().find(e => e.id === s.model.endpoint);
  if (!ep) throw new Error('This model is not available.');
  const clamp = (x: number | null | undefined) => (x == null ? null : Math.min(1, Math.max(0, x)));
  const thresholds: Thresholds =
    s.thresholds.mode === 'default'
      ? DEFAULT_THRESHOLDS
      : {...DEFAULT_THRESHOLDS, mode: 'custom', macroF1: clamp(s.thresholds.macroF1) ?? DEFAULT_THRESHOLDS.macroF1, valueF1: clamp(s.thresholds.valueF1), precision: clamp(s.thresholds.precision), recall: clamp(s.thresholds.recall)};
  const model: ModelSettings = {endpoint: ep.id, maxOutputTokens: Math.max(1, Math.round(s.model.maxOutputTokens) || 1024), temperature: ep.supportsTemperature ? (s.model.temperature ?? 0) : null};
  await writeSetup(projectId, prev, {schema: prev?.schema ?? null, schemaVersion: prev?.schemaVersion ?? 0, thresholds, models: [model]});
  await catalog.patch('projects', projectId, {settingsConfirmed: true});
  await catalog.audit(projectId, (await user()).name, 'settings.save', {mode: thresholds.mode, endpoint: model.endpoint});
  tm().event('settings_saved', {mode: thresholds.mode, first_confirm: !settingsConfirmed});
  tm().event('thresholds_saved', {mode: thresholds.mode, changed: ''});
  emitChange();
}

/**
 * Called when a version is saved: keeps the labels (with their newest wording) on the setup
 * version, and bumps `schemaVersion` when the label signature changed. Returns the setup version
 * the new prompt version belongs to.
 */
export async function syncLabels(projectId: string, labels: Schema, opts: {wording: boolean}): Promise<SetupVersion> {
  const {catalog} = getApp();
  const {prev} = await currentSetup(projectId);
  const d = prev ? null : defaultSettings();
  const before = prev?.schema ?? null;
  const changed = !before || !sameSignature(signatureOf(before), signatureOf(labels));
  if (prev && !changed && (!opts.wording || JSON.stringify(before) === JSON.stringify(labels))) return prev;
  const schemaVersion = (prev?.schemaVersion ?? 0) + (changed ? 1 : 0);
  const stale = changed && before ? (await catalog.find('gold_labels', {projectId})).filter(g => g.schemaVersion === prev!.schemaVersion).length : 0;
  const next = await writeSetup(projectId, prev, {schema: labels, schemaVersion, thresholds: prev?.thresholds ?? d!.thresholds, models: prev?.models.length ? prev.models : [d!.model]});
  if (changed) tm().event('signature_changed', {fields: labels.fields.length, values: labels.fields.reduce((n, f) => n + f.values.length, 0), schema_version: schemaVersion, gold_labels_needing_recheck: stale});
  return next;
}
