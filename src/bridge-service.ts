import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { classifyUserText, isOwnerAuthorized, parseActionId } from './security.ts';
import type { BridgeStore } from './store.ts';
import type { InboundTextMessage, PendingAction } from './types.ts';

type CodexResult = { exitCode: number | null; summary: string };
type ConversationMode = 'quick' | 'agent';

export class BridgeService {
  private store: BridgeStore;
  private sendText: (toUserId: string, text: string, contextToken?: string) => Promise<void>;
  private sendFile?: (toUserId: string, filePath: string, contextToken?: string) => Promise<void>;
  private runCodex: (prompt: string, mode: ConversationMode) => Promise<CodexResult>;
  private checkCodex?: () => Promise<CodexResult>;
  private fileSearchRoots: string[];
  private maxReplyChars: number;

  constructor(input: {
    store: BridgeStore;
    sendText: (toUserId: string, text: string, contextToken?: string) => Promise<void>;
    sendFile?: (toUserId: string, filePath: string, contextToken?: string) => Promise<void>;
    runCodex: (prompt: string, mode: ConversationMode) => Promise<CodexResult>;
    checkCodex?: () => Promise<CodexResult>;
    fileSearchRoots?: string[];
  }) {
    this.store = input.store;
    this.sendText = input.sendText;
    this.sendFile = input.sendFile;
    this.runCodex = input.runCodex;
    this.checkCodex = input.checkCodex;
    this.fileSearchRoots = input.fileSearchRoots ?? defaultFileSearchRoots();
    this.maxReplyChars = positiveInt(process.env.MAX_WECHAT_REPLY_CHARS) ?? 1800;
  }

  async handleInbound(message: InboundTextMessage) {
    if (message.chatType !== 'SINGLE') {
      await this.reply(message, '当前 MVP 只支持私聊。');
      return;
    }

    const rawText = message.text.trim();
    const routed = routeMessage(rawText);
    const text = routed.prompt;
    this.recordInbound(message, routed.mode, text);

    const owner = this.store.getOwnerUserId();
    if (!isOwnerAuthorized(owner, message.fromUserId, text)) {
      await this.reply(message, '未授权：这个微信助手只接受已绑定用户的私聊。');
      return;
    }

    if (!owner && text === '绑定') {
      this.store.setOwnerUserId(message.fromUserId);
      this.store.audit(message.fromUserId, 'bind_owner', { messageId: message.messageId });
      await this.reply(message, '绑定成功。之后只有当前微信用户可以使用这个 Codex 助手。');
      return;
    }

    const classification = classifyUserText(text);
    if (classification.kind === 'confirm') {
      await this.confirm(message, parseActionId(text));
      return;
    }
    if (classification.kind === 'cancel') {
      await this.cancel(message, parseActionId(text));
      return;
    }
    if (classification.kind === 'status') {
      await this.status(message);
      return;
    }
    if (classification.kind === 'task') {
      await this.taskStatus(message, parseActionId(text));
      return;
    }
    if (classification.requiresConfirmation) {
      await this.requestConfirmation({ ...message, text }, classification.kind, routed.mode);
      return;
    }
    await this.runCodexTask({ ...message, text }, routed.mode);
  }

  private async status(message: InboundTextMessage) {
    const tasks = this.store.listRecentTasks(5);
    const codexStatus = this.checkCodex ? await this.checkCodex() : undefined;
    const codexLine = codexStatus ? `Codex 自检: ${codexStatus.exitCode === 0 ? 'ok' : 'failed'}\n${codexStatus.summary}` : '';
    if (tasks.length === 0) {
      await this.reply(message, ['当前没有任务。', codexLine].filter(Boolean).join('\n'));
      return;
    }
    const lines = tasks.map((task) => `#${task.id} ${task.mode} ${task.status} ${task.prompt.slice(0, 40)}`);
    await this.reply(message, [`最近任务：\n${lines.join('\n')}`, codexLine].filter(Boolean).join('\n'));
  }

  private async taskStatus(message: InboundTextMessage, id: number | undefined) {
    if (!id) {
      await this.reply(message, '请使用：任务 #id');
      return;
    }
    const task = this.store.getTask(id);
    if (!task) {
      await this.reply(message, `没有找到任务 #${id}。`);
      return;
    }
    await this.reply(message, `任务 #${id}: ${task.mode} ${task.status}\n${task.result ?? task.prompt}`);
  }

  private async requestConfirmation(message: InboundTextMessage, type: string, mode: ConversationMode) {
    const action = buildAction(type, message.text, mode, this.fileSearchRoots);
    const id = this.store.createPendingAction({
      ownerUserId: message.fromUserId,
      type: action.type,
      description: action.description,
      payload: action.payload
    });
    this.store.audit(message.fromUserId, 'pending_action_created', { id, type });
    await this.reply(
      message,
      `待确认 #${id}\n${action.description}\n回复“确认”执行，或“取消”。多个待确认任务时请回复“确认 #${id}”。`
    );
  }

  private async confirm(message: InboundTextMessage, id: number | undefined) {
    const action = await this.resolvePendingAction(message, id, '确认');
    if (!action) return;
    this.store.updatePendingActionStatus(action.id, 'confirmed');
    await this.executeConfirmedAction(message, action);
  }

  private async cancel(message: InboundTextMessage, id: number | undefined) {
    const action = await this.resolvePendingAction(message, id, '取消');
    if (!action) return;
    this.store.updatePendingActionStatus(action.id, 'cancelled');
    this.store.audit(message.fromUserId, 'pending_action_cancelled', { id: action.id });
    await this.reply(message, `已取消 #${action.id}。`);
  }

  private async resolvePendingAction(message: InboundTextMessage, id: number | undefined, verb: '确认' | '取消'): Promise<PendingAction | undefined> {
    if (!id) {
      const actions = this.store.listPendingActions(message.fromUserId);
      if (actions.length === 1) return actions[0];
      await this.reply(message, actions.length === 0 ? `没有可${verb}的待处理动作。` : `请使用：${verb} #id`);
      return undefined;
    }
    const action = this.store.getPendingAction(id);
    if (!action || action.ownerUserId !== message.fromUserId || action.status !== 'pending') {
      await this.reply(message, `没有可${verb}的待处理动作 #${id}。`);
      return undefined;
    }
    return action;
  }

  private async executeConfirmedAction(message: InboundTextMessage, action: PendingAction) {
    this.store.audit(message.fromUserId, 'pending_action_confirmed', { id: action.id, type: action.type });
    if (action.type === 'reminder') {
      const fireAt = String(action.payload.fireAt);
      const text = String(action.payload.text);
      const reminderId = this.store.createReminder({
        ownerUserId: message.fromUserId,
        scheduleType: String(action.payload.scheduleType) === 'daily' ? 'daily' : 'once',
        fireAt,
        text
      });
      await this.reply(message, `提醒已创建 #${reminderId}：${text}`);
      return;
    }
    if (action.type === 'send_file') {
      await this.sendFileAttachment(message, String(action.payload.path ?? ''));
      return;
    }
    const taskId = this.store.createTask({
      ownerUserId: message.fromUserId,
      kind: action.type,
      mode: String(action.payload.mode) === 'agent' ? 'agent' : 'quick',
      status: 'running',
      prompt: String(action.payload.prompt ?? action.description)
    });
    const mode = String(action.payload.mode) === 'agent' ? 'agent' : 'quick';
    await this.reply(message, `任务 #${taskId} (${mode}) 已开始。`, { direction: 'system', taskId, mode });
    void this.finishCodexTask(message.fromUserId, taskId, String(action.payload.prompt ?? action.description), mode, message.contextToken);
  }

  private async sendFileAttachment(message: InboundTextMessage, filePath: string) {
    const resolved = resolve(filePath);
    try {
      const stats = statSync(resolved);
      if (!stats.isFile()) {
        await this.reply(message, `不是文件：${resolved}`);
        return;
      }
      if (!this.sendFile) {
        await this.sendFileAsText(message, resolved);
        return;
      }
      await this.sendFile(message.fromUserId, resolved, message.contextToken);
      await this.reply(message, `已发送文件：${basename(resolved)}`);
      this.store.createChatEvent({
        ownerUserId: message.fromUserId,
        direction: 'outbound',
        text: `已发送文件：${basename(resolved)}`
      });
    } catch (error) {
      await this.reply(message, `文件发送失败：${String((error as Error).message ?? error)}\n路径：${resolved}`);
    }
  }

  private async sendFileAsText(message: InboundTextMessage, filePath: string) {
    const stats = statSync(filePath);
    if (stats.size > 64 * 1024) {
      await this.reply(message, `文件过大：当前回退模式只支持 64KB 内文本发送：${basename(filePath)}\n路径：${filePath}`);
      return;
    }
    const body = readFileSync(filePath, 'utf8');
    await this.reply(message, `文件：${basename(filePath)}\n\n${body}`);
  }

  private async runCodexTask(message: InboundTextMessage, mode: ConversationMode) {
    const taskId = this.store.createTask({
      ownerUserId: message.fromUserId,
      kind: 'codex',
      mode,
      status: 'running',
      prompt: message.text
    });
    await this.reply(message, `任务 #${taskId} (${mode}) 已开始。`, { direction: 'system', taskId, mode });
    void this.finishCodexTask(message.fromUserId, taskId, message.text, mode, message.contextToken);
  }

  private async finishCodexTask(ownerUserId: string, taskId: number, prompt: string, mode: ConversationMode, contextToken?: string) {
    const result = await this.runCodex(prompt, mode);
    const status = result.exitCode === 0 ? 'completed' : 'failed';
    this.store.updateTask(taskId, status, result.summary);
    await this.replyTo(ownerUserId, `任务 #${taskId} ${status === 'completed' ? '完成' : '失败'}：\n${result.summary}`, contextToken, {
      direction: 'outbound',
      taskId,
      mode
    });
  }

  private recordInbound(message: InboundTextMessage, mode: ConversationMode, text: string) {
    this.store.createChatEvent({
      ownerUserId: message.fromUserId,
      direction: 'inbound',
      messageId: message.messageId,
      mode,
      text
    });
  }

  private async reply(message: InboundTextMessage, text: string, event?: { direction?: 'outbound' | 'system'; taskId?: number; mode?: ConversationMode }) {
    await this.replyTo(message.fromUserId, text, message.contextToken, event);
  }

  private async replyTo(ownerUserId: string, text: string, contextToken?: string, event?: { direction?: 'outbound' | 'system'; taskId?: number; mode?: ConversationMode }) {
    for (const chunk of splitReplyText(text, this.maxReplyChars)) {
      await this.sendText(ownerUserId, chunk, contextToken);
      this.store.createChatEvent({
        ownerUserId,
        direction: event?.direction ?? 'outbound',
        taskId: event?.taskId,
        mode: event?.mode,
        text: chunk
      });
    }
  }
}

function splitReplyText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const info = chunkInfo(text);
  const textToSplit = info.body;
  const bodyLimit = Math.max(20, maxChars - 40);
  const chunks = splitTextBody(textToSplit, bodyLimit);
  const width = String(chunks.length).length;
  return chunks.map((chunk, index) => `${info.label} (${String(index + 1).padStart(width, '0')}/${chunks.length})：\n${chunk}`);
}

function chunkInfo(text: string): { label: string; body: string } {
  const match = text.match(/^(任务 #\d+ (?:完成|失败))：\n([\s\S]*)$/u);
  if (match) return { label: match[1], body: match[2] };
  return { label: '消息分片', body: text };
}

function splitTextBody(text: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    const breakAt = findBreakPoint(remaining, maxChars);
    chunks.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function findBreakPoint(text: string, maxChars: number): number {
  const window = text.slice(0, maxChars + 1);
  for (const pattern of ['\n\n', '\n']) {
    const index = window.lastIndexOf(pattern);
    if (index >= Math.floor(maxChars * 0.5)) return index + pattern.length;
  }
  return maxChars;
}

function positiveInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value !== 'string' || !/^\d+$/u.test(value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function routeMessage(text: string): { mode: ConversationMode; prompt: string } {
  const match = text.match(/^\/cx(?:\s+|$)(.*)$/isu);
  if (!match) return { mode: 'quick', prompt: text };
  return { mode: 'agent', prompt: match[1].trim() || text };
}

function buildAction(type: string, text: string, mode: ConversationMode, fileSearchRoots: string[]) {
  if (type === 'reminder') {
    const reminder = parseReminderText(text);
    return {
      type: 'reminder',
      description: `创建提醒：${reminder.text} @ ${reminder.fireAt}`,
      payload: { ...reminder, mode }
    };
  }
  if (type === 'send_file') {
    const path = extractLikelyPath(text) || findLikelyFile(text, fileSearchRoots);
    return {
      type: 'send_file',
      description: path ? `发送文件：${path}` : `发送文件：未找到匹配文件，请使用完整路径重试。原始请求：${text}`,
      payload: { path, mode }
    };
  }
  return {
    type: 'execute',
    description: `执行高风险任务：${text}`,
    payload: { prompt: text, mode }
  };
}

function parseReminderText(text: string): { scheduleType: 'once' | 'daily'; fireAt: string; text: string } {
  const match = text.match(/^提醒我\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+(.+)$/u);
  if (!match) {
    throw new Error('提醒格式应为：提醒我 2026-05-07 09:00 提交材料');
  }
  const fireAt = new Date(`${match[1]}T${match[2]}:00+08:00`).toISOString();
  return { scheduleType: 'once', fireAt, text: match[3] };
}

function extractLikelyPath(text: string): string {
  const match = text.match(/([A-Za-z]:\\[^\s"',，。]+|\\\\[^\s"',，。]+|\.{1,2}[\\/][^\s"',，。]+)/u);
  return match?.[1] ?? '';
}

function findLikelyFile(text: string, roots: string[]): string {
  const wantedExt = wantedExtension(text);
  const terms = searchTerms(text);
  let best: { path: string; score: number } | undefined;
  for (const root of roots) {
    for (const candidate of walkFiles(root, 4)) {
      if (wantedExt && extname(candidate).toLowerCase() !== wantedExt) continue;
      const score = scoreCandidate(candidate, terms);
      if (score > 0 && (!best || score > best.score)) best = { path: candidate, score };
    }
  }
  return best?.path ?? '';
}

function wantedExtension(text: string): string | undefined {
  const lower = text.toLowerCase();
  for (const ext of ['pdf', 'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'txt', 'md', 'zip', 'rar', '7z']) {
    if (lower.includes(ext)) return `.${ext}`;
  }
  return undefined;
}

function searchTerms(text: string): string[] {
  const normalized = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ');
  const words = normalized.split(/\s+/u).filter((word) => word.length >= 2);
  const compact = normalized.replace(/\s+/gu, '');
  const grams: string[] = [];
  for (let i = 0; i < compact.length - 1; i += 1) grams.push(compact.slice(i, i + 2));
  const stop = new Set(['从我', '电脑', '找到', '一个', '类似', '写的', '一篇', '文件', '发给', '给我', 'pdf']);
  return [...new Set([...words, ...grams].filter((term) => !stop.has(term)))];
}

function scoreCandidate(path: string, terms: string[]): number {
  const name = basename(path).toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (name.includes(term)) score += term.length;
  }
  return score;
}

function walkFiles(root: string, maxDepth: number): string[] {
  try {
    const stats = statSync(root);
    if (stats.isFile()) return [resolve(root)];
    if (!stats.isDirectory()) return [];
  } catch {
    return [];
  }
  const out: string[] = [];
  walkInto(resolve(root), 0, maxDepth, out);
  return out;
}

function walkInto(dir: string, depth: number, maxDepth: number, out: string[]) {
  if (depth > maxDepth) return;
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkInto(path, depth + 1, maxDepth, out);
    } else if (entry.isFile()) {
      out.push(path);
    }
  }
}

function defaultFileSearchRoots(): string[] {
  return [
    process.env.DEFAULT_WORKDIR,
    process.env.USERPROFILE ? join(process.env.USERPROFILE, 'Documents') : undefined,
    process.cwd()
  ].filter((value): value is string => Boolean(value));
}
