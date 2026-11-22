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
