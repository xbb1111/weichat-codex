import { randomUUID } from 'node:crypto';

const FIXED_BASE_URL = 'https://ilinkai.weixin.qq.com';
const DEFAULT_BOT_TYPE = '3';
const QR_LONG_POLL_TIMEOUT_MS = 35_000;

export type LoginSession = {
  sessionKey: string;
  qrcode: string;
  qrcodeUrl: string;
};

export type BotSession = {
  baseurl: string;
  botToken: string;
  ilinkBotId: string;
  ilinkUserId?: string;
};

export class WeixinQrLogin {
  private botType: string;
  private fetchFn: typeof fetch;
  private sleepFn: (ms: number) => Promise<void>;

  constructor(input: { botType?: string; fetchFn?: typeof fetch; sleepFn?: (ms: number) => Promise<void> } = {}) {
    this.botType = input.botType ?? DEFAULT_BOT_TYPE;
    this.fetchFn = input.fetchFn ?? fetch;
    this.sleepFn = input.sleepFn ?? sleep;
  }

  async start(): Promise<LoginSession> {
    const url = `${FIXED_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(this.botType)}`;
    const response = await this.fetchFn(url);
    if (!response.ok) throw new Error(`get_bot_qrcode failed: HTTP ${response.status}`);
    const body = await response.json() as { qrcode?: string; qrcode_img_content?: string };
    if (!body.qrcode || !body.qrcode_img_content) throw new Error('get_bot_qrcode did not return qrcode data');
    return {
      sessionKey: randomUUID(),
      qrcode: body.qrcode,
      qrcodeUrl: body.qrcode_img_content
    };
  }

  async wait(session: LoginSession, timeoutMs = 480_000): Promise<BotSession> {
    const deadline = Date.now() + timeoutMs;
    let baseUrl = FIXED_BASE_URL;
    while (Date.now() < deadline) {
      const status = await this.poll(baseUrl, session.qrcode);
      if (status.status === 'scaned_but_redirect' && status.redirect_host) {
        baseUrl = `https://${status.redirect_host}`;
      }
      if (status.status === 'confirmed') {
        if (!status.bot_token || !status.ilink_bot_id || !status.baseurl) {
          throw new Error('login confirmed without bot_token, ilink_bot_id, or baseurl');
        }
        return {
          baseurl: status.baseurl,
          botToken: status.bot_token,
          ilinkBotId: status.ilink_bot_id,
          ilinkUserId: status.ilink_user_id
        };
      }
      if (status.status === 'expired') throw new Error('QR code expired');
      await this.sleepFn(1000);
    }
    throw new Error('QR login timed out');
  }

  private async poll(baseUrl: string, qrcode: string): Promise<{
    status?: string;
    bot_token?: string;
    ilink_bot_id?: string;
    baseurl?: string;
    ilink_user_id?: string;
    redirect_host?: string;
  }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), QR_LONG_POLL_TIMEOUT_MS);
    try {
      const response = await this.fetchFn(`${baseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, {
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`get_qrcode_status failed: HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      if (isTransientPollError(error)) return { status: 'wait' };
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientPollError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError') return true;
  const cause = (error as { cause?: unknown }).cause;
  if (cause && typeof cause === 'object' && 'code' in cause) {
    const code = String((cause as { code?: unknown }).code);
    return code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'ECONNRESET' || code === 'ETIMEDOUT';
  }
  return false;
}
