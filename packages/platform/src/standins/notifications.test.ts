import assert from 'node:assert/strict';
import test from 'node:test';
import {logNotifications} from './notifications.ts';

test('logNotifications writes one line per notification and keeps the last few (#71)', async () => {
  const lines: string[] = [];
  const port = logNotifications(2, l => lines.push(l));
  for (const n of [1, 2, 3]) await port.send({userIds: ['u_1'], kind: 'scoring_finished', projectId: 'pr_1', text: `Scoring ${n} finished`, link: '/prompt/?p=pr_1'});
  assert.equal(lines.length, 3);
  assert.equal(lines[2], '[notification] scoring_finished to u_1: Scoring 3 finished (/prompt/?p=pr_1)');
  assert.deepEqual(port.sent().map(n => n.text), ['Scoring 2 finished', 'Scoring 3 finished']);
});
