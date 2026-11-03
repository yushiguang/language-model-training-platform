import type {SetupVersion} from '../core/types';
import {newId} from '../data/repo';
import {emitChange, getApp, now} from './app';
import {getProject, updateProject} from './projects';

type Patch = Partial<Pick<SetupVersion, 'task' | 'schema' | 'thresholds' | 'models' | 'steps'>>;

/** Any change makes a new Setup version. A schema change also bumps the schema version, which archives reports and re-opens gold labels. */
export async function saveSetup(projectId: string, patch: Patch): Promise<SetupVersion> {
  const {repo, user} = getApp();
  const project = (await getProject(projectId))!;
  const prev = project.setupVersionId ? await repo.get<SetupVersion>('setup_versions', project.setupVersionId) : null;
  const schemaChanged = patch.schema !== undefined && JSON.stringify(patch.schema) !== JSON.stringify(prev?.schema ?? null);
  const u = await user();
  const next: SetupVersion = {
    id: newId('sv'),
    projectId,
    number: (prev?.number ?? 0) + 1,
    schemaVersion: (prev?.schemaVersion ?? 0) + (schemaChanged ? 1 : 0),
    task: patch.task ?? prev?.task ?? '',
    schema: patch.schema ?? prev?.schema ?? null,
    thresholds: patch.thresholds !== undefined ? patch.thresholds : (prev?.thresholds ?? null),
    models: patch.models ?? prev?.models ?? [],
    steps: {...(prev?.steps ?? {schema: false, evaluation: false, models: false}), ...patch.steps},
    createdAt: now(),
    createdBy: u.name,
  };
  await repo.insert('setup_versions', next);
  await updateProject({...project, setupVersionId: next.id});
  await repo.audit(projectId, u.name, 'setup.save', {number: next.number, schemaChanged});
  emitChange();
  return next;
}
