import assert from 'node:assert/strict';
import { test } from './harness.ts';
import { classifyUserText, isOwnerAuthorized } from '../src/security.ts';

test('rejects unbound users except bind command', () => {
  assert.equal(isOwnerAuthorized(undefined, 'user-1', '状态'), false);
  assert.equal(isOwnerAuthorized(undefined, 'user-1', '绑定'), true);
  assert.equal(isOwnerAuthorized('owner-1', 'user-2', '状态'), false);
  assert.equal(isOwnerAuthorized('owner-1', 'owner-1', '状态'), true);
});

test('classifies command execution, file sending, and reminders as confirmation-required', () => {
  assert.equal(classifyUserText('执行 npm test').requiresConfirmation, true);
  assert.equal(classifyUserText('把 C:\\tmp\\a.txt 发给我').requiresConfirmation, true);
  assert.equal(classifyUserText('提醒我 2026-05-07 09:00 提交材料').requiresConfirmation, true);
  assert.equal(classifyUserText('查看当前代码运行状态').requiresConfirmation, false);
});
