import {test} from 'node:test';
import assert from 'node:assert/strict';
import {applyFix, checkTemplate, diffLines, renderPrompt} from './template.ts';
import {computeMetrics, judge, DEFAULT_THRESHOLDS} from './metrics.ts';
import {nextVersion} from './versions.ts';
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

test('macro-F1 and pass judgement', () => {
  const schema: Schema = {policy: '', fields: [{name: 'f', kind: 'single', values: [{name: 'a', definition: ''}, {name: 'b', definition: ''}]}]};
  const items = [
    {exampleId: '1', gold: {f: ['a']}, predicted: {f: ['a']}, costUsd: 0.001},
    {exampleId: '2', gold: {f: ['b']}, predicted: {f: ['a']}, costUsd: 0.001},
    {exampleId: '3', gold: {f: ['b']}, predicted: {f: ['b']}, costUsd: 0.001},
    {exampleId: '4', gold: {f: ['b']}, predicted: null, costUsd: 0.001},
  ];
  const m = computeMetrics(schema, items);
  // a: p=0.5 r=1 f1=0.667; b: p=1 r=1/3 f1=0.5
  assert.equal(m.fields[0].macroF1, 0.584);
  assert.equal(m.invalid, 1);
  assert.equal(m.mixUps[0].count, 1);
  assert.equal(judge(m, DEFAULT_THRESHOLDS, 30).passed, false);
});

test('versions: save is next minor in its line, save as is next major', () => {
  const all = [{major: 1, minor: 0}, {major: 1, minor: 4}, {major: 2, minor: 0}];
  assert.deepEqual(nextVersion(all, {major: 1}, 'minor'), {major: 1, minor: 5});
  assert.deepEqual(nextVersion(all, {major: 1}, 'major'), {major: 3, minor: 0});
  assert.deepEqual(nextVersion([], null, 'minor'), {major: 1, minor: 0});
});

test('diff', () => {
  const d = diffLines('a\nb\nc', 'a\nx\nc\nd');
  assert.deepEqual(d.map(l => l.kind), ['same', 'del', 'add', 'same', 'add']);
});
