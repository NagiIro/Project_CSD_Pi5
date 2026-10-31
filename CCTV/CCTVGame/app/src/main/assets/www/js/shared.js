/* 主觸屏與第二屏幕之間的通訊層。
 * 電腦測試：兩個瀏覽器視窗同源，用 BroadcastChannel + localStorage 雙通道。
 * Android 雙屏：之後在原生殼裡用 JS bridge 呼叫同一組 window.CctvBus 介面即可。 */
(function () {
  const CHANNEL = 'cctv-game-channel';
  const CMD_KEY = 'cctv.cmd';        // localStorage 指令備援通道
  const SCREEN_KEY = 'cctv.screen';  // 第二屏幕目前狀態 'A' | 'B'
  const HB_KEY = 'cctv.heartbeat';   // 主遊戲心跳（JSON: {t, state}）

  let bc = null;
  try { bc = new BroadcastChannel(CHANNEL); } catch (e) { /* 舊瀏覽器無 BroadcastChannel */ }

  const listeners = [];
  let lastTs = Date.now(); // 頁面載入前的舊指令不執行（狀態另有 SCREEN_KEY 持久化）

  function send(cmd) {
    const msg = Object.assign({ ts: Date.now() }, cmd);
    if (bc) { try { bc.postMessage(msg); } catch (e) {} }
    try { localStorage.setItem(CMD_KEY, JSON.stringify(msg)); } catch (e) {}
    // Android 原生殼：經 JS bridge 直達另一個 WebView（兩個 WebView 不共享 BroadcastChannel）
    if (window.CctvNative && typeof window.CctvNative.send === 'function') {
      try { window.CctvNative.send(JSON.stringify(msg)); } catch (e) {}
    }
  }

  function dispatchIfNew(msg) {
    if (!msg || typeof msg.ts !== 'number' || msg.ts <= lastTs) return;
    lastTs = msg.ts;
    dispatch(msg);
  }

  if (bc) bc.onmessage = (ev) => { if (ev.data) dispatchIfNew(ev.data); };
  window.addEventListener('storage', (ev) => {
    if (ev.key === CMD_KEY && ev.newValue) {
      try { dispatchIfNew(JSON.parse(ev.newValue)); } catch (e) {}
    }
  });
  // Android 原生殼回調入口
  window.__cctvNativeReceive = function (json) {
    try { dispatchIfNew(JSON.parse(json)); } catch (e) {}
  };
  // 輪詢備援：部分 WebView 環境 storage 事件不跨頁觸發
  setInterval(() => {
    try {
      const raw = localStorage.getItem(CMD_KEY);
      if (raw) dispatchIfNew(JSON.parse(raw));
    } catch (e) {}
  }, 800);

  function dispatch(msg) { listeners.forEach((fn) => { try { fn(msg); } catch (e) {} }); }

  window.CctvBus = {
    // 指令：{type:'setVideo', which:'A'|'B'} / {type:'reset'} / {type:'configChanged'}
    send,
    onMessage(fn) { listeners.push(fn); },
    getScreenState() { return localStorage.getItem(SCREEN_KEY) || 'A'; },
    setScreenState(s) { localStorage.setItem(SCREEN_KEY, s); },
    heartbeat(state) {
      try { localStorage.setItem(HB_KEY, JSON.stringify({ t: Date.now(), state })); } catch (e) {}
    },
    clearHeartbeat() { try { localStorage.setItem(HB_KEY, JSON.stringify({ t: 0, state: 'closed' })); } catch (e) {} },
    heartbeatAge() {
      try {
        const hb = JSON.parse(localStorage.getItem(HB_KEY) || 'null');
        if (!hb || !hb.t) return Infinity;
        return Date.now() - hb.t;
      } catch (e) { return Infinity; }
    }
  };

  /* 設定載入：config.json 為底，localStorage 的覆寫值蓋上去（遊戲內設定頁存的）。
   * 兩個頁面（index / screen2）都用這個，確保設定一致。 */
  const OVERRIDE_KEY = 'cctv.config.override';

  window.CctvConfig = {
    OVERRIDE_KEY,
    async load() {
      const base = await this._fetchJson('config.json');
      return this.merge(base, this.getOverride());
    },
    /* fetch 在部分 file:// WebView 環境會失敗，退回 XHR（配合原生殼的
     * allowFileAccessFromFileURLs 設定，APK 內必定可讀）。 */
    async _fetchJson(url) {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.json();
      } catch (e) {
        return await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.overrideMimeType('application/json');
          xhr.open('GET', url + '?t=' + Date.now(), true);
          xhr.onreadystatechange = () => {
            if (xhr.readyState !== 4) return;
            if ((xhr.status >= 200 && xhr.status < 300) || (xhr.status === 0 && xhr.responseText)) {
              try { resolve(JSON.parse(xhr.responseText)); }
              catch (pe) { reject(new Error('JSON 解析失敗：' + pe.message)); }
            } else {
              reject(new Error('XHR HTTP ' + xhr.status));
            }
          };
          xhr.onerror = () => reject(new Error('XHR 網路錯誤'));
          xhr.send();
        });
      }
    },
    merge(base, ov) {
      if (!ov || !Object.keys(ov).length) return base;
      const out = Object.assign({}, base);
      for (const k of Object.keys(ov)) {
        if (k === 'api' && ov.api && typeof ov.api === 'object' && base.api) {
          out.api = Object.assign({}, base.api, ov.api);
        } else {
          out[k] = ov[k];
        }
      }
      return out;
    },
    getOverride() {
      try { return JSON.parse(localStorage.getItem(OVERRIDE_KEY) || '{}'); } catch (e) { return {}; }
    },
    saveOverride(ov) { localStorage.setItem(OVERRIDE_KEY, JSON.stringify(ov)); },
    clearOverride() { localStorage.removeItem(OVERRIDE_KEY); }
  };
})();
