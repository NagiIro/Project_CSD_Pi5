/* 主遊戲邏輯：開始畫面 → 7 分鐘倒數 → 拖放方塊 → 全部正確 →
 * 1) 通知第二屏幕由影片 A 切換為影片 B（固定循環）
 * 2) 發送一條可在 config.json 設定的 API request
 * 重置 / 關閉遊戲 → 第二屏幕切回影片 A。 */
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);

  const els = {
    startScreen: $('#start-screen'),
    gameScreen: $('#game-screen'),
    btnStart: $('#btn-start'),
    btnReset: $('#btn-reset'),
    configError: $('#config-error'),
    timer: $('#timer'),
    tpBlocks: $('#timeplace-blocks'),
    numBlocks: $('#num-blocks'),
    zonesPanel: $('#zones-panel'),
    overlay: $('#overlay'),
    overlayTitle: $('#overlay-title'),
    overlayMsg: $('#overlay-msg'),
    overlayApi: $('#overlay-api'),
    btnOverlayOk: $('#btn-overlay-ok'),
    ghost: $('#drag-ghost')
  };

  let config = null;
  let state = 'boot'; // boot | start | playing | won | lost
  let timerId = null;
  let heartbeatId = null;
  let remainSec = 0;
  let placedCount = 0;
  let totalSlots = 0;

  /* ---------- 載入設定檔（config.json + 遊戲內設定頁的覆寫值） ---------- */
  async function loadConfig() {
    try {
      config = await window.CctvConfig.load();
      document.title = config.gameTitle || document.title;
      $('.game-title').innerHTML = (config.gameTitle || '閉路電視•案件重組')
        .replace('•', '<span class="title-dot">•</span>');
      els.btnStart.textContent = config.startButtonText || '開始重組案件';
    } catch (e) {
      els.configError.textContent = '讀取 config.json 失敗：' + e.message +
        '（請用本機伺服器開啟，例如 python -m http.server）';
      els.btnStart.disabled = true;
    }
  }

  /* ---------- 副屏控制（本機 WebView / PI5 HTTP / 兩者） ---------- */
  function scType() {
    return (config && config.screenControl && config.screenControl.type) || 'local';
  }
  function pi5Base() {
    return ((config && config.screenControl && config.screenControl.pi5BaseUrl) || '').replace(/\/+$/, '');
  }
  function pi5Use() { const t = scType(); return t === 'pi5' || t === 'both'; }

  function screenSetVideo(which) {
    const t = scType();
    if (t === 'local' || t === 'both') {
      window.CctvBus.setScreenState(which);
      window.CctvBus.send(which === 'B' ? { type: 'setVideo', which: 'B' } : { type: 'reset' });
    }
    if (pi5Use()) {
      const base = pi5Base();
      if (base) fetch(base + '/api/play?video=' + which, { method: 'POST' }).catch(() => {});
    }
  }

  function pi5Heartbeat() {
    if (!pi5Use()) return;
    const base = pi5Base();
    if (base) fetch(base + '/api/heartbeat', { method: 'POST' }).catch(() => {});
  }

  /* ---------- 心跳：讓第二屏幕知道遊戲還活著 ---------- */
  function startHeartbeat() {
    stopHeartbeat();
    const beat = () => { window.CctvBus.heartbeat(state); pi5Heartbeat(); };
    beat();
    heartbeatId = setInterval(beat, 1000);
  }
  function stopHeartbeat() { if (heartbeatId) clearInterval(heartbeatId); heartbeatId = null; }

  /* ---------- 全螢幕 ---------- */
  async function enterFullscreen() {
    if (document.fullscreenElement) return;
    try {
      await document.documentElement.requestFullscreen();
    } catch (e) { /* 部分環境（如 iframe / 舊 WebView）不支援，靜默略過 */ }
  }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch (e) {}
  }

  function syncFsButtons() {
    const label = document.fullscreenElement ? '退出全螢幕' : '全螢幕';
    const hudBtn = $('#btn-fullscreen');
    if (hudBtn) hudBtn.textContent = label;
  }
  document.addEventListener('fullscreenchange', syncFsButtons);

  /* ---------- 遊戲流程 ---------- */
  function startGame() {
    state = 'playing';
    remainSec = config.timerSeconds || 420;
    placedCount = 0;
    buildBoard();
    els.startScreen.classList.add('hidden');
    els.overlay.classList.add('hidden');
    els.gameScreen.classList.remove('hidden');
    $('#btn-autowin').classList.toggle('hidden', !config.devAutoWin);
    updateTimer();
    clearInterval(timerId);
    timerId = setInterval(tick, 1000);
    startHeartbeat();
    enterFullscreen(); // 點擊開始屬用戶手勢，可合法進入全螢幕
  }

  function tick() {
    remainSec--;
    updateTimer();
    if (remainSec <= 0) {
      clearInterval(timerId);
      state = 'lost';
      showOverlay(false);
    }
  }

  function updateTimer() {
    const m = Math.max(0, Math.floor(remainSec / 60));
    const s = Math.max(0, remainSec % 60);
    els.timer.textContent = String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    els.timer.classList.toggle('urgent', remainSec <= 60);
  }

  function showOverlay(won) {
    els.overlayTitle.textContent = won ? '案件重組成功！' : '時間到！';
    els.overlayTitle.className = won ? 'win' : 'lose';
    els.overlayMsg.textContent = won
      ? '所有紀錄已正確歸位，第二屏幕已切換播放影片 B。'
      : '未能在時限內完成重組，請再試一次。';
    els.overlayApi.textContent = '';
    els.overlayApi.className = 'api-status';
    els.overlay.classList.remove('hidden');
  }

  async function onWin() {
    clearInterval(timerId);
    state = 'won';
    // 1) 切換第二屏幕到影片 B（本機副屏 / PI5，固定循環）
    screenSetVideo('B');
    showOverlay(true);
    // 2) 發送 API request（可在 config.json 設定；失敗不影響遊戲）
    await sendApiRequest();
    startHeartbeat(); // won 狀態下繼續心跳，直到重置或關閉
  }

  async function sendApiRequest() {
    const api = (config && config.api) || {};
    if (!api.enabled || !api.url) {
      els.overlayApi.textContent = 'API request：未啟用（config.json → api.enabled = false）';
      return;
    }
    els.overlayApi.textContent = 'API request：發送中… ' + api.url;
    try {
      const res = await fetch(api.url, {
        method: api.method || 'POST',
        headers: api.headers || { 'Content-Type': 'application/json' },
        body: (api.method || 'POST').toUpperCase() === 'GET' ? undefined : (api.body || '')
      });
      els.overlayApi.textContent = 'API request：已送出，回應 HTTP ' + res.status;
      els.overlayApi.classList.add(res.ok ? 'ok' : 'err');
    } catch (e) {
      els.overlayApi.textContent = 'API request：失敗（' + e.message + '）';
      els.overlayApi.classList.add('err');
    }
  }

  /* 重置：回開始畫面 + 第二屏幕切回影片 A */
  function resetGame() {
    clearInterval(timerId);
    state = 'start';
    screenSetVideo('A');
    els.gameScreen.classList.add('hidden');
    els.overlay.classList.add('hidden');
    els.startScreen.classList.remove('hidden');
    startHeartbeat();
  }

  /* 關閉遊戲：通知第二屏幕切回影片 A 並停止心跳 */
  window.addEventListener('pagehide', () => {
    if (pi5Use()) {
      const base = pi5Base();
      if (base && navigator.sendBeacon) {
        try { navigator.sendBeacon(base + '/api/play?video=A', ''); } catch (e) {}
      }
    }
    screenSetVideo('A');
    window.CctvBus.clearHeartbeat();
  });

  /* ---------- 建立遊戲板 ---------- */
  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function buildBoard() {
    els.tpBlocks.innerHTML = '';
    els.numBlocks.innerHTML = '';
    els.zonesPanel.innerHTML = '';

    const blocks = [];
    config.zones.forEach((z) => {
      blocks.push({ type: 'timeplace', zoneId: z.id, date: z.date, time: z.time });
      blocks.push({ type: 'num', zoneId: z.id, code: z.camera });
    });
    totalSlots = blocks.length;

    const tp = shuffle(blocks.filter((b) => b.type === 'timeplace'));
    const num = shuffle(blocks.filter((b) => b.type === 'num'));
    tp.forEach((b) => els.tpBlocks.appendChild(makeBlock(b)));
    num.forEach((b) => els.numBlocks.appendChild(makeBlock(b)));

    config.zones.forEach((z) => els.zonesPanel.appendChild(makeZone(z)));
  }

  function makeBlock(data) {
    const el = document.createElement('div');
    el.className = 'block ' + data.type;
    el.dataset.type = data.type;
    el.dataset.zoneId = data.zoneId;
    if (data.type === 'timeplace') {
      el.innerHTML = '<div class="b-date"></div><div class="b-time"></div>';
      el.querySelector('.b-date').textContent = data.date;
      el.querySelector('.b-time').textContent = data.time;
    } else {
      el.innerHTML = '<div class="b-code"></div>';
      el.querySelector('.b-code').textContent = data.code;
    }
    attachDrag(el);
    return el;
  }

  function makeZone(z) {
    const el = document.createElement('div');
    el.className = 'zone';
    el.innerHTML =
      '<img alt="CCTV 畫面 ' + z.id + '">' +
      '<div class="slots">' +
        '<div class="slot-wrap"><div class="slot-label">日期、時間</div>' +
          '<div class="slot" data-slot-type="timeplace"></div></div>' +
        '<div class="slot-wrap"><div class="slot-label">閉路電視編號</div>' +
          '<div class="slot" data-slot-type="num"></div></div>' +
      '</div>';
    el.querySelector('img').src = z.image;
    el.querySelectorAll('.slot').forEach((s) => { s.dataset.zoneId = z.id; });
    return el;
  }

  /* ---------- 拖放（Pointer Events，滑鼠與觸摸通用） ---------- */
  let drag = null; // {el, type, zoneId, offsetX, offsetY, w, h}

  function attachDrag(el) {
    el.addEventListener('pointerdown', (ev) => {
      if (state !== 'playing') return; // 已放入格也可再拖動調整
      ev.preventDefault();
      const r = el.getBoundingClientRect();
      drag = {
        el, type: el.dataset.type, zoneId: el.dataset.zoneId,
        w: r.width, h: r.height
      };
      el.classList.add('dragging');
      els.ghost.innerHTML = '';
      const clone = el.cloneNode(true);
      clone.className = el.className.replace('dragging', '');
      clone.style.width = r.width + 'px';
      clone.style.height = r.height + 'px';
      els.ghost.appendChild(clone);
      els.ghost.classList.remove('hidden');
      moveGhost(ev.clientX, ev.clientY);
      highlightSlots(drag.type);
      window.addEventListener('pointermove', onDragMove);
      window.addEventListener('pointerup', onDragEnd, { once: true });
      window.addEventListener('pointercancel', onDragCancel, { once: true });
    });
  }

  function moveGhost(x, y) {
    els.ghost.style.left = x + 'px';
    els.ghost.style.top = y + 'px';
  }

  function slotAt(x, y) {
    els.ghost.classList.add('hidden'); // elementFromPoint 需避開 ghost
    const under = document.elementFromPoint(x, y);
    els.ghost.classList.remove('hidden');
    return under ? under.closest('.slot') : null;
  }

  function highlightSlots(type) {
    document.querySelectorAll('.slot').forEach((s) => {
      if (s.classList.contains('filled')) return;
      s.classList.toggle('hint-ok', s.dataset.slotType === type);
      s.classList.toggle('hint-bad', s.dataset.slotType !== type);
    });
  }

  function clearHints() {
    document.querySelectorAll('.slot').forEach((s) => s.classList.remove('hint-ok', 'hint-bad'));
  }

  function onDragMove(ev) {
    if (!drag) return;
    ev.preventDefault();
    moveGhost(ev.clientX, ev.clientY);
  }

  function onDragCancel() { endDrag(null); }

  function onDragEnd(ev) {
    const slot = drag ? slotAt(ev.clientX, ev.clientY) : null;
    endDrag(slot);
  }

  function endDrag(slot) {
    window.removeEventListener('pointermove', onDragMove);
    if (!drag) return;
    const { el, type } = drag;
    drag = null;
    els.ghost.classList.add('hidden');
    els.ghost.innerHTML = '';
    el.classList.remove('dragging');
    clearHints();
    if (!slot || state !== 'playing') return;
    if (slot.dataset.slotType !== type) return; // 類型不符（日期放編號格）不接受

    const fromSlot = el.parentElement && el.parentElement.classList.contains('slot')
      ? el.parentElement : null;
    const old = slot.querySelector('.block');
    if (old === el) return; // 放回原位
    if (old) returnBlockToPanel(old); // 格子被佔：舊方塊退回左面板
    if (fromSlot) fromSlot.classList.remove('filled', 'wrong');
    slot.classList.add('filled');
    slot.appendChild(el);
    el.classList.add('placed');
    slot.classList.remove('wrong');
    // 對錯留到「✔ 確認答案」才檢驗
  }

  function returnBlockToPanel(block) {
    block.classList.remove('placed');
    const panel = block.dataset.type === 'timeplace' ? els.tpBlocks : els.numBlocks;
    panel.appendChild(block);
  }

  /* 「✔ 確認答案」：此刻才檢驗所有放置
   * 全對 → 成功；有錯 → 錯的退回左面板並提示，對的保留鎖定 */
  function checkAnswers() {
    if (state !== 'playing') return;
    let correct = 0, wrong = 0;
    document.querySelectorAll('.slot').forEach((slot) => {
      const block = slot.querySelector('.block');
      if (!block) return;
      if (String(block.dataset.zoneId) === String(slot.dataset.zoneId)) {
        correct++;
        slot.classList.remove('wrong');
      } else {
        wrong++;
        slot.classList.remove('filled');
        slot.classList.add('wrong');
        setTimeout(() => slot.classList.remove('wrong'), 600);
        returnBlockToPanel(block);
      }
    });
    placedCount = correct;
    if (correct >= totalSlots) {
      onWin();
    } else if (wrong > 0) {
      showToast('有 ' + wrong + ' 格不正確，已退回左側重新拖放', 'bad');
    } else {
      showToast('已確認 ' + correct + ' / ' + totalSlots + ' 格，繼續拖放剩餘方塊', '');
    }
  }

  let toastTimer = null;
  function showToast(msg, kind) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = kind || '';
    t.classList.remove('hidden', 'fade');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      t.classList.add('fade');
      setTimeout(() => t.classList.add('hidden'), 450);
    }, 2200);
  }

  /* ---------- 事件綁定 ---------- */
  els.btnStart.addEventListener('click', startGame);
  els.btnReset.addEventListener('click', resetGame);
  els.btnOverlayOk.addEventListener('click', resetGame);
  $('#btn-fullscreen').addEventListener('click', toggleFullscreen);
  $('#btn-autowin').addEventListener('click', solveAllSlots);
  $('#btn-check').addEventListener('click', checkAnswers);

  /* ---------- 密碼鎖 + 設定頁 ---------- */
  const pinModal = $('#pin-modal');
  const pinDisplay = $('#pin-display');
  const pinError = $('#pin-error');
  const settingsModal = $('#settings-modal');
  const settingsError = $('#settings-error');
  let pinInput = '';

  function renderPin() {
    pinDisplay.querySelectorAll('span').forEach((s, i) => {
      s.textContent = i < pinInput.length ? '●' : '';
    });
  }

  function openPinModal() {
    pinInput = '';
    pinError.textContent = '';
    renderPin();
    pinModal.classList.remove('hidden');
  }

  function closePinModal() { pinModal.classList.add('hidden'); }

  function pinDigit(d) {
    if (pinInput.length >= 4) return;
    pinInput += d;
    renderPin();
    if (pinInput.length === 4) {
      const want = String((config && config.settingsPin) || '0000');
      if (pinInput === want) {
        closePinModal();
        openSettings();
      } else {
        pinError.textContent = '密碼錯誤';
        pinModal.querySelector('.pin-box').classList.add('shake');
        setTimeout(() => {
          pinModal.querySelector('.pin-box').classList.remove('shake');
          pinInput = '';
          renderPin();
        }, 400);
      }
    }
  }

  pinModal.querySelectorAll('.pin-keypad button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const k = btn.dataset.key;
      if (k === 'clear') { pinInput = ''; renderPin(); }
      else if (k === 'back') { pinInput = pinInput.slice(0, -1); renderPin(); }
      else pinDigit(k);
    });
  });
  $('#btn-pin-cancel').addEventListener('click', closePinModal);
  $('#btn-settings').addEventListener('click', openPinModal);

  /* 設定表單 */
  function field(id) { return document.getElementById(id); }

  function buildZonesEditor(zones) {
    const box = field('zones-editor');
    box.innerHTML = '';
    zones.forEach((z, i) => {
      const row = document.createElement('div');
      row.className = 'zone-row';
      row.dataset.zoneId = z.id;
      row.innerHTML =
        '<div class="z-num">' + (i + 1) + '</div>' +
        '<input class="z-image" placeholder="圖片路徑" spellcheck="false">' +
        '<input class="z-date" placeholder="日期 如 15/11/2026" spellcheck="false">' +
        '<input class="z-time" placeholder="時間 如 09:00" spellcheck="false">' +
        '<input class="z-camera" placeholder="編號 如 DH1" spellcheck="false">';
      row.querySelector('.z-image').value = z.image || '';
      row.querySelector('.z-date').value = z.date || '';
      row.querySelector('.z-time').value = z.time || '';
      row.querySelector('.z-camera').value = z.camera || '';
      box.appendChild(row);
    });
  }

  function readZonesEditor() {
    const rows = document.querySelectorAll('#zones-editor .zone-row');
    const zones = [];
    for (const row of rows) {
      const z = {
        id: parseInt(row.dataset.zoneId, 10),
        image: row.querySelector('.z-image').value.trim(),
        date: row.querySelector('.z-date').value.trim(),
        time: row.querySelector('.z-time').value.trim(),
        camera: row.querySelector('.z-camera').value.trim()
      };
      if (!z.image || !z.date || !z.time || !z.camera) {
        return { error: '第 ' + z.id + ' 區有空白欄位（圖片/日期/時間/編號都要填）' };
      }
      zones.push(z);
    }
    return { zones };
  }

  function openSettings() {
    settingsError.textContent = '';
    field('set-timer').value = config.timerSeconds ?? 420;
    field('set-pin').value = config.settingsPin || '0000';
    field('set-videoA').value = config.videoA || '';
    field('set-videoB').value = config.videoB || '';
    field('set-autowin').checked = !!config.devAutoWin;
    const sc = config.screenControl || {};
    field('set-sc-type').value = sc.type || 'local';
    field('set-pi5-url').value = sc.pi5BaseUrl || '';
    const api = config.api || {};
    field('set-api-enabled').checked = !!api.enabled;
    field('set-api-method').value = api.method || 'POST';
    field('set-api-url').value = api.url || '';
    field('set-api-headers').value = JSON.stringify(api.headers || {}, null, 2);
    field('set-api-body').value = api.body || '';
    buildZonesEditor(config.zones || []);
    settingsModal.classList.remove('hidden');
    refreshDiag();
  }

  function closeSettings() { settingsModal.classList.add('hidden'); }

  function saveSettings() {
    // 驗證 JSON 欄位
    let headers;
    try { headers = JSON.parse(field('set-api-headers').value || '{}'); }
    catch (e) { settingsError.textContent = 'API Headers 不是有效的 JSON'; return; }
    const zr = readZonesEditor();
    if (zr.error) { settingsError.textContent = zr.error; return; }
    const zones = zr.zones;
    const pin = field('set-pin').value.trim();
    if (!/^\d{4}$/.test(pin)) {
      settingsError.textContent = '密碼必須是 4 位數字'; return;
    }
    const timer = parseInt(field('set-timer').value, 10);
    if (!(timer >= 10)) { settingsError.textContent = '限時至少 10 秒'; return; }

    // 以 config.json 為底，把表單值整份存成覆寫
    const ov = {
      timerSeconds: timer,
      settingsPin: pin,
      videoA: field('set-videoA').value.trim(),
      videoB: field('set-videoB').value.trim(),
      devAutoWin: field('set-autowin').checked,
      screenControl: {
        type: field('set-sc-type').value,
        pi5BaseUrl: field('set-pi5-url').value.trim()
      },
      api: {
        enabled: field('set-api-enabled').checked,
        url: field('set-api-url').value.trim(),
        method: field('set-api-method').value,
        headers,
        body: field('set-api-body').value
      },
      zones
    };
    window.CctvConfig.saveOverride(ov);
    loadConfig().then(() => {
      closeSettings();
      window.CctvBus.send({ type: 'configChanged' }); // 通知第二屏幕重讀設定
    });
  }

  $('#btn-settings-save').addEventListener('click', saveSettings);
  $('#btn-settings-cancel').addEventListener('click', closeSettings);

  /* 副屏診斷：經原生橋讀取系統顯示器狀態 */
  function refreshDiag() {
    const out = document.getElementById('diag-output');
    if (window.CctvNativeDiag && typeof window.CctvNativeDiag.getDisplayInfo === 'function') {
      try {
        const info = JSON.parse(window.CctvNativeDiag.getDisplayInfo());
        const lines = (info.displays || []).map((d) =>
          '顯示器 #' + d.id + '「' + d.name + '」 ' + d.size +
          (d.isPresentation ? '  [可投放副屏]' : '  [主屏/鏡像]') +
          ' 狀態=' + d.state);
        lines.push('副屏視窗建立：' + (info.presentationShowing ? '是' : '否'));
        lines.push('副屏頁面載入：' + (info.screen2Loaded ? '是' : '否'));
        if (!(info.displays || []).some((d) => d.isPresentation)) {
          lines.push('⚠ 系統找不到可投放的副屏。若已接線，代表這台裝置的輸出只有「鏡像模式」，Android 層不開放異顯，雙屏無法用。');
        }
        out.textContent = lines.join('\n');
        return;
      } catch (e) {
        out.textContent = '診斷失敗：' + e.message;
        return;
      }
    }
    out.textContent = '瀏覽器模式：無原生診斷（電腦上副屏請另開 screen2.html）';
  }
  $('#btn-diag-refresh').addEventListener('click', refreshDiag);

  $('#btn-settings-default').addEventListener('click', () => {
    window.CctvConfig.clearOverride();
    loadConfig().then(() => {
      closeSettings();
      window.CctvBus.send({ type: 'configChanged' });
    });
  });

  /* ---------- 一鍵通關（測試模式） ---------- */
  function solveAllSlots() {
    if (state !== 'playing') return false;
    document.querySelectorAll('.slot').forEach((slot) => {
      if (slot.classList.contains('filled')) return;
      const want = slot.dataset.slotType;
      const block = document.querySelector(
        '.block:not(.placed)[data-type="' + want + '"][data-zone-id="' + slot.dataset.zoneId + '"]'
      );
      if (block) {
        slot.classList.add('filled');
        slot.appendChild(block);
        block.classList.add('placed');
      }
    });
    checkAnswers(); // 一鍵通關：放好後走同一条檢驗路徑
    return true;
  }

  /* ---------- 測試/除錯掛勾（自動化測試用，不影響正常操作） ---------- */
  window.__cctv = {
    getState: () => state,
    getPlaced: () => placedCount,
    getConfig: () => config,
    solveAll: solveAllSlots,
    reset: resetGame
  };

  /* ---------- 啟動 ---------- */
  loadConfig().then(() => {
    state = 'start';
    screenSetVideo('A'); // 遊戲載入時確保第二屏幕回到影片 A
    startHeartbeat();
  });
})();
