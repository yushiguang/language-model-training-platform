import assert from 'node:assert/strict';
import test from 'node:test';
import {configureSystem, DEFAULT_SYSTEM_CONFIG, dryRunSize, mergeConfig, systemConfig} from './index.ts';

test('system config: overrides merge over the defaults, by key; arrays are replaced whole', () => {
  const c = mergeConfig(DEFAULT_SYSTEM_CONFIG, {optimiser: {dryRunMaxExamples: 6}, gateway: {retryDelaysMs: [1], assumedLimits: {'model-x': {tier: 'fast', qpm: 1, tpm: 2, maxConcurrency: 3}}}});
  assert.equal(c.optimiser.dryRunMaxExamples, 6);
  assert.equal(c.optimiser.defaultMaxRounds, DEFAULT_SYSTEM_CONFIG.optimiser.defaultMaxRounds);
  assert.deepEqual(c.gateway.retryDelaysMs, [1]);
  assert.equal(c.gateway.assumedLimits['model-x'].qpm, 1);
  assert.ok(c.gateway.assumedLimits['gpt-5.4']);
  assert.equal(DEFAULT_SYSTEM_CONFIG.optimiser.dryRunMaxExamples, 20, 'the defaults are not changed');
});

test('system config: code reads the configuration in force', () => {
  assert.equal(dryRunSize(100), 20);
  configureSystem({optimiser: {dryRunMaxExamples: 6}});
  assert.equal(dryRunSize(100), 6);
  configureSystem();
  assert.equal(systemConfig(), DEFAULT_SYSTEM_CONFIG);
  assert.equal(dryRunSize(100), 20);
});

test('config keys: one dotted key per leaf; a map with free keys is one JSON key', async () => {
  const {systemConfigKeys} = await import('./index.ts');
  const keys = systemConfigKeys();
  assert.ok(keys.includes('labeling.maxFailedShare'));
  assert.ok(keys.includes('jobs.limit.model'));
  assert.ok(keys.includes('gateway.unknownModelLimits.tier'));
  assert.ok(keys.includes('gateway.assumedLimits'));
  assert.ok(keys.includes('gateway.retryDelaysMs'));
  assert.ok(!keys.some(k => k.startsWith('gateway.assumedLimits.')));
});

test('config values: parsed by the type of the default; unset left out; invalid named and skipped', async () => {
  const {parseSystemConfig} = await import('./index.ts');
  const {overrides, invalid} = parseSystemConfig({
    'labeling.maxFailedShare': '0.1',
    'jobs.limit.compute': '4',
    'gateway.retryDelaysMs': '[100, 200]',
    'gateway.assumedLimits': '{"m": {"tier": "fast", "qpm": 1, "tpm": 2, "maxConcurrency": 3}}',
    'gateway.unknownModelLimits.tier': 'fast',
    'optimiser.defaultMaxRounds': 'ten',
    'gateway.windowMs': '',
    'agent.maxToolCalls': null,
    'not.a.key': '5',
  });
  assert.deepEqual(overrides, {
    labeling: {maxFailedShare: 0.1},
    jobs: {limit: {compute: 4}},
    gateway: {retryDelaysMs: [100, 200], assumedLimits: {m: {tier: 'fast', qpm: 1, tpm: 2, maxConcurrency: 3}}, unknownModelLimits: {tier: 'fast'}},
  });
  assert.deepEqual(invalid.sort(), ['gateway.windowMs', 'optimiser.defaultMaxRounds']);
  assert.deepEqual(parseSystemConfig({'gateway.retryDelaysMs': '["a"]', 'gateway.assumedLimits': '[1]'}).invalid.sort(), ['gateway.assumedLimits', 'gateway.retryDelaysMs']);
});

test('job limits: tenant endpoint, then tenant model, then the process value; compute has its own', async () => {
  const {jobLimitKeys, parseJobLimit, processConfigReader} = await import('./index.ts');
  assert.deepEqual(jobLimitKeys('t1', {kind: 'model', endpointId: 'm7'}), ['tenant.t1.jobs.limit.endpoint.m7', 'tenant.t1.jobs.limit.model']);
  assert.deepEqual(jobLimitKeys('t1', {kind: 'compute'}), ['tenant.t1.jobs.limit.compute']);
  assert.deepEqual(jobLimitKeys(undefined, {kind: 'compute'}), []);
  assert.equal(parseJobLimit(' 3 '), 3);
  for (const bad of ['0', '-1', '1.5', 'x', '', null]) assert.equal(parseJobLimit(bad), null, String(bad));
  const reader = processConfigReader();
  assert.equal(await reader.forTenant('t1').jobLimit({kind: 'model', endpointId: 'm7'}), 1);
  assert.equal(await reader.forTenant('t1').jobLimit({kind: 'compute'}), 10);
  assert.equal(await reader.forTenant('t1').get('jobs.limit.model'), null);
  configureSystem({jobs: {limit: {compute: 3}}});
  assert.equal(await reader.forTenant(undefined).jobLimit({kind: 'compute'}), 3);
  configureSystem();
});
