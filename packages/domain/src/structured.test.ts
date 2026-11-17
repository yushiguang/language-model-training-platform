import assert from 'node:assert/strict';
import test from 'node:test';
import type {StructuredPrompt} from '@tsp/contracts';
import {addRule, addToDefinition, checkStructured, checkTemplate, compilePrompt, emptyStructuredPrompt, normalizeStructured, partsToText, readStructured, renderPrompt, rewordOnly, SAMPLE_SCHEMA, sameSignature, signatureOf, structuredChangeSummary, structuredFromSchema, tidyStructured, parseOutput, schemaOf, toFeatures} from './index.ts';

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
  assert.match(text, /<output_labels name="primary_value" selection="single">\n {2}<label value="Entertainment">\nfun, emotion or story; nothing usable left afterwards\n {2}<\/label>/);
  assert.match(text, /<rules>\n {2}<rule_group name="Thin evidence">\nWhen the evidence is thin, prefer Other\.\n {2}<\/rule_group>\n<\/rules>/);
  assert.match(text, /<output_format>\nReturn one JSON object only/);
  assert.match(text, /with the exact key "primary_value" and exactly one allowed value from <output_labels>:\n\{"primary_value": "Entertainment \| Practical \| Discussion \| Ecosystem issue"\}/);
  // The sections come in authoring order.
  const order = ['<persona_and_task>', '<input_features>', '<output_labels ', '<rules>', '<output_format>'].map(tag => text.indexOf(tag));
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
  const got = parseOutput('{"reason": "r", "primary_value": "Practical"}', schemaOf(p));
  assert.deepEqual(got.answer, ['Practical']);
});

test('compilePrompt: a multi-select label asks for a list within its bounds, and an exclusive value on its own', () => {
  const p = prompt();
  p.label = {...p.label, kind: 'multi', min: 1, max: 2, values: [...p.label.values, {name: 'None', definition: 'nothing fits', exclusive: true}]};
  const text = compilePrompt(p);
  assert.match(text, /<output_labels name="primary_value" selection="multi" min="1" max="2">/);
  assert.match(text, /<label value="None" exclusive="true">/);
  assert.match(text, /a list of 1 to 2 allowed values from <output_labels>, each at most once:\n\{"primary_value": \["Entertainment" \| /);
  assert.match(text, /A value marked exclusive="true" is always the only value in the list\./);
  assert.deepEqual(parseOutput('{"primary_value": ["Practical", "Entertainment"]}', schemaOf(p)).answer, ['Entertainment', 'Practical']);
  assert.deepEqual(checkStructured(p), []);
  p.label.max = 9;
  assert.deepEqual(checkStructured(p).map(i => i.message), ['The most values must be between 1 and 5']);
  // Switching selection changes what answers are allowed, so it is a new signature.
  assert.ok(!sameSignature(signatureOf(prompt()), signatureOf(p)));
  assert.equal(structuredChangeSummary({...p, label: {...p.label, max: 2}}, p), 'Changed selection');
});

test('signature: wording changes keep it, the key and value names change it', () => {
  const a = prompt();
  const b = structuredClone(a);
  b.label.values[0].definition = 'new wording';
  b.ruleGroups[0].content = 'other rules';
  b.taskSummary = 'other task';
  assert.ok(sameSignature(signatureOf(a), signatureOf(b)));
  assert.equal(structuredChangeSummary(a, b), 'Changed task summary, 1 definition, 1 rule group');
  const c = structuredClone(a);
  c.label.values[0].name = 'Fun';
  assert.ok(!sameSignature(signatureOf(a), signatureOf(c)));
  const d = structuredClone(a);
  d.label.name = 'category';
  assert.ok(!sameSignature(signatureOf(a), signatureOf(d)));
});

test('checkStructured: names what stops a save', () => {
  assert.deepEqual(checkStructured(prompt()), []);
  const p = prompt();
  p.label.values[1].name = p.label.values[0].name;
  p.features = {video: [], photo_text: [], metadata: []};
  assert.deepEqual(checkStructured(p).map(i => i.message), ['Tick at least one input feature', 'The value Entertainment is there twice']);
  const q = prompt();
  q.label = {name: ' ', kind: 'single', values: [{name: 'Only', definition: ''}]};
  assert.deepEqual(checkStructured(q).map(i => i.message), ['Name the label', 'The label needs at least 2 values']);
});

test('a new prompt starts with nothing ticked and no rules (2026-11-16 refinements, 2.1)', () => {
  assert.deepEqual(emptyStructuredPrompt(), {taskSummary: '', features: {video: [], photo_text: [], metadata: []}, label: {name: '', kind: 'single', values: []}, ruleGroups: [], images: []});
});

test('compilePrompt: no rules section without rules; names are escaped in attributes', () => {
  const p = prompt();
  p.ruleGroups = [{id: 'rg1', title: 'Empty', content: '  '}];
  p.label.values[0].name = 'Say "hi" & <wave>';
  p.label.values[1].definition = '';
  const text = compilePrompt(p);
  assert.ok(!text.includes('<rules>'));
  assert.match(text, /<label value="Say &quot;hi&quot; &amp; &lt;wave&gt;">/);
  // An empty definition is a self-closing tag; a multi-line one keeps its lines.
  assert.match(text, /<label value="Practical"\/>/);
  const multi = compilePrompt(addToDefinition(prompt(), 'Discussion', '- Not a clip with no comment.'));
  assert.match(multi, /<label value="Discussion">\n- the poster's own added view, inviting replies \(a clip with no added comment is not Discussion\)\n- Not a clip with no comment\.\n {2}<\/label>/);
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
  const read = readStructured({label: base.label, ruleGroups: [{title: 'A', content: 'x'}, 'junk', {title: 'B', content: 'y'}]}, base);
  assert.deepEqual(read?.ruleGroups.map(g => [g.id, g.title]), [['rg1', 'A'], ['rg2', 'B']]);
});

test('addRule puts a cross-value rule in the group with that title, made when missing', () => {
  const p = addRule(addRule(prompt(), 'Label priority', 'Rule one.'), 'label priority', 'Rule two.');
  assert.deepEqual(p.ruleGroups.at(-1), {id: 'rg2', title: 'Label priority', content: 'Rule one.\nRule two.'});
});

test('a rewording keeps the key and value names; a model that writes a list of fields has its first read as the label', () => {
  const base = prompt();
  const next = rewordOnly(base, {label: {name: 'renamed', values: [{name: 'Practical', definition: 'sharper'}, {name: 'New', definition: 'x'}]}} as Partial<StructuredPrompt>);
  assert.deepEqual(signatureOf(next), signatureOf(base));
  assert.equal(next.label.values.find(v => v.name === 'Practical')?.definition, 'sharper');
  const old = readStructured({fields: [{name: 'kind', values: ['A', {name: 'B', definition: 'b'}]}, {name: 'other', values: ['x', 'y']}]});
  assert.deepEqual(old?.label, {name: 'kind', kind: 'single', values: [{name: 'A', definition: ''}, {name: 'B', definition: 'b'}]});
});

test('a prompt saved before single-label projects reads with its first field as the label and its notes as rule groups', () => {
  const {label: _l, ...rest} = prompt();
  const old = {
    ...rest,
    ruleGroups: undefined,
    generalRules: 'Prefer Other.',
    fields: [
      {name: 'primary_value', kind: 'single', values: SAMPLE_SCHEMA.values},
      {name: 'format', kind: 'single', note: 'Clip beats Vlog.', values: [{name: 'Clip', definition: ''}, {name: 'Vlog', definition: ''}]},
    ],
  } as unknown as StructuredPrompt;
  const now = normalizeStructured(old);
  assert.deepEqual(now.ruleGroups, [
    {id: 'rg1', title: 'General rules', content: 'Prefer Other.'},
    {id: 'rg2', title: 'format rules', content: 'Clip beats Vlog.'},
  ]);
  assert.ok(!('generalRules' in now) && !('fields' in now));
  assert.deepEqual(signatureOf(now), {name: 'primary_value', kind: 'single', values: SAMPLE_SCHEMA.values.map(v => v.name)});
  assert.match(compilePrompt(old), /<rule_group name="format rules">\nClip beats Vlog\./);
});
