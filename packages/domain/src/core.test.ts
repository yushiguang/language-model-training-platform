import {test} from 'node:test';
import assert from 'node:assert/strict';
import {applyFix, checkTemplate, diffLines, diffWords, renderPrompt, withReasons, toFeatures} from './template.ts';
import {pageFromPath} from './pages.ts';
import {computeMetrics, judge, DEFAULT_THRESHOLDS} from './metrics.ts';
import {nextVersion, versionLabel} from './versions.ts';
import type {Schema} from '@yushiguang/sprint-contracts';

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
  const parts = renderPrompt(t, {type: 'video', features: toFeatures({Description: 'hello', Language: '', Frame: ['f1.jpg', 'f2.jpg']})}, sel);
  const text = parts.filter(p => p.type === 'text').map(p => (p as {text: string}).text).join('');
  assert.ok(!text.includes('Title'));
  assert.ok(text.includes('Desc: hello'));
  assert.ok(text.includes('Lang: none'));
  assert.equal(parts.filter(p => p.type === 'image').length, 2);
});

test('images sit where their placeholders were, and captions stay out of the text', () => {
  const t = 'Desc: {{Description}}\nFrames: {{Frame}}\nLogo: [Image 1]\nEnd';
  const parts = renderPrompt(t, {type: 'video', features: toFeatures({Description: 'hi', Title: '', Language: '', Frame: ['f1.jpg', 'f2.jpg']})}, sel, [{url: 'logo.png', name: 'logo.png', size: 1}]);
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
  assert.equal(pageFromPath('/gold/'), 'gold');
  assert.equal(pageFromPath('/language-model-training-platform/prompt/edit/'), 'prompt_edit');
  assert.equal(pageFromPath('/prompt-design.html'), 'prompt_design');
  assert.equal(pageFromPath('/'), 'projects');
});

test('macro-F1 and pass judgement', () => {
  const schema: Schema = {name: 'f', kind: 'single', values: [{name: 'a', definition: ''}, {name: 'b', definition: ''}]};
  const items = [
    {exampleId: '1', gold: ['a'], predicted: ['a'], costUsd: 0.001},
    {exampleId: '2', gold: ['b'], predicted: ['a'], costUsd: 0.001},
    {exampleId: '3', gold: ['b'], predicted: ['b'], costUsd: 0.001},
    {exampleId: '4', gold: ['b'], predicted: null, costUsd: 0.001},
  ];
  const m = computeMetrics(schema, [...items, {exampleId: '5', gold: ['a'], predicted: null, filtered: true, costUsd: 0}]);
  // R4-6: the invalid (4) and filtered (5) answers are left out. a: p=0.5 r=1 f1=0.667; b: p=1 r=1/2 f1=0.667
  assert.equal(m.macroF1, 0.667);
  assert.equal(m.accuracy, 0.667);
  assert.deepEqual(m.lowestValue, {value: 'a', f1: 0.667});
  assert.deepEqual(m.mixUps, [{kind: 'confused', gold: 'b', predicted: 'a', count: 1, exampleIds: ['2']}]);
  assert.equal(judge(m, DEFAULT_THRESHOLDS, 30).checks[0].label, 'Macro-F1');
  assert.deepEqual([m.n, m.total, m.invalid, m.filtered, m.invalidRate], [3, 5, 1, 1, 0.2]);
  assert.equal(m.mixUps[0].count, 1);
  // The invalid cap is always checked: 20% invalid fails even with a passing score.
  const lenient = {...DEFAULT_THRESHOLDS, macroF1: 0.5};
  const j = judge(m, lenient, 30);
  assert.equal(j.passed, false);
  assert.deepEqual(j.checks.find(c => c.label === 'Invalid outputs'), {label: 'Invalid outputs', msg: {key: 'Invalid outputs'}, actual: '20%', need: '≤ 1.0%', met: false});
  assert.equal(judge(computeMetrics(schema, items.slice(0, 3)), lenient, 30).passed, true);
  // Review 2026-11-13: the count is of gold-labeled eval examples; under minEval it is a rough
  // reading and never passes, however good the score.
  const few = judge(computeMetrics(schema, items.slice(0, 3)), lenient, 4);
  assert.deepEqual([few.passed, few.rough], [false, true]);
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

test('a single-select answer is exactly one value of the label; a one-item list is read as that value', async () => {
  const {parseOutput} = await import('./labels.ts');
  const schema: Schema = {name: 'topic', kind: 'single', values: [{name: 'Food', definition: ''}, {name: 'Travel', definition: ''}]};
  assert.deepEqual(parseOutput('{"reason": "x", "topic": "Food"}', schema).answer, ['Food']);
  assert.deepEqual(parseOutput('{"topic": ["Travel"]}', schema).answer, ['Travel']);
  assert.equal(parseOutput('{"topic": ["Travel", "Travel"]}', schema).reason, 'topic lists a value twice');
  assert.equal(parseOutput('{"topic": ["Food", "Travel"]}', schema).reason, 'topic needs exactly one value');
  assert.equal(parseOutput('{"topic": "Games"}', schema).reason, '"Games" isn\'t a value of topic');
  assert.equal(parseOutput('{"other": "Food"}', schema).answer, null);
});

test('a multi-select answer is a list within the bounds, in label order, with an exclusive value on its own', async () => {
  const {parseOutput, sameAnswer} = await import('./labels.ts');
  const schema: Schema = {name: 'tags', kind: 'multi', min: 1, max: 2, values: [{name: 'Food', definition: ''}, {name: 'Travel', definition: ''}, {name: 'Pets', definition: ''}, {name: 'None', definition: '', exclusive: true}]};
  assert.deepEqual(parseOutput('{"tags": ["Travel", "Food"]}', schema).answer, ['Food', 'Travel']);
  assert.deepEqual(parseOutput('{"tags": "Pets"}', schema).answer, ['Pets']);
  assert.deepEqual(parseOutput('{"tags": ["None"]}', schema).answer, ['None']);
  assert.equal(parseOutput('{"tags": []}', schema).reason, 'tags needs 1 to 2 values');
  assert.equal(parseOutput('{"tags": ["Food", "Travel", "Pets"]}', schema).reason, 'tags needs 1 to 2 values');
  assert.equal(parseOutput('{"tags": ["Food", "None"]}', schema).reason, '"None" must be the only value of tags');
  assert.equal(sameAnswer(['Travel', 'Food'], ['Food', 'Travel']), true);
  assert.equal(sameAnswer(['Food'], ['Food', 'Travel']), false);
});

test('multi-select scores: a value counts wherever it is in the list; accuracy needs the exact set', () => {
  const schema: Schema = {name: 'tags', kind: 'multi', min: 1, max: 2, values: [{name: 'a', definition: ''}, {name: 'b', definition: ''}]};
  const m = computeMetrics(schema, [
    {exampleId: '1', gold: ['a', 'b'], predicted: ['a', 'b'], costUsd: 0},
    {exampleId: '2', gold: ['a'], predicted: ['a', 'b'], costUsd: 0},
    {exampleId: '3', gold: ['a', 'b'], predicted: ['a'], costUsd: 0},
  ]);
  // a: all right (f1 1); b: tp 1, fp 1, fn 1 (f1 0.5). Exact sets: 1 of 3.
  assert.equal(m.macroF1, 0.75);
  assert.equal(m.accuracy, 0.333);
  assert.deepEqual(m.mixUps.map(x => [x.kind, x.gold, x.predicted, x.exampleIds]), [
    ['extra', null, 'b', ['2']],
    ['missed', 'b', null, ['3']],
  ]);
});

test('gold labels from upload files: the value, a list, or an older file\'s one-item list', async () => {
  const {readGoldAnswer} = await import('./labels.ts');
  const schema: Schema = {name: 'topic', kind: 'single', values: [{name: 'Food', definition: ''}, {name: 'Travel', definition: ''}]};
  assert.deepEqual(readGoldAnswer('Food', schema), ['Food']);
  assert.deepEqual(readGoldAnswer({topic: ['Travel']}, schema), ['Travel']);
  assert.deepEqual(readGoldAnswer({primary: ['Food']}, schema), ['Food']);
  assert.deepEqual(readGoldAnswer({tags: ['Travel', 'Food', 'Food']}, {...schema, name: 'tags', kind: 'multi', max: 2}), ['Food', 'Travel']);
  assert.equal(readGoldAnswer({a: ['Food'], b: ['Travel']}, schema), null);
  assert.equal(readGoldAnswer({topic: ['Food', 'Travel']}, schema), null);
  assert.equal(readGoldAnswer('Games', schema), null);
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

test('label files: CSV with an id and an answer column, or JSONL; rows numbered as in the file (#31)', async () => {
  const {readLabelFile, csvCells} = await import('./label-file.ts');
  assert.deepEqual(csvCells('a,"b, c","say ""hi"""'), ['a', 'b, c', 'say "hi"']);
  const csv = readLabelFile('l.csv', 'item_id,answer\n1,Food\n\n2,"Food|Travel"\n,Food\n', 'topic');
  assert.ok(!('error' in csv));
  if ('error' in csv) return;
  assert.deepEqual(csv.rows, [
    {row: 2, externalId: '1', answer: 'Food'},
    {row: 4, externalId: '2', answer: ['Food', 'Travel']},
  ]);
  assert.deepEqual(csv.bad, [{row: 5, reason: 'The row has no item id'}]);
  // The label's own name may head the answer column.
  const named = readLabelFile('l.csv', 'video_id,topic\n7,Travel', 'topic');
  assert.ok(!('error' in named) && named.rows[0].answer === 'Travel');
  assert.ok('error' in readLabelFile('l.csv', 'id,value\n1,Food', 'topic'));
  const jl = readLabelFile('l.jsonl', '{"item_id":"1","answer":"Food"}\nnot json\n{"externalId":"2","topic":["Travel"]}\n', 'topic');
  assert.ok(!('error' in jl));
  if ('error' in jl) return;
  assert.deepEqual(jl.rows.map(r => [r.row, r.externalId]), [[1, '1'], [3, '2']]);
  assert.deepEqual(jl.bad, [{row: 2, reason: 'The row is not valid JSON'}]);
  assert.ok('error' in readLabelFile('l.txt', '1 Food', 'topic'));
});
