import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from './harness.ts';
import { CodexRunner } from '../src/codex-runner.ts';

test('runs codex in isolated mode and writes prompt through stdin', async () => {
  const calls: unknown[] = [];
  const child = fakeChild({ stdout: 'ok', code: 0 });
  const runner = new CodexRunner({
    codexCmd: 'C:\\Program Files\\nodejs\\node_global\\codex.cmd',
    defaultWorkdir: 'C:\\work',
    spawnFn(command, args, options) {
      calls.push({ command, args, options });
      return child;
    }
  });

  const result = await runner.runPrompt('hello');

  assert.equal(result.exitCode, 0);
  assert.equal(result.summary, 'ok');
  const call = calls[0] as { command: string; args: string[]; options: unknown };
  assert.equal(call.command, 'cmd.exe');
  assert.deepEqual(call.args.slice(0, 8), [
    '/d',
    '/s',
    '/c',
    'C:\\Program Files\\nodejs\\node_global\\codex.cmd',
    'exec',
    '--ignore-user-config',
    '--ignore-rules',
    '--ephemeral'
  ]);
  assert.equal(call.args.includes('--output-last-message'), true);
  assert.equal(call.args.at(-1), '-');
  assert.deepEqual(call.options, { cwd: 'C:\\work', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  assert.equal(child.stdin.writes.join(''), '用中文简短回答。不要读取文件，不要调用工具。\n\nhello');
  assert.equal(child.stdin.ended, true);
});

test('does not isolate codex when useUserConfig is enabled', async () => {
  const calls: Array<{ args: string[] }> = [];
  const runner = new CodexRunner({
    codexCmd: 'codex.cmd',
    defaultWorkdir: 'C:\\work',
    useUserConfig: true,
    spawnFn(_command, args) {
      calls.push({ args });
      return fakeChild({ stdout: 'ok', code: 0 });
    }
  });

  await runner.runPrompt('hello');

  assert.equal(calls[0]?.args.includes('--ignore-user-config'), false);
  assert.equal(calls[0]?.args.includes('--ignore-rules'), false);
  assert.equal(calls[0]?.args.includes('--ephemeral'), false);
});

test('uses output-last-message file before stdout transcript', async () => {
  const runner = new CodexRunner({
    codexCmd: 'codex.cmd',
    defaultWorkdir: 'C:\\work',
    readFileFn: (path) => path.includes('codex-last-message') ? 'final answer from file' : '',
    spawnFn: () => fakeChild({ stdout: 'noisy transcript', code: 0 })
  });

  const result = await runner.runPrompt('hello');

  assert.equal(result.exitCode, 0);
  assert.equal(result.summary, 'final answer from file');
});

test('returns nonzero exit code with compact stderr summary when codex fails', async () => {
  const runner = new CodexRunner({
    codexCmd: 'codex.cmd',
    defaultWorkdir: 'C:\\work',
    spawnFn: () => fakeChild({ stderr: 'bad\n'.repeat(100), code: 2 })
  });

  const result = await runner.runPrompt('hello');

  assert.equal(result.exitCode, 2);
  assert.match(result.summary, /^Codex 失败/);
  assert.equal(result.summary.includes('COMMAND='), false);
  assert.ok(result.summary.length < 1200);
});

test('includes command and workdir when codex fails to start', async () => {
  const runner = new CodexRunner({
    codexCmd: 'missing-codex.cmd',
    defaultWorkdir: 'C:\\work',
    spawnFn: () => fakeChild({ error: new Error('ENOENT') })
  });

  const result = await runner.runPrompt('hello');

  assert.equal(result.exitCode, null);
  assert.match(result.summary, /missing-codex\.cmd/u);
  assert.match(result.summary, /C:\\work/u);
  assert.match(result.summary, /ENOENT/u);
});

test('returns startup failure when spawn throws synchronously', async () => {
  const runner = new CodexRunner({
    codexCmd: 'codex.cmd',
    defaultWorkdir: 'C:\\work',
    spawnFn() {
      throw Object.assign(new Error('spawn EINVAL'), { code: 'EINVAL' });
    }
  });

  const result = await runner.runPrompt('hello');

  assert.equal(result.exitCode, null);
  assert.match(result.summary, /codex\.cmd/u);
  assert.match(result.summary, /C:\\work/u);
  assert.match(result.summary, /EINVAL/u);
});

test('returns partial stdout as successful answer when codex times out after answering', async () => {
  const runner = new CodexRunner({
    codexCmd: 'codex.cmd',
    defaultWorkdir: 'C:\\work',
    timeoutMs: 1,
    spawnFn: () => fakeChild({
      stdout: 'started model call',
      stderr: 'warning: Access is denied'
    })
  });

  const result = await runner.runPrompt('hello');

  assert.equal(result.exitCode, 0);
  assert.equal(result.summary, 'started model call');
  assert.doesNotMatch(result.summary, /Access is denied/u);
});

test('uses separate quick and agent timeout settings from environment', async () => {
  const previousQuick = process.env.QUICK_TIMEOUT_MS;
  const previousAgent = process.env.AGENT_TIMEOUT_MS;
  process.env.QUICK_TIMEOUT_MS = '1';
  process.env.AGENT_TIMEOUT_MS = '2';
  try {
    const kills: string[] = [];
    const runner = new CodexRunner({
      codexCmd: 'codex.cmd',
      defaultWorkdir: 'C:\\work',
      timeoutMs: 1,
      spawnFn: () => fakeChild({ stderr: 'still running', onKill: () => kills.push('killed') })
    });

    const quick = await runner.runPrompt('hello', 'quick');
    assert.match(quick.summary, /0\.001 秒/u);
    assert.equal(kills.length, 1);

    const agent = await runner.runPrompt('hello', 'agent');
    assert.match(agent.summary, /0\.002 秒/u);
    assert.equal(kills.length, 2);
  } finally {
    restoreEnv('QUICK_TIMEOUT_MS', previousQuick);
    restoreEnv('AGENT_TIMEOUT_MS', previousAgent);
  }
});

test('ignores invalid environment timeout values and uses explicit settings', async () => {
  const previousQuick = process.env.QUICK_TIMEOUT_MS;
  const previousAgent = process.env.AGENT_TIMEOUT_MS;
  process.env.QUICK_TIMEOUT_MS = '0';
  process.env.AGENT_TIMEOUT_MS = 'not-a-number';
  try {
    const runner = new CodexRunner({
      codexCmd: 'codex.cmd',
      defaultWorkdir: 'C:\\work',
      timeoutMs: 1,
      quickTimeoutMs: 1,
      agentTimeoutMs: 1,
      spawnFn: () => fakeChild({ stderr: 'still running' })
    });

    const quick = await runner.runPrompt('hello', 'quick');
    assert.match(quick.summary, /0\.001 秒/u);

    const agent = await runner.runPrompt('hello', 'agent');
    assert.match(agent.summary, /0\.001 秒/u);
  } finally {
    restoreEnv('QUICK_TIMEOUT_MS', previousQuick);
    restoreEnv('AGENT_TIMEOUT_MS', previousAgent);
  }
});

test('timeout failure is concise unless diagnostics are enabled', async () => {
  const previous = process.env.WECHAT_CODEX_DIAGNOSTICS;
  delete process.env.WECHAT_CODEX_DIAGNOSTICS;
  try {
    const runner = new CodexRunner({
      codexCmd: 'codex.cmd',
      defaultWorkdir: 'C:\\work',
      timeoutMs: 1,
      spawnFn: () => fakeChild({ stderr: 'warning: Access is denied' })
    });

    const result = await runner.runPrompt('hello', 'quick');

    assert.equal(result.exitCode, null);
    assert.match(result.summary, /Codex 任务超过/u);
    assert.doesNotMatch(result.summary, /COMMAND=/u);
    assert.doesNotMatch(result.summary, /Access is denied/u);
  } finally {
    restoreEnv('WECHAT_CODEX_DIAGNOSTICS', previous);
  }
});

test('timeout failure includes diagnostics when enabled', async () => {
  const previous = process.env.WECHAT_CODEX_DIAGNOSTICS;
  process.env.WECHAT_CODEX_DIAGNOSTICS = '1';
  try {
    const runner = new CodexRunner({
      codexCmd: 'codex.cmd',
      defaultWorkdir: 'C:\\work',
      timeoutMs: 1,
      spawnFn: () => fakeChild({ stderr: 'warning: Access is denied' })
    });

    const result = await runner.runPrompt('hello', 'quick');

    assert.equal(result.exitCode, null);
    assert.match(result.summary, /COMMAND=/u);
    assert.match(result.summary, /Access is denied/u);
  } finally {
    restoreEnv('WECHAT_CODEX_DIAGNOSTICS', previous);
  }
});

test('checkCli returns compact status only', async () => {
  const runner = new CodexRunner({
    codexCmd: 'codex.cmd',
    defaultWorkdir: 'C:\\work',
    spawnFn: () => fakeChild({ stdout: 'codex-cli 0.124.0\nextra line', code: 0 })
  });

  const result = await runner.checkCli();

  assert.equal(result.exitCode, 0);
  assert.equal(result.summary, 'codex-cli 0.124.0');
});

function fakeChild(input: { stdout?: string; stderr?: string; code?: number; error?: Error; onKill?: () => void }) {
  const child = new EventEmitter() as EventEmitter & {
    stdin: { writes: string[]; ended: boolean; write: (chunk: string) => void; end: () => void };
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  child.stdin = {
    writes: [],
    ended: false,
    write(chunk: string) {
      this.writes.push(chunk);
    },
    end() {
      this.ended = true;
    }
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {
    input.onKill?.();
  };
  queueMicrotask(() => {
    if (input.stdout) child.stdout.emit('data', Buffer.from(input.stdout));
    if (input.stderr) child.stderr.emit('data', Buffer.from(input.stderr));
    if (input.error) {
      child.emit('error', input.error);
      return;
    }
    if (typeof input.code === 'number') child.emit('close', input.code);
  });
  return child;
}

function restoreEnv(name: string, value: string | undefined) {
  if (typeof value === 'string') {
    process.env[name] = value;
    return;
  }
  delete process.env[name];
}
