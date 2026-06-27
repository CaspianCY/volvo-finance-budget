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

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 首頁直接進預算頁
app.get('/', (req, res) => res.redirect('/budget-projection.html'));

// 健康檢查
app.get('/healthz', (req, res) => res.json({ ok: true, db: dbReady }));

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
