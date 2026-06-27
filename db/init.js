/**
 * db/init.js — 只建立本服務需要「寫入」的表：revenue_budget_plan
 *
 * 讀取用的表（repair_income / revenue_targets / income_config / parts_sales）
 * 由現有 DMS 平台維護，本服務不建立、不修改，只查詢。
 *
 * 損益擴充：除四大營收編列值（paid/bodywork/general/extended）外，另存
 * 「營業成本(cost)」與「營業費用(expense)」兩欄，以編列完整損益
 * （毛利＝營收−成本、營業淨利＝毛利−費用）。舊資料庫以 ADD COLUMN IF
 * NOT EXISTS 平滑升級，不影響既有版本資料。
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
      cost        NUMERIC(15,2) DEFAULT 0,
      expense     NUMERIC(15,2) DEFAULT 0,
      note        TEXT          DEFAULT '',
      updated_at  TIMESTAMPTZ   DEFAULT NOW(),
      updated_by  VARCHAR(50)   DEFAULT '',
      UNIQUE(year, branch, version, period)
    )`);
  // 損益擴充欄位（沿用舊版資料庫時補欄）
  await pool.query(`ALTER TABLE revenue_budget_plan ADD COLUMN IF NOT EXISTS cost    NUMERIC(15,2) DEFAULT 0`);
  await pool.query(`ALTER TABLE revenue_budget_plan ADD COLUMN IF NOT EXISTS expense NUMERIC(15,2) DEFAULT 0`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rev_budget_plan_lookup
    ON revenue_budget_plan(year, branch, version)`);
}

module.exports = init;
