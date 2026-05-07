import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from './harness.ts';
import { BridgeService } from '../src/bridge-service.ts';
import { CodexRunner } from '../src/codex-runner.ts';
import { BridgeStore } from '../src/store.ts';

test('CodexRunner uses quick model and read-only sandbox for normal messages', async () => {
  const calls: Array<{ command: string; args: string[]; options: unknown }> = [];
  const runner = new CodexRunner({
    codexCmd: 'codex.cmd',
    defaultWorkdir: 'C:\\work',
    quickModel: 'gpt-5.4-mini',
    agentModel: 'gpt-5.5',
    quickReasoningEffort: 'low',
    agentReasoningEffort: 'medium',
    quickSandbox: 'read-only',
    agentSandbox: 'workspace-write',
    approvalPolicy: 'on-request',
    spawnFn(command, args, options) {
      calls.push({ command, args, options });
      return fakeChild('quick ok', 0);
    }
  });

  await runner.runPrompt('hello', 'quick');

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.command, 'cmd.exe');
  assert.deepEqual(calls[0]?.args.slice(0, 8), [
    '/d',
    '/s',
    '/c',
    'codex.cmd',
    'exec',
    '--ignore-user-config',
    '--ignore-rules',
    '--ephemeral'
  ]);
  assert.equal(calls[0]?.args.includes('--model'), true);
  assert.equal(calls[0]?.args[calls[0].args.indexOf('--model') + 1], 'gpt-5.4-mini');
  assert.equal(calls[0]?.args.includes('-c'), true);
  assert.equal(calls[0]?.args.includes('model_reasoning_effort="low"'), true);
  assert.equal(calls[0]?.args.includes('--sandbox'), true);
  assert.equal(calls[0]?.args[calls[0].args.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(calls[0]?.args.includes('--output-last-message'), true);
  assert.equal(calls[0]?.args.at(-1), '-');
  assert.deepEqual(calls[0]?.options, { cwd: 'C:\\work', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
});

test('CodexRunner uses agent model and workspace sandbox for /cx messages', async () => {
  const calls: Array<{ command: string; args: string[]; options: unknown }> = [];
  const runner = new CodexRunner({
    codexCmd: 'codex.cmd',
    defaultWorkdir: 'C:\\work',
    quickModel: 'gpt-5.4-mini',
    agentModel: 'gpt-5.5',
    quickReasoningEffort: 'low',
    agentReasoningEffort: 'medium',
    quickSandbox: 'read-only',
    agentSandbox: 'workspace-write',
    approvalPolicy: 'on-request',
    spawnFn(command, args, options) {
      calls.push({ command, args, options });
      return fakeChild('agent ok', 0);
    }
  });

  await runner.runPrompt('inspect code', 'agent');

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.command, 'cmd.exe');
  assert.equal(calls[0]?.args.includes('--model'), true);
  assert.equal(calls[0]?.args[calls[0].args.indexOf('--model') + 1], 'gpt-5.5');
  assert.equal(calls[0]?.args.includes('model_reasoning_effort="medium"'), true);
  assert.equal(calls[0]?.args.includes('--sandbox'), true);
  assert.equal(calls[0]?.args[calls[0].args.indexOf('--sandbox') + 1], 'workspace-write');
  assert.equal(calls[0]?.args.includes('--ask-for-approval'), false);
  assert.equal(calls[0]?.args.includes('--ignore-user-config'), true);
  assert.equal(calls[0]?.args.includes('--ignore-rules'), true);
  assert.equal(calls[0]?.args.includes('--ephemeral'), true);
  assert.equal(calls[0]?.args.at(-1), '-');
  assert.deepEqual(calls[0]?.options, { cwd: 'C:\\work', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
});

test('BridgeService strips /cx prefix and records agent task mode', async () => {
  const store = new BridgeStore(':memory:');
  store.setOwnerUserId('owner-1');
  const prompts: Array<{ prompt: string; mode: string }> = [];
  const replies: string[] = [];
  const service = new BridgeService({
    store,
    sendText: async (_to, text) => replies.push(text),
    runCodex: async (prompt, mode) => {
      prompts.push({ prompt, mode });
      return { exitCode: 0, summary: 'done' };
    }
  });

  await service.handleInbound({
    messageId: 'm1',
    fromUserId: 'owner-1',
    chatType: 'SINGLE',
    text: '/cx inspect code',
    contextToken: 'ctx'
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(prompts, [{ prompt: 'inspect code', mode: 'agent' }]);
  assert.equal(store.getTask(1)?.mode, 'agent');
  assert.match(replies.join('\n'), /agent/);
});

function fakeChild(output: string, code: number) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  queueMicrotask(() => {
    child.stdout.emit('data', Buffer.from(output));
    child.emit('close', code);
  });
  return child;
}
