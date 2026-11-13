import assert from 'node:assert/strict';
import test from 'node:test';
import type {AgentRuntimeContract, EndpointInfo, ExampleSource, FileStore, LabelCallResult, LlmGatewayContract} from '@tsp/contracts';
import {createCatalog} from '@tsp/catalog';
import {createLabeling, memoryLocks} from '@tsp/labeling';
import {localDocRuntime} from '@tsp/platform';
import {createBffApi} from './api.ts';
import {configureBff} from './services/app.ts';

const endpoint: EndpointInfo = {id: 'A', name: 'Model A', description: '', badge: '', cost: 'Lower', speed: 'Faster', supportsTemperature: true, priceIn: 0, priceOut: 200};
const structured = (rules = '') => ({taskSummary: 'Label this', features: {video: ['Description'], photo_text: [], metadata: []}, fields: [{name: 'format', kind: 'single' as const, values: [{name: 'Vlog', definition: ''}, {name: 'Tutorial', definition: ''}]}], generalRules: rules, images: []});

/** A bff with one project: a schema, 4 eval examples with gold labels, and a fake model. */
async function world(prefix: string) {
  const db = localDocRuntime(prefix);
  const catalog = createCatalog(db);
  const gateway = {
    endpoints: () => [endpoint],
    labelingEndpoints: () => [endpoint],
    agentModel: () => ({}),
    label: async (): Promise<LabelCallResult> => ({text: '{"format": "Vlog"}', inputTokens: 0, outputTokens: 150, costUsd: 0.03, endpointId: 'labeling-A', attempts: 1}),
  } as unknown as LlmGatewayContract;
  const labeling = createLabeling({db, catalog, gateway, locks: memoryLocks()});
  configureBff({catalog, labeling, gateway, agents: {} as AgentRuntimeContract, identity: {currentUser: async () => ({id: 'u_1', name: 'Tester'})}, files: {} as FileStore, examples: {} as ExampleSource, standIns: []});
  const projectId = `pr_${prefix}`;
  await catalog.insert('setup_versions', {id: `sv_${prefix}`, projectId, number: 1, schemaVersion: 1, task: '', schema: {fields: [{name: 'format', kind: 'single', values: [{name: 'Vlog', definition: ''}, {name: 'Tutorial', definition: ''}]}]}, thresholds: null, models: [{endpoint: 'A', maxOutputTokens: 150, temperature: null}], steps: {schema: true, evaluation: true, models: true}, createdAt: '', createdBy: ''});
  await catalog.insert('dataset_snapshots', {id: `ds_${prefix}`, projectId, number: 1, source: 'sample', sourceName: 'test', createdAt: '', counts: {rows: 4, valid: 4, invalid: 0, video: 4, photoText: 0}, split: {eval: 4, test: 0, train: 0}});
  await catalog.insertMany('examples', Array.from({length: 4}, (_, i) => ({id: `ex_${prefix}_${i}`, snapshotId: `ds_${prefix}`, externalId: String(i), type: 'video' as const, title: '', features: {}, split: 'eval' as const, optimiserHalf: i % 2 === 0})));
  for (let i = 0; i < 4; i++) await catalog.insert('gold_labels', {id: `gl_${prefix}_${i}`, projectId, exampleId: `ex_${prefix}_${i}`, schemaVersion: 1, answer: {format: ['Vlog']}, source: 'labeled', revealed: false, createdAt: '', createdBy: 'Tester'});
  await catalog.insert('projects', {id: projectId, name: 'p', createdAt: '', createdBy: '', kind: 'prompt_tuning', settingsConfirmed: true, setupVersionId: `sv_${prefix}`, snapshotId: `ds_${prefix}`, approvedNodes: []});
  return {api: createBffApi(), catalog, projectId};
}

async function until(cond: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 400; i++) {
    if (await cond()) return;
    await new Promise(r => setTimeout(r, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

test('contract: a version is created and scored from ids alone, and the same key never creates it twice', async () => {
  const {api, catalog, projectId} = await world('api1');
  const req = {projectId, structured: structured(), parentId: null, madeBy: 'user' as const, change: 'First prompt', kind: 'major' as const, idempotencyKey: 'k1'};
  const [a, b] = await Promise.all([api.createVersion(req), api.createVersion(req)]);
  assert.equal(a.id, b.id);
  assert.equal((await catalog.find('prompt_versions', {projectId})).length, 1);
  const again = await api.createVersion({...req, idempotencyKey: 'k2', parentId: a.id, structured: structured('Prefer Vlog.'), kind: 'minor'});
  assert.equal(again.parentId, a.id);

  await api.scoreVersion({projectId, promptVersionId: a.id});
  await until(async () => ((await api.loadProjectState(projectId))?.reports.length ?? 0) > 0, 'the score');
  const preds = await api.predictionsFor(a.id, 'A', {endpoint: 'A', maxOutputTokens: 150, temperature: null});
  assert.equal(Object.keys(preds).length, 4);
});

test('contract: ids of another project are refused', async () => {
  const one = await world('api2');
  const two = await world('api3');
  // The second world's bff is the configured one; the first project's records are in another store.
  await assert.rejects(two.api.scoreVersion({projectId: two.projectId, promptVersionId: 'pv_missing'}), /does not exist/);
  await assert.rejects(two.api.closeProposal({projectId: two.projectId, proposalId: 'ap_missing', decision: 'approved'}), /does not exist/);
  await assert.rejects(two.api.tick({projectId: one.projectId}).then(() => two.api.createVersion({projectId: one.projectId, structured: structured(), parentId: null, madeBy: 'user', change: '', kind: 'major'})), /does not exist/);
});

test('contract: every response is plain JSON (it survives a round trip unchanged)', async () => {
  const {api, projectId} = await world('api4');
  const v = await api.createVersion({projectId, structured: structured(), parentId: null, madeBy: 'user', change: 'First prompt', kind: 'major'});
  await api.scoreVersion({projectId, promptVersionId: v.id});
  await until(async () => ((await api.loadProjectState(projectId))?.reports.length ?? 0) > 0, 'the score');
  const responses: Record<string, unknown> = {
    getRuntimeInfo: await api.getRuntimeInfo(),
    listProjects: await api.listProjects(),
    loadProjectState: await api.loadProjectState(projectId),
    predictionsFor: await api.predictionsFor(v.id, 'A', {endpoint: 'A', maxOutputTokens: 150, temperature: null}),
    mismatches: await api.mismatches(projectId),
    chatHistory: await api.chatHistory(projectId),
    proposals: await api.proposals(projectId),
    getAgentLive: await api.getAgentLive(projectId),
  };
  for (const [name, dto] of Object.entries(responses)) assert.deepEqual(JSON.parse(JSON.stringify(dto)), dto, name);
  const state = (await api.loadProjectState(projectId))!;
  assert.equal(Object.keys(state.gold).length, 4);
});
