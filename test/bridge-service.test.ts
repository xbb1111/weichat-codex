import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from './harness.ts';
import { BridgeService } from '../src/bridge-service.ts';
import { BridgeStore } from '../src/store.ts';

test('binds first owner and rejects other users', async () => {
  const store = new BridgeStore(':memory:');
  const replies: string[] = [];
  const service = new BridgeService({
    store,
    sendText: async (_to, text) => replies.push(text),
    runCodex: async () => ({ exitCode: 0, summary: 'unused' })
  });

  await service.handleInbound({
    messageId: 'm1',
    fromUserId: 'owner-1',
    chatType: 'SINGLE',
    text: '绑定',
    contextToken: 'ctx'
  });
  await service.handleInbound({
    messageId: 'm2',
    fromUserId: 'user-2',
    chatType: 'SINGLE',
    text: '状态',
    contextToken: 'ctx'
  });

  assert.equal(store.getOwnerUserId(), 'owner-1');
  assert.match(replies[0], /绑定成功/);
  assert.match(replies[1], /未授权/);
});

test('creates confirmation action for reminder before scheduling it', async () => {
  const store = new BridgeStore(':memory:');
  store.setOwnerUserId('owner-1');
  const replies: string[] = [];
  const service = new BridgeService({
    store,
    sendText: async (_to, text) => replies.push(text),
    runCodex: async () => ({ exitCode: 0, summary: 'unused' })
  });

  await service.handleInbound({
    messageId: 'm1',
    fromUserId: 'owner-1',
    chatType: 'SINGLE',
    text: '提醒我 2026-05-07 09:00 提交材料',
    contextToken: 'ctx'
  });
  await service.handleInbound({
    messageId: 'm2',
    fromUserId: 'owner-1',
    chatType: 'SINGLE',
    text: '确认 #1',
    contextToken: 'ctx'
  });

  assert.match(replies[0], /待确认 #1/);
  assert.match(replies[1], /提醒已创建/);
  assert.equal(store.dueReminders(new Date('2026-05-07T01:00:01.000Z')).length, 1);
});

test('confirms the only pending action without requiring an id', async () => {
  const store = new BridgeStore(':memory:');
  store.setOwnerUserId('owner-1');
  const replies: string[] = [];
  const sentFiles: string[] = [];
  const root = join(tmpdir(), `weichat-codex-confirm-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const filePath = join(root, 'a.pdf');
  writeFileSync(filePath, 'pdf');
  const service = new BridgeService({
    store,
    sendText: async (_to, text) => replies.push(text),
    sendFile: async (_to, path) => sentFiles.push(path),
    runCodex: async () => ({ exitCode: 0, summary: 'unused' })
  });
  const actionId = store.createPendingAction({
    ownerUserId: 'owner-1',
    type: 'send_file',
    description: `发送文件：${filePath}`,
    payload: { path: filePath }
  });

  await service.handleInbound({
    messageId: 'm1',
    fromUserId: 'owner-1',
    chatType: 'SINGLE',
    text: '确认',
    contextToken: 'ctx'
  });

  assert.equal(store.getPendingAction(actionId)?.status, 'confirmed');
  assert.deepEqual(sentFiles, [filePath]);
  assert.match(replies[0] ?? '', /已发送文件：a\.pdf/);
});

test('requires an id when multiple pending actions exist', async () => {
  const store = new BridgeStore(':memory:');
  store.setOwnerUserId('owner-1');
  const replies: string[] = [];
  const service = new BridgeService({
    store,
    sendText: async (_to, text) => replies.push(text),
    runCodex: async () => ({ exitCode: 0, summary: 'unused' })
  });
  store.createPendingAction({ ownerUserId: 'owner-1', type: 'execute', description: 'one' });
  store.createPendingAction({ ownerUserId: 'owner-1', type: 'execute', description: 'two' });

  await service.handleInbound({
    messageId: 'm1',
    fromUserId: 'owner-1',
    chatType: 'SINGLE',
    text: '确认',
    contextToken: 'ctx'
  });

  assert.match(replies[0] ?? '', /请使用：确认 #id/);
});

test('creates a send_file confirmation from descriptive pdf search text', async () => {
  const root = join(tmpdir(), `weichat-codex-test-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const pdfPath = join(root, '岳大力-碎屑岩储层表征研究进展.pdf');
  writeFileSync(pdfPath, 'pdf');
  const store = new BridgeStore(':memory:');
  store.setOwnerUserId('owner-1');
  const replies: string[] = [];
  const service = new BridgeService({
    store,
    sendText: async (_to, text) => replies.push(text),
    runCodex: async () => ({ exitCode: 0, summary: 'unused' }),
    fileSearchRoots: [root]
  });

  await service.handleInbound({
    messageId: 'm1',
    fromUserId: 'owner-1',
    chatType: 'SINGLE',
    text: '从我电脑上找到1个类似于岳大力写的一篇碎屑岩储层表征研究进展的pdf文件，发给我',
    contextToken: 'ctx'
  });

  const action = store.getPendingAction(1);
  assert.equal(action?.type, 'send_file');
  assert.equal(action?.payload.path, pdfPath);
  assert.match(replies[0] ?? '', /待确认 #1/);
});

test('records inbound, task, and outbound transcript events', async () => {
  const store = new BridgeStore(':memory:');
  store.setOwnerUserId('owner-1');
  const service = new BridgeService({
    store,
    sendText: async () => {},
    runCodex: async () => ({ exitCode: 0, summary: 'done' })
  });

  await service.handleInbound({
    messageId: 'm1',
    fromUserId: 'owner-1',
    chatType: 'SINGLE',
    text: '你好',
    contextToken: 'ctx'
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const events = store.listChatEvents(10);
  assert.deepEqual(events.map((event) => event.direction), ['inbound', 'system', 'outbound']);
  assert.equal(events[0]?.text, '你好');
  assert.match(events[2]?.text ?? '', /done/);
});

test('splits long task results into numbered reply chunks without losing content', async () => {
  const previous = process.env.MAX_WECHAT_REPLY_CHARS;
  process.env.MAX_WECHAT_REPLY_CHARS = '80';
  try {
    const store = new BridgeStore(':memory:');
    store.setOwnerUserId('owner-1');
    const replies: string[] = [];
    const body = `第一段 ${'甲'.repeat(45)}\n第二段 ${'乙'.repeat(45)}\n第三段 ${'丙'.repeat(45)}`;
    const service = new BridgeService({
      store,
      sendText: async (_to, text) => replies.push(text),
      runCodex: async () => ({ exitCode: 0, summary: body })
    });

    await service.handleInbound({
      messageId: 'm1',
      fromUserId: 'owner-1',
      chatType: 'SINGLE',
      text: '长输出',
      contextToken: 'ctx'
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const outbound = replies.filter((reply) => reply.includes('任务 #1 完成'));
    assert.ok(outbound.length > 1);
    assert.match(outbound[0] ?? '', /任务 #1 完成 \(1\/\d+\)：/u);
    assert.match(outbound.at(-1) ?? '', /任务 #1 完成 \(\d+\/\d+\)：/u);
    const reconstructed = outbound.map((reply) => reply.replace(/^任务 #1 完成 \(\d+\/\d+\)：\n/u, '')).join('');
    assert.equal(reconstructed, body);
    assert.equal(store.getTask(1)?.result, body);
    const events = store.listChatEvents(20).filter((event) => event.direction === 'outbound');
    assert.equal(events.length, outbound.length);
    assert.deepEqual(events.map((event) => event.text), outbound);
  } finally {
    restoreEnv('MAX_WECHAT_REPLY_CHARS', previous);
  }
});

test('sends short task results as one reply without chunk numbering', async () => {
  const previous = process.env.MAX_WECHAT_REPLY_CHARS;
  process.env.MAX_WECHAT_REPLY_CHARS = '500';
  try {
    const store = new BridgeStore(':memory:');
    store.setOwnerUserId('owner-1');
    const replies: string[] = [];
    const service = new BridgeService({
      store,
      sendText: async (_to, text) => replies.push(text),
      runCodex: async () => ({ exitCode: 0, summary: '短结果' })
    });

    await service.handleInbound({
      messageId: 'm1',
      fromUserId: 'owner-1',
      chatType: 'SINGLE',
      text: '短输出',
      contextToken: 'ctx'
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const outbound = replies.filter((reply) => reply.includes('任务 #1 完成'));
    assert.deepEqual(outbound, ['任务 #1 完成：\n短结果']);
  } finally {
    restoreEnv('MAX_WECHAT_REPLY_CHARS', previous);
  }
});

function restoreEnv(name: string, value: string | undefined) {
  if (typeof value === 'string') {
    process.env[name] = value;
    return;
  }
  delete process.env[name];
}
