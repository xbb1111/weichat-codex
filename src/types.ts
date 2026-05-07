export type ChatType = 'SINGLE' | 'GROUP' | string;

export type InboundTextMessage = {
  messageId: string;
  fromUserId: string;
  chatType: ChatType;
  text: string;
  contextToken?: string;
};

export type TaskStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export type TaskRecord = {
  id: number;
  ownerUserId: string;
  kind: string;
  mode: 'quick' | 'agent';
  status: TaskStatus;
  prompt: string;
  result?: string;
  createdAt: string;
  updatedAt: string;
};

export type PendingAction = {
  id: number;
  ownerUserId: string;
  type: string;
  description: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'confirmed' | 'cancelled';
  createdAt: string;
};

export type ChatEventDirection = 'inbound' | 'outbound' | 'system';

export type ChatEvent = {
  id: number;
  ownerUserId?: string;
  direction: ChatEventDirection;
  messageId?: string;
  taskId?: number;
  mode?: 'quick' | 'agent';
  text: string;
  createdAt: string;
};

export type Reminder = {
  id: number;
  ownerUserId: string;
  scheduleType: 'once' | 'daily';
  fireAt: string;
  text: string;
  active: boolean;
  lastFiredAt?: string;
};
