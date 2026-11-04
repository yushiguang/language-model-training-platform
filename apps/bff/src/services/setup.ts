import type {SetupPatch, SetupVersion} from '@tsp/contracts';
import {emitChange, getApp, tm} from './app.ts';
import {getProject} from './projects.ts';

export type {SetupPatch};

/** Any change makes a new Setup version. A schema change also bumps the schema version, which archives reports and re-opens gold labels. */
export async function saveSetup(projectId: string, patch: SetupPatch): Promise<SetupVersion> {
  const {catalog, user} = getApp();
  const project = await getProject(projectId);
  if (!project) throw new Error('Project not found');
  const prev = project.setupVersionId ? await catalog.get('setup_versions', project.setupVersionId) : null;
  const schemaChanged = patch.schema !== undefined && JSON.stringify(patch.schema) !== JSON.stringify(prev?.schema ?? null);
  const u = await user();
  const next = await catalog.createSetupVersion({
    projectId,
    schemaVersion: (prev?.schemaVersion ?? 0) + (schemaChanged ? 1 : 0),
    task: patch.task ?? prev?.task ?? '',
    schema: patch.schema ?? prev?.schema ?? null,
    thresholds: patch.thresholds !== undefined ? patch.thresholds : (prev?.thresholds ?? null),
    models: patch.models ?? prev?.models ?? [],
    steps: {...(prev?.steps ?? {schema: false, evaluation: false, models: false}), ...patch.steps},
    autoStart: patch.autoStart ?? prev?.autoStart ?? true,
    createdBy: u.name,
  });
  const t = tm();
  if (schemaChanged && next.schema) t.event('schema_approved', {fields: next.schema.fields.length, values: next.schema.fields.reduce((n, f) => n + f.values.length, 0), schema_version: next.schemaVersion, revisions_before: 0, edited_before_approve: false});
  if (patch.thresholds !== undefined) t.event('thresholds_saved', {mode: patch.thresholds === null ? 'none' : 'custom', changed: ''});
  if (patch.models) t.event('models_saved', {slots: patch.models.length > 1 ? 'both' : 'A', temperature_changed: patch.models.some(m => m.temperature !== 0)});
  if (patch.autoStart !== undefined && patch.autoStart !== (prev?.autoStart ?? true)) {
    t.event('auto_start_switched', {on: patch.autoStart});
    await catalog.audit(projectId, u.name, 'setup.auto_start', {on: patch.autoStart});
  }
  await catalog.patch('projects', projectId, {setupVersionId: next.id});
  await catalog.audit(projectId, u.name, 'setup.save', {number: next.number, schemaChanged});
  emitChange();
  return next;
}
