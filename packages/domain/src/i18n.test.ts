import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import type {AgentPreset} from '@tsp/contracts';
import {catalogKeys, fill, hasKey, isLocale, msg, msgText, translate} from './i18n.ts';
import {ZH} from './locales/zh.ts';
import {NODES} from './gates.ts';
import {FEATURES} from './catalogue.ts';
import {agentName} from './workflow.ts';
import {checkStructured, emptyStructuredPrompt} from './structured.ts';
import {usedKeys} from './locales/used-keys.ts';

test('fill puts params in, keeps unknown placeholders and spells nested messages in English', () => {
  assert.equal(fill('{who} saved it as {version}', {who: 'You', version: 'v2'}), 'You saved it as v2');
  assert.equal(fill('Hello {name}'), 'Hello {name}');
  assert.equal(fill('{check} is {n}', {check: msg('Lowest value F1')}), 'Lowest value F1 is {n}');
  assert.equal(msgText(msg('Started {time}', {time: '10:00'})), 'Started 10:00');
});

test('translate looks the key up, fills params, and translates term params and nested messages', () => {
  assert.equal(translate('en', 'Save'), 'Save');
  assert.equal(translate('zh', 'Save'), ZH['Save']);
  // A key the catalog lacks reads in English.
  assert.equal(translate('zh', 'No such text {n}', {n: 3}), 'No such text 3');
  // "who" and "page" are words of the site, so they are translated; a version label is not.
  const line = translate('zh', '{who} put a draft on {page}', {who: 'Prompt helper', page: 'Prompt Design'});
  assert.ok(line.includes(ZH['Prompt helper']) && line.includes(ZH['Prompt Design']), line);
  assert.ok(translate('zh', '{who} saved it as {version}', {who: 'You', version: 'v2'}).includes('v2'));
  const nested = translate('zh', '{check} is {actual} (needs {need})', {check: msg('Lowest value F1'), actual: '0.50', need: '≥ 0.60'});
  assert.ok(nested.startsWith(ZH['Lowest value F1']), nested);
  assert.ok(isLocale('zh') && isLocale('en') && !isLocale('fr'));
  assert.ok(hasKey('en', 'anything') && hasKey('zh', 'Save') && !hasKey('zh', 'No such text'));
});

test('every Chinese text keeps the placeholders of its key', () => {
  const ph = (s: string) => [...new Set(s.match(/\{\w+\}/g) ?? [])].sort().join(',');
  const bad = catalogKeys('zh').filter(k => ph(k) !== ph(ZH[k]));
  assert.deepEqual(bad, []);
});

test('every text the site shows is in the Chinese catalog', () => {
  const keys = usedKeys();
  // Built at run time: step, helper and feature names, the stand-in services, the words the helpers' language line uses.
  for (const n of NODES) keys.set(n.label, 'gates.ts');
  for (const a of ['front_desk', 'prompt_agent', 'evaluation_agent'] as AgentPreset[]) keys.set(agentName(a), 'workflow.ts');
  for (const list of Object.values(FEATURES)) for (const f of list) keys.set(f.label, 'catalogue.ts');
  const standIns = /standIns: \[([^\]]*)\]/.exec(readFileSync(new URL('../../platform/src/config.ts', import.meta.url), 'utf8'))?.[1] ?? '';
  for (const s of standIns.matchAll(/'([^']+)'/g)) keys.set(s[1], 'platform config');
  for (const w of ['You', 'Workflow', 'gold label', 'eval set', 'version', 'field', 'value']) keys.set(w, 'action lines and helpers');
  // An action line's key is "{who} " + what the service passed (chat-events.ts).
  const missing = [...keys].filter(([k]) => !(k in ZH) && !(`{who} ${k}` in ZH)).map(([k, f]) => `${f}: ${k}`);
  assert.deepEqual(missing, []);
});

test('the reasons a prompt cannot be saved carry their catalog key', () => {
  const issues = checkStructured(emptyStructuredPrompt());
  assert.ok(issues.length > 0);
  for (const i of issues) {
    assert.equal(i.message, msgText(i.msg));
    assert.ok(i.msg.key in ZH, i.msg.key);
  }
});
