import { createServer } from 'node:http';
import type { BridgeStore } from './store.ts';

export function startWebUi(input: { store: BridgeStore; host?: string; port?: number }) {
  const host = input.host ?? process.env.WECHAT_CODEX_WEB_HOST ?? '127.0.0.1';
  const port = input.port ?? Number(process.env.WECHAT_CODEX_WEB_PORT ?? 17878);
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${host}:${port}`);
    if (url.pathname === '/api/events') {
      const limit = Number(url.searchParams.get('limit') ?? 200);
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store'
      });
      response.end(JSON.stringify({ events: input.store.listChatEvents(limit) }));
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(renderHtml());
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  });
  server.listen(port, host, () => {
    console.log(`wechat transcript UI: http://${host}:${port}`);
  });
  return server;
}

function renderHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>WeChat ClawBot Transcript</title>
  <style>
    :root { color-scheme: light dark; font-family: "Segoe UI", system-ui, sans-serif; }
    body { margin: 0; background: #f6f7f9; color: #17202a; }
    header { height: 52px; display: flex; align-items: center; padding: 0 18px; background: #111827; color: white; }
    main { max-width: 920px; margin: 0 auto; padding: 18px; }
    .event { margin: 10px 0; display: flex; }
    .event.inbound { justify-content: flex-end; }
    .bubble { max-width: min(680px, 86vw); white-space: pre-wrap; word-break: break-word; border-radius: 8px; padding: 10px 12px; line-height: 1.45; box-shadow: 0 1px 2px rgba(15, 23, 42, .08); }
    .inbound .bubble { background: #3dd17f; color: #07140b; }
    .outbound .bubble { background: #fff; border: 1px solid #d6dbe2; }
    .system .bubble { background: #e8edf4; color: #374151; font-size: 13px; }
    .meta { display: block; margin-bottom: 4px; font-size: 11px; opacity: .65; }
    @media (prefers-color-scheme: dark) {
      body { background: #111827; color: #e5e7eb; }
      header { background: #030712; }
      .outbound .bubble { background: #1f2937; border-color: #374151; }
      .system .bubble { background: #263142; color: #cbd5e1; }
    }
  </style>
</head>
<body>
  <header>WeChat ClawBot Transcript</header>
  <main id="events"></main>
  <script>
    const root = document.getElementById('events');
    let last = '';
    function escapeText(value) {
      return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    }
    async function refresh() {
      const response = await fetch('/api/events?limit=200', { cache: 'no-store' });
      const data = await response.json();
      const html = data.events.map(event => {
        const meta = [event.direction, event.mode, event.taskId ? '#' + event.taskId : '', new Date(event.createdAt).toLocaleString()].filter(Boolean).join(' ');
        return '<section class="event ' + event.direction + '"><div class="bubble"><span class="meta">' + escapeText(meta) + '</span>' + escapeText(event.text) + '</div></section>';
      }).join('');
      if (html !== last) {
        root.innerHTML = html || '<section class="event system"><div class="bubble">暂无聊天记录</div></section>';
        last = html;
        window.scrollTo({ top: document.body.scrollHeight });
      }
    }
    refresh();
    setInterval(refresh, 1500);
  </script>
</body>
</html>`;
}
