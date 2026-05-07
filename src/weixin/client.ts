import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { buildFileMessagePayload, buildTextMessagePayload, extractUpdateCursor, extractUpdateMessages, parseInboundTextMessage } from './protocol.ts';
import type { InboundTextMessage } from '../types.ts';

const CHANNEL_VERSION = 'codex-weixin-bridge/0.1.0';
const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
const GET_UPDATES_TIMEOUT_MS = 45_000;
const TRANSIENT_NETWORK_RETRIES = 3;
const SESSION_EXPIRED_RET = -14;

type FetchFn = typeof fetch;
type SendFileInput = string | {
  fileName: string;
  content: Buffer | Uint8Array;
};

export class WeixinIlinkApiError extends Error {
  endpoint: string;
  ret?: number;
  errmsg?: string;
  status?: number;
  causeName?: string;
  causeCode?: string;
  causeMessage?: string;

  constructor(input: {
    endpoint: string;
    ret?: number;
    errmsg?: string;
    status?: number;
    message?: string;
    cause?: unknown;
  }) {
    const causeDetail = errorCauseDetail(input.cause);
    const details = [
      input.message ?? `${input.endpoint} failed`,
      typeof input.status === 'number' ? `HTTP ${input.status}` : '',
      typeof input.ret === 'number' ? `ret=${input.ret}` : '',
      input.errmsg ? `errmsg=${input.errmsg}` : '',
      causeDetail.code ? `cause.code=${causeDetail.code}` : '',
      causeDetail.message ? `cause.message=${causeDetail.message}` : ''
    ].filter(Boolean).join(': ');
    super(details);
    this.name = 'WeixinIlinkApiError';
    this.endpoint = input.endpoint;
    this.ret = input.ret;
    this.errmsg = input.errmsg;
    this.status = input.status;
    this.causeName = causeDetail.name;
    this.causeCode = causeDetail.code;
    this.causeMessage = causeDetail.message;
  }
}

export class WeixinSessionExpiredError extends WeixinIlinkApiError {
  constructor(input: { endpoint: string; ret: number; errmsg?: string }) {
    super({ ...input, message: 'Weixin iLink bot session expired; clear saved bot session and scan QR again' });
    this.name = 'WeixinSessionExpiredError';
  }
}

export class WeixinIlinkClient {
  private baseurl: string;
  private botToken: string;
  private ilinkBotId: string;
  private fetchFn: FetchFn;
  private sleepFn: (ms: number) => Promise<void>;
  private contextTokens = new Map<string, string>();

  constructor(input: {
    baseurl: string;
    botToken: string;
    ilinkBotId: string;
    fetchFn?: FetchFn;
    sleepFn?: (ms: number) => Promise<void>;
  }) {
    this.baseurl = input.baseurl.replace(/\/+$/u, '');
    this.botToken = input.botToken;
    this.ilinkBotId = input.ilinkBotId;
    this.fetchFn = input.fetchFn ?? fetch;
    this.sleepFn = input.sleepFn ?? sleep;
  }

  async getUpdates(cursor?: string): Promise<{ cursor?: string; messages: InboundTextMessage[] }> {
    const raw = await this.getUpdatesJson(cursor);
    const messages = extractUpdateMessages(raw).map(parseInboundTextMessage).filter((item): item is InboundTextMessage => Boolean(item));
    for (const message of messages) {
      if (message.contextToken) this.contextTokens.set(message.fromUserId, message.contextToken);
    }
    return {
      cursor: extractUpdateCursor(raw),
      messages
    };
  }

  async sendText(toUserId: string, text: string, contextToken?: string) {
    const resolvedContextToken = contextToken ?? this.contextTokens.get(toUserId);
    if (!resolvedContextToken) {
      throw new Error(`sendmessage requires context_token for ${toUserId}; send a user message first or pass contextToken explicitly`);
    }
    await this.withTransientRetry(() => this.requestJson('sendmessage', `${this.baseurl}/ilink/bot/sendmessage`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          msg: buildTextMessagePayload({ toUserId, text, contextToken: resolvedContextToken }),
          base_info: { channel_version: CHANNEL_VERSION }
        })
      }));
  }

  async sendFile(toUserId: string, input: SendFileInput, contextToken?: string) {
    const resolvedContextToken = contextToken ?? this.contextTokens.get(toUserId);
    if (!resolvedContextToken) {
      throw new Error(`sendmessage requires context_token for ${toUserId}; send a user message first or pass contextToken explicitly`);
    }
    const file = typeof input === 'string' ? readFileInput(input) : {
      fileName: input.fileName,
      content: Buffer.from(input.content)
    };
    const fileMd5 = createHash('md5').update(file.content).digest('hex');
    const mediaKey = createMediaEncryptionKey();
    const encryptedContent = encryptAes128Ecb(file.content, mediaKey.raw);
    const uploadInfo = await this.withTransientRetry(() => this.requestJson('getuploadurl', `${this.baseurl}/ilink/bot/getuploadurl`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        filekey: mediaKey.hex,
        media_type: 3,
        to_user_id: toUserId,
        rawsize: file.content.byteLength,
        rawfilemd5: fileMd5,
        filesize: encryptedContent.byteLength,
        no_need_thumb: true,
        aeskey: mediaKey.hex,
        base_info: { channel_version: CHANNEL_VERSION }
      })
    }));
    const target = parseUploadInfo(uploadInfo, { fileKey: mediaKey.hex, aesKey: mediaKey.base64 });
    const uploadResult = await this.withTransientRetry(async () => {
      const response = await this.fetchFn(buildCdnUploadUrl(target), {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: encryptedContent
      });
      if (!response.ok) {
        throw new WeixinIlinkApiError({ endpoint: 'uploadfile', status: response.status, message: 'uploadfile failed' });
      }
      return parseUploadResult(response, target);
    });
    await this.withTransientRetry(() => this.requestJson('sendmessage', `${this.baseurl}/ilink/bot/sendmessage`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        msg: buildFileMessagePayload({
          toUserId,
          fileName: file.fileName,
          fileSize: file.content.byteLength,
          md5: fileMd5,
          encryptQueryParam: uploadResult.encryptQueryParam,
          aesKey: uploadResult.aesKey,
          encryptType: uploadResult.encryptType,
          contextToken: resolvedContextToken
        }),
        base_info: { channel_version: CHANNEL_VERSION }
      })
    }));
  }

  private headers() {
    return {
      'content-type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': Buffer.from(String(Math.floor(Math.random() * 2 ** 32)), 'utf8').toString('base64'),
      authorization: `Bearer ${this.botToken}`
    };
  }

  private async getUpdatesJson(cursor?: string): Promise<unknown> {
    return this.withTransientRetry(() => this.requestJson('getupdates', `${this.baseurl}/ilink/bot/getupdates`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        get_updates_buf: cursor ?? '',
        base_info: { channel_version: CHANNEL_VERSION }
      }),
      signal: AbortSignal.timeout(GET_UPDATES_TIMEOUT_MS)
    }));
  }

  private async withTransientRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= TRANSIENT_NETWORK_RETRIES; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (!isTransientFetchError(error) || attempt === TRANSIENT_NETWORK_RETRIES) throw error;
        await this.sleepFn(1000 * attempt);
      }
    }
    throw lastError;
  }

  private async requestJson(endpoint: string, url: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchFn(url, init);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new WeixinIlinkApiError({ endpoint, message: `${endpoint} request failed: ${message}`, cause: error });
    }
    const rawText = await response.text();
    let body: unknown;
    try {
      body = rawText ? JSON.parse(rawText) : {};
    } catch {
      throw new WeixinIlinkApiError({ endpoint, status: response.status, message: `${endpoint} returned non-JSON response` });
    }
    if (!response.ok) {
      const api = apiStatus(body);
      throw new WeixinIlinkApiError({ endpoint, status: response.status, ret: api.ret, errmsg: api.errmsg });
    }
    const api = apiStatus(body);
    if (api.ret === SESSION_EXPIRED_RET) {
      throw new WeixinSessionExpiredError({ endpoint, ret: api.ret, errmsg: api.errmsg });
    }
    if (typeof api.ret === 'number' && api.ret !== 0) {
      throw new WeixinIlinkApiError({ endpoint, ret: api.ret, errmsg: api.errmsg });
    }
    return body;
  }
}

function readFileInput(path: string): { fileName: string; content: Buffer } {
  const stats = statSync(path);
  if (!stats.isFile()) throw new Error(`not a file: ${path}`);
  return {
    fileName: basename(path),
    content: readFileSync(path)
  };
}

function parseUploadInfo(raw: unknown, fallback: { fileKey: string; aesKey: string }): { uploadUrl?: string; uploadParam?: string; fileKey: string; aesKey: string; encryptQueryParam?: string; encryptType?: number } {
  if (!raw || typeof raw !== 'object') throw new Error('getuploadurl returned empty response');
  const root = raw as Record<string, unknown>;
  const data = (root.data && typeof root.data === 'object' ? root.data : root) as Record<string, unknown>;
  const uploadUrl = firstString(data.upload_full_url, data.uploadFullUrl, data.upload_url, data.uploadUrl, data.url, data.cdn_upload_url);
  const fileKey = firstString(data.filekey, data.file_key, data.fileKey, data.file_token, data.fileToken) ?? fallback.fileKey;
  const aesKey = encodeMediaAesKey(firstString(data.aeskey, data.aes_key, data.aesKey, data.encrypt_key, data.encryptKey)) ?? fallback.aesKey;
  const uploadParam = firstString(data.upload_param, data.uploadParam);
  const encryptQueryParam = firstString(data.encrypt_query_param, data.encryptQueryParam, uploadParam);
  const encryptType = firstNumber(data.encrypt_type, data.encryptType);
  if (!uploadUrl && !uploadParam) throw new Error('getuploadurl response missing upload url or upload_param');
  return { uploadUrl, uploadParam, fileKey, aesKey, encryptQueryParam, encryptType };
}

function parseUploadResult(response: Response, fallback: { aesKey: string; encryptQueryParam?: string; encryptType?: number }): { encryptQueryParam: string; aesKey: string; encryptType: number } {
  const encryptQueryParam = response.headers.get('x-encrypted-param')
    ?? response.headers.get('x-encrypt-param')
    ?? response.headers.get('x-cdn-param')
    ?? fallback.encryptQueryParam;
  if (!encryptQueryParam) {
    throw new Error('uploadfile response missing x-encrypted-param and getuploadurl response missing upload_param');
  }
  return {
    encryptQueryParam,
    aesKey: fallback.aesKey,
    encryptType: fallback.encryptType ?? 1
  };
}

function buildCdnUploadUrl(target: { uploadUrl?: string; uploadParam?: string; fileKey: string }): string {
  if (target.uploadParam) {
    return `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(target.uploadParam)}&filekey=${encodeURIComponent(target.fileKey)}`;
  }
  if (target.uploadUrl) return target.uploadUrl;
  throw new Error('getuploadurl response missing upload url or upload_param');
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

function createMediaEncryptionKey(): { raw: Buffer; hex: string; base64: string } {
  const raw = randomBytes(16);
  const hex = raw.toString('hex');
  return {
    raw,
    hex,
    base64: Buffer.from(hex, 'utf8').toString('base64')
  };
}

function encodeMediaAesKey(value?: string): string | undefined {
  if (!value) return undefined;
  if (/^[0-9a-f]{32}$/iu.test(value)) return Buffer.from(value, 'utf8').toString('base64');
  return value;
}

function encryptAes128Ecb(content: Buffer, keyInput: string | Buffer): Buffer {
  const key = Buffer.isBuffer(keyInput) ? keyInput : normalizeAesKey(keyInput);
  const cipher = createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(content), cipher.final()]);
}

function normalizeAesKey(value: string): Buffer {
  const decoded = decodeAesKey(value);
  if (decoded.length === 16) return decoded;
  const key = Buffer.alloc(16);
  decoded.copy(key, 0, 0, Math.min(decoded.length, 16));
  return key;
}

function decodeAesKey(value: string): Buffer {
  if (/^[0-9a-f]{32}$/iu.test(value)) return Buffer.from(value, 'hex');
  try {
    const base64 = Buffer.from(value, 'base64');
    if (base64.length === 16) return base64;
  } catch {
    // Fall back to UTF-8 below.
  }
  return Buffer.from(value, 'utf8');
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function apiStatus(body: unknown): { ret?: number; errmsg?: string } {
  if (!body || typeof body !== 'object') return {};
  const root = body as Record<string, unknown>;
  const ret = typeof root.ret === 'number' ? root.ret : undefined;
  const errmsgValue = root.errmsg ?? root.err_msg ?? root.message;
  return {
    ret,
    errmsg: typeof errmsgValue === 'string' ? errmsgValue : undefined
  };
}

function isTransientFetchError(error: unknown): boolean {
  if (!(error instanceof WeixinIlinkApiError)) return false;
  return error.causeCode === 'UND_ERR_CONNECT_TIMEOUT'
    || error.causeCode === 'UND_ERR_HEADERS_TIMEOUT'
    || error.causeCode === 'ECONNRESET'
    || error.causeCode === 'ETIMEDOUT';
}

function errorCauseDetail(error: unknown): { name?: string; code?: string; message?: string } {
  if (!(error instanceof Error)) return {};
  const cause = (error as { cause?: unknown }).cause;
  if (!cause || typeof cause !== 'object') return {};
  const record = cause as { name?: unknown; code?: unknown; message?: unknown };
  return {
    name: typeof record.name === 'string' ? record.name : undefined,
    code: typeof record.code === 'string' ? record.code : undefined,
    message: typeof record.message === 'string' ? record.message : undefined
  };
}
