import assert from 'node:assert/strict';
import test from 'node:test';
import type {AgentRuntimeContract, EndpointInfo, ExampleSource, FileStore, Identity, LabelCallResult, LlmGatewayContract, RequestContext, WorkflowContract} from '@yushiguang/sprint-contracts';
import {createCatalog} from '@yushiguang/sprint-catalog';
import {createLabeling, labelingExecutor, memoryLocks} from '@yushiguang/sprint-labeling';
import {createJobs} from '@yushiguang/sprint-jobs';
import {localDocRuntime, loopback, memoryJobStore, memorySharedState} from '@yushiguang/sprint-platform';
import {createWorkflow} from '@yushiguang/sprint-workflow';
import {createBffApi} from './api.ts';

const endpoint: EndpointInfo = {id: 'A', name: 'Model A', description: '', badge: '', cost: 'Lower', speed: 'Faster', supportsTemperature: true, priceIn: 0, priceOut: 200};
const structured = (rules = '') => ({taskSummary: 'Label this', features: {video: ['Description'], photo_text: [], metadata: []}, label: {name: 'format', kind: 'single' as const, values: [{name: 'Vlog', definition: ''}, {name: 'Tutorial', definition: ''}]}, ruleGroups: rules ? [{id: 'rg1', title: 'Rules', content: rules}] : [], images: []});

/** A bff over a workflow (through the loopback) with one project: a schema, 4 eval examples with gold labels, and a fake model. */
async function world(prefix: string, identity: Identity = {currentUser: async () => ({id: 'u_1', name: 'Tester'})}) {
  const db = localDocRuntime(prefix);
  const catalog = createCatalog(db);
  const gateway = {
    endpoints: () => [endpoint],
    labelingEndpoints: () => [endpoint],
    labelingEndpointsFor: async () => [endpoint],
    forgetTenant: () => {},
    agentModel: () => ({}),
    cancel: async () => {},
    label: async (): Promise<LabelCallResult> => ({text: '{"format": "Vlog"}', inputTokens: 0, outputTokens: 150, costUsd: 0.03, endpointId: 'labeling-A', attempts: 1}),
  } as unknown as LlmGatewayContract;
  const labeling = createLabeling({db, catalog, gateway, locks: memoryLocks()});
  const jobs = createJobs({store: memoryJobStore()});
  const wf = createWorkflow({catalog, labeling, gateway, files: {} as FileStore, examples: {} as ExampleSource, standIns: [], sharedState: memorySharedState(), jobs: jobs.api});
  wf.connect({agents: {} as AgentRuntimeContract});
  for (const e of [labelingExecutor(labeling), ...wf.executors]) jobs.register(e);
  // Every context the workflow receives, in order.
  const contexts: RequestContext[] = [];
  const workflow = new Proxy(loopback(wf.api), {
    get: (t, k) => (ctx: RequestContext, ...args: unknown[]) => (contexts.push(ctx), (t[k as keyof WorkflowContract] as (...a: unknown[]) => unknown)(ctx, ...args)),
  });
  const projectId = `pr_${prefix}`;
  await catalog.insert('setup_versions', {id: `sv_${prefix}`, projectId, number: 1, schemaVersion: 1, task: '', schema: {name: 'format', kind: 'single' as const, values: [{name: 'Vlog', definition: ''}, {name: 'Tutorial', definition: ''}]}, thresholds: null, models: [{endpoint: 'A', maxOutputTokens: 150, temperature: null}], steps: {schema: true, evaluation: true, models: true}, createdAt: '', createdBy: ''});
  await catalog.insert('dataset_snapshots', {id: `ds_${prefix}`, projectId, number: 1, source: 'sample', sourceName: 'test', createdAt: '', counts: {rows: 4, valid: 4, invalid: 0, video: 4, photoText: 0}, split: {eval: 4, test: 0, train: 0}});
  await catalog.insertMany('examples', Array.from({length: 4}, (_, i) => ({id: `ex_${prefix}_${i}`, snapshotId: `ds_${prefix}`, externalId: String(i), type: 'video' as const, title: '', features: {}, split: 'eval' as const, optimiserHalf: i % 2 === 0})));
  for (let i = 0; i < 4; i++) await catalog.insert('gold_labels', {id: `gl_${prefix}_${i}`, projectId, exampleId: `ex_${prefix}_${i}`, schemaVersion: 1, answer: ['Vlog'], source: 'labeled', revealed: false, createdAt: '', createdBy: 'Tester'});
  await catalog.insert('projects', {id: projectId, tenantId: 'default', name: 'p', createdAt: '', createdBy: '', kind: 'prompt_tuning', settingsConfirmed: true, setupVersionId: `sv_${prefix}`, snapshotId: `ds_${prefix}`, approvedNodes: []});
  return {api: createBffApi({workflow, identity, appVersion: '9.9.9'}), catalog, projectId, contexts, workflow, jobs};
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

  const started = await api.scoreVersion({projectId, promptVersionId: a.id});
  assert.equal(started.runIds.length, 1, 'returns once the labeling is queued, with its task');
  await until(async () => ((await api.loadProjectState(projectId))?.reports.length ?? 0) > 0, 'the score');
  const preds = await api.predictionsFor(projectId, a.id, 'A', {endpoint: 'A', maxOutputTokens: 150, temperature: null});
  assert.equal(Object.keys(preds).length, 4);
});

test('contract: ids of another project are refused', async () => {
  const one = await world('api2');
  const two = await world('api3');
  // Each bff has its own workflow and store: the first project's records are not in the second's.
  await assert.rejects(two.api.scoreVersion({projectId: two.projectId, promptVersionId: 'pv_missing'}), /does not exist/);
  await assert.rejects(two.api.closeProposal({projectId: two.projectId, proposalId: 'ap_missing', decision: 'approved'}), /does not exist/);
  await assert.rejects(two.api.tick({projectId: one.projectId}).then(() => two.api.createVersion({projectId: one.projectId, structured: structured(), parentId: null, madeBy: 'user', change: '', kind: 'major'})), /does not exist/);
});

test('contract: a call naming a project only reaches records of that project (review G2)', async () => {
  const {api, projectId} = await world('api-g2');
  const v = await api.createVersion({projectId, structured: structured(), parentId: null, madeBy: 'user', change: '', kind: 'major'});
  const {runIds} = await api.scoreVersion({projectId, promptVersionId: v.id});
  await until(async () => ((await api.loadProjectState(projectId))?.reports.length ?? 0) > 0, 'the score');
  const other = await api.createProject('Other');
  const settings = {endpoint: 'A' as const, maxOutputTokens: 150, temperature: null};
  await assert.rejects(api.predictionsFor(other.id, v.id, 'A', settings), /does not exist/);
  await assert.rejects(api.exampleMedia(other.id, `ex_api-g2_0`), /does not exist/);
  assert.equal(await api.exampleMedia(projectId, `ex_api-g2_0`), null, 'no media source here, but the example is the project\'s');
  await assert.rejects(api.stopRun({projectId: other.id, runId: runIds[0]}), /does not exist/);
  // The Optimiser's runs: see the Retry test in apps/workflow (this bff has no Optimiser).
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
    predictionsFor: await api.predictionsFor(projectId, v.id, 'A', {endpoint: 'A', maxOutputTokens: 150, temperature: null}),
    mismatches: await api.mismatches(projectId),
    chatHistory: await api.chatHistory(projectId),
    proposals: await api.proposals(projectId),
    getAgentLive: await api.getAgentLive(projectId),
  };
  for (const [name, dto] of Object.entries(responses)) assert.deepEqual(JSON.parse(JSON.stringify(dto)), dto, name);
  const state = (await api.loadProjectState(projectId))!;
  assert.equal(Object.keys(state.gold).length, 4);
});

test('contract: a failed call is not kept under its idempotency key, so a retry runs again', async () => {
  const {api, projectId} = await world('api5');
  const req = {projectId, structured: structured(), parentId: 'pv_missing', madeBy: 'user' as const, change: '', kind: 'minor' as const, idempotencyKey: 'k-fail'};
  await assert.rejects(api.createVersion(req));
  const ok = await api.createVersion({...req, parentId: null, kind: 'major'});
  assert.ok(ok.id);
});

test('contract: Sign out is offered only when the platform can end the session (2026-11-16 refinements, 1.2)', async () => {
  const none = await world('so1');
  assert.equal((await none.api.getRuntimeInfo()).canSignOut, false);
  await assert.rejects(none.api.signOut(), /no sign-out/);
  let out = 0;
  const sso = await world('so2', {currentUser: async () => ({id: 'u_1', name: 'Tester'}), signOut: async () => void out++});
  const info = await sso.api.getRuntimeInfo();
  assert.equal(info.canSignOut, true);
  assert.deepEqual(JSON.parse(JSON.stringify(info)), info, 'plain JSON');
  await sso.api.signOut();
  assert.equal(out, 1);
});

test('contract: each call carries a context with its own request id, the signed-in user and the app version', async () => {
  const {api, projectId, contexts} = await world('ctx1');
  await api.loadProjectState(projectId);
  await api.sendUserMessage({projectId, text: '', page: {label: 'x', agent: 'front_desk', intent: 'answer', context: {}}, locale: 'zh'}).catch(() => undefined);
  assert.equal(contexts.length, 2);
  assert.notEqual(contexts[0].requestId, contexts[1].requestId);
  for (const c of contexts) assert.deepEqual([c.user, c.caller, c.appVersion], [{id: 'u_1', name: 'Tester'}, 'bff', '9.9.9']);
  assert.equal(contexts[1].locale, 'zh', "a message carries the user's language");
});

test('contract: a failed sign-in check is asked again on the next call; a good one is kept', async () => {
  let asked = 0;
  const {api} = await world('ctx2', {
    currentUser: async () => {
      if (++asked === 1) throw new Error('not signed in');
      return {id: 'u_2', name: 'Later'};
    },
  });
  await assert.rejects(api.listProjects(), /not signed in/);
  assert.deepEqual((await api.getRuntimeInfo()).user, {id: 'u_2', name: 'Later'});
  await api.listProjects();
  assert.equal(asked, 2);
});

test('contract: the runtime names the caller\'s tenant, by its organization\'s name when the platform has one (#91)', async () => {
  const plain = await world('tn1');
  assert.deepEqual((await plain.api.getRuntimeInfo()).tenant, {id: 'default', name: 'default', role: 'admin'}, 'no organization: the default tenant; no permission checks: an admin');
  const named = await world('tn2', {currentUser: async () => ({id: 'u_a', name: 'Ann', organization: 'org_acme', organizationName: 'Acme Safety'})});
  const info = await named.api.getRuntimeInfo();
  assert.deepEqual(info.tenant, {id: 'org_acme', name: 'Acme Safety', role: 'admin'});
  assert.deepEqual(JSON.parse(JSON.stringify(info)), info, 'plain JSON');
  assert.equal('tenantRole' in info, false, 'the workflow\'s field stays inside');
});

test('contract: a workflow that names no role means the caller is not in the tenant (#94); requests for access pass through with the caller (#91)', async () => {
  const seen: unknown[] = [];
  const workflow = {
    runtimeInfo: async () => ({appVersion: '9.9.9', standIns: []}),
    requestAccess: async (ctx: RequestContext, req: unknown) => (seen.push([ctx.user.id, ctx.tenantId, req]), {trackUrl: 'https://perm.example/r/1'}),
  } as unknown as WorkflowContract;
  const api = createBffApi({workflow, identity: {currentUser: async () => ({id: 'u_b', name: 'Bo', organization: 'org_acme'})}, appVersion: '9.9.9'});
  assert.equal((await api.getRuntimeInfo()).tenant, undefined);
  assert.deepEqual(await api.requestAccess({permission: 'project_write', projectId: 'pr_1', reason: 'Food'}), {trackUrl: 'https://perm.example/r/1'});
  assert.deepEqual(seen, [['u_b', 'org_acme', {permission: 'project_write', projectId: 'pr_1', reason: 'Food'}]]);
});

test('contract: the channel names the tenant of each call; tenants without a record are named as the top bar names them (#94)', async () => {
  let chosen: string | undefined;
  const seen: (string | undefined)[] = [];
  const workflow = {
    runtimeInfo: async (ctx: RequestContext) => (seen.push(ctx.tenantId), {standIns: [], endpoints: [], hasBundledGold: false, tenantRole: 'admin', ...(ctx.tenantId === 'tn_1' ? {tenantName: 'Ads'} : {})}),
    listTenants: async (ctx: RequestContext) => (seen.push(ctx.tenantId), [{id: 'org_acme', name: 'org_acme', role: 'admin', projects: 3}, {id: 'tn_1', name: 'Ads', role: 'member', projects: 0}]),
  } as unknown as WorkflowContract;
  const api = createBffApi({workflow, identity: {currentUser: async () => ({id: 'u_a', name: 'Ann', organization: 'org_acme', organizationName: 'Acme Safety'})}, tenant: () => chosen});
  assert.deepEqual((await api.getRuntimeInfo()).tenant, {id: 'org_acme', name: 'Acme Safety', role: 'admin'}, 'none chosen: the organization');
  chosen = 'tn_1';
  assert.deepEqual((await api.getRuntimeInfo()).tenant, {id: 'tn_1', name: 'Ads', role: 'admin'});
  chosen = '  ';
  await api.getRuntimeInfo();
  assert.deepEqual(await api.listTenants(), [{id: 'org_acme', name: 'Acme Safety', role: 'admin', projects: 3}, {id: 'tn_1', name: 'Ads', role: 'member', projects: 0}]);
  assert.deepEqual(seen, ['org_acme', 'tn_1', 'org_acme', 'org_acme'], 'a blank choice is no choice');
});

test('contract: the signed-in organization is the tenant; one organization never sees another one\'s data sources (#29)', async () => {
  const acme: Identity = {currentUser: async () => ({id: 'u_a', name: 'Ann', organization: 'org_acme'})};
  const globex: Identity = {currentUser: async () => ({id: 'u_g', name: 'Gus', organization: 'org_globex'})};
  const w = await world('tenants', acme);
  const other = createBffApi({workflow: w.workflow, identity: globex, appVersion: '9.9.9'});
  const made = await w.api.createDataSource({name: 'Feed', fileName: 'feed.txt', text: 'v1\nv2'});
  assert.ok(made.source, made.error ?? 'no source');
  await w.jobs.idle();
  assert.equal(w.contexts.at(-1)?.tenantId, 'org_acme');
  assert.deepEqual((await w.api.listDataSources()).map(s => [s.name, s.items]), [['Feed', 2]]);
  assert.deepEqual(await other.listDataSources(), []);
  assert.equal(w.contexts.at(-1)?.tenantId, 'org_globex');
  assert.equal(await other.getDataSource(made.source!.id), null);
  await assert.rejects(other.addSourceFile({sourceId: made.source!.id, fileName: 'x.txt', text: 'v3'}), /does not exist/);
  // The same name is free in another organization.
  assert.ok((await other.createDataSource({name: 'Feed', fileName: 'feed.txt', text: 'v9'})).source);
  assert.equal((await w.api.listDataSources()).length, 1);
  // Rename and delete pass through, and reach only the caller's own sources.
  await assert.rejects(other.deleteDataSource({sourceId: made.source!.id}), /does not exist/);
  assert.deepEqual(await w.api.renameDataSource({sourceId: made.source!.id, name: 'Weekly'}), {name: 'Weekly'});
  await w.api.deleteDataSource({sourceId: made.source!.id});
  assert.deepEqual(await w.api.listDataSources(), []);
});
