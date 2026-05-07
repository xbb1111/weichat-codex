import { DatabaseSync } from 'node:sqlite';
import type { ChatEvent, ChatEventDirection, PendingAction, Reminder, TaskRecord, TaskStatus } from './types.ts';

type SqlValue = string | number | null;

export class BridgeStore {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_user_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'quick',
        status TEXT NOT NULL,
        prompt TEXT NOT NULL,
        result TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_user_id TEXT NOT NULL,
        type TEXT NOT NULL,
        description TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_user_id TEXT NOT NULL,
        schedule_type TEXT NOT NULL,
        fire_at TEXT NOT NULL,
        text TEXT NOT NULL,
        active INTEGER NOT NULL,
        last_fired_at TEXT
      );
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_user_id TEXT,
        event TEXT NOT NULL,
        detail TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chat_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_user_id TEXT,
        direction TEXT NOT NULL,
        message_id TEXT,
        task_id INTEGER,
        mode TEXT,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    this.ensureColumn('tasks', 'mode', "TEXT NOT NULL DEFAULT 'quick'");
  }

  getOwnerUserId(): string | undefined {
    return this.getKv('owner_user_id');
  }

  setOwnerUserId(value: string) {
    this.setKv('owner_user_id', value);
  }

  getUpdateCursor(): string | undefined {
    return this.getKv('get_updates_buf');
  }

  setUpdateCursor(value: string) {
    this.setKv('get_updates_buf', value);
  }

  clearUpdateCursor() {
    this.deleteKv('get_updates_buf');
  }

  getBotSession(): { baseurl: string; botToken: string; ilinkBotId: string } | undefined {
    const baseurl = this.getKv('bot_baseurl');
    const botToken = this.getKv('bot_token');
    const ilinkBotId = this.getKv('ilink_bot_id');
    if (!baseurl || !botToken || !ilinkBotId) return undefined;
    return { baseurl, botToken, ilinkBotId };
  }

  setBotSession(input: { baseurl: string; botToken: string; ilinkBotId: string }) {
    this.setKv('bot_baseurl', input.baseurl);
    this.setKv('bot_token', input.botToken);
    this.setKv('ilink_bot_id', input.ilinkBotId);
  }

  clearBotSession() {
    this.deleteKv('bot_baseurl');
    this.deleteKv('bot_token');
    this.deleteKv('ilink_bot_id');
  }

  createTask(input: { ownerUserId: string; kind: string; mode?: 'quick' | 'agent'; status: TaskStatus; prompt: string; result?: string }): number {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      INSERT INTO tasks (owner_user_id, kind, mode, status, prompt, result, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.ownerUserId, input.kind, input.mode ?? 'quick', input.status, input.prompt, input.result ?? null, now, now);
    return Number(result.lastInsertRowid);
  }

  getTask(id: number): TaskRecord | undefined {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, SqlValue> | undefined;
    return row ? mapTask(row) : undefined;
  }

  updateTask(id: number, status: TaskStatus, resultText?: string) {
    this.db.prepare('UPDATE tasks SET status = ?, result = ?, updated_at = ? WHERE id = ?')
      .run(status, resultText ?? null, new Date().toISOString(), id);
  }

  failStaleRunningTasks(olderThan: Date, reason: string): number {
    const result = this.db.prepare(`
      UPDATE tasks
      SET status = 'failed', result = ?, updated_at = ?
      WHERE status = 'running' AND created_at < ?
    `).run(reason, new Date().toISOString(), olderThan.toISOString());
    return Number(result.changes);
  }

  listRecentTasks(limit = 5): TaskRecord[] {
    const rows = this.db.prepare('SELECT * FROM tasks ORDER BY id DESC LIMIT ?').all(limit) as Record<string, SqlValue>[];
    return rows.map(mapTask);
  }

  createPendingAction(input: {
    ownerUserId: string;
    type: string;
    description: string;
    payload?: Record<string, unknown>;
  }): number {
    const result = this.db.prepare(`
      INSERT INTO pending_actions (owner_user_id, type, description, payload, status, created_at)
      VALUES (?, ?, ?, ?, 'pending', ?)
    `).run(input.ownerUserId, input.type, input.description, JSON.stringify(input.payload ?? {}), new Date().toISOString());
    return Number(result.lastInsertRowid);
  }

  getPendingAction(id: number): PendingAction | undefined {
    const row = this.db.prepare('SELECT * FROM pending_actions WHERE id = ?').get(id) as Record<string, SqlValue> | undefined;
    return row ? mapAction(row) : undefined;
  }

  listPendingActions(ownerUserId: string): PendingAction[] {
    const rows = this.db.prepare(`
      SELECT * FROM pending_actions
      WHERE owner_user_id = ? AND status = 'pending'
      ORDER BY id ASC
    `).all(ownerUserId) as Record<string, SqlValue>[];
    return rows.map(mapAction);
  }

  updatePendingActionStatus(id: number, status: 'confirmed' | 'cancelled') {
    this.db.prepare('UPDATE pending_actions SET status = ? WHERE id = ?').run(status, id);
  }

  createChatEvent(input: {
    ownerUserId?: string;
    direction: ChatEventDirection;
    messageId?: string;
    taskId?: number;
    mode?: 'quick' | 'agent';
    text: string;
  }): number {
    const result = this.db.prepare(`
      INSERT INTO chat_events (owner_user_id, direction, message_id, task_id, mode, text, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.ownerUserId ?? null,
      input.direction,
      input.messageId ?? null,
      input.taskId ?? null,
      input.mode ?? null,
      input.text,
      new Date().toISOString()
    );
    return Number(result.lastInsertRowid);
  }

  listChatEvents(limit = 100): ChatEvent[] {
    const rows = this.db.prepare(`
      SELECT * FROM chat_events
      ORDER BY id ASC
      LIMIT ?
    `).all(limit) as Record<string, SqlValue>[];
    return rows.map(mapChatEvent);
  }

  createReminder(input: {
    ownerUserId: string;
    scheduleType: 'once' | 'daily';
    fireAt: string;
    text: string;
  }): number {
    const result = this.db.prepare(`
      INSERT INTO reminders (owner_user_id, schedule_type, fire_at, text, active, last_fired_at)
      VALUES (?, ?, ?, ?, 1, NULL)
    `).run(input.ownerUserId, input.scheduleType, input.fireAt, input.text);
    return Number(result.lastInsertRowid);
  }

  getReminder(id: number): Reminder | undefined {
    const row = this.db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as Record<string, SqlValue> | undefined;
    return row ? mapReminder(row) : undefined;
  }

  dueReminders(now: Date): Reminder[] {
    const rows = this.db.prepare(`
      SELECT * FROM reminders
      WHERE active = 1 AND fire_at <= ?
      ORDER BY fire_at ASC
    `).all(now.toISOString()) as Record<string, SqlValue>[];
    return rows.map(mapReminder);
  }

  markReminderFired(id: number, nextFireAt?: string) {
    if (nextFireAt) {
      this.db.prepare('UPDATE reminders SET fire_at = ?, last_fired_at = ? WHERE id = ?')
        .run(nextFireAt, new Date().toISOString(), id);
      return;
    }
    this.db.prepare('UPDATE reminders SET active = 0, last_fired_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id);
  }

  audit(ownerUserId: string | undefined, event: string, detail: Record<string, unknown>) {
    this.db.prepare('INSERT INTO audit_log (owner_user_id, event, detail, created_at) VALUES (?, ?, ?, ?)')
      .run(ownerUserId ?? null, event, JSON.stringify(detail), new Date().toISOString());
  }

  private getKv(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  private setKv(key: string, value: string) {
    this.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  private deleteKv(key: string) {
    this.db.prepare('DELETE FROM kv WHERE key = ?').run(key);
  }

  private ensureColumn(table: string, column: string, definition: string) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.some((entry) => entry.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function mapTask(row: Record<string, SqlValue>): TaskRecord {
  return {
    id: Number(row.id),
    ownerUserId: String(row.owner_user_id),
    kind: String(row.kind),
    mode: (String(row.mode ?? 'quick') === 'agent' ? 'agent' : 'quick'),
    status: String(row.status) as TaskStatus,
    prompt: String(row.prompt),
    result: typeof row.result === 'string' ? row.result : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function mapAction(row: Record<string, SqlValue>): PendingAction {
  return {
    id: Number(row.id),
    ownerUserId: String(row.owner_user_id),
    type: String(row.type),
    description: String(row.description),
    payload: JSON.parse(String(row.payload)),
    status: String(row.status) as PendingAction['status'],
    createdAt: String(row.created_at)
  };
}

function mapChatEvent(row: Record<string, SqlValue>): ChatEvent {
  const mode = row.mode === 'quick' || row.mode === 'agent' ? row.mode : undefined;
  return {
    id: Number(row.id),
    ownerUserId: typeof row.owner_user_id === 'string' ? row.owner_user_id : undefined,
    direction: String(row.direction) as ChatEventDirection,
    messageId: typeof row.message_id === 'string' ? row.message_id : undefined,
    taskId: typeof row.task_id === 'number' ? Number(row.task_id) : undefined,
    mode,
    text: String(row.text),
    createdAt: String(row.created_at)
  };
}

function mapReminder(row: Record<string, SqlValue>): Reminder {
  return {
    id: Number(row.id),
    ownerUserId: String(row.owner_user_id),
    scheduleType: String(row.schedule_type) as Reminder['scheduleType'],
    fireAt: String(row.fire_at),
    text: String(row.text),
    active: Number(row.active) === 1,
    lastFiredAt: typeof row.last_fired_at === 'string' ? row.last_fired_at : undefined
  };
}
