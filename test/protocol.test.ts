import assert from 'node:assert/strict';
import { test } from './harness.ts';
import { buildFileMessagePayload, buildTextMessagePayload, extractUpdateMessages, parseInboundTextMessage } from '../src/weixin/protocol.ts';
import { WeixinIlinkApiError, WeixinIlinkClient, WeixinSessionExpiredError } from '../src/weixin/client.ts';

test('parses inbound text and preserves context token', () => {
  const message = parseInboundTextMessage({
    message_id: 'm1',
    from_user_id: 'user-1',
    chat_type: 'SINGLE',
    context_token: 'ctx-123',
    item_list: [{ type: 'TEXT', text_item: { text: '绑定' } }]
  });

  assert.deepEqual(message, {
    messageId: 'm1',
    fromUserId: 'user-1',
    chatType: 'SINGLE',
    text: '绑定',
    contextToken: 'ctx-123'
  });
});

test('builds text sendmessage payload compatible with iLink bot text replies', () => {
  const payload = buildTextMessagePayload({
    toUserId: 'user-1',
    text: 'hello',
    contextToken: 'ctx-123'
  });

  assert.equal(payload.to_user_id, 'user-1');
  assert.equal(payload.message_type, 2);
  assert.equal(payload.message_state, 2);
  assert.equal(payload.context_token, 'ctx-123');
  assert.match(payload.client_id, /^openclaw-weixin-/u);
  assert.deepEqual(payload.item_list, [{ type: 1, text_item: { text: 'hello' } }]);
});

test('builds file sendmessage payload with file item metadata', () => {
  const payload = buildFileMessagePayload({
    toUserId: 'user-1',
    fileName: 'report.pdf',
    fileSize: 1234,
    md5: 'md5-1',
    encryptQueryParam: 'download-param-1',
    aesKey: 'aes-key-1',
    contextToken: 'ctx-123'
  });

  assert.equal(payload.to_user_id, 'user-1');
  assert.equal(payload.message_type, 2);
  assert.equal(payload.context_token, 'ctx-123');
  assert.deepEqual(payload.item_list, [{
    type: 4,
    file_item: {
      file_name: 'report.pdf',
      md5: 'md5-1',
      len: '1234',
      media: {
        file_size: 1234,
        encrypt_query_param: 'download-param-1',
        aes_key: 'aes-key-1',
        encrypt_type: 1
      }
    }
  }]);
});

test('extracts messages from real getupdates msgs response shape', () => {
  const messages = extractUpdateMessages({
    ret: 0,
    get_updates_buf: 'cursor-2',
    msgs: [{
      message_id: 'm1',
      from_user_id: 'user-1',
      message_type: 1,
      item_list: [{ type: 1, text_item: { text: 'hello' } }]
    }]
  });

  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.message_id, 'm1');
});

test('parses numeric text item type and filters bot messages', () => {
  const userMessage = parseInboundTextMessage({
    message_id: 'm1',
    from_user_id: 'user-1',
    message_type: 1,
    item_list: [{ type: 1, text_item: { text: 'hello' } }]
  });
  const botMessage = parseInboundTextMessage({
    message_id: 'm2',
    from_user_id: 'bot-1',
    message_type: 2,
    item_list: [{ type: 1, text_item: { text: 'bot echo' } }]
  });

  assert.equal(userMessage?.text, 'hello');
  assert.equal(botMessage, undefined);
});

test('sendText wraps msg and requires a context token', async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const client = new WeixinIlinkClient({
    baseurl: 'https://bot.example.test',
    botToken: 'token-1',
    ilinkBotId: 'bot-1',
    fetchFn: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
    }
  });

  await assert.rejects(() => client.sendText('user-1', 'missing context'), /context_token/u);
  await client.sendText('user-1', 'hello', 'ctx-123');

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.body, {
    msg: {
      to_user_id: 'user-1',
      client_id: (calls[0]?.body as { msg: { client_id: string } }).msg.client_id,
      message_type: 2,
      message_state: 2,
      context_token: 'ctx-123',
      item_list: [{ type: 1, text_item: { text: 'hello' } }]
    },
    base_info: { channel_version: 'codex-weixin-bridge/0.1.0' }
  });
});

test('getUpdates treats ret -14 as session expired', async () => {
  const client = new WeixinIlinkClient({
    baseurl: 'https://bot.example.test',
    botToken: 'token-1',
    ilinkBotId: 'bot-1',
    fetchFn: async () => new Response(JSON.stringify({ ret: -14, errmsg: 'expired' }), { status: 200 })
  });

  await assert.rejects(() => client.getUpdates('cursor-1'), WeixinSessionExpiredError);
});

test('getUpdates includes ret and errmsg in API errors', async () => {
  const client = new WeixinIlinkClient({
    baseurl: 'https://bot.example.test',
    botToken: 'token-1',
    ilinkBotId: 'bot-1',
    fetchFn: async () => new Response(JSON.stringify({ ret: -2, errmsg: 'bad request' }), { status: 200 })
  });

  await assert.rejects(
    () => client.getUpdates('cursor-1'),
    (error) => error instanceof WeixinIlinkApiError && error.message.includes('ret=-2') && error.message.includes('bad request')
  );
});

test('getUpdates retries transient connect timeouts before failing poll', async () => {
  let calls = 0;
  const timeout = new TypeError('fetch failed', {
    cause: Object.assign(new Error('Connect Timeout Error'), {
      name: 'ConnectTimeoutError',
      code: 'UND_ERR_CONNECT_TIMEOUT'
    })
  });
  const client = new WeixinIlinkClient({
    baseurl: 'https://bot.example.test',
    botToken: 'token-1',
    ilinkBotId: 'bot-1',
    sleepFn: async () => {},
    fetchFn: async () => {
      calls += 1;
      if (calls < 3) throw timeout;
      return new Response(JSON.stringify({
        ret: 0,
        get_updates_buf: 'cursor-2',
        msgs: []
      }), { status: 200 });
    }
  });

  const result = await client.getUpdates('cursor-1');

  assert.equal(calls, 3);
  assert.equal(result.cursor, 'cursor-2');
});

test('sendText retries transient connect timeouts before failing reply', async () => {
  let calls = 0;
  const timeout = new TypeError('fetch failed', {
    cause: Object.assign(new Error('Connect Timeout Error'), {
      name: 'ConnectTimeoutError',
      code: 'UND_ERR_CONNECT_TIMEOUT'
    })
  });
  const client = new WeixinIlinkClient({
    baseurl: 'https://bot.example.test',
    botToken: 'token-1',
    ilinkBotId: 'bot-1',
    sleepFn: async () => {},
    fetchFn: async () => {
      calls += 1;
      if (calls < 3) throw timeout;
      return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
    }
  });

  await client.sendText('user-1', 'hello', 'ctx-123');

  assert.equal(calls, 3);
});

test('sendFile gets upload url, uploads encrypted content, then sends file item', async () => {
  const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
  const client = new WeixinIlinkClient({
    baseurl: 'https://bot.example.test',
    botToken: 'token-1',
    ilinkBotId: 'bot-1',
    fetchFn: async (url, init) => {
      calls.push({
        url: String(url),
        method: init?.method,
        body: init?.body instanceof Uint8Array || init?.body instanceof ArrayBuffer ? init.body : init?.body ? JSON.parse(String(init.body)) : undefined
      });
      if (String(url).endsWith('/ilink/bot/getuploadurl')) {
        const body = JSON.parse(String(init?.body));
        assert.equal(typeof body.filekey, 'string');
        assert.equal(body.filekey.length, 32);
        assert.equal(body.media_type, 3);
        assert.equal(body.to_user_id, 'user-1');
        assert.equal(body.rawsize, 8);
        assert.equal(body.rawfilemd5, '0d3762f5814c83c67a0e8c51967158f1');
        assert.equal(body.filesize, 16);
        assert.equal(body.no_need_thumb, true);
        assert.equal(typeof body.aeskey, 'string');
        assert.equal(body.aeskey, body.filekey);
        return new Response(JSON.stringify({
          ret: 0,
          filekey: body.filekey,
          upload_param: 'upload param/1',
          aeskey: body.aeskey,
          encrypt_type: 1
        }), { status: 200 });
      }
      if (String(url) === 'https://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param=upload%20param%2F1&filekey=' + (calls[0]?.body as { filekey: string }).filekey) {
        return new Response('', {
          status: 200,
          headers: { 'x-encrypted-param': 'upload-param-1' }
        });
      }
      return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
    }
  });

  await client.sendFile('user-1', {
    fileName: 'report.pdf',
    content: Buffer.from('pdf body')
  }, 'ctx-123');

  assert.equal(calls.length, 3);
  assert.equal(calls[0]?.url, 'https://bot.example.test/ilink/bot/getuploadurl');
  assert.equal(calls[1]?.url, 'https://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param=upload%20param%2F1&filekey=' + (calls[0]?.body as { filekey: string }).filekey);
  assert.equal(calls[1]?.method, 'POST');
  assert.ok(Buffer.isBuffer(calls[1]?.body) || calls[1]?.body instanceof Uint8Array);
  assert.deepEqual(calls[2]?.body, {
    msg: {
      to_user_id: 'user-1',
      client_id: (calls[2]?.body as { msg: { client_id: string } }).msg.client_id,
      message_type: 2,
      message_state: 2,
      context_token: 'ctx-123',
      item_list: [{
        type: 4,
        file_item: {
          file_name: 'report.pdf',
          md5: '0d3762f5814c83c67a0e8c51967158f1',
          len: '8',
          media: {
            file_size: 8,
            encrypt_query_param: 'upload-param-1',
            aes_key: Buffer.from((calls[0]?.body as { aeskey: string }).aeskey, 'utf8').toString('base64'),
            encrypt_type: 1
          }
        }
      }]
    },
    base_info: { channel_version: 'codex-weixin-bridge/0.1.0' }
  });
});
