import type {NewVersion, PromptVersion} from '@tsp/contracts';
import {checkTemplate, MADE_BY, versionLabel} from '@tsp/domain';
import {emitChange, getApp, tm} from './app.ts';
import {postEvent} from './chat-events.ts';

export {MADE_BY};
export type {NewVersion};

/** Saves a new version. Versions are never overwritten, a template with check errors is refused, and the catalog picks the number. */
export async function createVersion(projectId: string, v: NewVersion): Promise<PromptVersion> {
  const {catalog, user} = getApp();
  const check = checkTemplate(v.template, v.features, {schema: v.schema, images: v.images});
  if (check.errors.length) throw new Error(`Fix ${check.errors.length} error${check.errors.length > 1 ? 's' : ''} in Checks first.`);
  // A save right after a helper's draft went into the editor closes that story in Ask AI.
  const [newest] = await catalog.find('prompt_versions', {projectId}, 'createdAt desc');
  const [draft] = await catalog.find('agent_proposals', {projectId, kind: 'prompt'}, 'createdAt desc');
  const fromDraft = v.madeBy === 'user' && draft?.state === 'approved' && (!newest || draft.createdAt > newest.createdAt);
  const version = await catalog.createPromptVersion({
    projectId,
    template: v.template,
    features: v.features,
    images: v.images,
    parentId: v.parent?.id ?? null,
    madeBy: v.madeBy,
    change: v.change,
    schemaVersion: v.schemaVersion,
    kind: v.kind,
  });
  await catalog.audit(projectId, v.madeBy === 'user' ? (await user()).name : v.madeBy, 'prompt.create', {version: versionLabel(version)});
  if (fromDraft) await postEvent(projectId, 'approved', 'user', `saved it as ${versionLabel(version)}`, {path: '/prompt/edit', params: {v: version.id}});
  const before = new Set((v.parent?.template ?? '').split('\n'));
  const after = new Set(v.template.split('\n'));
  tm().event('version_created', {
    made_by: v.madeBy,
    kind: v.kind,
    from_version_id: v.parent?.id ?? null,
    warnings: check.warnings.length,
    lines_added: [...after].filter(l => !before.has(l)).length,
    lines_removed: v.parent ? [...before].filter(l => !after.has(l)).length : 0,
  });
  emitChange();
  return version;
}
