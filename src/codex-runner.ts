import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

type ChildLike = {
  stdin?: {
    write: (chunk: string) => void;
    end: () => void;
  };
  stdout?: NodeJS.EventEmitter;
  stderr?: NodeJS.EventEmitter;
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
  kill: () => void;
};

type SpawnOptions = {
  cwd: string;
  windowsHide: boolean;
  shell?: boolean;
  stdio?: ['pipe', 'pipe', 'pipe'];
};

type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildLike;
type ReadFileFn = (path: string) => string;

export type CodexMode = 'quick' | 'agent';

export type CodexRunResult = {
  exitCode: number | null;
  summary: string;
};

export type CodexDiagnosticResult = {
  exitCode: number | null;
  summary: string;
};

type RunDetails = {
  command: string;
  args: string[];
  model: string;
  sandbox: string;
  prompt: string;
  outputPath: string;
  mode: CodexMode;
  timeoutMs: number;
};

export class CodexRunner {
  private codexCmd: string;
  private defaultWorkdir: string;
  private spawnFn: SpawnFn;
  private readFileFn: ReadFileFn;
  private quickTimeoutMs: number;
  private agentTimeoutMs: number;
  private quickModel: string;
  private agentModel: string;
  private quickSandbox: string;
  private agentSandbox: string;
  private quickReasoningEffort: string;
  private agentReasoningEffort: string;
  private approvalPolicy: string;
  private quickPromptPrefix: string;
  private agentPromptPrefix: string;
  private useUserConfig: boolean;

  constructor(input: {
    codexCmd: string;
    defaultWorkdir: string;
    timeoutMs?: number;
    quickModel?: string;
    agentModel?: string;
    quickReasoningEffort?: string;
    agentReasoningEffort?: string;
    quickSandbox?: string;
    agentSandbox?: string;
    quickTimeoutMs?: number;
    agentTimeoutMs?: number;
    approvalPolicy?: string;
    quickPromptPrefix?: string;
    agentPromptPrefix?: string;
    useUserConfig?: boolean;
    readFileFn?: ReadFileFn;
    spawnFn?: SpawnFn;
  }) {
    this.codexCmd = input.codexCmd;
    this.defaultWorkdir = input.defaultWorkdir;
    this.quickTimeoutMs = positiveInt(input.quickTimeoutMs)
      ?? positiveInt(process.env.QUICK_TIMEOUT_MS)
      ?? positiveInt(input.timeoutMs)
      ?? 180_000;
    this.agentTimeoutMs = positiveInt(input.agentTimeoutMs)
      ?? positiveInt(process.env.AGENT_TIMEOUT_MS)
      ?? positiveInt(input.timeoutMs)
      ?? 900_000;
    this.quickModel = input.quickModel ?? process.env.QUICK_MODEL ?? 'gpt-5.4-mini';
    this.agentModel = input.agentModel ?? process.env.AGENT_MODEL ?? 'gpt-5.5';
    this.quickSandbox = input.quickSandbox ?? process.env.QUICK_SANDBOX ?? 'read-only';
    this.agentSandbox = input.agentSandbox ?? process.env.AGENT_SANDBOX ?? 'workspace-write';
    this.quickReasoningEffort = input.quickReasoningEffort ?? process.env.QUICK_REASONING_EFFORT ?? 'low';
    this.agentReasoningEffort = input.agentReasoningEffort ?? process.env.AGENT_REASONING_EFFORT ?? 'medium';
    this.approvalPolicy = input.approvalPolicy ?? process.env.CODEX_APPROVAL_POLICY ?? 'on-request';
    this.quickPromptPrefix = input.quickPromptPrefix ?? '用中文简短回答。不要读取文件，不要调用工具。';
    this.agentPromptPrefix = input.agentPromptPrefix ?? '';
    this.useUserConfig = input.useUserConfig ?? process.env.WECHAT_CODEX_USE_USER_CONFIG === '1';
    this.readFileFn = input.readFileFn ?? ((path) => readFileSync(path, 'utf8'));
    this.spawnFn = input.spawnFn ?? ((command, args, options) => spawn(command, args, options));
  }

  runPrompt(prompt: string, mode: CodexMode = 'quick'): Promise<CodexRunResult> {
    return new Promise((resolve) => {
      const details = this.buildRunDetails(prompt, mode);
      let child: ChildLike;
      try {
        this.ensureOutputDir(details.outputPath);
        child = this.spawnFn(details.command, details.args, {
          cwd: this.defaultWorkdir,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        });
        child.stdin?.write(details.prompt);
        child.stdin?.end();
      } catch (error) {
        resolve({ exitCode: null, summary: this.formatStartupFailure(error, details) });
        return;
      }

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        const lastMessage = this.readLastMessage(details.outputPath);
        const output = Buffer.concat(stdout).toString('utf8').trim();
        if (lastMessage || output) {
          resolve({ exitCode: 0, summary: (lastMessage || output).trim() });
          return;
        }
        resolve({ exitCode: null, summary: this.formatTimeout(details, stdout, stderr) });
      }, details.timeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
      child.stderr?.on('data', (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const output = Buffer.concat(stdout).toString('utf8').trim();
        const error = Buffer.concat(stderr).toString('utf8').trim();
        const exitCode = typeof code === 'number' ? code : null;
        const lastMessage = this.readLastMessage(details.outputPath);
        if (exitCode === 0) {
          resolve({ exitCode, summary: (lastMessage || output || error).trim() || '(无输出)' });
          return;
        }
        resolve({ exitCode, summary: this.formatFailure(error || output || `exit code ${String(exitCode)}`) });
      });
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ exitCode: null, summary: this.formatStartupFailure(error, details) });
      });
    });
  }

  checkCli(): Promise<CodexDiagnosticResult> {
    return new Promise((resolve) => {
      const command = process.platform === 'win32' ? 'cmd.exe' : this.codexCmd;
      const args = process.platform === 'win32' ? ['/d', '/s', '/c', this.codexCmd, '--version'] : ['--version'];
      let child: ChildLike;
      try {
        child = this.spawnFn(command, args, {
          cwd: this.defaultWorkdir,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        });
      } catch (error) {
        resolve({
          exitCode: null,
          summary: `Codex 自检启动失败：${String((error as Error).message ?? error)}`
        });
        return;
      }
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        resolve({
          exitCode: null,
          summary: `Codex 自检超时：${summarize(Buffer.concat(stderr).toString('utf8') || Buffer.concat(stdout).toString('utf8'), 400)}`
        });
      }, 15_000);
      child.stdout?.on('data', (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
      child.stderr?.on('data', (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const output = Buffer.concat(stdout).toString('utf8').trim();
        const error = Buffer.concat(stderr).toString('utf8').trim();
        const exitCode = typeof code === 'number' ? code : null;
        if (exitCode === 0 && output) {
          resolve({ exitCode, summary: output.split('\n')[0]?.trim() || output });
          return;
        }
        resolve({ exitCode, summary: `Codex 自检失败：${summarize(error || output || `exit code ${String(exitCode)}`, 400)}` });
      });
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          exitCode: null,
          summary: `Codex 自检失败：${String((error as Error).message ?? error)}`
        });
      });
    });
  }

  private buildRunDetails(prompt: string, mode: CodexMode): RunDetails {
    const model = mode === 'agent' ? this.agentModel : this.quickModel;
    const sandbox = mode === 'agent' ? this.agentSandbox : this.quickSandbox;
    const timeoutMs = mode === 'agent' ? this.agentTimeoutMs : this.quickTimeoutMs;
    const reasoningEffort = mode === 'agent' ? this.agentReasoningEffort : this.quickReasoningEffort;
    const prefix = mode === 'agent' ? this.agentPromptPrefix : this.quickPromptPrefix;
    const finalPrompt = prefix ? `${prefix}\n\n${prompt}` : prompt;
    const outputPath = resolve(this.defaultWorkdir, 'state', `codex-last-message-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    const codexArgs = ['exec'];
    if (!this.useUserConfig) {
      codexArgs.push('--ignore-user-config', '--ignore-rules', '--ephemeral');
    }
    codexArgs.push(
      '-c',
      `model_reasoning_effort="${reasoningEffort}"`,
      '-c',
      `approval_policy="${this.approvalPolicy}"`,
      '--skip-git-repo-check',
      '--cd',
      this.defaultWorkdir,
      '--model',
      model,
      '--sandbox',
      sandbox,
      '--output-last-message',
      outputPath,
      '-'
    );
    return {
      command: process.platform === 'win32' ? 'cmd.exe' : this.codexCmd,
      args: process.platform === 'win32' ? ['/d', '/s', '/c', this.codexCmd, ...codexArgs] : codexArgs,
      model,
      sandbox,
      prompt: finalPrompt,
      outputPath,
      mode,
      timeoutMs
    };
  }

  private readLastMessage(path: string): string {
    try {
      const text = this.readFileFn(path).trim();
      try {
        unlinkSync(path);
      } catch {
        // Best-effort cleanup; stale files do not affect correctness because names are unique.
      }
      return text;
    } catch {
      return '';
    }
  }

  private ensureOutputDir(path: string): void {
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch {
      // Directory creation is only for convenience. Startup diagnostics should
      // still report the Codex process error if the CLI cannot run.
    }
  }

  private formatStartupFailure(error: unknown, details: RunDetails): string {
    const message = String((error as Error).message ?? error);
    return [
      `Codex 启动失败：${message}`,
      ...this.formatRunDetails(details)
    ].join('\n');
  }

  private formatFailure(text: string): string {
    return `Codex 失败：\n${summarize(text, 900)}`;
  }

  private formatTimeout(details: RunDetails, stdout: Buffer[], stderr: Buffer[]): string {
    const output = Buffer.concat(stdout).toString('utf8').trim();
    const error = Buffer.concat(stderr).toString('utf8').trim();
    const concise = [
      `Codex 任务超过 ${formatDuration(details.timeoutMs)}，已自动终止。`,
      details.mode === 'quick'
        ? '复杂联网查询或代码任务建议使用 /cx，或调大 QUICK_TIMEOUT_MS。'
        : '如需更长执行时间，请调大 AGENT_TIMEOUT_MS。'
    ];
    if (process.env.WECHAT_CODEX_DIAGNOSTICS !== '1') return concise.join('\n');
    return [
      ...concise,
      '',
      ...this.formatRunDetails(details),
      output ? `STDOUT:\n${summarize(output, 700)}` : '',
      error ? `STDERR:\n${summarize(error, 700)}` : ''
    ].filter(Boolean).join('\n');
  }

  private formatRunDetails(details: RunDetails): string[] {
    return [
      `CODEX_CMD=${this.codexCmd}`,
      `DEFAULT_WORKDIR=${this.defaultWorkdir}`,
      `MODEL=${details.model}`,
      `SANDBOX=${details.sandbox}`,
      `TIMEOUT_MS=${details.timeoutMs}`,
      `COMMAND=${formatCommand(details.command, details.args)}`
    ];
  }
}

function positiveInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value !== 'string' || !/^\d+$/u.test(value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function formatDuration(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000} 分钟`;
  if (ms >= 1_000 && ms % 1_000 === 0) return `${ms / 1_000} 秒`;
  return `${ms / 1_000} 秒`;
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].map((part) => /\s/u.test(part) ? JSON.stringify(part) : part).join(' ');
}

export function summarize(text: string, limit = 3500): string {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (normalized.length <= limit) return normalized || '(无输出)';
  return `${normalized.slice(0, limit)}\n\n...输出已截断，共 ${normalized.length} 字符`;
}
