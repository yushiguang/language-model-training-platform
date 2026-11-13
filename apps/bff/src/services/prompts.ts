import type {ChatMessage, FeatureInfo, NewVersion, PromptVersion} from '@tsp/contracts';
import {checkStructured, compilePrompt, MADE_BY, newId, schemaOf, signatureOf, sameSignature, tidyStructured, versionLabel} from '@tsp/domain';
import {emitChange, getApp, now, tm} from './app.ts';
import {postEvent} from './chat-events.ts';
import {syncLabels} from './settings.ts';

export {MADE_BY};
export type {NewVersion};

/**
 * Saves a structured prompt as a new version (spec 1.0.0, section 3). Versions are never
 * overwritten and the catalog picks the number. The text the model reads is compiled here, the
 * same way every time, so a placeholder can never be unticked, unused or broken. A change to the
 * label signature bumps the schema version; a change of wording does not. The Optimiser may
 * change wording only.
 */
export async function createVersion(projectId: string, v: NewVersion): Promise<PromptVersion> {
  const {catalog, user} = getApp();
  const structured = tidyStructured(v.structured);
  const issues = checkStructured(structured);
  if (issues.length) throw new Error(issues[0].message);
  if (v.madeBy === 'optimiser' && v.parent && !sameSignature(signatureOf(structured), signatureOf(v.parent.structured))) throw new Error('The Optimiser may not change the label fields or values.');
  // The labels on record follow what people write; an Optimiser candidate may be dropped, so its wording does not.
  const setup = await syncLabels(projectId, schemaOf(structured), {wording: v.madeBy !== 'optimiser'});
  const existing = await catalog.find('prompt_versions', {projectId}, 'createdAt desc');
  const [draft] = await catalog.find('agent_proposals', {projectId, kind: 'prompt'}, 'createdAt desc');
  // A save right after a helper's draft went into the editor closes that story in Ask AI.
  const fromDraft = !!v.parent && v.madeBy !== 'optimiser' && draft?.state === 'approved' && (!existing[0] || draft.createdAt > existing[0].createdAt);
  const template = compilePrompt(structured);
  const version = await catalog.createPromptVersion({
    projectId,
    structured,
    template,
    features: structured.features,
    images: structured.images,
    parentId: v.parent?.id ?? null,
    madeBy: v.madeBy,
    change: v.change,
    schemaVersion: setup.schemaVersion,
    kind: v.kind,
    ...(v.inMajor != null ? {inMajor: v.inMajor} : {}),
  });
  await catalog.audit(projectId, v.madeBy === 'optimiser' ? v.madeBy : (await user()).name, 'prompt.create', {version: versionLabel(version)});
  if (fromDraft) await postEvent(projectId, 'approved', 'user', `saved it as ${versionLabel(version)}`, {path: '/prompt/edit', params: {v: version.id}});
  if (!existing.length) {
    // The first version, approved on Prompt Design: the helper says what comes next (spec 6.2).
    await postEvent(projectId, 'approved', 'user', `approved the prompt as ${versionLabel(version)}`, {path: '/prompt-design'});
    const msg: ChatMessage = {id: newId('cm'), projectId, createdAt: now(), role: 'agent', agent: 'prompt_agent', text: `${versionLabel(version)} is saved. Next, click "Next: Eval Dataset" at the top right to add the examples it will be scored on.`, page: 'Prompt Design'};
    await catalog.insert('chat_messages', msg);
  }
  const before = new Set((v.parent?.template ?? '').split('\n'));
  const after = new Set(template.split('\n'));
  tm().event('version_created', {
    made_by: v.madeBy,
    kind: v.kind,
    from_version_id: v.parent?.id ?? null,
    warnings: 0,
    lines_added: [...after].filter(l => !before.has(l)).length,
    lines_removed: v.parent ? [...before].filter(l => !after.has(l)).length : 0,
  });
  emitChange();
  return version;
}

/** Feature descriptions by key, for hover text in the editor (empty without a source). */
export async function featureInfo(keys: string[]): Promise<Record<string, FeatureInfo>> {
  return (await getApp().featureInfo?.describe(keys)) ?? {};
}
