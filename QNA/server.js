const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const QUESTIONS_FILE = path.join(DATA_DIR, 'questions.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

/* ================= progressDB（PostgreSQL） =================
   記錄每局遊戲進度：開始、每題結果、逾時、成功、失敗。
   資料庫唔在或連唔到時，遊戲照行，只係唔記錄。 */
const { Pool } = require('pg');
let pool = null;
if (process.env.DATABASE_URL) {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
}

async function initDb() {
  if (!pool) return;
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS game_events (
          id SERIAL PRIMARY KEY,
          ts TIMESTAMPTZ NOT NULL DEFAULT now(),
          event TEXT NOT NULL,
          detail JSONB
        )
      `);
      console.log('[DB] progressDB connected, game_events table ready');
      return;
    } catch (e) {
      console.log(`[DB] connect attempt ${attempt}/10 failed: ${e.message}, retrying in 3s`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  console.error('[DB] progressDB unavailable, progress logging disabled');
}
initDb();

async function logEvent(event, detail) {
  if (!pool) return;
  try {
    await pool.query('INSERT INTO game_events (event, detail) VALUES ($1, $2)', [event, detail || {}]);
  } catch (e) {
    console.error('[DB] log failed:', e.message);
  }
}

// 前台回報遊戲事件
app.post('/api/events', async (req, res) => {
  const { event, detail } = req.body || {};
  if (!event || typeof event !== 'string') {
    return res.status(400).json({ error: 'Missing event' });
  }
  await logEvent(event, detail);
  res.json({ ok: true });
});

// 後台睇進度記錄
app.get('/api/events', async (req, res) => {
  if (!pool) return res.json({ available: false, events: [] });
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const r = await pool.query('SELECT id, ts, event, detail FROM game_events ORDER BY id DESC LIMIT $1', [limit]);
    res.json({ available: true, events: r.rows });
  } catch (e) {
    res.json({ available: false, events: [], error: e.message });
  }
});

// 清空進度記錄
app.delete('/api/events', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not available' });
  try {
    const r = await pool.query('DELETE FROM game_events');
    res.json({ ok: true, deleted: r.rowCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Questions API ----

app.get('/api/questions', (req, res) => {
  res.json(readJson(QUESTIONS_FILE, []));
});

// Replace entire question list (used by admin save)
app.put('/api/questions', (req, res) => {
  const questions = req.body;
  if (!Array.isArray(questions)) {
    return res.status(400).json({ error: 'Expected an array of questions' });
  }
  for (const q of questions) {
    if (!q.question || !Array.isArray(q.options) || q.options.length !== 3 ||
        typeof q.answer !== 'number' || q.answer < 0 || q.answer > 2) {
      return res.status(400).json({ error: 'Invalid question format', question: q });
    }
  }
  writeJson(QUESTIONS_FILE, questions);
  res.json({ ok: true, count: questions.length });
});

// ---- Config API（webhook URL、每題限時等） ----

const DEFAULT_CONFIG = { successWebhookUrl: '', questionTimeLimit: 5, gameTimeLimit: 180 };

app.get('/api/config', (req, res) => {
  res.json({ ...DEFAULT_CONFIG, ...readJson(CONFIG_FILE, {}) });
});

app.put('/api/config', (req, res) => {
  const current = { ...DEFAULT_CONFIG, ...readJson(CONFIG_FILE, {}) };
  const updated = { ...current, ...req.body };
  // 每題限時 1-30 秒；整局總時間 30-600 秒
  updated.questionTimeLimit = Math.min(Math.max(parseInt(updated.questionTimeLimit) || DEFAULT_CONFIG.questionTimeLimit, 1), 30);
  updated.gameTimeLimit = Math.min(Math.max(parseInt(updated.gameTimeLimit) || DEFAULT_CONFIG.gameTimeLimit, 30), 600);
  writeJson(CONFIG_FILE, updated);
  res.json({ ok: true, config: updated });
});

// ---- Success trigger ----
// Game calls this when player wins; server fires the configured HTTP request
// server-side to avoid CORS issues.
app.post('/api/success', async (req, res) => {
  await logEvent('game_success', {});
  const config = { ...DEFAULT_CONFIG, ...readJson(CONFIG_FILE, {}) };
  const url = config.successWebhookUrl;
  if (!url) {
    console.log('[SUCCESS] Player won, but no webhook URL configured yet.');
    return res.json({ ok: true, webhook: 'not-configured' });
  }
  try {
    const response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(10000) });
    console.log(`[SUCCESS] Webhook called: ${url} -> HTTP ${response.status}`);
    res.json({ ok: true, webhook: 'called', status: response.status });
  } catch (e) {
    console.error(`[SUCCESS] Webhook call failed: ${url} - ${e.message}`);
    res.json({ ok: true, webhook: 'failed', error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Quiz game running at http://localhost:${PORT}`);
  console.log(`Admin panel at      http://localhost:${PORT}/admin.html`);
});
