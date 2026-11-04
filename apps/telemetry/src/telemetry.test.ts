import assert from 'node:assert/strict';
import test from 'node:test';
import type {TelemetryEvent} from '@tsp/contracts';
import {createTelemetry} from './telemetry.ts';

const sink = () => {
  const s = {events: [] as TelemetryEvent[], metrics: ''};
  return {s, sink: {pushEvents: async (e: TelemetryEvent[]) => void s.events.push(...e), pushMetrics: async (m: string) => void (s.metrics = m)}};
};

test('renders Prometheus text with app and env labels, and cumulative histogram buckets', () => {
  const {sink: k} = sink();
  const t = createTelemetry({sink: k, env: 'test', flushMs: 0});
  t.counter('tsp_llm_calls_total', {endpoint: 'chat-terra', purpose: 'chat', outcome: 'ok'});
  t.counter('tsp_llm_calls_total', {endpoint: 'chat-terra', purpose: 'chat', outcome: 'ok'}, 2);
  t.histogram('tsp_llm_call_duration_seconds', 0.7, {endpoint: 'chat-terra', purpose: 'chat'});
  t.histogram('tsp_llm_call_duration_seconds', 3, {endpoint: 'chat-terra', purpose: 'chat'});
  const text = t.render();
  assert.match(text, /# TYPE tsp_llm_calls_total counter/);
  assert.match(text, /tsp_llm_calls_total\{app="llm_gateway",env="test",endpoint="chat-terra",purpose="chat",outcome="ok"\} 3/);
  assert.match(text, /tsp_llm_call_duration_seconds_bucket\{[^}]*le="1"\} 1/);
  assert.match(text, /tsp_llm_call_duration_seconds_bucket\{[^}]*le="4"\} 2/);
  assert.match(text, /tsp_llm_call_duration_seconds_count\{[^}]*\} 2/);
});

test('labels not declared are dropped and id-like values become "other"', () => {
  const {sink: k} = sink();
  const t = createTelemetry({sink: k, flushMs: 0});
  t.counter('tsp_web_page_views_total', {page: 'pr_0123456789abcdef', projectId: 'pr_1'} as never);
  const text = t.render();
  assert.match(text, /page="other"/);
  assert.ok(!text.includes('projectId'));
});

test('events carry the envelope, keep the newest when the buffer is full, and flush to the sink', async () => {
  const {s, sink: k} = sink();
  const t = createTelemetry({sink: k, flushMs: 0, maxBuffered: 2, appVersion: 'b1'});
  t.setContext({userId: 'u1', projectId: 'pr_1', page: 'gold'});
  t.event('gold_skipped', {eval_done: 1, eval_total: 35});
  t.event('gold_skipped', {eval_done: 2, eval_total: 35});
  t.event('gold_skipped', {eval_done: 3, eval_total: 35});
  await t.flush();
  assert.deepEqual(s.events.map(e => (e.props as {eval_done: number}).eval_done), [2, 3]);
  assert.equal(s.events[0].project_id, 'pr_1');
  assert.equal(s.events[0].page, 'gold');
  assert.equal(s.events[0].app_version, 'b1');
  assert.ok(s.events[0].session_id && s.events[0].event_id);
});

test('a failing sink never throws to the caller', async () => {
  const t = createTelemetry({sink: {pushEvents: async () => Promise.reject(new Error('down')), pushMetrics: async () => {}}, flushMs: 0});
  t.event('compare_opened', {});
  await t.flush();
});
