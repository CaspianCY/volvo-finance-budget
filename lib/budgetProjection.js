/**
 * lib/budgetProjection.js
 * -------------------------------------------------------------
 * 年度營收「預算 / 全年預估」推估引擎。
 *
 * 情境（2026 為例）：
 *   - 1~5 月已有 DMS 實際數字（repair_income）
 *   - 6~12 月還沒發生 → 需要推估，方法二選一：
 *       method='target'        後續月份用「今年度目標」(revenue_targets)
 *       method='average'       後續月份用「已實現月份的平均」推估
 *       method='conservative'  取「目標 / 平均」兩者較低值（車市不好、目標達不到）
 *   - 全年預估 = 已實現月份實際 + 後續月份推估
 *
 * 營收維度沿用四大營收（與 revenue_targets / computeAllRevenues 一致）：
 *   paid（有費）、bodywork（鈑烤）、general（一般）、extended（延保）
 *
 * 所有金額單位：元（未稅），與 revenue_targets 一致。
 */
const pool = require('../db/pool');
const { computeAllRevenues } = require('./revenueActual');

const CATEGORIES = ['paid', 'bodywork', 'general', 'extended'];
const CATEGORY_LABEL = { paid: '有費營收', bodywork: '鈑烤營收', general: '一般營收', extended: '延保營收' };
const REAL_BRANCHES = ['AMA', 'AMC', 'AMD', 'AME'];
const VALID_METHODS = new Set(['target', 'average', 'conservative', 'workday', 'target_pct']);

// branch 參數 → 實際要查的廠別清單（'ALL'/'合計' 代表四廠合計）
function resolveBranches(branch) {
  const b = String(branch || '').trim().toUpperCase();
  if (b === 'ALL' || b === '合計' || b === 'B-AM') return REAL_BRANCHES.slice();
  if (REAL_BRANCHES.includes(b)) return [b];
  return [b]; // 其他（鈑烤/聯合…）原樣帶入，computeAllRevenues 會自行處理
}

function pad2(m) { return String(m).padStart(2, '0'); }

// 哪些月份已有 DMS 實際資料（依 repair_income 是否有該期該廠的列判定）
async function getActualMonths(year, branches) {
  const r = await pool.query(
    `SELECT DISTINCT substring(period from 5 for 2)::int AS m
       FROM repair_income
      WHERE branch = ANY($1) AND period BETWEEN $2 AND $3`,
    [branches, `${year}01`, `${year}12`]
  );
  return r.rows
    .map(row => parseInt(row.m))
    .filter(m => m >= 1 && m <= 12)
    .sort((a, b) => a - b);
}

// 各月四大營收的「實際值」（已實現月份才有意義）。回傳 { m: {paid,bodywork,general,extended} }
async function getMonthlyActuals(year, branches, months) {
  const out = {};
  for (const m of months) {
    const period = `${year}${pad2(m)}`;
    const agg = { paid: 0, bodywork: 0, general: 0, extended: 0 };
    for (const br of branches) {
      const rev = await computeAllRevenues(period, br); // {paid,bodywork,general,extended}
      agg.paid     += rev.paid     || 0;
      agg.bodywork += rev.bodywork || 0;
      agg.general  += rev.general  || 0;
      agg.extended += rev.extended || 0;
    }
    out[m] = agg;
  }
  return out;
}

// 各月「營業成本」的 DMS 實際值（repair_income.parts_cost，多廠加總）。回傳 { m: cost }
// 注意：DMS 僅含「料件成本」，不含工資/外包等其他成本。後續月份無此資料，
// 由 computeProjection 以「成本率（已實現月份成本/營收）× 該月營收」推估，財務可覆寫。
async function getMonthlyCostActuals(year, branches) {
  const r = await pool.query(
    `SELECT substring(period from 5 for 2)::int AS m,
            COALESCE(SUM(parts_cost),0) AS cost
       FROM repair_income
      WHERE branch = ANY($1) AND period BETWEEN $2 AND $3
      GROUP BY 1`,
    [branches, `${year}01`, `${year}12`]
  );
  const out = {};
  for (const row of r.rows) {
    const m = parseInt(row.m);
    if (m >= 1 && m <= 12) out[m] = parseFloat(row.cost) || 0;
  }
  return out;
}

// 各月四大營收的「今年度目標」（revenue_targets，多廠加總）。回傳 { m: {...} }
async function getMonthlyTargets(year, branches) {
  const r = await pool.query(
    `SELECT period,
            COALESCE(SUM(paid_target),0)     AS paid,
            COALESCE(SUM(bodywork_target),0) AS bodywork,
            COALESCE(SUM(general_target),0)  AS general,
            COALESCE(SUM(extended_target),0) AS extended
       FROM revenue_targets
      WHERE branch = ANY($1) AND period BETWEEN $2 AND $3
      GROUP BY period`,
    [branches, `${year}01`, `${year}12`]
  );
  const out = {};
  for (let m = 1; m <= 12; m++) out[m] = { paid: 0, bodywork: 0, general: 0, extended: 0 };
  for (const row of r.rows) {
    const m = parseInt(String(row.period).slice(4, 6));
    if (m >= 1 && m <= 12) {
      out[m] = {
        paid: parseFloat(row.paid) || 0,
        bodywork: parseFloat(row.bodywork) || 0,
        general: parseFloat(row.general) || 0,
        extended: parseFloat(row.extended) || 0,
      };
    }
  }
  return out;
}

// 已實現月份的「每月平均」(per category)
function computeAverage(monthlyActuals, actualMonths) {
  const sum = { paid: 0, bodywork: 0, general: 0, extended: 0 };
  for (const m of actualMonths) {
    const a = monthlyActuals[m] || {};
    for (const c of CATEGORIES) sum[c] += a[c] || 0;
  }
  const n = actualMonths.length || 1;
  const avg = {};
  for (const c of CATEGORIES) avg[c] = sum[c] / n;
  return avg;
}

// ── 財務編列：預算版本（revenue_budget_plan）的讀寫 ──
// 回傳 { m: {paid,bodywork,general,extended,cost,expense} }；只含財務手動編列過的月份
async function getPlan(year, branch, version = 'default') {
  const r = await pool.query(
    `SELECT period, paid, bodywork, general, extended, cost, expense
       FROM revenue_budget_plan
      WHERE year=$1 AND branch=$2 AND version=$3`,
    [year, String(branch).toUpperCase(), version]
  );
  const out = {};
  for (const row of r.rows) {
    const m = parseInt(String(row.period).slice(4, 6));
    if (m >= 1 && m <= 12) {
      out[m] = {
        paid: parseFloat(row.paid) || 0,
        bodywork: parseFloat(row.bodywork) || 0,
        general: parseFloat(row.general) || 0,
        extended: parseFloat(row.extended) || 0,
        cost: parseFloat(row.cost) || 0,
        expense: parseFloat(row.expense) || 0,
      };
    }
  }
  return out;
}

// items: [{ month|period, paid, bodywork, general, extended, cost, expense, note? }]
async function savePlan(year, branch, version, items, updatedBy = '') {
  const br = String(branch).toUpperCase();
  const client = await pool.connect();
  let written = 0;
  try {
    await client.query('BEGIN');
    for (const it of items) {
      let m = it.month != null ? parseInt(it.month)
            : it.period ? parseInt(String(it.period).slice(4, 6)) : NaN;
      if (!(m >= 1 && m <= 12)) continue;
      const period = `${year}${String(m).padStart(2, '0')}`;
      const num = v => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
      await client.query(
        `INSERT INTO revenue_budget_plan
           (year, branch, version, period, paid, bodywork, general, extended, cost, expense, note, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (year, branch, version, period)
         DO UPDATE SET paid=EXCLUDED.paid, bodywork=EXCLUDED.bodywork,
           general=EXCLUDED.general, extended=EXCLUDED.extended,
           cost=EXCLUDED.cost, expense=EXCLUDED.expense,
           note=EXCLUDED.note, updated_at=NOW(), updated_by=EXCLUDED.updated_by`,
        [year, br, version, period, num(it.paid), num(it.bodywork),
         num(it.general), num(it.extended), num(it.cost), num(it.expense),
         String(it.note || ''), String(updatedBy || '')]
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

async function listPlanVersions(year, branch) {
  const r = await pool.query(
    `SELECT version, COUNT(*) AS months, MAX(updated_at) AS updated_at, MAX(updated_by) AS updated_by
       FROM revenue_budget_plan
      WHERE year=$1 AND branch=$2
      GROUP BY version
      ORDER BY MAX(updated_at) DESC`,
    [year, String(branch).toUpperCase()]
  );
  return r.rows.map(row => ({
    version: row.version,
    months: parseInt(row.months) || 0,
    updated_at: row.updated_at,
    updated_by: row.updated_by || '',
  }));
}

async function deletePlan(year, branch, version) {
  const r = await pool.query(
    `DELETE FROM revenue_budget_plan WHERE year=$1 AND branch=$2 AND version=$3`,
    [year, String(branch).toUpperCase(), version]
  );
  return r.rowCount;
}

/**
 * 主入口：算出某年某廠的全年營收預估表。
 * @param {number} year
 * @param {string} branch  AMA/AMC/AMD/AME 或 ALL（四廠合計）
 * @param {string} method  target | average | conservative
 * @param {object} planOverrides  { m: {paid,bodywork,general,extended,cost,expense} } 財務編列覆寫值。
 *                 營收四項套在非實際月份上（實際月份營收恆採 DMS）；cost 與 expense 套在
 *                 所有月份上（含已實現月份，供財務補列 DMS 沒有的工資/外包成本與營業費用）。
 *                 某月某項有值就蓋掉預設，其餘仍依推估邏輯。
 * @param {object} opts  { workdays:{m:days}, factor:number } 推估法參數：
 *                 method='workday'    → 後續月份 = 日產能(已實現Σ營收/Σ工作天數) × 該月工作天數
 *                 method='target_pct' → 後續月份 = 月目標 × factor（如 0.85＝目標的 85%）
 */
async function computeProjection(year, branch, method = 'target', planOverrides = {}, opts = {}) {
  if (!VALID_METHODS.has(method)) method = 'target';
  const branches = resolveBranches(branch);

  const actualMonths = await getActualMonths(year, branches);
  const projectedMonths = [];
  for (let m = 1; m <= 12; m++) if (!actualMonths.includes(m)) projectedMonths.push(m);

  const [monthlyActuals, monthlyTargets, monthlyCost] = await Promise.all([
    getMonthlyActuals(year, branches, actualMonths),
    getMonthlyTargets(year, branches),
    getMonthlyCostActuals(year, branches),
  ]);
  const average = computeAverage(monthlyActuals, actualMonths);

  // 工作天數推估：日產能（每工作天營收，per category）= Σ已實現月份營收 / Σ已實現月份工作天數
  const workdays = opts.workdays || {};
  let actualWorkdaysSum = 0;
  for (const m of actualMonths) actualWorkdaysSum += (workdays[m] || 0);
  const dailyRate = {};
  for (const c of CATEGORIES) {
    let s = 0;
    for (const m of actualMonths) s += (monthlyActuals[m] && monthlyActuals[m][c]) || 0;
    dailyRate[c] = actualWorkdaysSum > 0 ? s / actualWorkdaysSum : 0;
  }
  // 目標係數法的係數（預設 0.85；夾在 0~2 之間防呆）
  let factor = parseFloat(opts.factor);
  if (isNaN(factor)) factor = 0.85;
  factor = Math.max(0, Math.min(2, factor));

  const overrides = planOverrides || {};
  const isOverridden = (category, m) =>
    overrides[m] && overrides[m][category] != null && !isNaN(parseFloat(overrides[m][category]));

  // 後續月份各 category 的推估值（財務編列覆寫優先）
  function projectValue(category, m) {
    if (isOverridden(category, m)) return parseFloat(overrides[m][category]);
    const tgt = (monthlyTargets[m] && monthlyTargets[m][category]) || 0;
    const avg = average[category] || 0;
    if (method === 'target') return tgt;
    if (method === 'average') return avg;
    if (method === 'workday') return (dailyRate[category] || 0) * (workdays[m] || 0);
    if (method === 'target_pct') return tgt * factor;
    // conservative：兩者都 > 0 取較低；只有一個有值就用那個（避免被 0 拉死）
    if (tgt > 0 && avg > 0) return Math.min(tgt, avg);
    return tgt > 0 ? tgt : avg;
  }

  // 組各 category 的逐月表 + 小計
  const rows = {};
  const totals = {
    months: {}, actual_ytd: 0, projected_rest: 0, full_year: 0,
    target_full_year: 0, gap: 0, gap_pct: null,
  };
  for (let m = 1; m <= 12; m++) totals.months[m] = { value: 0, source: actualMonths.includes(m) ? 'actual' : 'projected' };

  for (const c of CATEGORIES) {
    const row = {
      label: CATEGORY_LABEL[c],
      months: {},
      actual_ytd: 0,
      projected_rest: 0,
      full_year: 0,
      target_full_year: 0,
      gap: 0,
      gap_pct: null,
    };
    for (let m = 1; m <= 12; m++) {
      const isActual = actualMonths.includes(m);
      const value = isActual
        ? ((monthlyActuals[m] && monthlyActuals[m][c]) || 0)
        : projectValue(c, m);
      const source = isActual ? 'actual' : (isOverridden(c, m) ? 'plan' : 'projected');
      row.months[m] = { value, source };
      if (isActual) row.actual_ytd += value; else row.projected_rest += value;
      row.full_year += value;
      row.target_full_year += (monthlyTargets[m] && monthlyTargets[m][c]) || 0;
      // 累計到合計列
      totals.months[m].value += value;
    }
    row.gap = row.full_year - row.target_full_year;
    row.gap_pct = row.target_full_year ? Math.round(row.full_year / row.target_full_year * 1000) / 10 : null;
    rows[c] = row;

    totals.actual_ytd += row.actual_ytd;
    totals.projected_rest += row.projected_rest;
    totals.full_year += row.full_year;
    totals.target_full_year += row.target_full_year;
  }
  totals.gap = totals.full_year - totals.target_full_year;
  totals.gap_pct = totals.target_full_year ? Math.round(totals.full_year / totals.target_full_year * 1000) / 10 : null;

  // ── 損益擴充：營業成本 / 毛利 / 營業費用 / 營業淨利 ──
  // 成本率＝已實現月份（DMS 料件成本合計）/（同月營收合計）；後續月份成本 = 該月營收 × 成本率
  let actualRevSum = 0, actualCostSum = 0;
  for (const m of actualMonths) {
    actualRevSum += totals.months[m].value;
    actualCostSum += monthlyCost[m] || 0;
  }
  const costRatio = actualRevSum > 0 ? actualCostSum / actualRevSum : 0;

  const numOv = (m, key) => {
    if (!overrides[m] || overrides[m][key] == null) return null;
    const n = parseFloat(overrides[m][key]);
    return isNaN(n) ? null : n;
  };
  // 成本：編列覆寫優先（含已實現月份，供財務補列工資/外包等 DMS 沒有的成本）；
  // 無覆寫時，已實現月份用 DMS 料件成本、後續月份用 營收×成本率 推估。
  const costOf = (m, isActual, rev) => {
    const ov = numOv(m, 'cost');
    if (ov != null) return ov;
    return isActual ? (monthlyCost[m] || 0) : rev * costRatio;
  };
  // 費用：DMS 無來源，全部依編列（含實際月份），未編列則 0
  const expenseOf = (m) => {
    const ov = numOv(m, 'expense');
    return ov != null ? ov : 0;
  };

  const mkLine = () => ({ months: {}, actual_ytd: 0, projected_rest: 0, full_year: 0 });
  const pnl = {
    revenue: { months: {}, actual_ytd: totals.actual_ytd, projected_rest: totals.projected_rest, full_year: totals.full_year },
    cost: mkLine(), gross: mkLine(), expense: mkLine(), net: mkLine(),
    cost_ratio: costRatio,
    gross_margin: null, net_margin: null,
  };
  for (let m = 1; m <= 12; m++) {
    const isActual = actualMonths.includes(m);
    const rev = totals.months[m].value;
    const cost = costOf(m, isActual, rev);
    const exp = expenseOf(m);
    const gross = rev - cost;
    const net = gross - exp;
    const costSource = numOv(m, 'cost') != null ? 'plan' : (isActual ? 'actual' : 'projected');
    const expSource = numOv(m, 'expense') != null ? 'plan' : 'projected';
    pnl.revenue.months[m] = { value: rev, source: totals.months[m].source };
    pnl.cost.months[m] = { value: cost, source: costSource };
    pnl.gross.months[m] = { value: gross };
    pnl.expense.months[m] = { value: exp, source: expSource };
    pnl.net.months[m] = { value: net };
    pnl.cost.full_year += cost; pnl.gross.full_year += gross;
    pnl.expense.full_year += exp; pnl.net.full_year += net;
    if (isActual) { pnl.cost.actual_ytd += cost; pnl.expense.actual_ytd += exp; }
    else { pnl.cost.projected_rest += cost; pnl.expense.projected_rest += exp; }
  }
  pnl.gross.actual_ytd = pnl.revenue.actual_ytd - pnl.cost.actual_ytd;
  pnl.gross.projected_rest = pnl.revenue.projected_rest - pnl.cost.projected_rest;
  pnl.net.actual_ytd = pnl.gross.actual_ytd - pnl.expense.actual_ytd;
  pnl.net.projected_rest = pnl.gross.projected_rest - pnl.expense.projected_rest;
  pnl.gross_margin = pnl.revenue.full_year > 0 ? Math.round(pnl.gross.full_year / pnl.revenue.full_year * 1000) / 10 : null;
  pnl.net_margin = pnl.revenue.full_year > 0 ? Math.round(pnl.net.full_year / pnl.revenue.full_year * 1000) / 10 : null;

  return {
    year,
    branch: String(branch || '').toUpperCase(),
    branches,
    method,
    categories: CATEGORIES,
    category_labels: CATEGORY_LABEL,
    actual_months: actualMonths,
    projected_months: projectedMonths,
    rows,
    totals,
    pnl,
    factor: method === 'target_pct' ? factor : null,
    basis: {
      // 透明化推估依據，前端可顯示
      average_per_month: average,
      target_per_month: monthlyTargets,
      avg_basis_months: actualMonths,
      // 損益：DMS 料件成本（實際月份）與推估成本率，供前端編列時即時試算
      cost_actual: monthlyCost,
      cost_ratio: costRatio,
      // 工作天數推估：各月工作天數、日產能（per category）、目標係數
      workdays,
      daily_rate: dailyRate,
      workdays_actual_sum: actualWorkdaysSum,
      target_factor: factor,
    },
  };
}

module.exports = {
  CATEGORIES,
  CATEGORY_LABEL,
  REAL_BRANCHES,
  VALID_METHODS,
  resolveBranches,
  getActualMonths,
  getMonthlyActuals,
  getMonthlyTargets,
  getMonthlyCostActuals,
  computeAverage,
  computeProjection,
  getPlan,
  savePlan,
  listPlanVersions,
  deletePlan,
};
