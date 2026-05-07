import type { BridgeStore } from './store.ts';
import type { Reminder } from './types.ts';

export class ReminderScheduler {
  private store: BridgeStore;
  private now: () => Date;
  private send: (ownerUserId: string, text: string) => Promise<void>;
  private timer?: NodeJS.Timeout;

  constructor(input: {
    store: BridgeStore;
    now?: () => Date;
    send: (ownerUserId: string, text: string) => Promise<void>;
  }) {
    this.store = input.store;
    this.now = input.now ?? (() => new Date());
    this.send = input.send;
  }

  start(intervalMs = 30_000) {
    this.stop();
    this.timer = setInterval(() => {
      this.tick().catch((error) => console.error('reminder tick failed', error));
    }, intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick() {
    const due = this.store.dueReminders(this.now());
    for (const reminder of due) {
      await this.send(reminder.ownerUserId, `提醒：${reminder.text}`);
      this.afterFire(reminder);
    }
  }

  private afterFire(reminder: Reminder) {
    if (reminder.scheduleType === 'daily') {
      const next = new Date(reminder.fireAt);
      next.setUTCDate(next.getUTCDate() + 1);
      this.store.markReminderFired(reminder.id, next.toISOString());
      return;
    }
    this.store.markReminderFired(reminder.id);
  }
}
