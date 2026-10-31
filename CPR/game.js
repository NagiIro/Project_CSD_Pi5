'use strict';
/* ============================================================
   醫院尋證•急救行動 — CPR 節拍按壓遊戲
   - 5 次節拍隨機分佈，整段 10–15 秒
   - 空白鍵在節拍時間 ±0.5s 內按下 = 正確
   - 5 次全中 → 傳送 API request + 循環播放 Loop.mp4
   - 任何錯誤 / 漏按 → 失敗，回開始畫面
   - Ctrl + R → 隨時回開始畫面
   ============================================================ */

const $ = id => document.getElementById(id);

/* ---------------- 設定儲存 ---------------- */
const store = {
  get pwd()    { return localStorage.getItem('cpr_pwd') || '0000'; },
  set pwd(v)   { localStorage.setItem('cpr_pwd', v); },
  get apiUrl() { return localStorage.getItem('cpr_api_url') || ''; },
  set apiUrl(v){ localStorage.setItem('cpr_api_url', v); },
  get apiOn()  { return localStorage.getItem('cpr_api_on') === '1'; },
  set apiOn(v) { localStorage.setItem('cpr_api_on', v ? '1' : '0'); },
  get durationSec() {
    const v = parseInt(localStorage.getItem('cpr_duration'), 10);
    return (v >= 5 && v <= 120) ? v : 12;
  },
  set durationSec(v) { localStorage.setItem('cpr_duration', String(v)); },
};

/* ---------------- 畫面切換 ---------------- */
const SCREENS = ['start', 'pwd', 'settings', 'howto', 'game', 'fail', 'video'];
let current = 'start';
function show(name) {
  current = name;
  for (const s of SCREENS) $('screen-' + s).classList.toggle('hidden', s !== name);
}

/* ---------------- 音效 (WebAudio, 無需外部檔) ---------------- */
let actx = null;
function audioInit() {
  if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} }
  if (actx && actx.state === 'suspended') actx.resume();
}
function beep(freq, dur, type = 'square', vol = 0.15, when = 0) {
  if (!actx) return;
  const t = actx.currentTime + when;
  const o = actx.createOscillator(), g = actx.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g); g.connect(actx.destination);
  o.start(t); o.stop(t + dur);
}
const sndCue   = () => beep(880, 0.09, 'square', 0.18);
const sndHit   = () => { beep(660, 0.08, 'square', 0.2); beep(990, 0.12, 'square', 0.2, 0.08); };
const sndFail  = () => beep(140, 0.9, 'sawtooth', 0.22);
const sndWin   = () => { [523, 659, 784, 1046].forEach((f, i) => beep(f, 0.15, 'square', 0.18, i * 0.12)); };

/* ---------------- API Request ---------------- */
function sendApiRequest() {
  if (!store.apiOn || !store.apiUrl) return;
  try {
    fetch(store.apiUrl, { method: 'GET', mode: 'no-cors', cache: 'no-store' }).catch(() => {});
  } catch (e) { /* 忽略，不影響遊戲 */ }
}

/* ============================================================
   CPR 遊戲核心
   ============================================================ */
const HIT_WINDOW = 500;          // ±0.5 秒容許誤差 (ms)
const LEAD_TIME  = 2000;         // 標記提前 2 秒從右側出現 (ms)
const STRIKE_X   = 0.22;         // 判定線在畫面 22% 位置

const canvas = $('ecg-canvas');
const ctx = canvas.getContext('2d');

let game = null;   // 進行中的遊戲狀態
let rafId = 0;
const timers = [];

function later(fn, ms) { const id = setTimeout(fn, ms); timers.push(id); return id; }
function clearTimers() { while (timers.length) clearTimeout(timers.pop()); }

/* 依設定的 CPR 時長產生指示：第一拍 1.5–2 秒，之後每 1–2 秒一次 */
function planBeats() {
  const end = store.durationSec * 1000;
  const times = [];
  let t = 1500 + Math.random() * 500;
  while (t <= end - 500) {
    times.push(Math.round(t));
    t += 1000 + Math.random() * 1000;
  }
  if (times.length === 0) times.push(1500);
  return { times, total: end };
}

/* 渲染解析度上限 FHD（1920×1080），超出的屏幕自動放大；小於 FHD 不設下限 */
let gridCanvas = null;
function resizeCanvas() {
  canvas.width = Math.max(1, Math.min(canvas.clientWidth, 1920));
  canvas.height = Math.max(1, Math.min(canvas.clientHeight, 1080));
  buildGrid();
}
/* 格線只需畫一次，預渲染到離屏 canvas */
function buildGrid() {
  const W = canvas.width, H = canvas.height;
  gridCanvas = document.createElement('canvas');
  gridCanvas.width = W; gridCanvas.height = H;
  const g = gridCanvas.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  g.strokeStyle = 'rgba(255,42,42,0.10)';
  g.lineWidth = 1;
  const grid = Math.max(28, Math.round(W / 32));
  g.beginPath();
  for (let x = 0; x < W; x += grid) { g.moveTo(x, 0); g.lineTo(x, H); }
  for (let y = 0; y < H; y += grid) { g.moveTo(0, y); g.lineTo(W, y); }
  g.stroke();
}
window.addEventListener('resize', () => { if (current === 'game') resizeCanvas(); });

/* ---------------- 遊戲開始 ---------------- */
function startGame() {
  stopVideo();
  clearTimers();
  cancelAnimationFrame(rafId);
  lastDraw = 0;
  show('game');          // 先顯示畫面，canvas 才有實際尺寸
  resizeCanvas();

  const plan = planBeats();
  game = {
    beats: plan.times.map(t => ({ t, judged: false })),
    startTime: performance.now(),
    hits: 0,
    over: false,
    flat: false,
    spikes: [],          // 心電圖跳動事件 {t, amp}（按壓成功時大跳）
    trace: new Array(Math.floor(canvas.width / 2)).fill(0),
    lastCue: -1,
  };
  $('game-count').textContent = '0 / ' + game.beats.length;
  $('game-status').textContent = '跟隨節拍，在標記到達白線時按下空白鍵！';
  rafId = requestAnimationFrame(gameLoop);
}

/* ---------------- 主迴圈（鎖 30fps，減輕 PI5 負擔） ---------------- */
const FRAME_MS = 33;
let lastDraw = 0;

function gameLoop(now) {
  if (!game || game.over) return;
  rafId = requestAnimationFrame(gameLoop);   // 先排下一幀，failGame 可取消
  if (now - lastDraw < FRAME_MS) return;     // 30fps 鎖定
  lastDraw = now;
  const t = now - game.startTime;
  const strikeX = canvas.width * STRIKE_X;
  const pxPerMs = (canvas.width - strikeX) / LEAD_TIME;

  /* 節拍提示音（到達判定線瞬間） */
  game.beats.forEach((b) => {
    if (!b.cued && t >= b.t) { b.cued = true; if (!b.judged) sndCue(); }
    /* 漏按 → 失敗 */
    if (!b.judged && t > b.t + HIT_WINDOW) return failGame('漏按');
  });
  if (game.over) return;

  drawEcg(t, strikeX, pxPerMs);
}

/* ---------------- 繪圖：心電圖 + 節拍標記（無 shadowBlur，PI5 友善） ---------------- */
function tracePath(mid, H) {
  const W = canvas.width;
  const step = W / game.trace.length;
  ctx.beginPath();
  for (let i = 0; i < game.trace.length; i++) {
    const y = mid - game.trace[i] * H * 0.7;
    i === 0 ? ctx.moveTo(0, y) : ctx.lineTo(i * step, y);
  }
}

function drawEcg(t, strikeX, pxPerMs) {
  const W = canvas.width, H = canvas.height, mid = H / 2;
  if (gridCanvas && gridCanvas.width === W && gridCanvas.height === H) ctx.drawImage(gridCanvas, 0, 0);
  else { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); }

  /* 基線：平靜微幅波動（大幅跳動只在指示時機出現） */
  const v = (Math.random() - 0.5) * 0.018 + Math.sin(t / 480) * 0.008;
  game.spikes = game.spikes.filter(s => t - s.t < 700);
  /* 依目前寬度動態校正波形緩衝長度（防止初始化時尺寸為 0）；每 3px 一點降低繪製成本 */
  const N = Math.max(2, Math.floor(W / 3));
  while (game.trace.length < N) game.trace.unshift(0);
  while (game.trace.length > N) game.trace.shift();
  game.trace.push(game.flat ? 0 : v);
  game.trace.shift();
  game.frames = (game.frames || 0) + 1;

  /* 畫波形：寬半透明 + 窄實色兩層，模擬發光（比 shadowBlur 便宜得多） */
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(255,42,42,0.30)';
  ctx.lineWidth = Math.max(4, H * 0.009);
  tracePath(mid, H); ctx.stroke();
  ctx.strokeStyle = game.flat ? '#ff2a2a' : '#ff5a5a';
  ctx.lineWidth = Math.max(1.5, H * 0.0035);
  tracePath(mid, H); ctx.stroke();

  /* 心跳：指示到達判定線瞬間，在判定線位置大幅跳動（QRS 波） */
  for (const s of game.spikes) {
    const p = (t - s.t) / 700;
    if (p < 0 || p >= 1) continue;
    const env = p < 0.12 ? p / 0.12 : 1 - (p - 0.12) / 0.88;  // 快起慢落
    const halfW = W * 0.055;
    const ampPx = s.amp * env * H * 0.30;
    for (const pass of [[Math.max(5, H * 0.010), 'rgba(255,42,42,0.30)'], [Math.max(2, H * 0.004), '#ff5a5a']]) {
      ctx.strokeStyle = pass[1];
      ctx.lineWidth = pass[0];
      ctx.beginPath();
      const SEG = 24;
      for (let i = 0; i <= SEG; i++) {
        const u = -1 + (i / SEG) * 2;
        const q = Math.exp(-Math.pow(u * 3.2, 2))                       // R 主峰
                - 0.38 * Math.exp(-Math.pow((u - 0.42) * 3.6, 2))       // S 下陷
                + 0.12 * Math.exp(-Math.pow((u + 0.55) * 3.0, 2));      // P 前波
        const x = strikeX + u * halfW;
        const y = mid - q * ampPx;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }

  /* 判定線（白線）：同樣用雙層模擬發光 */
  const ringR = H * 0.055;
  ctx.strokeStyle = 'rgba(255,255,255,0.30)';
  ctx.lineWidth = Math.max(4, W * 0.005);
  ctx.beginPath(); ctx.moveTo(strikeX, H * 0.15); ctx.lineTo(strikeX, H * 0.85); ctx.stroke();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = Math.max(1.5, W * 0.0018);
  ctx.beginPath(); ctx.moveTo(strikeX, H * 0.15); ctx.lineTo(strikeX, H * 0.85); ctx.stroke();
  ctx.beginPath(); ctx.arc(strikeX, mid, ringR, 0, Math.PI * 2); ctx.stroke();

  /* 節拍標記（右→左移動，到達白線瞬間按空白鍵） */
  for (const b of game.beats) {
    if (b.judged) continue;
    const x = strikeX + (b.t - t) * pxPerMs;
    if (x < strikeX - 60 || x > W + 60) continue;
    const near = Math.abs(b.t - t) < HIT_WINDOW;
    const R = near ? H * 0.042 : H * 0.030;
    ctx.fillStyle = near ? 'rgba(255,255,255,0.25)' : 'rgba(255,42,42,0.25)';
    ctx.beginPath(); ctx.arc(x, mid, R * 1.9, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = near ? '#fff' : '#ff2a2a';
    ctx.beginPath(); ctx.arc(x, mid, R, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#000';
    ctx.font = `bold ${Math.round(R * 1.1)}px monospace`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('♥', x, mid + 1);
  }
}

/* ---------------- 按壓判定 ---------------- */
function judgePress() {
  if (!game || game.over) return;
  const t = performance.now() - game.startTime;

  /* 找最近的未判定節拍 */
  let best = null, bestDt = Infinity;
  for (const b of game.beats) {
    if (b.judged) continue;
    const dt = Math.abs(t - b.t);
    if (dt < bestDt) { bestDt = dt; best = b; }
  }

  if (best && bestDt <= HIT_WINDOW) {
    best.judged = true;
    best.cued = true;                    // 避免稍後提示時間再跳一次
    game.hits++;
    game.spikes.push({ t, amp: 1.15 });  // 按壓瞬間心跳大幅跳動
    sndHit();    flash('hit');
    $('game-count').textContent = game.hits + ' / ' + game.beats.length;
    if (game.hits === game.beats.length) {
      game.over = true;
      $('game-status').textContent = '搶救成功！';
      sndWin();
      later(winGame, 700);
    }
  } else {
    failGame('時機錯誤');
  }
}

function flash(kind) {
  const el = $('game-flash');
  el.classList.remove('hidden', 'hit', 'miss');
  void el.offsetWidth;          // 重新觸發動畫
  el.classList.add(kind);
}

/* ---------------- 勝 / 敗 ---------------- */
function winGame() {
  cancelAnimationFrame(rafId);
  sendApiRequest();            // 傳送 API request
  show('video');
  const v = $('loop-video');
  $('video-error').classList.add('hidden');
  v.muted = false;                   // 影片含症狀解說，需要聲音
  v.currentTime = 0;
  const p = v.play();
  if (p) p.catch(() => { v.muted = true; v.play().catch(() => {}); }); // 若被瀏覽器擋聲音則靜音播放
}

function failGame(reason) {
  if (!game || game.over) return;
  game.over = true;
  game.flat = true;
  cancelAnimationFrame(rafId);
  drawFlatline();
  sndFail();
  flash('miss');
  later(() => { show('fail'); }, 350);
  later(() => { goStart(); }, 3000);   // 顯示失敗畫面後回開始
}

function drawFlatline() {
  const W = canvas.width, H = canvas.height, mid = H / 2;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(255,42,42,0.3)';
  ctx.lineWidth = Math.max(4, H * 0.009);
  ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(W, mid); ctx.stroke();
  ctx.strokeStyle = '#ff2a2a';
  ctx.lineWidth = Math.max(1.5, H * 0.0035);
  ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(W, mid); ctx.stroke();
}

function stopVideo() {
  const v = $('loop-video');
  v.pause();
}

/* ---------------- 回開始畫面（Ctrl+R / 失敗後） ---------------- */
function goStart() {
  clearTimers();
  cancelAnimationFrame(rafId);
  game = null;
  stopVideo();
  $('pwd-input').value = '';
  $('pwd-error').classList.add('hidden');
  show('start');
}

/* ============================================================
   設定畫面
   ============================================================ */
function openSettings() {
  $('set-api-on').checked = store.apiOn;
  $('set-api-url').value = store.apiUrl;
  $('set-duration').value = store.durationSec;
  $('set-pwd-new').value = '';
  $('set-pwd-new2').value = '';
  $('set-msg').classList.add('hidden');
  show('settings');
}

function saveSettings() {
  const p1 = $('set-pwd-new').value.trim();
  const p2 = $('set-pwd-new2').value.trim();
  const msg = $('set-msg');

  const dur = parseInt($('set-duration').value, 10);
  if (!(dur >= 5 && dur <= 120)) { msg.textContent = 'CPR 時長須為 5–120 秒'; msg.className = 'msg err'; return; }

  if (p1 || p2) {
    if (p1 !== p2) { msg.textContent = '兩次密碼輸入不一致'; msg.className = 'msg err'; return; }
    if (!/^\d{4,8}$/.test(p1)) { msg.textContent = '密碼須為 4–8 位數字'; msg.className = 'msg err'; return; }
    store.pwd = p1;
  }
  store.apiOn = $('set-api-on').checked;
  store.apiUrl = $('set-api-url').value.trim();
  store.durationSec = dur;
  msg.textContent = '已儲存 ✔';
  msg.className = 'msg';
  later(goStart, 900);
}

/* ============================================================
   事件綁定
   ============================================================ */
function showHowto() {
  $('howto-duration').textContent = store.durationSec;
  show('howto');
}

$('btn-start').addEventListener('click', () => { audioInit(); showHowto(); });
$('btn-howto-go').addEventListener('click', () => { audioInit(); startGame(); });
$('btn-settings').addEventListener('click', () => { audioInit(); $('pwd-input').value = ''; $('pwd-error').classList.add('hidden'); show('pwd'); setTimeout(() => $('pwd-input').focus(), 50); });

$('btn-pwd-ok').addEventListener('click', tryPwd);
$('pwd-input').addEventListener('keydown', e => { if (e.key === 'Enter') tryPwd(); });
function tryPwd() {
  if ($('pwd-input').value === store.pwd) openSettings();
  else { $('pwd-error').classList.remove('hidden'); $('pwd-input').value = $('pwd-input').value; beep(180, 0.25, 'sawtooth', 0.2); }
}
$('btn-pwd-back').addEventListener('click', goStart);

$('btn-set-save').addEventListener('click', saveSettings);
$('btn-set-back').addEventListener('click', goStart);

$('loop-video').addEventListener('error', () => $('video-error').classList.remove('hidden'));

/* 全域鍵盤 */
document.addEventListener('keydown', e => {
  /* Ctrl + R → 回開始畫面（阻止瀏覽器重新整理） */
  if (e.ctrlKey && (e.key === 'r' || e.key === 'R')) {
    e.preventDefault();
    audioInit();
    goStart();
    return;
  }
  if (e.repeat) return;

  const isSpace = e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar';
  if (!isSpace) return;
  e.preventDefault();

  if (current === 'game') judgePress();
  else if (current === 'start') { audioInit(); showHowto(); }
  else if (current === 'howto') { audioInit(); startGame(); }
});

/* 防止空白鍵捲動 / 觸發按鈕 */
window.addEventListener('keyup', e => { if (e.code === 'Space') e.preventDefault(); });

/* ---------------- 測試掛鉤（自動化測試用，不影響遊戲） ---------------- */
window.__cpr = {
  state: () => current,
  beats: () => (game ? game.beats.map(b => ({ t: b.t, judged: b.judged })) : []),
  hits: () => (game ? game.hits : 0),
  trace: () => (game ? game.trace.slice(-20) : []),
  frames: () => (game ? (game.frames || 0) : 0),
  start: () => { audioInit(); startGame(); },
  reset: () => goStart(),
};

show('start');
