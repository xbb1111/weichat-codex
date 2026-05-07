import assert from 'node:assert/strict';
import { test } from './harness.ts';
import { BridgeStore } from '../src/store.ts';
import { ReminderScheduler } from '../src/reminders.ts';

test('persists owner, update cursor, tasks, pending actions, and reminders in sqlite', () => {
  const store = new BridgeStore(':memory:');
  store.setOwnerUserId('owner-1');
  store.setUpdateCursor('buf-1');
  const taskId = store.createTask({ ownerUserId: 'owner-1', kind: 'codex', status: 'running', prompt: 'hi' });
  const actionId = store.createPendingAction({ ownerUserId: 'owner-1', type: 'send_file', description: 'send report' });
  const reminderId = store.createReminder({
    ownerUserId: 'owner-1',
    scheduleType: 'once',
    fireAt: new Date('2026-05-07T09:00:00+08:00').toISOString(),
    text: '提交材料'
  });

  assert.equal(store.getOwnerUserId(), 'owner-1');
  assert.equal(store.getUpdateCursor(), 'buf-1');
  assert.equal(store.getTask(taskId)?.status, 'running');
  assert.equal(store.getPendingAction(actionId)?.type, 'send_file');
  assert.deepEqual(store.dueReminders(new Date('2026-05-07T01:00:01.000Z')).map((r) => r.id), [reminderId]);
});

test('persists chat transcript events in chronological order', () => {
  const store = new BridgeStore(':memory:');
  store.createChatEvent({
    ownerUserId: 'owner-1',
    direction: 'inbound',
    messageId: 'm1',
    mode: 'quick',
    text: '你好'
  });
  store.createChatEvent({
    ownerUserId: 'owner-1',
    direction: 'outbound',
    taskId: 1,
    mode: 'quick',
    text: '你好，我在。'
  });

  const events = store.listChatEvents(10);

  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => event.direction), ['inbound', 'outbound']);
  assert.equal(events[0]?.messageId, 'm1');
  assert.equal(events[1]?.taskId, 1);
  assert.equal(events[1]?.text, '你好，我在。');
});

test('scheduler sends once reminders only once', async () => {
  const store = new BridgeStore(':memory:');
  const sent: string[] = [];
  const reminderId = store.createReminder({
    ownerUserId: 'owner-1',
    scheduleType: 'once',
    fireAt: new Date('2026-05-07T01:00:00.000Z').toISOString(),
    text: '提交材料'
  });
  const scheduler = new ReminderScheduler({
    store,
    now: () => new Date('2026-05-07T01:00:01.000Z'),
    send: async (_owner, text) => sent.push(text)
  });

  await scheduler.tick();
  await scheduler.tick();

  assert.equal(store.getReminder(reminderId)?.active, false);
  assert.deepEqual(sent, ['提醒：提交材料']);
});
