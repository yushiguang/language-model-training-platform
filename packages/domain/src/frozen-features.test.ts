import assert from 'node:assert/strict';
import test from 'node:test';
import type {ExampleType, Features} from '@yushiguang/sprint-contracts';
import {
  addChecks,
  checksTotal,
  computeFeatureMissingness,
  FEATURES,
  featureMissingForGroup,
  mergeFeatureMissingness,
  missingFeatureKeys,
  noChecks,
  subtractFeatureMissingness,
  summarizeMissingness,
  toFeatures,
} from './index.ts';

const ex = (type: ExampleType, raw: Record<string, unknown>): {type: ExampleType; features: Features} => ({
  type,
  features: toFeatures(raw),
});

test('missingFeatureKeys checks catalogue keys for that type plus metadata', () => {
  const missing = missingFeatureKeys('video', toFeatures({Description: 'hi', Frame: ['f1.jpg'], Language: 'en', Title: 'ignored'}));
  assert.ok(!missing.includes('Description'));
  assert.ok(!missing.includes('Frame'));
  assert.ok(!missing.includes('Language'));
  assert.ok(!missing.includes('Title'), 'photo_text-only key is not checked for video');
  assert.ok(missing.includes('OCR_Text'));
  assert.ok(missing.includes('Hashtags'));
});

test('computeFeatureMissingness aggregates per type and records zeroFeatureExcluded', () => {
  const list = [
    ex('video', {Description: 'a', Frame: ['f1.jpg'], Language: 'en'}),
    ex('video', {Description: '  ', Frame: [], ASR: 'hello'}),
    ex('photo_text', {Title: 't', Images: ['i1.jpg'], Language: 'en'}),
  ];
  const stats = computeFeatureMissingness(list, {video: 2, photo_text: 0});
  assert.equal(stats.version, 1);
  assert.equal(stats.byType.video?.examples, 2);
  assert.equal(stats.byType.video?.missing.Description, 1);
  assert.equal(stats.byType.video?.missing.Frame, 1);
  assert.equal(stats.byType.video?.missing.ASR, 1);
  assert.equal(stats.byType.video?.missing.Language, 1);
  assert.equal(stats.byType.video?.missing.OCR_Text, 2);
  assert.equal(stats.byType.video?.missing.Title, undefined);
  assert.equal(Object.keys(stats.byType.video?.missing ?? {}).length, FEATURES.video.length + FEATURES.metadata.length);

  assert.equal(stats.byType.photo_text?.examples, 1);
  assert.equal(stats.byType.photo_text?.missing.Title, 0);
  assert.equal(stats.byType.photo_text?.missing.Images, 0);
  assert.equal(stats.byType.photo_text?.missing.Description, 1);
  assert.equal(stats.byType.photo_text?.missing.Frame, undefined);
  assert.equal(Object.keys(stats.byType.photo_text?.missing ?? {}).length, FEATURES.photo_text.length + FEATURES.metadata.length);

  assert.deepEqual(stats.zeroFeatureExcluded, {video: 2});
});

test('mergeFeatureMissingness and subtractFeatureMissingness preserve counts, clamp at 0, and drop empty types', () => {
  const a = computeFeatureMissingness(
    [
      ex('video', {Description: 'a', Language: 'en'}),
      ex('video', {Description: '', Language: ''}),
      ex('photo_text', {Title: 't', Language: 'en'}),
    ],
    {video: 1},
  );
  const b = computeFeatureMissingness(
    [
      ex('video', {Description: '', Frame: ['f.jpg']}),
    ],
    {video: 2, photo_text: 1},
  );

  const merged = mergeFeatureMissingness(a, b);
  assert.equal(merged.byType.video?.examples, 3);
  assert.equal(merged.byType.video?.missing.Description, 2);
  assert.equal(merged.byType.video?.missing.Frame, 2);
  assert.equal(merged.byType.video?.missing.Language, 2);
  assert.equal(merged.byType.photo_text?.examples, 1);
  assert.deepEqual(merged.zeroFeatureExcluded, {video: 3, photo_text: 1});
  assert.deepEqual(mergeFeatureMissingness(undefined, b), b);
  assert.deepEqual(mergeFeatureMissingness(a, undefined), a);
  assert.deepEqual(subtractFeatureMissingness(undefined, a), {version: 1, byType: {}, zeroFeatureExcluded: {}});

  // Subtracting a removes photo_text completely (1 -> 0 examples) and reduces video (3 -> 1).
  const sub = subtractFeatureMissingness(merged, a);
  assert.equal(sub.byType.video?.examples, 1);
  assert.equal(sub.byType.video?.missing.Description, 1);
  assert.equal(sub.byType.photo_text, undefined);
  assert.deepEqual(sub.zeroFeatureExcluded, {video: 2, photo_text: 1});

  // Clamping at 0 and at post-subtraction examples (while missing < examples stays unclamped), and dropping a type when examples hit 0.
  const clamped = subtractFeatureMissingness(
    {version: 1, byType: {video: {examples: 4, missing: {Description: 1, ASR: 4, Language: 2}}}, zeroFeatureExcluded: {video: 1}},
    {version: 1, byType: {video: {examples: 1, missing: {Description: 5, ASR: 0, Language: 0}}}, zeroFeatureExcluded: {video: 4}},
  );
  assert.deepEqual(clamped, {
    version: 1,
    byType: {video: {examples: 3, missing: {Description: 0, ASR: 3, Language: 2}}},
    zeroFeatureExcluded: {},
  });
  const dropped = subtractFeatureMissingness(clamped, {version: 1, byType: {video: {examples: 5, missing: {}}}, zeroFeatureExcluded: {}});
  assert.deepEqual(dropped, {version: 1, byType: {}, zeroFeatureExcluded: {}});
});

test('featureMissingForGroup and summarizeMissingness compute exact rates per group and overall', () => {
  const stats = computeFeatureMissingness(
    [
      ex('video', {Description: 'a', Language: 'en'}),
      ex('video', {Description: '', Language: ''}),
      ex('photo_text', {Title: 't', Language: ''}),
    ],
    {video: 1},
  );
  assert.deepEqual(featureMissingForGroup(stats, 'video', 'Description'), {missing: 1, total: 2, rate: 0.5});
  assert.deepEqual(featureMissingForGroup(stats, 'photo_text', 'Title'), {missing: 0, total: 1, rate: 0});
  assert.deepEqual(featureMissingForGroup(stats, 'metadata', 'Language'), {missing: 2, total: 3, rate: 2 / 3});
  assert.equal(featureMissingForGroup(stats, 'video', 'Title'), null);
  assert.equal(featureMissingForGroup(null, 'video', 'Description'), null);

  const summary = summarizeMissingness(stats);
  assert.ok(summary);
  assert.equal(summary.totalExamples, 3);
  assert.equal(summary.totalZeroExcluded, 1);
  assert.equal(summary.byType.video?.examples, 2);
  assert.equal(summary.byType.video?.zeroExcluded, 1);
  assert.ok(summary.byType.video?.alwaysMissing.includes('OCR_Text'));
  assert.ok(!summary.byType.video?.alwaysMissing.includes('Description'));
  assert.equal(summary.metadataMissing.find(m => m.key === 'Language')?.missing, 2);
  assert.equal(summarizeMissingness(undefined), null);
  assert.deepEqual(summarizeMissingness(computeFeatureMissingness([], {video: 2})), {
    totalExamples: 0,
    totalZeroExcluded: 2,
    zeroFeatureExcluded: {video: 2},
    byType: {},
    metadataMissing: [],
  });
});

test('addChecks and checksTotal handle optional noFeatures and omit it when 0', () => {
  const base = noChecks();
  assert.equal('noFeatures' in base, false);
  assert.equal(checksTotal(base), 0);
  assert.equal(checksTotal(undefined), 0);

  const sumZero = addChecks(base, {missing: 1, minorCreator: 0, notRecommendable: 2, noFeatures: 0});
  assert.deepEqual(sumZero, {missing: 1, minorCreator: 0, notRecommendable: 2});
  assert.equal('noFeatures' in sumZero, false);
  assert.equal(checksTotal(sumZero), 3);

  const sumWithNoFeatures = addChecks(sumZero, {missing: 0, minorCreator: 1, notRecommendable: 0, noFeatures: 3});
  assert.deepEqual(sumWithNoFeatures, {missing: 1, minorCreator: 1, notRecommendable: 2, noFeatures: 3});
  assert.equal(checksTotal(sumWithNoFeatures), 7);

  const sumBoth = addChecks(sumWithNoFeatures, {missing: 0, minorCreator: 0, notRecommendable: 0, noFeatures: 2});
  assert.equal(sumBoth.noFeatures, 5);
  assert.equal(checksTotal(sumBoth), 9);
});
