/* ===== 問答挑戰 遊戲邏輯（單人兩次作答版） ===== */
(() => {
  const TOTAL_QUESTIONS = 10;   // 每局題數
  let gameTimeLimit = 180;      // 整局總限時（秒），由後台設定
  const SUCCESS_RETURN_DELAY = 15; // 成功後幾多秒返回開始畫面
  const ATTEMPTS_PER_QUESTION = 2; // 每題要作答兩次，兩次都啱先過關

  const KEYS = { a: 0, b: 1, c: 2 };

  const screens = {
    start: document.getElementById('screen-start'),
    game: document.getElementById('screen-game'),
    success: document.getElementById('screen-success'),
    fail: document.getElementById('screen-fail'),
  };
  const els = {
    progressText: document.getElementById('progress-text'),
    progressDots: document.getElementById('progress-dots'),
    timerText: document.getElementById('timer-text'),
    timerBarFill: document.getElementById('timer-bar-fill'),
    questionNumber: document.getElementById('question-number'),
    questionText: document.getElementById('question-text'),
    options: Array.from(document.querySelectorAll('.option')),
    chips: [document.getElementById('chip-1'), document.getElementById('chip-2')],
    qTimerFill: document.getElementById('q-timer-fill'),
    ruleQuestionTime: document.getElementById('rule-question-time'),
    feedbackOverlay: document.getElementById('feedback-overlay'),
    feedbackBox: document.getElementById('feedback-box'),
    feedbackIcon: document.getElementById('feedback-icon'),
    feedbackText: document.getElementById('feedback-text'),
    successTimeUsed: document.getElementById('success-time-used'),
    successCountdown: document.getElementById('success-countdown'),
  };

  let state = 'start';       // start | playing | feedback | success | fail
  let questionPool = [];     // 全部問題（由 server 載入）
  let gameQuestions = [];    // 今局抽嘅 10 條（含洗牌後嘅 options）
  let currentIndex = 0;
  let picks = [];            // 今題各次作答揀咗嘅選項 index
  let timeLeft = gameTimeLimit;
  let timerId = null;
  let countdownId = null;    // 成功畫面嘅 15 秒倒數
  let questionTimeLimit = 5; // 每題限時（秒），由後台設定
  let qTimeLeft = 0;
  let qTimerId = null;
  let bufferedKey = null;    // 提示動畫期間暫存嘅按鍵，切題後補返

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function showScreen(name) {
    Object.values(screens).forEach(s => s.classList.remove('active'));
    screens[name].classList.add('active');
    state = name === 'game' ? 'playing' : name;
  }

  // 回報遊戲事件去 progressDB（唔影響遊戲，失敗都照行）
  function report(event, detail) {
    fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, detail }),
    }).catch(() => {});
  }

  async function loadConfig() {
    try {
      const res = await fetch('/api/config');
      const cfg = await res.json();
      questionTimeLimit = cfg.questionTimeLimit || 5;
      els.ruleQuestionTime.textContent = questionTimeLimit;
      gameTimeLimit = cfg.gameTimeLimit || 180;
      // 開始畫面顯示總時間（秒 → 分鐘描述）
      const mins = gameTimeLimit / 60;
      const label = Number.isInteger(mins) ? mins + ' 分鐘' : Math.floor(mins) + ' 分 ' + (gameTimeLimit % 60) + ' 秒';
      document.querySelectorAll('.rule-total-time').forEach(el => { el.textContent = label; });
    } catch (e) {
      console.error('無法載入設定:', e);
    }
  }

  async function loadQuestions() {
    try {
      const res = await fetch('/api/questions');
      questionPool = await res.json();
    } catch (e) {
      console.error('無法載入問題:', e);
      questionPool = [];
    }
  }

  function pickGameQuestions() {
    // 隨機抽 10 條，並將每條嘅選項洗牌（記住正確答案嘅新位置）
    const picked = shuffle(questionPool).slice(0, TOTAL_QUESTIONS);
    return picked.map(q => {
      const indexed = q.options.map((text, i) => ({ text, correct: i === q.answer }));
      return { question: q.question, options: shuffle(indexed) };
    });
  }

  function reshuffleOptions() {
    // 答錯重頭嚟過時，重新洗牌選項，避免純記位
    gameQuestions = gameQuestions.map(q => ({ question: q.question, options: shuffle(q.options) }));
  }

  function startGame() {
    if (questionPool.length < TOTAL_QUESTIONS) {
      alert(`問題數量不足！需要至少 ${TOTAL_QUESTIONS} 條，請到管理介面新增。`);
      return;
    }
    clearInterval(countdownId); // 防止成功畫面嘅倒數喺新一局中途觸發
    hideFeedback();
    bufferedKey = null;
    gameQuestions = pickGameQuestions();
    currentIndex = 0;
    timeLeft = gameTimeLimit;
    showScreen('game');
    renderDots();
    renderQuestion();
    updateTimer();
    clearInterval(timerId);
    timerId = setInterval(tick, 1000);
    report('game_start', { totalQuestions: TOTAL_QUESTIONS, questionTimeLimit });
  }

  function tick() {
    timeLeft--;
    updateTimer();
    if (timeLeft <= 0) {
      clearInterval(timerId);
      clearInterval(qTimerId);
      hideFeedback();          // 答題提示可能仲顯示緊，先收埋
      bufferedKey = null;
      showScreen('fail');
      report('game_fail', { reachedQuestion: currentIndex + 1 });
    }
  }

  function updateTimer() {
    const m = Math.floor(timeLeft / 60);
    const s = timeLeft % 60;
    els.timerText.textContent = `${m}:${String(s).padStart(2, '0')}`;
    const pct = (timeLeft / gameTimeLimit) * 100;
    els.timerBarFill.style.width = pct + '%';
    const urgent = timeLeft <= 30;
    els.timerText.classList.toggle('urgent', urgent);
    els.timerBarFill.classList.toggle('urgent', urgent);
  }

  /* ===== 每題倒數 ===== */
  function startQuestionTimer() {
    clearInterval(qTimerId);
    qTimeLeft = questionTimeLimit;
    updateQTimer();
    qTimerId = setInterval(() => {
      qTimeLeft -= 0.25;
      updateQTimer();
      if (qTimeLeft <= 0) {
        clearInterval(qTimerId);
        questionTimeout();
      }
    }, 250);
  }

  function updateQTimer() {
    const pct = Math.max(0, (qTimeLeft / questionTimeLimit) * 100);
    els.qTimerFill.style.width = pct + '%';
    els.qTimerFill.classList.toggle('urgent', qTimeLeft <= 2);
  }

  function questionTimeout() {
    if (state !== 'playing') return;
    if (picks.length >= ATTEMPTS_PER_QUESTION) return; // 兩個輸入已到，交俾 resolveAnswers 判
    report('question_timeout', { question: currentIndex + 1 });
    showFeedback(false, '逾時！由第 1 題重新開始');
    setTimeout(() => {
      if (state !== 'feedback') return; // 期間可能已 Ctrl+R
      hideFeedback();
      currentIndex = 0;
      reshuffleOptions();
      renderQuestion();
      flushBufferedKey();
    }, 1600);
  }

  function renderDots() {
    els.progressDots.innerHTML = '';
    for (let i = 0; i < gameQuestions.length; i++) {
      const dot = document.createElement('div');
      dot.className = 'dot' + (i < currentIndex ? ' done' : i === currentIndex ? ' current' : '');
      els.progressDots.appendChild(dot);
    }
  }

  function renderQuestion() {
    const q = gameQuestions[currentIndex];
    picks = [];
    els.progressText.textContent = `${currentIndex + 1} / ${gameQuestions.length}`;
    els.questionNumber.textContent = `第 ${currentIndex + 1} 題`;
    els.questionText.textContent = q.question;
    els.options.forEach((btn, i) => {
      btn.classList.remove('correct', 'wrong', 'shake');
      btn.querySelector('.option-text').textContent = q.options[i].text;
      btn.querySelector('.option-picks').innerHTML = '';
    });
    updateChips();
    renderDots();
    startQuestionTimer();
  }

  function updateChips() {
    els.chips.forEach((chip, i) => {
      const answered = picks.length > i;
      chip.classList.toggle('answered', answered);
      chip.querySelector('.chip-status').textContent = answered ? '✓ 已輸入' : '待輸入';
    });
  }

  function updatePickMarkers() {
    els.options.forEach((btn, i) => {
      const marks = [];
      picks.forEach((p, n) => {
        if (p === i) marks.push(`<span class="pick-badge">${n + 1}</span>`);
      });
      btn.querySelector('.option-picks').innerHTML = marks.join('');
    });
  }

  function answer(idx) {
    if (state !== 'playing') return;
    picks.push(idx);
    updateChips();
    updatePickMarkers();
    if (picks.length >= ATTEMPTS_PER_QUESTION) resolveAnswers();
  }

  function resolveAnswers() {
    clearInterval(qTimerId);
    const q = gameQuestions[currentIndex];
    const correctIdx = q.options.findIndex(o => o.correct);
    const allCorrect = picks.every(p => p === correctIdx);

    els.options[correctIdx].classList.add('correct');
    picks.forEach((p) => {
      if (p !== correctIdx) els.options[p].classList.add('wrong', 'shake');
    });
    report('question_result', {
      question: currentIndex + 1,
      picks,
      correct: allCorrect,
    });

    if (allCorrect) {
      currentIndex++;
      if (currentIndex >= gameQuestions.length) {
        winGame();
      } else {
        showFeedback(true, '兩次都正確！');
        setTimeout(() => {
          if (state !== 'feedback') return; // 期間可能已 timeout / Ctrl+R
          hideFeedback();
          renderQuestion();
          flushBufferedKey();
        }, 700);
      }
    } else {
      showFeedback(false, '答錯！由第 1 題重新開始');
      setTimeout(() => {
        if (state !== 'feedback') return; // 期間可能已 timeout / Ctrl+R
        hideFeedback();
        currentIndex = 0;
        reshuffleOptions();
        renderQuestion();
        flushBufferedKey();
      }, 1600);
    }
  }

  // 提示動畫期間被暫存嘅按鍵，喺新題目 render 完之後補返
  function flushBufferedKey() {
    if (bufferedKey === null) return;
    const k = bufferedKey;
    bufferedKey = null;
    answer(k);
  }

  function showFeedback(good, text) {
    state = 'feedback';
    els.feedbackBox.className = 'feedback-box ' + (good ? 'good' : 'bad');
    els.feedbackIcon.textContent = good ? '✓' : '✗';
    els.feedbackText.textContent = text;
    els.feedbackOverlay.classList.add('show');
  }

  function hideFeedback() {
    if (!els.feedbackOverlay.classList.contains('show')) return;
    els.feedbackOverlay.classList.remove('show');
    state = 'playing';
  }

  async function winGame() {
    clearInterval(timerId);
    clearInterval(qTimerId);
    bufferedKey = null;
    const used = gameTimeLimit - timeLeft;
    const m = Math.floor(used / 60);
    const s = used % 60;
    els.successTimeUsed.textContent = `完成時間：${m} 分 ${s} 秒`;
    showScreen('success');

    // 通知 server 觸發 HTTP request（連去你手機）＋ 記錄成功事件
    fetch('/api/success', { method: 'POST' })
      .then(r => r.json())
      .then(r => console.log('Success webhook:', r))
      .catch(e => console.error('Success webhook error:', e));

    // 15 秒倒數後返回開始畫面
    let countdown = SUCCESS_RETURN_DELAY;
    els.successCountdown.textContent = countdown;
    clearInterval(countdownId);
    countdownId = setInterval(() => {
      countdown--;
      els.successCountdown.textContent = countdown;
      if (countdown <= 0) {
        clearInterval(countdownId);
        countdownId = null;
        showScreen('start');
      }
    }, 1000);
  }

  // ===== 鍵盤輸入 =====
  document.addEventListener('keydown', (e) => {
    // 按住唔放嘅自動重複唔計數，一個物理按鍵動作只係一次輸入
    if (e.repeat) return;
    const key = e.key.toLowerCase();

    // Ctrl+R：返回開始畫面（並阻止瀏覽器重新整理頁面）
    if (key === 'r' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (state !== 'start') {
        clearInterval(timerId);
        clearInterval(qTimerId);
        clearInterval(countdownId);
        bufferedKey = null;
        hideFeedback();
        showScreen('start');
      }
      return;
    }

    const isAnswerKey = key in KEYS;
    if (!isAnswerKey && key !== 'enter') return;
    e.preventDefault();

    if (state === 'playing') {
      if (isAnswerKey) answer(KEYS[key]);
    } else if (state === 'feedback') {
      // 提示動畫期間唔食輸入，暫存落嚟，切題後補返（避免快按被吞）
      if (isAnswerKey) bufferedKey = KEYS[key];
    } else if (state === 'start') {
      startGame();
    } else if (state === 'fail') {
      showScreen('start');
    }
    // success 畫面唔接受輸入，等 15 秒自動返回
  });

  // 滑鼠點擊都得（方便測試）
  els.options.forEach(btn => {
    btn.addEventListener('click', () => {
      if (state === 'playing') answer(Number(btn.dataset.idx));
    });
  });

  loadQuestions();
  loadConfig();
})();
