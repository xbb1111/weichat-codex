import assert from 'node:assert/strict';
import { test } from './harness.ts';
import { WeixinQrLogin } from '../src/weixin/login.ts';

test('QR wait retries transient fetch failures while polling status', async () => {
  let calls = 0;
  const login = new WeixinQrLogin({
    fetchFn: async () => {
      calls += 1;
      if (calls === 1) {
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' })
        });
      }
      return new Response(JSON.stringify({
        status: 'confirmed',
        baseurl: 'https://bot.example.test',
        bot_token: 'token-1',
        ilink_bot_id: 'bot-1',
        ilink_user_id: 'user-1'
      }), { status: 200 });
    },
    sleepFn: async () => {}
  });

  const session = await login.wait({ sessionKey: 's1', qrcode: 'qr', qrcodeUrl: 'url' }, 10_000);

  assert.equal(calls, 2);
  assert.deepEqual(session, {
    baseurl: 'https://bot.example.test',
    botToken: 'token-1',
    ilinkBotId: 'bot-1',
    ilinkUserId: 'user-1'
  });
});
