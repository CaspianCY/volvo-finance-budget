/**
 * index.js — volvo-finance-budget 精簡獨立版伺服器
 * -------------------------------------------------------------
 * 只跑「全年營收預算編列 / 推估」這一個功能。
 *
 * 資料來源（read）：repair_income、revenue_targets、income_config、parts_sales
 *   —— 這些表由現有 DMS 平台維護，本服務只讀。請把 POSTGRES_CONNECTION_STRING
 *   指向同一個 Postgres。
 * 資料寫入（write）：revenue_budget_plan（財務編列的預算版本，由本服務 init 建立）
 *
 * 不含登入/權限：定位為內部財務工具。若要對外開放，請自行加反向代理層的存取控管。
 */
require('dotenv').config();
const path = require('path');
const express = require('express');
const initDb = require('./db/init');
const pool = require('./db/pool');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 連線字串去敏：只留 host:port/dbname，隱藏帳密（給診斷端點顯示用）
function maskedTarget() {
  const raw = process.env.POSTGRES_CONNECTION_STRING || '';
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return `${u.hostname}:${u.port || 5432}${u.pathname || ''}`;
  } catch {
    return '(無法解析 POSTGRES_CONNECTION_STRING)';
  }
}

// 首頁直接進預算頁
app.get('/', (req, res) => res.redirect('/budget-projection.html'));

// 健康檢查（即時 ping DB；不只看啟動當下的 dbReady）
app.get('/healthz', async (req, res) => {
  const out = {
    ok: true,
    db_init: dbReady,                       // 啟動時 init 是否成功
    target: maskedTarget(),                 // 連到哪個 host/DB（去敏）
    ssl: (process.env.POSTGRES_SSL || 'false').toLowerCase(),
  };
  try {
    const r = await pool.query('SELECT current_database() AS db, current_user AS usr, now() AS now');
    out.db_connected = true;                // 此刻確實連得到 Postgres
    out.database = r.rows[0].db;
    out.db_user = r.rows[0].usr;
    out.server_time = r.rows[0].now;
  } catch (e) {
    out.ok = false;
    out.db_connected = false;
    out.db_error = e.message;               // 例如 ECONNREFUSED = 連不到內網 DB
  }
  res.status(out.db_connected ? 200 : 503).json(out);
});

// DMS 來源確認：證明「連到的是正確的內網 DMS 庫」——逐表檢查是否存在 + 概略資料量
// （不在 /api 的 dbReady 閘門後面，DB 還沒就緒時也能用來診斷）
app.get('/db-check', async (req, res) => {
  const tables = ['repair_income', 'revenue_targets', 'income_config', 'parts_sales', 'revenue_budget_plan'];
  const out = { target: maskedTarget(), checked_at: null, db_connected: false, tables: {} };
  try {
    const meta = await pool.query('SELECT current_database() AS db, now() AS now');
    out.db_connected = true;
    out.database = meta.rows[0].db;
    out.checked_at = meta.rows[0].now;
    for (const t of tables) {
      try {
        // to_regclass：表不存在回 NULL（不會丟錯）
        const reg = await pool.query('SELECT to_regclass($1) AS oid', [`public.${t}`]);
        if (!reg.rows[0].oid) { out.tables[t] = { exists: false }; continue; }
        const cnt = await pool.query(`SELECT COUNT(*)::int AS n FROM ${t}`);
        out.tables[t] = { exists: true, rows: cnt.rows[0].n };
      } catch (e) {
        out.tables[t] = { exists: false, error: e.message };
      }
    }
    // 內網 DMS 庫的判準：四張只讀來源表都在，且至少有資料
    const src = ['repair_income', 'revenue_targets'];
    out.looks_like_dms = src.every(t => out.tables[t] && out.tables[t].exists);
    out.has_data = src.some(t => out.tables[t] && out.tables[t].rows > 0);
  } catch (e) {
    out.db_error = e.message;
    return res.status(503).json(out);
  }
  res.json(out);
});

// DB 尚未就緒前，/api/* 回 503（而非模糊 500）
let dbReady = false;
app.use('/api', (req, res, next) => {
  if (dbReady) return next();
  res.status(503).json({ error: '系統啟動中，請稍後重試', code: 'DB_NOT_READY' });
});

app.use('/api', require('./routes/budgetProjection'));

// 統一錯誤處理
app.use((err, req, res, next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: '內部錯誤' });
});

const PORT = process.env.PORT || 3000;

(async () => {
  try {
    await initDb();
    dbReady = true;
    console.log('[init] revenue_budget_plan ready');
  } catch (e) {
    // init 失敗不擋啟動：讀取端點仍可用；寫入（編列）會在 DB 修復後恢復
    console.error('[init] DB 初始化失敗（稍後可重試）：', e.message);
  }
  app.listen(PORT, () => console.log(`🚀 volvo-finance-budget on :${PORT}`));
})();
