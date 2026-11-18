import assert from 'node:assert/strict';
import test from 'node:test';
import type {ProjectState} from '@yushiguang/sprint-contracts';
import {autoSpendUsd, dueStarts} from './auto-start.ts';

const version = {id: 'pv_1', template: 'Label {{Title}}', features: {video: [], photo_text: [], metadata: []}, images: [], madeBy: 'user', createdAt: '2026-11-04T00:00:00Z', schemaVersion: 1} as unknown as ProjectState['versions'][number];
const state = (over: Partial<ProjectState> = {}): ProjectState =>
  ({
    project: {id: 'pr_1', approvedNodes: ['prompt_design', 'dataset', 'gold']},
    setup: {schema: {fields: []}, models: [{endpoint: 'A', maxOutputTokens: 512, temperature: 0}], thresholds: null},
    snapshot: {split: {eval: 2, test: 0, train: 0}},
    examples: [
      {id: 'ex_1', split: 'eval', features: {Title: 'a'}, type: 'video'},
      {id: 'ex_2', split: 'eval', features: {Title: 'b'}, type: 'video'},
      {id: 'ex_3', split: 'eval', features: {Title: 'c'}, type: 'video'},
      {id: 'ex_4', split: 'eval', features: {Title: 'd'}, type: 'video'},
    ],
    gold: {},
    versions: [version],
    reports: [],
    runs: [],
    optimisation: [],
    facts: {examples: 4, goldEvalDone: 4, goldHalves: {optimiser: 2, heldOut: 2}, settingsConfirmed: true},
    endpoints: [{id: 'A', priceIn: 1, priceOut: 4}],
    ...over,
  }) as unknown as ProjectState;

test('a new version is due for scoring on each chosen model', () => {
  const due = dueStarts(state());
  assert.deepEqual(due.map(d => `${d.what}:${d.endpoint}`), ['score:A']);
  assert.ok(due[0].estimateUsd > 0);
});

test('automatic spend counts runs started by code and try_prompt spend, not runs the user clicked', () => {
  const clicked = state({runs: [{id: 'lt_1', promptVersionId: 'pv_0', endpoint: 'A', state: 'done', done: 2, total: 2, costUsd: 9, autoCostUsd: 0}] as ProjectState['runs']});
  assert.equal(autoSpendUsd(clicked), 0);
  const resumed = state({runs: [{id: 'lt_1', promptVersionId: 'pv_0', endpoint: 'A', state: 'done', done: 2, total: 2, costUsd: 9, autoCostUsd: 4.5}] as ProjectState['runs']});
  assert.equal(autoSpendUsd(resumed), 4.5);
  assert.equal(autoSpendUsd(state({otherAutoSpendUsd: 0.25})), 0.25);
});

test('a paused scoring run is due to resume, and costs only what is left', () => {
  const s = state({runs: [{id: 'lt_1', promptVersionId: 'pv_1', endpoint: 'A', state: 'paused', done: 2, total: 4, costUsd: 0}] as ProjectState['runs']});
  const due = dueStarts(s);
  assert.deepEqual(due.map(d => d.what), ['resume']);
  assert.ok(Math.abs(due[0].estimateUsd * 2 - dueStarts(state())[0].estimateUsd) < 1e-9);
});

test('nothing starts by itself before settings are confirmed and enough gold labels exist (spec 2.5)', () => {
  const facts = state().facts;
  assert.deepEqual(dueStarts(state({facts: {...facts, settingsConfirmed: false}})), []);
  assert.deepEqual(dueStarts(state({facts: {...facts, goldEvalDone: 1, goldHalves: {optimiser: 1, heldOut: 0}}})), []);
  assert.deepEqual(dueStarts(state({facts: {...facts, goldHalves: {optimiser: 3, heldOut: 1}}})), []);
  assert.equal(dueStarts(state()).length, 1);
});

test('nothing is scored by itself until Gold Labels is approved, however many gold labels exist', () => {
  const s = state();
  assert.deepEqual(dueStarts({...s, project: {...s.project, approvedNodes: ['prompt_design', 'dataset']}}), []);
  assert.equal(dueStarts(s).length, 1);
});

test('the Optimiser is never due by itself, and its labeling waits for Retry', () => {
  const scored = state({
    setup: {schema: {fields: []}, models: [{endpoint: 'A', maxOutputTokens: 512, temperature: 0}], thresholds: {macroF1: 0.8}} as unknown as ProjectState['setup'],
    runs: [{id: 'lt_1', promptVersionId: 'pv_1', endpoint: 'A', state: 'done', done: 2, total: 2, costUsd: 0}] as ProjectState['runs'],
  });
  assert.deepEqual(dueStarts(scored), []);
  const cand = {...version, id: 'pv_2', madeBy: 'optimiser'} as ProjectState['versions'][number];
  const paused = state({
    versions: [cand, version],
    runs: [
      {id: 'lt_1', promptVersionId: 'pv_1', endpoint: 'A', state: 'done', done: 2, total: 2, costUsd: 0},
      {id: 'lt_2', promptVersionId: 'pv_2', endpoint: 'A', state: 'paused', done: 1, total: 2, costUsd: 0},
    ] as ProjectState['runs'],
    optimisation: [{id: 'op_1', state: 'paused', history: [{versionId: 'pv_2'}]}] as unknown as ProjectState['optimisation'],
  });
  assert.deepEqual(dueStarts(paused), []);
});

test('frozen features (#32): estimates use average sizes per kind; images count as images (a single URL too), text lists as text', async () => {
  const {averageExample, evalEstimate, featureSizes, mergeFeatureSizes, renderPrompt, estimateTokens, costForTokens, systemConfig, toFeatures} = await import('./index.ts');
  // 1 video in 5: two frames, a cover given as a single URL, a transcript. 4 photo posts: three
  // images, a list of hashtags (text), a title.
  const video = {type: 'video' as const, features: {...toFeatures({Cover: 'https://img.invalid/c.jpg', ASR: 'y'.repeat(100)}), Frame: {items: ['https://img.invalid/1', 'https://img.invalid/2']}}};
  const photo = {type: 'photo_text' as const, features: {...toFeatures({Title: 't'.repeat(10)}), Images: {items: ['https://img.invalid/a', 'https://img.invalid/b', 'https://img.invalid/c']}, Hashtags: {items: ['#one', '#two']}}};
  assert.deepEqual((video.features as Record<string, unknown>).Cover, {text: 'https://img.invalid/c.jpg'}, 'a single URL comes in as text');
  const list = [video, photo, photo, photo, photo];
  const sizes = featureSizes(list);
  assert.deepEqual(sizes.video, {Cover: {chars: 0, items: 1}, ASR: {chars: 100, items: 0}, Frame: {chars: 0, items: 2}}, 'averaged over the videos only');
  assert.equal(sizes.photo_text?.Images.items, 3);
  assert.ok((sizes.photo_text?.Hashtags.chars ?? 0) >= 8 && sizes.photo_text?.Hashtags.items === 0, 'a text list counts its text');
  assert.deepEqual(averageExample('video', sizes).features.Frame?.items?.length, 2, 'a minority kind keeps its images');
  assert.equal(averageExample('video', sizes).features.Cover?.items?.length, 1);
  assert.equal(averageExample('photo_text', sizes).features.Cover, undefined, 'no cover on photo posts');
  assert.ok(typeof averageExample('photo_text', sizes).features.Hashtags?.text === 'string');
  // The estimate equals pricing each example as it is.
  const template = 'Label {{Frame}} {{Cover}} {{ASR}} {{Images}} {{Hashtags}} {{Title}}';
  const sel = {video: ['Frame', 'Cover', 'ASR'], photo_text: ['Images', 'Hashtags', 'Title'], metadata: []};
  const s = state({snapshot: {split: {eval: 5, test: 0, train: 0}, featureSizes: sizes} as unknown as ProjectState['snapshot'], examples: list.map((e, i) => ({id: `ex_${i}`, split: 'eval', type: e.type})) as unknown as ProjectState['examples']});
  const out = systemConfig().gateway.evalOutputTokensEstimate;
  const exact = list.reduce((n, e) => n + costForTokens(s.endpoints, 'A', estimateTokens(renderPrompt(template, e, sel)), out), 0);
  const estimate = evalEstimate(s, {template, features: sel, images: []}, 'A');
  assert.ok(Math.abs(estimate - exact) / exact < 0.02, `estimate ${estimate} vs ${exact}`);
  // Merging weighs each kind by its own examples.
  const more = featureSizes([{type: 'video', features: {Frame: {items: ['u', 'v', 'w', 'x']}}}]);
  assert.equal(mergeFeatureSizes(sizes, {video: 1, photo_text: 4}, more, {video: 1}).video?.Frame.items, 3);
  assert.equal(mergeFeatureSizes(sizes, {video: 1, photo_text: 4}, more, {video: 1}).photo_text?.Images.items, 3);
});
