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
