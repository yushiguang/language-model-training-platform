import assert from 'node:assert/strict';
import test from 'node:test';
import {readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import type {AgentRuntimeContract, BffContract, EndpointInfo, ExampleSource, FileStore, LabelCallResult, LlmGatewayContract} from '@yushiguang/sprint-contracts';
import {createCatalog} from '@yushiguang/sprint-catalog';
import {createLabeling, labelingExecutor, memoryLocks} from '@yushiguang/sprint-labeling';
import {createJobs} from '@yushiguang/sprint-jobs';
import {localDocRuntime, loopback, memoryJobStore, memorySharedState} from '@yushiguang/sprint-platform';
import {createWorkflow} from '@yushiguang/sprint-workflow';
import {createBffApi} from './api.ts';
import {recorded, replay, withOutcomes, type BffFixture, type FixtureWorld} from './golden.ts';

/**
 * The golden BFF fixtures (`apps/bff/fixtures/*.json`) replayed on this BFF and the reference
 * workflow behind it: each fixture's world is built, its steps are called in order, and each
 * result must equal the recorded one. Any other implementation is held to the same files (see
 * fixtures/README.md). `RECORD_FIXTURES=1 npm test` writes the results back instead; read the diff
 * before committing.
 */

const DIR = fileURLToPath(new URL('../fixtures/', import.meta.url));
const RECORD = process.env.RECORD_FIXTURES === '1';
const fixtures = readdirSync(DIR)
  .filter(f => f.endsWith('.json'))
  .map(f => [f, JSON.parse(readFileSync(DIR + f, 'utf8')) as BffFixture] as const);

/** The one model of every world. */
const endpoint: EndpointInfo = {id: 'A', name: 'Model A', description: '', badge: '', cost: 'Lower', speed: 'Faster', supportsTemperature: true, priceIn: 0, priceOut: 200};

/** The feature port of a world: its items, its checks and its sample data. */
function exampleSource(w: FixtureWorld): ExampleSource {
  const items = w.items ?? {};
  return {
    lookup: async ids => ids.filter(id => id in items).map(externalId => ({externalId, ...items[externalId]})),
    check: async ids => ids.map(externalId => ({externalId, type: items[externalId]?.type ?? null, problem: w.problems?.[externalId] ?? (externalId in items ? null : 'missing')})),
    ...(w.builtIn ? {builtIn: async () => w.builtIn!} : {}),
  };
}

/** The reference BFF over the reference workflow, with the world's records, one BFF per user. */
async function build(name: string, w: FixtureWorld) {
  const db = localDocRuntime(`golden-${name}`);
  const catalog = createCatalog(db);
  const gateway = {
    endpoints: () => [endpoint],
    labelingEndpoints: () => [endpoint],
    agentModel: () => ({}),
    cancel: async () => {},
    async label(req: {messages?: unknown}): Promise<LabelCallResult> {
      const prompt = JSON.stringify(req.messages ?? '');
      const text = w.replies?.find(r => prompt.includes(r.when))?.text ?? w.reply;
      return {text, inputTokens: 0, outputTokens: 150, costUsd: 0.03, endpointId: 'labeling-A', attempts: 1};
    },
  } as unknown as LlmGatewayContract;
  const labeling = createLabeling({db, catalog, gateway, locks: memoryLocks()});
  const jobs = createJobs({store: memoryJobStore()});
  const wf = createWorkflow({catalog, labeling, gateway, files: {} as FileStore, examples: exampleSource(w), standIns: [], sharedState: memorySharedState(), jobs: jobs.api});
  wf.connect({agents: {} as AgentRuntimeContract});
  for (const e of [labelingExecutor(labeling), ...wf.executors]) jobs.register(e);
  for (const [collection, rows] of Object.entries(w.records ?? {}))
    for (const row of rows) await catalog.insert(collection as never, row as never);
  const workflow = loopback(wf.api);
  const apis = new Map<string, BffContract>();
  for (const [key, u] of Object.entries(w.users)) apis.set(key, createBffApi({workflow, identity: {currentUser: async () => u}, appVersion: '9.9.9'}));
  const apiFor = (user: string) => {
    const api = apis.get(user);
    if (!api) throw new Error(`no user ${user} in the world`);
    return api;
  };
  return {apiFor, settle: () => jobs.idle()};
}

test('golden BFF fixtures: each names its case and holds plain JSON', () => {
  assert.ok(fixtures.length > 0);
  for (const [file, fx] of fixtures) {
    assert.ok(fx.name && fx.guards.length && fx.steps.length, `${file} names its case, its guards and its steps`);
    assert.ok(Object.keys(fx.world.users).length > 0, `${file} has a user`);
  }
});

for (const [file, fx] of fixtures) {
  test(`golden BFF fixture ${file}: ${fx.name}`, async () => {
    const {apiFor, settle} = await build(file.replace(/\.json$/, ''), fx.world);
    const got = await replay(fx, apiFor, settle);
    if (RECORD) {
      writeFileSync(DIR + file, JSON.stringify(withOutcomes(fx, got), null, 2) + '\n');
      return;
    }
    fx.steps.forEach((step, i) => {
      const want = recorded(step);
      const what = `${file}, step ${i + 1}${'call' in step ? ` (${step.call})` : ''}`;
      if ('expectError' in want) {
        assert.ok('expectError' in got[i], `${what} must fail; it gave ${JSON.stringify(got[i])}`);
        assert.ok((got[i] as {expectError: string}).expectError.includes(want.expectError), `${what}: the error "${(got[i] as {expectError: string}).expectError}" must contain "${want.expectError}"`);
      } else {
        assert.deepEqual(got[i], want, what);
      }
    });
  });
}
