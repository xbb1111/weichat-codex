import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { BridgeService } from './bridge-service.ts';
import { CodexRunner } from './codex-runner.ts';
import { ReminderScheduler } from './reminders.ts';
import { BridgeStore } from './store.ts';
import { WeixinSessionExpiredError, WeixinIlinkClient } from './weixin/client.ts';
import { WeixinQrLogin } from './weixin/login.ts';
import { startWebUi } from './web-ui.ts';

const statePath = resolve(process.env.WEIXIN_STATE_PATH ?? './state/bridge.sqlite');
mkdirSync(dirname(statePath), { recursive: true });

const store = new BridgeStore(statePath);
const staleTaskCount = store.failStaleRunningTasks(new Date(Date.now() - 10 * 60 * 1000), '服务重启时标记失败：旧运行中任务已失效。');
if (staleTaskCount > 0) {
  console.log(`marked stale running tasks failed: ${staleTaskCount}`);
}
const codex = new CodexRunner({
  codexCmd: process.env.CODEX_CMD ?? 'codex',
  defaultWorkdir: process.env.DEFAULT_WORKDIR ?? process.cwd()
});

if (process.env.OWNER_USER_ID) store.setOwnerUserId(process.env.OWNER_USER_ID);

const session = await resolveBotSession().catch((error) => {
  console.error(formatStartupError(error));
  process.exit(1);
});
const weixin = new WeixinIlinkClient(session);
const service = new BridgeService({
  store,
  sendText: (to, text, contextToken) => weixin.sendText(to, text, contextToken),
  sendFile: (to, filePath, contextToken) => weixin.sendFile(to, filePath, contextToken),
  runCodex: (prompt, mode) => codex.runPrompt(prompt, mode),
  checkCodex: () => codex.checkCli(),
  fileSearchRoots: fileSearchRoots()
});

startWebUi({ store });

const scheduler = new ReminderScheduler({
  store,
  send: async (ownerUserId, text) => {
    try {
      await weixin.sendText(ownerUserId, text);
    } catch (error) {
      console.error('reminder send failed', formatRuntimeError(error));
      throw error;
    }
  }
});
scheduler.start();

console.log('codex-weixin-bridge started');
for (;;) {
  try {
    const updates = await weixin.getUpdates(store.getUpdateCursor());
    if (updates.cursor) store.setUpdateCursor(updates.cursor);
    for (const message of updates.messages) {
      try {
        await service.handleInbound(message);
      } catch (error) {
        console.error('message handling failed', formatRuntimeError(error));
      }
    }
  } catch (error) {
    if (error instanceof WeixinSessionExpiredError) {
      store.clearBotSession();
      store.clearUpdateCursor();
      console.error('weixin session expired; cleared saved bot session. Restart the service to scan a new QR code.', formatRuntimeError(error));
      process.exit(1);
    }
    console.error('poll failed', formatRuntimeError(error));
    await sleep(5000);
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function sleep(ms: number) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function fileSearchRoots(): string[] {
  const configured = process.env.WECHAT_FILE_SEARCH_ROOTS;
  if (configured) return configured.split(';').map((entry) => entry.trim()).filter(Boolean);
  return [
    process.env.DEFAULT_WORKDIR,
    process.env.USERPROFILE ? resolve(process.env.USERPROFILE, 'Documents') : undefined,
    process.cwd()
  ].filter((entry): entry is string => Boolean(entry));
}

async function resolveBotSession() {
  if (process.env.WEIXIN_BASEURL && process.env.WEIXIN_BOT_TOKEN && process.env.WEIXIN_ILINK_BOT_ID) {
    const sessionFromEnv = {
      baseurl: process.env.WEIXIN_BASEURL,
      botToken: process.env.WEIXIN_BOT_TOKEN,
      ilinkBotId: process.env.WEIXIN_ILINK_BOT_ID
    };
    store.setBotSession(sessionFromEnv);
    return sessionFromEnv;
  }
  const persisted = store.getBotSession();
  if (persisted) return persisted;

  console.log('No Weixin bot session found. Starting QR login.');
  const login = new WeixinQrLogin();
  const qr = await login.start();
  console.log('Open this QR URL with a browser or scan it from a terminal QR renderer:');
  console.log(qr.qrcodeUrl);
  const connected = await login.wait(qr);
  const sessionFromLogin = {
    baseurl: connected.baseurl,
    botToken: connected.botToken,
    ilinkBotId: connected.ilinkBotId
  };
  store.setBotSession(sessionFromLogin);
  if (connected.ilinkUserId) {
    store.audit(undefined, 'qr_login_confirmed', { ilinkUserId: connected.ilinkUserId });
  }
  return sessionFromLogin;
}

function formatStartupError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error && 'cause' in error ? String((error as { cause?: unknown }).cause ?? '') : '';
  return [
    '启动失败：无法完成微信 iLink Bot 登录。',
    `错误：${message}`,
    cause ? `底层原因：${cause}` : '',
    '',
    '排查：',
    '1. 运行：Test-NetConnection ilinkai.weixin.qq.com -Port 443',
    '2. 如果你使用代理，先设置 HTTPS_PROXY/HTTP_PROXY 后再运行 cmd /c npm start。',
    '3. 如果网络正常，稍后重试；首次 QR 登录依赖微信 iLink 服务响应。'
  ].filter(Boolean).join('\n');
}

function formatRuntimeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { message: String(error) };
  const detail: Record<string, unknown> = {
    name: error.name,
    message: error.message
  };
  if ('endpoint' in error) detail.endpoint = (error as { endpoint?: unknown }).endpoint;
  if ('ret' in error) detail.ret = (error as { ret?: unknown }).ret;
  if ('errmsg' in error) detail.errmsg = (error as { errmsg?: unknown }).errmsg;
  if ('status' in error) detail.status = (error as { status?: unknown }).status;
  if ('causeName' in error) detail.causeName = (error as { causeName?: unknown }).causeName;
  if ('causeCode' in error) detail.causeCode = (error as { causeCode?: unknown }).causeCode;
  if ('causeMessage' in error) detail.causeMessage = (error as { causeMessage?: unknown }).causeMessage;
  return detail;
}
