/**
 * lib/workdays.js
 * -------------------------------------------------------------
 * 工作天數：每年每廠每月的營業日數。用於
 *   1) 預算參數頁顯示「工作天數」與「日產能」；
 *   2) 全年預估的「工作天數推估法」（後續月份營收 = 日產能 × 該月工作天數）。
 *
 * 來源優先序：
 *   - 財務於 budget_workdays 手動覆寫的值（最準）
 *   - 否則用月曆預設：當月「週一~週五」日數（可選含週六）。
 *     國定假日不在此自動扣除——由財務手動覆寫該月天數即可。
 */
const pool = require('../db/pool');

// 當月工作日數（預設週一~五；includeSat=true 時含週六）
function defaultWorkdays(year, month, includeSat = false) {
  let c = 0;
  const d = new Date(year, month - 1, 1);
  while (d.getMonth() === month - 1) {
    const wd = d.getDay(); // 0=日 .. 6=六
    if (wd >= 1 && wd <= 5) c++;
    else if (wd === 6 && includeSat) c++;
    d.setDate(d.getDate() + 1);
  }
  return c;
}

function defaultMap(year, includeSat = false) {
  const out = {};
  for (let m = 1; m <= 12; m++) out[m] = defaultWorkdays(year, m, includeSat);
  return out;
}

// 取某年某廠 12 個月工作天數：手動覆寫優先，否則月曆預設。
// 回傳 { map:{m:days}, overridden:{m:true}, source:{m:'manual'|'calendar'} }
async function getWorkdays(year, branch, includeSat = false) {
  const br = String(branch || '').toUpperCase();
  const base = defaultMap(year, includeSat);
  const overridden = {};
  let r = { rows: [] };
  try {
    r = await pool.query(
      `SELECT month, days FROM budget_workdays WHERE year=$1 AND branch=$2`,
      [year, br]
    );
  } catch (e) { /* 表不存在等 → 用預設 */ }
  for (const row of r.rows) {
    const m = parseInt(row.month);
    if (m >= 1 && m <= 12) { base[m] = parseFloat(row.days) || 0; overridden[m] = true; }
  }
  const source = {};
  for (let m = 1; m <= 12; m++) source[m] = overridden[m] ? 'manual' : 'calendar';
  return { map: base, overridden, source };
}

// 儲存覆寫：items = [{ month, days }]
async function saveWorkdays(year, branch, items) {
  const br = String(branch || '').toUpperCase();
  const client = await pool.connect();
  let written = 0;
  try {
    await client.query('BEGIN');
    for (const it of items) {
      const m = parseInt(it.month);
      if (!(m >= 1 && m <= 12)) continue;
      const days = Math.max(0, parseFloat(it.days) || 0);
      await client.query(
        `INSERT INTO budget_workdays (year, branch, month, days)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (year, branch, month)
         DO UPDATE SET days=EXCLUDED.days, updated_at=NOW()`,
        [year, br, m, days]
      );
      written++;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return written;
}

// 還原某月為月曆預設（刪除覆寫）
async function resetWorkdays(year, branch, month) {
  const br = String(branch || '').toUpperCase();
  const r = await pool.query(
    `DELETE FROM budget_workdays WHERE year=$1 AND branch=$2 AND month=$3`,
    [year, br, parseInt(month)]
  );
  return r.rowCount;
}

module.exports = {
  defaultWorkdays,
  defaultMap,
  getWorkdays,
  saveWorkdays,
  resetWorkdays,
};
