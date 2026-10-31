/* 第二屏幕：預設循環播放影片 A；收到切換指令後固定循環播放影片 B；
 * 收到重置 / 遊戲關閉（心跳停止）→ 切回影片 A。 */
(function () {
  'use strict';

  const stage = document.getElementById('stage');
  const status = document.getElementById('status');

  let config = null;
  let current = null; // 'A' | 'B'

  function isImage(url) {
    return /\.(gif|png|jpe?g|webp|avif)(\?|#|$)/i.test(url);
  }

  function makeMedia(url) {
    if (isImage(url)) {
      const img = document.createElement('img');
      img.src = url;
      return img;
    }
    const v = document.createElement('video');
    v.src = url;
    v.muted = true;          // 靜音以符合自動播放政策
    v.loop = true;
    v.autoplay = true;
    v.playsInline = true;
    v.play().catch(() => {});
    return v;
  }

  function show(which) {
    if (!config) return;
    current = which;
    window.CctvBus.setScreenState(which);
    const url = which === 'B' ? config.videoB : config.videoA;
    const media = makeMedia(url);
    stage.innerHTML = '';
    stage.appendChild(media);
    requestAnimationFrame(() => media.classList.add('show'));
    setStatus();
  }

  function setStatus() {
    const hb = window.CctvBus.heartbeatAge();
    const alive = hb !== Infinity && hb < 5000;
    status.textContent =
      'SCREEN-2 · 影片 ' + current +
      ' · 遊戲連線: ' + (alive ? 'OK' : '中斷（將切回影片 A）');
  }

  /* 指令處理 */
  window.CctvBus.onMessage((msg) => {
    if (msg.type === 'setVideo') show(msg.which === 'B' ? 'B' : 'A');
    else if (msg.type === 'reset') show('A');
    else if (msg.type === 'configChanged') {
      // 設定頁儲存後即時重讀（影片來源可能已改），維持目前 A/B 狀態
      window.CctvConfig.load().then((cfg) => { config = cfg; show(current || 'A'); })
        .catch(() => {});
    }
  });

  /* 心跳監察：遊戲關閉 / 當機 → 切回影片 A */
  setInterval(() => {
    if (current === 'B') {
      const age = window.CctvBus.heartbeatAge();
      if (age === Infinity || age > 5000) show('A');
    }
    setStatus();
  }, 1000);

  /* 啟動：以持久化狀態為準（預設 A；若之前成功過且遊戲仍在，維持 B） */
  window.CctvConfig.load()
    .then((cfg) => {
      config = cfg;
      const saved = window.CctvBus.getScreenState();
      const age = window.CctvBus.heartbeatAge();
      const gameAlive = age !== Infinity && age < 5000;
      // B 只在遊戲仍然活著時才恢復，否則一律回 A
      show(saved === 'B' && gameAlive ? 'B' : 'A');
    })
    .catch((e) => { status.textContent = '讀取 config.json 失敗：' + e.message; });
})();
