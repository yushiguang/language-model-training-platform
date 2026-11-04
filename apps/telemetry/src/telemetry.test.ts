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
  t.allowLabelValues('endpoint', ['chat-terra']);
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

test('label values must be declared: an email, an id or an undeclared endpoint becomes "other"', () => {
  const {sink: k} = sink();
  const t = createTelemetry({sink: k, flushMs: 0});
  t.allowLabelValues('endpoint', ['labeling-A', 'pr_1', 'someone@example.com']);
  t.counter('tsp_llm_calls_total', {endpoint: 'labeling-A', purpose: 'labeling', outcome: 'ok'});
  t.counter('tsp_llm_calls_total', {endpoint: 'pr_1', purpose: 'labeling', outcome: 'ok'});
  t.counter('tsp_llm_calls_total', {endpoint: 'someone@example.com', purpose: 'labeling', outcome: 'ok'});
  t.counter('tsp_llm_calls_total', {endpoint: 'labeling-B', purpose: 'labeling', outcome: 'not a value'});
  const text = t.render();
  assert.match(text, /endpoint="labeling-A",purpose="labeling",outcome="ok"\} 1/);
  assert.match(text, /endpoint="other",purpose="labeling",outcome="ok"\} 2/, 'ids and emails are never allowed, even when declared');
  assert.match(text, /endpoint="other",purpose="labeling",outcome="other"\} 1/);
  assert.ok(!text.includes('example.com') && !text.includes('pr_1'));
});

test('event props are allowlisted: unknown keys dropped, text replaced, numbers finite', async () => {
  const {s, sink: k} = sink();
  const t = createTelemetry({sink: k, flushMs: 0});
  t.event('chat_message_sent', {entry_agent: 'front_desk', chars: 12, attachments: 0, text: 'my secret prompt'} as never);
  t.event('error_shown', {code: 'Please label these posts about cooking', where: 'gold'});
  t.event('page_left', {seconds_visible: Infinity, seconds_idle: 3});
  await t.flush();
  assert.deepEqual(s.events[0].props, {entry_agent: 'front_desk', chars: 12, attachments: 0});
  assert.deepEqual(s.events[1].props, {code: 'other', where: 'gold'});
  assert.deepEqual(s.events[2].props, {seconds_visible: null, seconds_idle: 3});
  assert.ok(!JSON.stringify(s.events).includes('secret'));
});

test('a counter ignores Infinity and NaN, so the exposition stays valid', () => {
  const {sink: k} = sink();
  const t = createTelemetry({sink: k, flushMs: 0});
  t.counter('tsp_labeling_cost_usd_total', {task_purpose: 'eval'}, Infinity);
  t.counter('tsp_labeling_cost_usd_total', {task_purpose: 'eval'}, NaN);
  t.counter('tsp_labeling_cost_usd_total', {task_purpose: 'eval'}, 0.5);
  assert.match(t.render(), /tsp_labeling_cost_usd_total\{[^}]*\} 0.5\n/);
});

test('a flush asked for during a flush also sends what was buffered meanwhile', async () => {
  const pushed: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(r => (release = r));
  const t = createTelemetry({
    sink: {
      pushEvents: async e => {
        pushed.push(...e.map(x => x.event));
        await gate;
      },
      pushMetrics: async () => {},
    },
    flushMs: 0,
  });
  t.event('compare_opened', {});
  const first = t.flush();
  t.event('assistant_opened', {});
  const second = t.flush();
  release();
  await second;
  await first;
  assert.deepEqual(pushed, ['compare_opened', 'assistant_opened']);
});
