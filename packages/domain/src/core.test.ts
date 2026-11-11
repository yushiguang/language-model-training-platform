import {test} from 'node:test';
import assert from 'node:assert/strict';
import {applyFix, checkTemplate, diffLines, diffWords, renderPrompt, withReasons} from './template.ts';
import {pageFromPath} from './pages.ts';
import {computeMetrics, judge, DEFAULT_THRESHOLDS} from './metrics.ts';
import {nextVersion, versionLabel} from './versions.ts';
import type {Schema} from '@tsp/contracts';

const sel = {video: ['Description', 'Frame'], photo_text: ['Description', 'Title'], metadata: ['Language']};

test('check finds unknown, unticked and unused features', () => {
  const t = 'Title: {{Title}}\nText: {{OCR}}\nDesc: {{Description}}\nASR: {{ASR}}\nLang: {{Language}}';
  const r = checkTemplate(t, sel);
  const codes = r.errors.map(e => `${e.code}:${e.key ?? ''}`).sort();
  assert.deepEqual(codes, ['not_ticked:ASR', 'unknown_key:OCR', 'unused_feature:Frame']);
  assert.equal(r.errors.find(e => e.code === 'unknown_key')!.fixes[0].fix.kind, 'replace');
  const fixed = applyFix(t, sel, {kind: 'replace', from: '{{OCR}}', to: '{{OCR_Text}}'});
  assert.ok(fixed.template.includes('{{OCR_Text}}'));
});

test('single braces are text, broken double braces are errors', () => {
  const ok = checkTemplate('Return {"a": 1}\nDesc: {{Description}}\nF {{Frame}} T {{Title}} L {{Language}}', sel);
  assert.equal(ok.errors.length, 0);
  const bad = checkTemplate('Desc: {{Description}\n{{Frame}} {{Title}} {{Language}}', sel);
  assert.equal(bad.errors.filter(e => e.code === 'broken_braces').length, 1);
});

test('render drops lines not ticked for the example type and fills empty with none', () => {
  const t = 'Title: {{Title}}\nDesc: {{Description}}\nLang: {{Language}}\nFrames: {{Frame}}';
  const parts = renderPrompt(t, {type: 'video', features: {Description: 'hello', Language: '', Frame: ['f1.jpg', 'f2.jpg']}}, sel);
  const text = parts.filter(p => p.type === 'text').map(p => (p as {text: string}).text).join('');
  assert.ok(!text.includes('Title'));
  assert.ok(text.includes('Desc: hello'));
  assert.ok(text.includes('Lang: none'));
  assert.equal(parts.filter(p => p.type === 'image').length, 2);
});

test('images sit where their placeholders were, and captions stay out of the text', () => {
  const t = 'Desc: {{Description}}\nFrames: {{Frame}}\nLogo: [Image 1]\nEnd';
  const parts = renderPrompt(t, {type: 'video', features: {Description: 'hi', Title: '', Language: '', Frame: ['f1.jpg', 'f2.jpg']}}, sel, [{url: 'logo.png', name: 'logo.png', size: 1}]);
  assert.deepEqual(
    parts.map(p => (p.type === 'text' ? p.text : p.url)),
    ['Desc: hi\nFrames: ', 'f1.jpg', 'f2.jpg', '\nLogo: ', 'logo.png', '\nEnd'],
  );
  const images = parts.filter(p => p.type === 'image');
  assert.deepEqual(images.map(p => p.source), ['example', 'example', 'prompt']);
  assert.match(images[1].caption, /2 of 2 · from the example/);
  assert.match(images[2].caption, /Image 1 · part of the prompt/);
  const text = parts.filter(p => p.type === 'text').map(p => p.text).join('');
  assert.ok(!text.includes('[Frame') && !text.includes('of 2'));
});

test('pages are found from the URL path, with or without a base path', () => {
  assert.equal(pageFromPath('/report/'), 'report');
  assert.equal(pageFromPath('/language-model-training-platform/prompt/edit/'), 'prompt_edit');
  assert.equal(pageFromPath('/training-set.html'), 'training');
  assert.equal(pageFromPath('/'), 'projects');
});

test('macro-F1 and pass judgement', () => {
  const schema: Schema = {fields: [{name: 'f', kind: 'single', values: [{name: 'a', definition: ''}, {name: 'b', definition: ''}]}]};
  const items = [
    {exampleId: '1', gold: {f: ['a']}, predicted: {f: ['a']}, costUsd: 0.001},
    {exampleId: '2', gold: {f: ['b']}, predicted: {f: ['a']}, costUsd: 0.001},
    {exampleId: '3', gold: {f: ['b']}, predicted: {f: ['b']}, costUsd: 0.001},
    {exampleId: '4', gold: {f: ['b']}, predicted: null, costUsd: 0.001},
  ];
  const m = computeMetrics(schema, [...items, {exampleId: '5', gold: {f: ['a']}, predicted: null, filtered: true, costUsd: 0}]);
  // R4-6: the invalid (4) and filtered (5) answers are left out. a: p=0.5 r=1 f1=0.667; b: p=1 r=1/2 f1=0.667
  assert.equal(m.fields[0].macroF1, 0.667);
  assert.deepEqual([m.n, m.total, m.invalid, m.filtered, m.invalidRate], [3, 5, 1, 1, 0.2]);
  assert.equal(m.mixUps[0].count, 1);
  // The invalid cap is always checked: 20% invalid fails even with a passing score.
  const lenient = {...DEFAULT_THRESHOLDS, macroF1: 0.5};
  const j = judge(m, lenient, 30);
  assert.equal(j.passed, false);
  assert.deepEqual(j.checks.find(c => c.label === 'Invalid outputs'), {label: 'Invalid outputs', actual: '20%', need: '≤ 1.0%', met: false});
  assert.equal(judge(computeMetrics(schema, items.slice(0, 3)), lenient, 30).passed, true);
});

test('versions: Save makes the next minor, Save as new version the next major, an Optimiser run its reserved major', () => {
  const all = [{major: 1, minor: 0}, {major: 1, minor: 4}, {major: 2, minor: 0}];
  assert.deepEqual(nextVersion(all, {major: 1}, 'minor'), {major: 1, minor: 5});
  assert.deepEqual(nextVersion(all, {major: 2}, 'minor'), {major: 2, minor: 1});
  assert.deepEqual(nextVersion(all, {major: 1}, 'major'), {major: 3, minor: 0});
  assert.deepEqual(nextVersion([], null, 'minor'), {major: 1, minor: 0});
  // An Optimiser run reserved v3: its first change is v3.1, and a user's new major skips to v4.
  assert.deepEqual(nextVersion(all, {major: 2}, 'minor', {inMajor: 3}), {major: 3, minor: 1});
  assert.deepEqual(nextVersion(all, {major: 2}, 'major', {reserved: [3]}), {major: 4, minor: 0});
  assert.equal(versionLabel({major: 13, minor: 0}), 'v13');
  assert.equal(versionLabel({major: 4, minor: 2}), 'v4.2');
});

test('diff', () => {
  const d = diffLines('a\nb\nc', 'a\nx\nc\nd');
  assert.deepEqual(d.map(l => l.kind), ['same', 'del', 'add', 'same', 'add']);
});

test('[Image N] without prompt image N is an error, so deleting an image used in the prompt is caught at Save', () => {
  const t = 'Look at [Image 1] and [Image 2].\nDesc: {{Description}}\nF {{Frame}} T {{Title}} L {{Language}}';
  const one = [{id: 'im_1', url: 'a.png', name: 'a'}] as never[];
  const r = checkTemplate(t, sel, {images: one});
  assert.deepEqual(r.errors.map(e => e.code), ['missing_image']);
  assert.match(r.errors[0].message, /\[Image 2\].*only 1 image/);
  assert.equal(checkTemplate(t, sel, {images: [...one, ...one]}).errors.length, 0);
});

test('a multi-select answer with the same value twice keeps it once', async () => {
  const {parseOutput} = await import('./labels.ts');
  const schema: Schema = {fields: [{name: 'topic', kind: 'multi', values: [{name: 'Food', definition: ''}, {name: 'Travel', definition: ''}]}]};
  assert.deepEqual(parseOutput('{"topic": ["Food", "Food", "Travel"]}', schema).answer, {topic: ['Food', 'Travel']});
});

test('change marks: word-level diff with removed text before added text', () => {
  const a = 'Creator: {{Creator_Nick_Name}} · {{Creator_Bio}}\nVlog: own day';
  const b = 'Creator: {{Creator_Nick_Name}}\nVlog: own day; not a cut';
  const d = diffWords(a, b);
  assert.deepEqual(d, [
    {kind: 'same', text: 'Creator: {{Creator_Nick_Name}}'},
    {kind: 'del', text: ' · {{Creator_Bio}}'},
    {kind: 'same', text: '\nVlog: own day'},
    {kind: 'add', text: '; not a cut'},
  ]);
  assert.equal(d.filter(s => s.kind !== 'del').map(s => s.text).join(''), b);
  const r = withReasons(d, [{text: 'not a cut from someone else', reason: '5 Clips were read as Vlog'}, {text: 'Untick Creator Bio', reason: 'Bio was empty'}]);
  assert.equal(r[3].reason, '5 Clips were read as Vlog');
  assert.equal(r[1].reason, 'Bio was empty');
  assert.equal(diffWords('same', 'same').length, 1);
  assert.deepEqual(diffWords('a b c d', 'a x y d').map(s => s.kind), ['same', 'del', 'add', 'same']);
});
