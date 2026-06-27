/**
 * db/init.js — 只建立本服務需要「寫入」的表：revenue_budget_plan
 *
 * 讀取用的表（repair_income / revenue_targets / income_config / parts_sales）
 * 由現有 DMS 平台維護，本服務不建立、不修改，只查詢。
 */
const pool = require('./pool');

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS revenue_budget_plan (
      id          SERIAL PRIMARY KEY,
      year        INTEGER      NOT NULL,
      branch      VARCHAR(10)  NOT NULL,
      version     VARCHAR(50)  NOT NULL DEFAULT 'default',
      period      VARCHAR(6)   NOT NULL,
      paid        NUMERIC(15,2) DEFAULT 0,
      bodywork    NUMERIC(15,2) DEFAULT 0,
      general     NUMERIC(15,2) DEFAULT 0,
      extended    NUMERIC(15,2) DEFAULT 0,
      note        TEXT          DEFAULT '',
      updated_at  TIMESTAMPTZ   DEFAULT NOW(),
      updated_by  VARCHAR(50)   DEFAULT '',
      UNIQUE(year, branch, version, period)
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rev_budget_plan_lookup
    ON revenue_budget_plan(year, branch, version)`);
}

module.exports = init;
