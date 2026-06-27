/**
 * db/pool.js
 * -------------------------------------------------------------
 * 建立並匯出單一 PostgreSQL 連線池（`pg.Pool`），所有路由透過它執行 SQL。
 *
 * 環境變數:
 *   POSTGRES_CONNECTION_STRING  必填
 *   POSTGRES_SSL                選填:
 *     false / disable  關閉 TLS（預設，對應現行 Zeabur Postgres）
 *     require / true   TLS on，接受自簽憑證（rejectUnauthorized:false）
 *     strict / verify  TLS on，嚴格驗憑證鏈
 */
const { Pool } = require('pg');

// 預設關閉 TLS（目前部署的 Zeabur Postgres 未開 SSL）。
// DB 支援 SSL 時，設 POSTGRES_SSL=require（接受自簽）或 POSTGRES_SSL=strict（嚴格驗證）。
const sslMode = (process.env.POSTGRES_SSL || 'false').toLowerCase();
const ssl =
  sslMode === 'strict' || sslMode === 'verify' ? true :
  sslMode === 'require' || sslMode === 'true'  ? { rejectUnauthorized: false } :
  false;

const pool = new Pool({
  connectionString: process.env.POSTGRES_CONNECTION_STRING,
  ssl,
  max: 10,
  // 連線逾時 10s：DB 不可達時讓請求快速失敗，不讓 client 痴等 TCP handshake 30s+
  connectionTimeoutMillis: 10_000,
  // idle 連線 30s 後歸還；避免 Zeabur 內部 NAT 悶掉殭屍連線
  idleTimeoutMillis: 30_000,
  // MEDIUM 6: 單一 statement 最長 30s（防慢查詢拖死整個 pool）
  // 大多數合法查詢應 <5s；超過 30s 一定是有問題的 SQL，讓它快速失敗。
  statement_timeout: 30_000,
  // BEGIN 後若 idle 超過 60s，自動 ABORT（防忘了 COMMIT/ROLLBACK 卡住連線）
  idle_in_transaction_session_timeout: 60_000,
  // client 端也加保險（PG server 沒回應時保護 Node）
  query_timeout: 30_000,
});

// pg Pool 的 'error' 事件必須接，不然連線斷線會變 uncaught exception → 整個程序掛掉
pool.on('error', (err) => {
  console.warn('[pgPool] idle client error:', err.message);
});

module.exports = pool;
