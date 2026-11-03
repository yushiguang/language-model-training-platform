import {checkTemplate} from '../core/template';
import {nextVersion, versionLabel} from '../core/versions';
import type {Actor, FeatureSelection, PromptImage, PromptVersion, Schema} from '../core/types';
import {newId} from '../data/repo';
import {emitChange, getApp, now} from './app';

export interface NewVersion {
  template: string;
  features: FeatureSelection;
  images: PromptImage[];
  parent: PromptVersion | null;
  madeBy: Actor;
  change: string;
  kind: 'minor' | 'major';
  schema: Schema;
  schemaVersion: number;
}

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

export const MADE_BY: Record<Actor, string> = {user: 'You', prompt_agent: 'Prompt agent', optimiser: 'Optimiser', schema_agent: 'Schema agent', system: 'System'};
