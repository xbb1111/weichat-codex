import type { InboundTextMessage } from '../types.ts';

type RawWeixinMessage = Record<string, unknown>;
const TEXT_ITEM_TYPE = 1;
const FILE_ITEM_TYPE = 4;
const USER_MESSAGE_TYPE = 1;
const BOT_MESSAGE_TYPE = 2;
const FINISH_MESSAGE_STATE = 2;

function firstTextItem(raw: RawWeixinMessage): string | undefined {
  const itemList = raw.item_list;
  if (!Array.isArray(itemList)) return undefined;
  for (const item of itemList) {
    if (!item || typeof item !== 'object') continue;
    const typed = item as Record<string, unknown>;
    if (typed.type !== TEXT_ITEM_TYPE && typed.type !== 'TEXT') continue;
    const textItem = typed.text_item as Record<string, unknown> | undefined;
    if (textItem && typeof textItem.text === 'string') return textItem.text;
  }
  return undefined;
}

export function parseInboundTextMessage(raw: RawWeixinMessage): InboundTextMessage | undefined {
  const messageType = raw.message_type ?? raw.messageType;
  if (messageType === BOT_MESSAGE_TYPE || messageType === 'BOT') return undefined;

  const text = firstTextItem(raw);
  if (!text) return undefined;

  const messageId = String(raw.message_id ?? raw.id ?? '');
  const fromUserId = String(raw.from_user_id ?? raw.fromUserId ?? '');
  const chatType = String(raw.chat_type ?? raw.chatType ?? 'SINGLE');
  if (!messageId || !fromUserId) return undefined;

  return {
    messageId,
    fromUserId,
    chatType,
    text,
    contextToken: typeof raw.context_token === 'string' ? raw.context_token : undefined
  };
}

export function buildTextMessagePayload(input: {
  toUserId: string;
  text: string;
  contextToken?: string;
}) {
  return {
    to_user_id: input.toUserId,
    client_id: `openclaw-weixin-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    message_type: BOT_MESSAGE_TYPE,
    message_state: FINISH_MESSAGE_STATE,
    context_token: input.contextToken,
    item_list: [{ type: TEXT_ITEM_TYPE, text_item: { text: input.text } }]
  };
}

export function buildFileMessagePayload(input: {
  toUserId: string;
  fileName: string;
  fileSize: number;
  md5: string;
  encryptQueryParam: string;
  aesKey: string;
  encryptType?: number;
  contextToken?: string;
}) {
  const fileItem = {
    file_name: input.fileName,
    md5: input.md5,
    len: String(input.fileSize),
    media: {
      file_size: input.fileSize,
      encrypt_query_param: input.encryptQueryParam,
      aes_key: input.aesKey,
      encrypt_type: input.encryptType ?? 1
    }
  };
  return {
    to_user_id: input.toUserId,
    client_id: `openclaw-weixin-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    message_type: BOT_MESSAGE_TYPE,
    message_state: FINISH_MESSAGE_STATE,
    context_token: input.contextToken,
    item_list: [{ type: FILE_ITEM_TYPE, file_item: fileItem }]
  };
}

export function extractUpdateMessages(raw: unknown): RawWeixinMessage[] {
  if (!raw || typeof raw !== 'object') return [];
  const root = raw as Record<string, unknown>;
  const candidates = [
    root.msgs,
    root.update_list,
    root.updates,
    root.message_list,
    root.messages,
    (root.data as Record<string, unknown> | undefined)?.msgs,
    (root.data as Record<string, unknown> | undefined)?.update_list
  ];
  for (const value of candidates) {
    if (Array.isArray(value)) return value.filter((item): item is RawWeixinMessage => Boolean(item && typeof item === 'object'));
  }
  return [];
}

export function extractUpdateCursor(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const root = raw as Record<string, unknown>;
  const cursor = root.get_updates_buf ?? (root.data as Record<string, unknown> | undefined)?.get_updates_buf;
  return typeof cursor === 'string' ? cursor : undefined;
}
