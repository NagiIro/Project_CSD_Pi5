/* ===== 問題管理介面 邏輯 ===== */
(() => {
  const listEl = document.getElementById('question-list');
  const statusBar = document.getElementById('status-bar');
  const webhookInput = document.getElementById('webhook-url');
  const webhookStatus = document.getElementById('webhook-status');
  const qtimeInput = document.getElementById('question-time');
  const qtimeStatus = document.getElementById('qtime-status');
  const gtimeInput = document.getElementById('game-time');
  const eventsList = document.getElementById('events-list');
  const LETTERS = ['A', 'B', 'C'];
  const EVENT_NAMES = {
    game_start: '🎮 開始新局',
    question_result: '📝 題目結果',
    question_timeout: '⏱ 題目逾時',
    game_success: '🏆 任務成功',
    game_fail: '❌ 任務失敗（總時間到）',
  };

  let questions = [];

  function setStatus(msg, ok = true) {
    statusBar.textContent = msg;
    statusBar.className = 'status-bar ' + (ok ? 'ok' : 'err');
    if (msg) setTimeout(() => { if (statusBar.textContent === msg) statusBar.textContent = ''; }, 4000);
  }

  async function load() {
    const res = await fetch('/api/questions');
    questions = await res.json();
    render();

    const cfgRes = await fetch('/api/config');
    const cfg = await cfgRes.json();
    webhookInput.value = cfg.successWebhookUrl || '';
    qtimeInput.value = cfg.questionTimeLimit || 5;
    gtimeInput.value = cfg.gameTimeLimit || 180;

    loadEvents();
  }

  async function loadEvents() {
    try {
      const res = await fetch('/api/events?limit=50');
      const data = await res.json();
      if (!data.available) {
        eventsList.textContent = '資料庫未連接（遊戲仍正常運作，只係冇記錄）';
        return;
      }
      if (!data.events.length) {
        eventsList.textContent = '暫時未有記錄';
        return;
      }
      eventsList.innerHTML = data.events.map(e => {
        const t = new Date(e.ts).toLocaleString('zh-HK');
        const name = EVENT_NAMES[e.event] || e.event;
        let detail = '';
        if (e.event === 'question_result') {
          detail = `第 ${e.detail.question} 題 — ${e.detail.correct ? '✅ 正確' : '❌ 錯誤'}`;
        } else if (e.event === 'question_timeout') {
          detail = `第 ${e.detail.question} 題逾時`;
        } else if (e.event === 'game_fail') {
          detail = `去到第 ${e.detail.reachedQuestion} 題`;
        } else if (e.event === 'game_start') {
          detail = `每題限時 ${e.detail.questionTimeLimit} 秒`;
        }
        return `<div class="event-row"><span class="event-time">${t}</span><span class="event-name">${name}</span><span class="event-detail">${detail}</span></div>`;
      }).join('');
    } catch (e) {
      eventsList.textContent = '載入記錄失敗';
    }
  }

  function render() {
    listEl.innerHTML = '';
    questions.forEach((q, qi) => {
      const card = document.createElement('div');
      card.className = 'q-card';

      const optionsHtml = q.options.map((opt, oi) => `
        <div class="q-option-row ${q.answer === oi ? 'is-answer' : ''}">
          <input type="radio" class="q-option-radio" name="answer-${qi}" data-q="${qi}" data-o="${oi}"
                 ${q.answer === oi ? 'checked' : ''} title="設為正確答案">
          <span class="q-option-letter">${LETTERS[oi]}</span>
          <input type="text" class="q-option-input" data-q="${qi}" data-o="${oi}"
                 value="${escapeAttr(opt)}" placeholder="選項 ${LETTERS[oi]}">
        </div>
      `).join('');

      card.innerHTML = `
        <div class="q-index">${qi + 1}</div>
        <div class="q-body">
          <input type="text" class="q-question-input" data-q="${qi}"
                 value="${escapeAttr(q.question)}" placeholder="輸入問題">
          <div class="q-options">${optionsHtml}</div>
          <div class="q-answer-hint">✅ 點選左邊嘅圓圈設定正確答案（綠色 = 正確答案）</div>
        </div>
        <div class="q-actions">
          <button class="btn btn-danger btn-delete" data-q="${qi}">🗑 刪除</button>
        </div>
      `;
      listEl.appendChild(card);
    });
  }

  function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  // 事件委派：文字輸入
  listEl.addEventListener('input', (e) => {
    const q = +e.target.dataset.q;
    if (Number.isNaN(q)) return;
    if (e.target.classList.contains('q-question-input')) {
      questions[q].question = e.target.value;
    } else if (e.target.classList.contains('q-option-input')) {
      questions[q].options[+e.target.dataset.o] = e.target.value;
    }
  });

  // 事件委派：設定答案 + 刪除
  listEl.addEventListener('click', (e) => {
    if (e.target.classList.contains('q-option-radio')) {
      const q = +e.target.dataset.q;
      questions[q].answer = +e.target.dataset.o;
      render();
    } else if (e.target.classList.contains('btn-delete')) {
      const q = +e.target.dataset.q;
      if (confirm(`確定刪除第 ${q + 1} 條問題？`)) {
        questions.splice(q, 1);
        render();
      }
    }
  });

  document.getElementById('btn-add').addEventListener('click', () => {
    questions.push({ question: '', options: ['', '', ''], answer: 0 });
    render();
    listEl.lastElementChild.scrollIntoView({ behavior: 'smooth' });
  });

  document.getElementById('btn-save').addEventListener('click', async () => {
    // 基本驗證
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      if (!q.question.trim() || q.options.some(o => !String(o).trim())) {
        setStatus(`第 ${i + 1} 條問題未填完整，請檢查。`, false);
        return;
      }
    }
    if (questions.length < 10) {
      if (!confirm(`而家只有 ${questions.length} 條問題，少過每局需要嘅 10 條，遊戲會開唔到局。確定儲存？`)) return;
    }
    const res = await fetch('/api/questions', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(questions),
    });
    if (res.ok) {
      setStatus(`✅ 已儲存 ${questions.length} 條問題`);
    } else {
      const err = await res.json();
      setStatus('儲存失敗：' + (err.error || res.statusText), false);
    }
  });

  document.getElementById('btn-save-qtime').addEventListener('click', async () => {
    const v = parseInt(qtimeInput.value);
    const g = parseInt(gtimeInput.value);
    if (!v || v < 1 || v > 30) {
      qtimeStatus.style.color = 'var(--danger)';
      qtimeStatus.textContent = '每題限時請輸入 1-30 秒';
      return;
    }
    if (!g || g < 30 || g > 600) {
      qtimeStatus.style.color = 'var(--danger)';
      qtimeStatus.textContent = '整局總時間請輸入 30-600 秒';
      return;
    }
    const res = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionTimeLimit: v, gameTimeLimit: g }),
    });
    if (res.ok) {
      qtimeStatus.style.color = 'var(--success)';
      qtimeStatus.textContent = `✅ 已儲存：每題限時 ${v} 秒，整局總時間 ${g} 秒`;
    } else {
      qtimeStatus.style.color = 'var(--danger)';
      qtimeStatus.textContent = '儲存失敗';
    }
  });

  document.getElementById('btn-save-webhook').addEventListener('click', async () => {
    const res = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ successWebhookUrl: webhookInput.value.trim() }),
    });
    if (res.ok) {
      webhookStatus.style.color = 'var(--success)';
      webhookStatus.textContent = '✅ Webhook URL 已儲存';
    } else {
      webhookStatus.style.color = 'var(--danger)';
      webhookStatus.textContent = '儲存失敗';
    }
  });

  document.getElementById('btn-test-webhook').addEventListener('click', async () => {
    webhookStatus.style.color = 'var(--text-dim)';
    webhookStatus.textContent = '觸發中…';
    const res = await fetch('/api/success', { method: 'POST' });
    const data = await res.json();
    if (data.webhook === 'called') {
      webhookStatus.style.color = 'var(--success)';
      webhookStatus.textContent = `✅ 已成功觸發（HTTP ${data.status}）`;
    } else if (data.webhook === 'not-configured') {
      webhookStatus.style.color = 'var(--text-dim)';
      webhookStatus.textContent = '⚠️ 未設定 URL，請先輸入並儲存';
    } else {
      webhookStatus.style.color = 'var(--danger)';
      webhookStatus.textContent = `❌ 觸發失敗：${data.error || '未知錯誤'}`;
    }
  });

  document.getElementById('btn-refresh-events').addEventListener('click', loadEvents);

  document.getElementById('btn-clear-events').addEventListener('click', async () => {
    if (!confirm('確定清空所有遊戲進度記錄？呢個動作冇得還原。')) return;
    const res = await fetch('/api/events', { method: 'DELETE' });
    if (res.ok) {
      const data = await res.json();
      eventsList.textContent = `✅ 已清空 ${data.deleted} 條記錄`;
    } else {
      eventsList.textContent = '清空失敗';
    }
  });

  load();
})();
