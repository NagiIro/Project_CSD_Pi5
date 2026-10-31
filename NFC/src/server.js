'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const express = require('express');
const { SerialPort } = require('serialport');
const pn532 = require('pn532');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const ADMIN_PORT = process.env.PORT || 3000;

const DEFAULTS = {
  apiUrl: 'https://api.questxr.ai/api/gate-trigger/0ea5a611e89a3063f15b03a1b4d0e8af5cb7',
  method: 'POST',
  serialPort: 'auto',
  cooldownMs: 5000,
  pollMs: 300,
  reconnectMs: 30000
};

let config = loadConfig();

const state = {
  nfcReady: false,
  nfcPort: null,
  nfcError: null,
  nextRetryAt: null,
  lastUid: null,
  lastUidAt: null,
  lastTrigger: null,
  startedAt: new Date().toISOString()
};

const logs = [];
function log(type, message) {
  const entry = { time: new Date().toISOString(), type, message };
  logs.push(entry);
  if (logs.length > 200) logs.shift();
  console.log(`[${entry.time}] [${type}] ${message}`);
}

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return { ...DEFAULTS, ...raw };
  } catch (e) {
    return { ...DEFAULTS };
  }
}

function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ---------- Trigger ----------

function sendTrigger(uid) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(config.apiUrl);
    } catch (e) {
      return reject(new Error('API URL 格式無效: ' + config.apiUrl));
    }

    const method = (config.method || 'POST').toUpperCase();
    const body = JSON.stringify({
      uid: uid || 'TEST',
      source: 'pi5-pn532',
      ts: new Date().toISOString()
    });

    let pathname = url.pathname + url.search;
    const headers = {};
    let payload = null;
    if (method === 'GET' || method === 'HEAD') {
      pathname += (url.search ? '&' : '?') + 'uid=' + encodeURIComponent(uid || 'TEST');
    } else {
      payload = body;
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }

    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: pathname,
        method,
        headers,
        timeout: 10000
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { if (data.length < 2048) data += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: data.slice(0, 500) }));
      }
    );
    req.on('timeout', () => req.destroy(new Error('Request timeout (10s)')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function trigger(uid) {
  log('trigger', `卡片 UID: ${uid} → ${config.method} ${config.apiUrl}`);
  try {
    const r = await sendTrigger(uid);
    state.lastTrigger = { time: new Date().toISOString(), uid, ok: r.status >= 200 && r.status < 300, status: r.status };
    log('trigger', `API 回應: HTTP ${r.status}${r.body ? ' — ' + r.body : ''}`);
  } catch (e) {
    state.lastTrigger = { time: new Date().toISOString(), uid, ok: false, error: e.message };
    log('error', `API request 失敗: ${e.message}`);
  }
}

function onTag(uid) {
  const now = Date.now();
  if (state.lastUid === uid && now - state.lastUidAt < config.cooldownMs) return;
  state.lastUid = uid;
  state.lastUidAt = now;
  trigger(uid);
}

// ---------- NFC ----------

async function resolveSerialPath() {
  if (config.serialPort && config.serialPort !== 'auto') return config.serialPort;
  const ports = await SerialPort.list();
  const found = ports.find((p) => /^\/dev\/tty(USB|ACM|AMA)/.test(p.path));
  if (!found) throw new Error('搵唔到序列埠裝置 (/dev/ttyUSB* /dev/ttyACM* /dev/ttyAMA*)，請檢查 PN532 接線');
  return found.path;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, ms, what) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${what}逾時`)), ms))
  ]);
}

// PN532 嘅 InListPassiveTarget 預設係無限重試：冇卡時唔會回應，
// 有卡先回覆。所以唔可以加逾時 —— 否則每個「逾時」都會疊加新指令，
// 擾亂 UART 通訊。真正嘅通訊錯誤會令 promise reject，嗰陣先重連。
async function pollLoop(rfid, ctx) {
  let failures = 0;
  while (ctx.alive) {
    try {
      const tag = await rfid.scanTag();
      failures = 0;
      if (!ctx.alive) return;
      if (tag && tag.uid) onTag(tag.uid);
      await sleep(config.pollMs);
    } catch (e) {
      if (!ctx.alive) return;
      failures++;
      log('error', `掃描失敗 (${failures}/3): ${e.message}`);
      if (failures >= 3) {
        log('error', '連續掃描失敗，重新連接讀卡器...');
        ctx.alive = false;
        try { currentPort && currentPort.close(); } catch (_) {}
        scheduleRetry('讀卡器通訊錯誤');
        return;
      }
      await sleep(1000);
    }
  }
}

let retryTimer = null;
let currentCtx = null;
let currentPort = null;

function scheduleRetry(reason) {
  if (retryTimer) return; // 已排咗期
  state.nextRetryAt = new Date(Date.now() + config.reconnectMs).toISOString();
  log('nfc', `${reason}，${Math.round(config.reconnectMs / 1000)} 秒後自動重試...`);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    state.nextRetryAt = null;
    startNfc();
  }, config.reconnectMs);
}

function reconnectNow() {
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  state.nextRetryAt = null;
  if (currentCtx) currentCtx.alive = false;          // 等 close handler 知係刻意關閉
  if (currentPort) { try { currentPort.close(); } catch (e) {} }
  state.nfcReady = false;
  startNfc();
}

async function startNfc() {
  try {
    const portPath = await resolveSerialPath();
    log('nfc', `開啟序列埠 ${portPath} (115200 baud)`);
    const port = new SerialPort({ path: portPath, baudRate: 115200 });
    const rfid = new pn532.PN532(port);
    const ctx = { alive: true };
    currentCtx = ctx;
    currentPort = port;

    // 'ready' 逾時：port 開到但 PN532 冇回應 → 當搵唔到讀卡器，排程重試
    const readyTimer = setTimeout(() => {
      if (!ctx.alive) return;
      ctx.alive = false;
      state.nfcError = '讀卡器冇回應';
      log('error', 'PN532 初始化逾時（開到 port 但讀卡器冇回應）');
      try { port.close(); } catch (_) {}
      scheduleRetry('讀卡器冇回應');
    }, 8000);

    rfid.on('ready', async () => {
      clearTimeout(readyTimer);
      state.nfcReady = true;
      state.nfcPort = portPath;
      state.nfcError = null;
      log('nfc', 'PN532 準備就緒，等待 NFC 卡...');
      try {
        const v = await withTimeout(rfid.getFirmwareVersion(), 3000, '讀取 firmware');
        log('nfc', `Firmware: ${JSON.stringify(v)}`);
      } catch (e) {
        log('error', e.message);
      }
      if (ctx.alive) pollLoop(rfid, ctx);
    });

    rfid.on('error', (e) => {
      state.nfcReady = false;
      state.nfcError = e.message;
      log('error', `PN532 錯誤: ${e.message}`);
    });

    port.on('close', () => {
      const unexpected = ctx.alive;
      ctx.alive = false;
      if (!unexpected) return; // reconnectNow() 刻意關閉，唔使排期
      state.nfcReady = false;
      state.nfcError = '序列埠已斷開';
      log('error', '序列埠斷開');
      scheduleRetry('序列埠斷開');
    });
  } catch (e) {
    state.nfcReady = false;
    state.nfcError = e.message;
    log('error', `NFC 初始化失敗: ${e.message}`);
    scheduleRetry('NFC 初始化失敗');
  }
}

// ---------- Admin web ----------

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/config', (req, res) => res.json(config));

app.post('/api/config', (req, res) => {
  const { apiUrl, method, serialPort, cooldownMs, reconnectMs } = req.body || {};
  if (apiUrl !== undefined) {
    try { new URL(apiUrl); } catch (e) { return res.status(400).json({ error: 'API URL 格式無效' }); }
    config.apiUrl = apiUrl;
  }
  if (method !== undefined) {
    const m = String(method).toUpperCase();
    if (!['GET', 'POST'].includes(m)) return res.status(400).json({ error: 'Method 只支援 GET / POST' });
    config.method = m;
  }
  const portChanged = serialPort !== undefined && serialPort !== config.serialPort;
  if (serialPort !== undefined) config.serialPort = serialPort;
  if (cooldownMs !== undefined) {
    const c = parseInt(cooldownMs, 10);
    if (isNaN(c) || c < 0) return res.status(400).json({ error: 'cooldownMs 必須為非負整數' });
    config.cooldownMs = c;
  }
  if (reconnectMs !== undefined) {
    const r = parseInt(reconnectMs, 10);
    if (isNaN(r) || r < 1000) return res.status(400).json({ error: 'reconnectMs 最少 1000' });
    config.reconnectMs = r;
  }
  saveConfig();
  log('config', `設定已更新: ${config.method} ${config.apiUrl}`);
  if (portChanged) {
    log('nfc', '序列埠設定已更改，重新尋找讀卡器...');
    reconnectNow();
  }
  res.json({ ok: true, config });
});

app.post('/api/test', async (req, res) => {
  try {
    const r = await sendTrigger('TEST');
    res.json({ ok: r.status >= 200 && r.status < 300, status: r.status, body: r.body });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

app.post('/api/reconnect', (req, res) => {
  log('nfc', '用戶要求即時尋找讀卡器');
  reconnectNow();
  res.json({ ok: true });
});

app.get('/api/status', (req, res) => res.json(state));
app.get('/api/logs', (req, res) => res.json(logs.slice(-50).reverse()));

app.listen(ADMIN_PORT, () => {
  log('admin', `後台已啟動: http://0.0.0.0:${ADMIN_PORT}`);
});

startNfc();
