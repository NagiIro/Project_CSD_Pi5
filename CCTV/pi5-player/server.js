/* PI5 播放服務（零依賴，Node 18+ 直接 node server.js）
 *
 * 職責：第二屏幕的影片播放全部在這裡。
 *  - GET  /                播放頁（Chromium kiosk 全屏開這個）
 *  - GET  /api/state       目前狀態 {video:'A'|'B', heartbeatAgeMs}
 *  - GET|POST /api/play?video=A|B   切換影片（GET 方便手動測試）
 *  - POST /api/heartbeat   遊戲心跳；心跳斷了超過 heartbeatTimeoutMs 且正在播 B → 自動回 A
 *  - GET  /api/config      播放頁讀取影片 URL
 *  - GET  /api/health      健康檢查
 *  - /media/*              影片檔
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const CONFIG_FILE = path.join(ROOT, 'config.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    console.error('[config] 讀取失敗，用預設值：', e.message);
    return { port: 3100, videoA: 'media/gifa.gif', videoB: 'media/gifb.gif', heartbeatTimeoutMs: 6000 };
  }
}
let config = loadConfig();

let current = 'A';
let lastHeartbeat = 0;

/* 看門狗：心跳斷了 → 回 A（遊戲關閉/當機/平板斷線都會觸發） */
setInterval(() => {
  if (current === 'B' && Date.now() - lastHeartbeat > (config.heartbeatTimeoutMs || 6000)) {
    console.log('[watchdog] 心跳逾時，切回影片 A');
    current = 'A';
  }
}, 1000);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.gif': 'image/gif', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.svg': 'image/svg+xml'
};

function sendJson(res, obj, code = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    // 遊戲在 WebView 裡是 file://（不透明來源），Chromium 對「私有網路存取」
    // （LAN IP / 127.0.0.1）會發 preflight 並要求這個 header，否則直接封鎖
    'Access-Control-Allow-Private-Network': 'true',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  console.log('[req]', req.method, req.url, 'from', req.socket.remoteAddress);
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;

  if (req.method === 'OPTIONS') { sendJson(res, { ok: true }); return; }

  if (p === '/' || p === '/index.html' || p === '/player.html') {
    serveFile(res, path.join(ROOT, 'public', 'player.html')); return;
  }
  if (p === '/api/health') { sendJson(res, { ok: true }); return; }
  if (p === '/api/state') {
    sendJson(res, { video: current, heartbeatAgeMs: lastHeartbeat ? Date.now() - lastHeartbeat : null });
    return;
  }
  if (p === '/api/config') {
    sendJson(res, { videoA: config.videoA, videoB: config.videoB }); return;
  }
  if (p === '/api/play') {
    const v = (u.searchParams.get('video') || '').toUpperCase();
    if (v === 'A' || v === 'B') {
      current = v;
      console.log('[play] 切換到影片', v);
      sendJson(res, { ok: true, video: current });
    } else {
      sendJson(res, { ok: false, error: 'video 參數只接受 A 或 B' }, 400);
    }
    return;
  }
  if (p === '/api/heartbeat' && req.method === 'POST') {
    lastHeartbeat = Date.now();
    sendJson(res, { ok: true }); return;
  }
  if (p === '/api/reload-config') {
    config = loadConfig(); sendJson(res, { ok: true, config }); return;
  }
  if (p.startsWith('/media/')) {
    const fp = path.normalize(path.join(ROOT, p));
    if (!fp.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    serveFile(res, fp); return;
  }
  res.writeHead(404); res.end('not found');
});

server.listen(config.port, '0.0.0.0', () => {
  console.log(`PI5 player 運行中: http://0.0.0.0:${config.port}`);
  console.log(`  播放頁（kiosk 開這個）: http://localhost:${config.port}/`);
  console.log(`  手動切換測試: http://localhost:${config.port}/api/play?video=B`);
});
