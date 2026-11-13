import assert from 'node:assert/strict';
import test from 'node:test';
import {checkStructured, checkTemplate, compilePrompt, partsToText, renderPrompt, SAMPLE_SCHEMA, sameSignature, signatureOf, structuredChangeSummary, structuredFromSchema, parseOutput, schemaOf} from './index.ts';

const prompt = () => ({...structuredFromSchema(SAMPLE_SCHEMA, 'Tag short videos for a recommendation team.'), generalRules: 'When the evidence is thin, prefer Other.'});

test('compilePrompt: the same parts always give the same text, and the editor checks pass by construction', () => {
  const p = prompt();
  const text = compilePrompt(p);
  assert.equal(text, compilePrompt(structuredClone(p)));
  const check = checkTemplate(text, p.features, {schema: schemaOf(p), images: p.images});
  assert.deepEqual(check.errors, []);
  assert.ok(!check.warnings.some(w => w.code === 'value_missing'));
  assert.match(text, /### 3\. topics \(choose 1 to 3\)/);
  assert.match(text, /### 1\. primary_value \(choose exactly 1\)/);
  assert.match(text, /- Vlog: the poster's own day or life, on camera/);
  assert.match(text, /## Rules\nWhen the evidence is thin, prefer Other\./);
  assert.match(text, /"format": "Vlog \| Tutorial \| Review \| Skit \| Clip \| Other"/);
});

test('compilePrompt: a feature line is left out for a type that does not load it, and an empty feature reads "none"', () => {
  const p = prompt();
  const text = compilePrompt(p);
  const video = partsToText(renderPrompt(text, {type: 'video', features: {Description: 'A day out', OCR_Text: ''}}, p.features, p.images));
  assert.match(video, /Description: A day out/);
  assert.match(video, /OCR Text: none/);
  assert.ok(!video.includes('Title:'), 'Title is ticked for photo and text only');
  const photo = partsToText(renderPrompt(text, {type: 'photo_text', features: {Title: 'Soup'}}, p.features, p.images));
  assert.match(photo, /Title: Soup/);
  assert.ok(!photo.includes('ASR:'));
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
  b.generalRules = 'other rules';
  b.taskSummary = 'other task';
  assert.ok(sameSignature(signatureOf(a), signatureOf(b)));
  assert.equal(structuredChangeSummary(a, b), 'Changed task summary, 1 definition, general rules');
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
