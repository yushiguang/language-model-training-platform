import type {NewVersion} from '../../../../packages/contracts/src/bff-api';
import {checkTemplate} from '../../../../packages/contracts/src/template';
import type {PromptVersion} from '../../../../packages/contracts/src/types';
import {nextVersion, versionLabel} from '../../../../packages/contracts/src/versions';
import {MADE_BY} from '../../../../packages/contracts/src/workflow';
import {newId} from '../data/repo';
import {emitChange, getApp, now} from './app';

export {MADE_BY};
export type {NewVersion};

/** Saves a new version. Versions are never overwritten, and a template with check errors is refused. */
export async function createVersion(projectId: string, all: PromptVersion[], v: NewVersion): Promise<PromptVersion> {
  const {repo, user} = getApp();
  const check = checkTemplate(v.template, v.features, {schema: v.schema});
  if (check.errors.length) throw new Error(`Fix ${check.errors.length} error${check.errors.length > 1 ? 's' : ''} in Checks first.`);
  const n = nextVersion(all, v.parent, v.kind);
  const version: PromptVersion = {
    id: newId('pv'),
    projectId,
    major: n.major,
    minor: n.minor,
    template: v.template,
    features: v.features,
    images: v.images,
    parentId: v.parent?.id ?? null,
    madeBy: v.madeBy,
    change: v.change,
    schemaVersion: v.schemaVersion,
    createdAt: now(),
  };
  await repo.insert('prompt_versions', version);
  await repo.audit(projectId, v.madeBy === 'user' ? (await user()).name : v.madeBy, 'prompt.create', {version: versionLabel(version)});
  emitChange();
  return version;
}
