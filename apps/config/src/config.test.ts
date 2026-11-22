import assert from 'node:assert/strict';
import test from 'node:test';
import {configureSystem, systemConfig} from '@yushiguang/sprint-domain';
import {memoryConfig} from '@yushiguang/sprint-platform';
import {createConfig} from './config.ts';

/** The configuration module (docs/design/server.md, 7) over the in-memory configuration platform. */

const model = (endpointId: string) => ({kind: 'model', endpointId}) as const;

test('refresh puts the platform values in force over the fixed overrides and the defaults', async () => {
  const port = memoryConfig({'labeling.maxFailedShare': '0.2', 'optimiser.defaultMaxRounds': 'many'});
  const problems: unknown[] = [];
  const config = createConfig({port, base: {labeling: {maxFailedInARow: 7, maxFailedShare: 0.5}}, onProblem: p => problems.push(p)});
  assert.equal(await config.refresh(), true);
  assert.equal(systemConfig().labeling.maxFailedShare, 0.2, 'the platform wins over the fixed override');
  assert.equal(systemConfig().labeling.maxFailedInARow, 7, 'the fixed override stays');
  assert.equal(systemConfig().optimiser.defaultMaxRounds, 10, 'an invalid value keeps the default');
  assert.deepEqual(problems, [{kind: 'invalid', keys: ['optimiser.defaultMaxRounds']}]);

  port.down(true);
  assert.equal(await config.refresh(), false);
  assert.equal(systemConfig().labeling.maxFailedShare, 0.2, 'an outage keeps the values in force');
  configureSystem();
});

test('refresh reads key by key when the platform has no getMany', async () => {
  const inner = memoryConfig({'jobs.limit.model': '2'});
  const config = createConfig({port: {get: k => inner.get(k)}});
  await config.refresh();
  assert.equal(systemConfig().jobs.limit.model, 2);
  configureSystem();
});

test('job limits follow the lookup order and skip invalid tenant values', async () => {
  const port = memoryConfig({
    'tenant.t1.jobs.limit.endpoint.m1': '3',
    'tenant.t1.jobs.limit.model': '2',
    'tenant.t1.jobs.limit.compute': '0',
    'tenant.t2.jobs.limit.compute': '4',
    'jobs.limit.model': '5',
  });
  const config = createConfig({port});
  await config.refresh();
  const t1 = config.reader.forTenant('t1');
  assert.equal(await t1.jobLimit(model('m1')), 3);
  assert.equal(await t1.jobLimit(model('m2')), 2);
  assert.equal(await t1.jobLimit({kind: 'compute'}), 10, 'an invalid tenant value falls through to the process value');
  assert.equal(await config.reader.forTenant('t2').jobLimit({kind: 'compute'}), 4);
  assert.equal(await config.reader.forTenant('t3').jobLimit(model('m1')), 5, 'no tenant key: the process value');
  assert.equal(await config.reader.forTenant(undefined).jobLimit(model('m1')), 5);
  assert.equal(await t1.get('jobs.limit.model'), '2');
  assert.equal(await config.reader.forTenant(undefined).get('jobs.limit.model'), null);
  configureSystem();
});

test('tenant values are cached for the TTL, the old value is used in an outage, and a push drops the cache', async () => {
  let now = 0;
  const port = memoryConfig({'tenant.t1.jobs.limit.model': '2'});
  const config = createConfig({port, ttlMs: 1000, clock: () => now});
  const t1 = config.reader.forTenant('t1');
  assert.equal(await t1.jobLimit(model('m')), 2);

  port.set('tenant.t1.jobs.limit.model', '3');
  assert.equal(await t1.jobLimit(model('m')), 2, 'within the TTL the cached value is used');
  now = 1000;
  assert.equal(await t1.jobLimit(model('m')), 3, 'after the TTL it is read again');

  port.down(true);
  now = 5000;
  assert.equal(await t1.jobLimit(model('m')), 3, 'an outage keeps the old value');
  assert.equal(await t1.get('jobs.limit.model'), '3');
  await assert.rejects(t1.get('never.read'), 'nothing read before: the outage shows');
  assert.equal(await config.reader.forTenant('t9').jobLimit(model('m')), 1, 'jobLimit never throws');

  port.down(false);
  await config.start();
  port.set('tenant.t1.jobs.limit.model', '4');
  assert.equal(await t1.jobLimit(model('m')), 4, 'a pushed change is seen at once');
  config.stop();
  configureSystem();
});

test('a push keeps the old values for an outage; a failing platform is asked again only after retryMs', async () => {
  let now = 0;
  let calls = 0;
  const inner = memoryConfig({'tenant.t1.jobs.limit.model': '3'});
  const port = {...inner, get: (k: string) => (calls++, inner.get(k))};
  const config = createConfig({port, ttlMs: 1000, retryMs: 500, clock: () => now});
  const t1 = config.reader.forTenant('t1');
  assert.equal(await t1.jobLimit(model('m')), 3);
  await config.start();
  inner.down(true);
  inner.set('tenant.t2.jobs.limit.model', '9');
  assert.equal(await t1.get('jobs.limit.model'), '3', 'a push followed by an outage keeps the old value');
  assert.equal(await t1.jobLimit(model('m')), 3);
  const before = calls;
  assert.equal(await t1.jobLimit(model('m')), 3);
  assert.equal(calls, before, 'within retryMs the platform is not asked again');
  now = 600;
  await t1.jobLimit(model('m'));
  assert.equal(calls, before + 2, 'after retryMs it is (both keys of the lookup)');
  config.stop();
  configureSystem();
});

test('reads of one key share one call; an older refresh that lands last is dropped', async () => {
  let calls = 0;
  const gates: Array<(v: Record<string, string | null>) => void> = [];
  const port = {
    get: async () => (calls++, await new Promise<string | null>(r => setTimeout(() => r('2'), 5))),
    getMany: () => new Promise<Record<string, string | null>>(r => gates.push(r)),
  };
  const config = createConfig({port});
  const t1 = config.reader.forTenant('t1');
  assert.deepEqual(await Promise.all([t1.get('x'), t1.get('x')]), ['2', '2']);
  assert.equal(calls, 1);

  const first = config.refresh();
  const second = config.refresh();
  gates[1]({'jobs.limit.compute': '7'});
  assert.equal(await second, true);
  gates[0]({'jobs.limit.compute': '3'});
  assert.equal(await first, false);
  assert.equal(systemConfig().jobs.limit.compute, 7, 'the newer answer stays in force');
  configureSystem();
});
