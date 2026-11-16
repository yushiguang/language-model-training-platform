import assert from 'node:assert/strict';
import test from 'node:test';
import type {StructuredPrompt} from '@tsp/contracts';
import {addFieldRule, checkStructured, checkTemplate, compilePrompt, emptyStructuredPrompt, normalizeStructured, partsToText, readStructured, renderPrompt, rewordOnly, SAMPLE_SCHEMA, sameSignature, signatureOf, structuredChangeSummary, structuredFromSchema, tidyStructured, parseOutput, schemaOf, toFeatures} from './index.ts';

const TICKED = {video: ['Description', 'OCR_Text', 'ASR'], photo_text: ['Title', 'Description', 'OCR_Text'], metadata: []};
const prompt = (): StructuredPrompt => ({
  ...structuredFromSchema(SAMPLE_SCHEMA, 'Tag short videos for a recommendation team.', structuredClone(TICKED)),
  ruleGroups: [{id: 'rg1', title: 'Thin evidence', content: 'When the evidence is thin, prefer Other.'}],
});

test('compilePrompt: the same parts always give the same text, and the editor checks pass by construction', () => {
  const p = prompt();
  const text = compilePrompt(p);
  assert.equal(text, compilePrompt(structuredClone(p)));
  const check = checkTemplate(text, p.features, {schema: schemaOf(p), images: p.images});
  assert.deepEqual(check.errors, []);
  assert.ok(!check.warnings.some(w => w.code === 'value_missing'));
  assert.match(text, /^<persona_and_task>\nTag short videos for a recommendation team\.\n<\/persona_and_task>/);
  assert.match(text, /<input_features>\n {2}<feature name="Title">\{\{Title\}\}<\/feature>\n {2}<feature name="Description">\{\{Description\}\}<\/feature>/);
  assert.match(text, /<field name="topics" selection="multi" min="1" max="3">/);
  assert.match(text, /<field name="primary_value" selection="single">/);
  assert.match(text, /<label value="Vlog">the poster's own day or life, on camera<\/label>/);
  assert.match(text, /<rules>\n {2}<rule_group name="Thin evidence">\nWhen the evidence is thin, prefer Other\.\n {2}<\/rule_group>\n<\/rules>/);
  assert.match(text, /<output_format>\nReturn one JSON object only/);
  assert.match(text, /"format": "Vlog \| Tutorial \| Review \| Skit \| Clip \| Other"/);
  // The sections come in authoring order.
  const order = ['<persona_and_task>', '<input_features>', '<output_labels>', '<rules>', '<output_format>'].map(tag => text.indexOf(tag));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test('compilePrompt: a feature line is left out for a type that does not load it, and an empty feature reads "none"', () => {
  const p = prompt();
  const text = compilePrompt(p);
  const video = partsToText(renderPrompt(text, {type: 'video', features: toFeatures({Description: 'A day out', OCR_Text: ''})}, p.features, p.images));
  assert.match(video, /<feature name="Description">A day out<\/feature>/);
  assert.match(video, /<feature name="OCR Text">none<\/feature>/);
  assert.ok(!video.includes('<feature name="Title">'), 'Title is ticked for photo and text only');
  const photo = partsToText(renderPrompt(text, {type: 'photo_text', features: toFeatures({Title: 'Soup'})}, p.features, p.images));
  assert.match(photo, /<feature name="Title">Soup<\/feature>/);
  assert.ok(!photo.includes('<feature name="ASR">'));
});

test('compilePrompt: the output it asks for is what parseOutput reads', () => {
  const p = prompt();
  const got = parseOutput('{"reason": "r", "primary_value": "Practical", "format": "Tutorial", "topics": ["Tech"]}', schemaOf(p));
  assert.deepEqual(got.answer, {primary_value: ['Practical'], format: ['Tutorial'], topics: ['Tech']});
});

test('signature: wording changes keep it, names and bounds change it', () => {
  const a = prompt();
  const b = structuredClone(a);
  b.fields[0].values[0].definition = 'new wording';
  b.ruleGroups[0].content = 'other rules';
  b.taskSummary = 'other task';
  assert.ok(sameSignature(signatureOf(a), signatureOf(b)));
  assert.equal(structuredChangeSummary(a, b), 'Changed task summary, 1 definition, 1 rule group');
  const c = structuredClone(a);
  c.fields[0].values[0].name = 'Fun';
  assert.ok(!sameSignature(signatureOf(a), signatureOf(c)));
  const d = structuredClone(a);
  d.fields[2].max = 2;
  assert.ok(!sameSignature(signatureOf(a), signatureOf(d)));
});

test('checkStructured: names what stops a save', () => {
  assert.deepEqual(checkStructured(prompt()), []);
  const p = prompt();
  p.fields[1].values = [p.fields[1].values[0]];
  p.fields[0].values[1].name = p.fields[0].values[0].name;
  p.features = {video: [], photo_text: [], metadata: []};
  assert.deepEqual(checkStructured(p).map(i => i.message), ['Tick at least one input feature', 'primary_value has the value Entertainment twice', 'format needs at least 2 values']);
});

test('a new prompt starts with nothing ticked and no rules (2026-11-16 refinements, 2.1)', () => {
  assert.deepEqual(emptyStructuredPrompt(), {taskSummary: '', features: {video: [], photo_text: [], metadata: []}, fields: [], ruleGroups: [], images: []});
});

test('compilePrompt: no rules section without rules; names are escaped in attributes', () => {
  const p = prompt();
  p.ruleGroups = [{id: 'rg1', title: 'Empty', content: '  '}];
  p.fields[1].values[0].name = 'Say "hi" & <wave>';
  const text = compilePrompt(p);
  assert.ok(!text.includes('<rules>'));
  assert.match(text, /<label value="Say &quot;hi&quot; &amp; &lt;wave&gt;">/);
});

test('rule groups: a group with rules needs a title; empty groups are dropped on tidy', () => {
  const p = prompt();
  p.ruleGroups.push({id: 'rg2', title: ' ', content: 'Some rule'}, {id: 'rg3', title: '', content: ''});
  assert.deepEqual(checkStructured(p).map(i => [i.where, i.group, i.message]), [['rules', 'rg2', 'A rule group has rules but no title']]);
  assert.deepEqual(tidyStructured(p).ruleGroups.map(g => g.id), ['rg1', 'rg2']);
});

test('rule groups: a rewording keeps the ids of the groups it continues, matched by title when ids are missing', () => {
  const base = prompt();
  const next = rewordOnly(base, {ruleGroups: [{id: '', title: 'Thin evidence', content: 'Sharper.'}, {id: '', title: 'Priority', content: 'Decide format first.'}]} as Partial<StructuredPrompt>);
  assert.deepEqual(next.ruleGroups, [
    {id: 'rg1', title: 'Thin evidence', content: 'Sharper.'},
    {id: 'rg2', title: 'Priority', content: 'Decide format first.'},
  ]);
  assert.equal(structuredChangeSummary(base, next), 'Changed 2 rule groups');
  const read = readStructured({fields: base.fields, ruleGroups: [{title: 'A', content: 'x'}, 'junk', {title: 'B', content: 'y'}]}, base);
  assert.deepEqual(read?.ruleGroups.map(g => [g.id, g.title]), [['rg1', 'A'], ['rg2', 'B']]);
});

test('addFieldRule puts a rule in the group for its field, made when missing', () => {
  const p = addFieldRule(addFieldRule(prompt(), 'format', 'Rule one.'), 'format', 'Rule two.');
  assert.deepEqual(p.ruleGroups.at(-1), {id: 'rg2', title: 'format rules', content: 'Rule one.\nRule two.'});
  assert.equal(addFieldRule(prompt(), 'nope', 'R.').ruleGroups.at(-1)?.title, 'General rules');
});

test('a prompt saved before rule groups reads as rule groups', () => {
  const old = {...prompt(), ruleGroups: undefined, generalRules: 'Prefer Other.', fields: prompt().fields.map((f, i) => (i === 1 ? {...f, note: 'Clip beats Vlog.'} : f))} as unknown as StructuredPrompt;
  const now = normalizeStructured(old);
  assert.deepEqual(now.ruleGroups, [
    {id: 'rg1', title: 'General rules', content: 'Prefer Other.'},
    {id: 'rg2', title: 'format rules', content: 'Clip beats Vlog.'},
  ]);
  assert.ok(!('generalRules' in now) && now.fields.every(f => !('note' in f)));
  assert.match(compilePrompt(old), /<rule_group name="format rules">\nClip beats Vlog\./);
});
