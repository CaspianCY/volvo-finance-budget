/**
 * lib/budgetParams.js
 * -------------------------------------------------------------
 * 「預算參數」：從某年某區間（預設 2026/1–5）的 DMS 實績，反推出編列預算
 * 要用的驅動因子：
 *   - 工作天數（每月營業日數；合計 / 月均）
 *   - 進廠台數（合計 / 日平均 / 月平均）
 *   - 單車消費額（整體單車產值＝總營收/台數、有費客單價＝有費營收/台數）
 *   - 各項營收金額 + 占比（一般 / 鈑烤 / 延保 / 保固其他，分母＝總營收）
 *   - 營業成本、毛利額、毛利率
 *
 * 營收口徑沿用 computeAllRevenues：
 *   有費營收(paid) = 一般(general) + 鈑烤(bodywork) + 延保(extended)
 *   總營收(total)  = repair_income.total_untaxed 全部帳別加總（含保固等）
 *   保固其他       = 總營收 − 有費營收
 *
 * 台數 / 工作天數沒有固定 schema：本模組於執行時查 information_schema 偵測
 * repair_income 是否有「日期欄」「工單/車輛識別欄」，有就用、沒有就退而：
 *   - 工作天數 → 該月「週一~週五」日數（月曆估算）
 *   - 台數     → 無法計（回 null），UI 顯示「—」並說明
 * 實際用了哪種來源，一律放在回傳的 basis 欄位，前端會顯示。
 */
const pool = require('../db/pool');
const {
  resolveBranches, getMonthlyActuals, getMonthlyCostActuals,
} = require('./budgetProjection');
const { getWorkdays } = require('./workdays');

// 可能的「日期欄」「工單/車輛識別欄」名稱（命中越前面越優先）
const DATE_NAMES = [
  'work_date', 'repair_date', 'close_date', 'closed_date', 'finish_date',
  'complete_date', 'completion_date', 'open_date', 'invoice_date', 'settle_date',
  'settlement_date', 'accounting_date', 'business_date', 'trans_date',
  'transaction_date', 'tx_date', 'create_date', 'created_at', 'create_time', 'date',
];
const ID_NAMES = [
  'work_order', 'work_order_no', 'workorder', 'wo_no', 'wono', 'ro_no', 'rono', 'ro',
  'repair_order', 'repair_order_no', 'order_no', 'order_number',
  'license_plate', 'plate_no', 'plate', 'car_no', 'car_plate',
  'vin', 'vehicle_no', 'vehicle_id', 'license', 'license_no',
];

async function detectColumns() {
  const r = await pool.query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema='public' AND table_name='repair_income'`
  );
  return new Map(r.rows.map(row => [row.column_name, row.data_type]));
}

// 只取「日期/timestamp 型別」的欄（字串型 YYYYMMDD 轉型不可靠，寧可退月曆）
function pickDateCol(cols) {
  const dateTyped = [...cols].filter(([, t]) => /date|timestamp/i.test(t)).map(([n]) => n);
  if (!dateTyped.length) return null;
  for (const n of DATE_NAMES) if (dateTyped.includes(n)) return n;
  return dateTyped[0];
}
function pickIdCol(cols) {
  for (const n of ID_NAMES) if (cols.has(n)) return n;
  return null;
}

// 某月「週一~週五」日數（DMS 無日期欄時的工作天數估算）
function weekdaysInMonth(year, month) {
  let c = 0;
  const d = new Date(year, month - 1, 1);
  while (d.getMonth() === month - 1) {
    const wd = d.getDay();
    if (wd >= 1 && wd <= 5) c++;
    d.setDate(d.getDate() + 1);
  }
  return c;
}

function periodRange(year, from, to) {
  return [`${year}${String(from).padStart(2, '0')}`, `${year}${String(to).padStart(2, '0')}`];
}

// 各月總營收（repair_income.total_untaxed 全帳別加總）
async function getMonthlyTotalRevenue(year, branches, p0, p1) {
  const r = await pool.query(
    `SELECT substring(period from 5 for 2)::int AS m, COALESCE(SUM(total_untaxed),0) AS total
       FROM repair_income WHERE branch = ANY($1) AND period BETWEEN $2 AND $3 GROUP BY 1`,
    [branches, p0, p1]
  );
  const out = {};
  for (const row of r.rows) out[parseInt(row.m)] = parseFloat(row.total) || 0;
  return out;
}

// 各月工作天數（用偵測到的日期欄，COUNT DISTINCT 營業日）
async function getMonthlyWorkdaysFromDate(branches, p0, p1, dateCol) {
  const r = await pool.query(
    `SELECT substring(period from 5 for 2)::int AS m, COUNT(DISTINCT (${dateCol})::date) AS days
       FROM repair_income WHERE branch = ANY($1) AND period BETWEEN $2 AND $3 GROUP BY 1`,
    [branches, p0, p1]
  );
  const out = {};
  for (const row of r.rows) out[parseInt(row.m)] = parseInt(row.days) || 0;
  return out;
}

// 各月進廠台數（用偵測到的工單/車輛識別欄，COUNT DISTINCT）
async function getMonthlyUnits(branches, p0, p1, idCol) {
  const r = await pool.query(
    `SELECT substring(period from 5 for 2)::int AS m, COUNT(DISTINCT ${idCol}) AS units
       FROM repair_income WHERE branch = ANY($1) AND period BETWEEN $2 AND $3 GROUP BY 1`,
    [branches, p0, p1]
  );
  const out = {};
  for (const row of r.rows) out[parseInt(row.m)] = parseInt(row.units) || 0;
  return out;
}

// 把某帳類集合 { account_type: {rev,cost,bw_rev,bw_cost} } 拆成「預算用細分類」：
//   一般帳類 → 一般(不含鈑烤) + 自費鈑烤；保險帳類 → 保險鈑烤；其餘 → 帳類原名。
// 回傳 { key, label, order } 對應的 {rev,cost}，key 在各月間穩定（供逐月表使用）。
function deriveDetail(atMap) {
  const out = {}; // key -> {label, order, rev, cost}
  const add = (key, label, order, rev, cost) => {
    if (!out[key]) out[key] = { key, label, order, rev: 0, cost: 0 };
    out[key].rev += rev; out[key].cost += cost;
  };
  for (const [at, v] of Object.entries(atMap)) {
    const name = at || '(未分類)';
    if (name.includes('一般')) {
      add('gen_pure', '一般(不含鈑烤)', 1, v.rev - v.bw_rev, v.cost - v.bw_cost);
      add('bw_self', '自費鈑烤(一般帳類)', 2, v.bw_rev, v.bw_cost);
    } else if (name.includes('保險')) {
      add('bw_ins', '保險鈑烤(保險帳類)', 3, v.rev, v.cost);
    } else {
      add('at_' + name, name, 10, v.rev, v.cost);
    }
  }
  return out;
}

// 各帳類(account_type)的逐月營收 + 料件成本明細。產出：
//   account_types：彙總層級各帳類（給「帳類明細」表）
//   bodywork：自費/保險鈑烤彙總
//   detail：預算用細分類的「逐月 + 合計 + 占比」（給上方參數表細分用）
async function getAccountTypeBreakdown(cols, branches, p0, p1, months) {
  if (!cols.has('account_type')) return null;
  const hasCost = cols.has('parts_cost');
  const hasBw = cols.has('bodywork_income') && cols.has('paint_income');
  const costExpr = hasCost ? 'COALESCE(SUM(parts_cost),0)' : '0';
  const bwCond = '(COALESCE(bodywork_income,0)>0 OR COALESCE(paint_income,0)>0)';
  const bwRevExpr = hasBw ? `COALESCE(SUM(CASE WHEN ${bwCond} THEN total_untaxed ELSE 0 END),0)` : '0';
  const bwCostExpr = (hasBw && hasCost) ? `COALESCE(SUM(CASE WHEN ${bwCond} THEN parts_cost ELSE 0 END),0)` : '0';
  const r = await pool.query(
    `SELECT substring(period from 5 for 2)::int AS m, account_type,
            COALESCE(SUM(total_untaxed),0) AS rev,
            ${costExpr}   AS cost,
            ${bwRevExpr}  AS bw_rev,
            ${bwCostExpr} AS bw_cost
       FROM repair_income
      WHERE branch = ANY($1) AND period BETWEEN $2 AND $3
      GROUP BY 1, account_type`,
    [branches, p0, p1]
  );
  // 解析成 逐月 與 彙總 兩份 { account_type: {rev,cost,bw_rev,bw_cost} }
  const perMonthAt = {};
  const aggAt = {};
  for (const row of r.rows) {
    const m = parseInt(row.m);
    const at = row.account_type || '(未分類)';
    const rec = {
      rev: parseFloat(row.rev) || 0, cost: parseFloat(row.cost) || 0,
      bw_rev: parseFloat(row.bw_rev) || 0, bw_cost: parseFloat(row.bw_cost) || 0,
    };
    (perMonthAt[m] = perMonthAt[m] || {})[at] = rec;
    const a = aggAt[at] = aggAt[at] || { rev: 0, cost: 0, bw_rev: 0, bw_cost: 0 };
    a.rev += rec.rev; a.cost += rec.cost; a.bw_rev += rec.bw_rev; a.bw_cost += rec.bw_cost;
  }

  // 帳類明細（彙總，給下方原始帳類表）
  const types = Object.entries(aggAt).map(([at, v]) => ({
    account_type: at, rev: v.rev, cost: v.cost, gross: v.rev - v.cost,
    gross_margin: v.rev > 0 ? Math.round((v.rev - v.cost) / v.rev * 1000) / 10 : null,
    bw_rev: v.bw_rev, bw_cost: v.bw_cost,
  })).sort((a, b) => b.rev - a.rev);

  const bodywork = { self_rev: 0, self_cost: 0, ins_rev: 0, ins_cost: 0 };
  for (const t of types) {
    if (t.account_type.includes('保險')) { bodywork.ins_rev += t.rev; bodywork.ins_cost += t.cost; }
    else if (t.account_type.includes('一般')) { bodywork.self_rev += t.bw_rev; bodywork.self_cost += t.bw_cost; }
  }

  // 預算用細分類：以彙總決定類別清單與順序，逐月填值
  const aggDetail = deriveDetail(aggAt);
  const totalRev = Object.values(aggDetail).reduce((s, c) => s + c.rev, 0);
  const categories = Object.values(aggDetail)
    .sort((a, b) => (a.order - b.order) || (b.rev - a.rev))
    .map(c => ({ key: c.key, label: c.label, paid: isPaidCategoryKey(c.key) }));
  const totals = {};
  for (const c of Object.values(aggDetail)) {
    totals[c.key] = {
      rev: c.rev, cost: c.cost, gross: c.rev - c.cost,
      mix: totalRev > 0 ? Math.round(c.rev / totalRev * 1000) / 10 : null,
    };
  }
  const per_month = {};
  for (const m of (months || [])) {
    const dm = deriveDetail(perMonthAt[m] || {});
    per_month[m] = {};
    for (const c of categories) {
      const v = dm[c.key];
      per_month[m][c.key] = v ? { rev: v.rev, cost: v.cost } : { rev: 0, cost: 0 };
    }
  }

  const detail = { categories, totals, per_month, total_rev: totalRev };
  addPaidFreeGroups(detail, months || []);
  return {
    has_cost: hasCost, has_bodywork_split: hasBw,
    account_types: types, bodywork,
    detail,
  };
}

// 細分類歸「有費 / 無費」：一般/自費鈑烤/保險鈑烤/延保/票券＝有費；保固/善意/內帳…＝無費。
function isPaidCategoryKey(key) {
  if (key === 'gen_pure' || key === 'bw_self' || key === 'bw_ins') return true;
  if (key.startsWith('at_')) return /延保|票/.test(key.slice(3));
  return false;
}

// 在 detail 上補出 groups：{ paid, free }，各含 rev/cost/gross/margin/mix 與逐月。
function addPaidFreeGroups(detail, monthsList) {
  const groups = { paid: { rev: 0, cost: 0, per_month: {} }, free: { rev: 0, cost: 0, per_month: {} } };
  for (const c of detail.categories) {
    const g = isPaidCategoryKey(c.key) ? groups.paid : groups.free;
    const t = detail.totals[c.key];
    g.rev += t.rev; g.cost += t.cost;
  }
  for (const m of monthsList) {
    groups.paid.per_month[m] = { rev: 0, cost: 0 };
    groups.free.per_month[m] = { rev: 0, cost: 0 };
    for (const c of detail.categories) {
      const x = detail.per_month[m] && detail.per_month[m][c.key];
      if (!x) continue;
      const g = isPaidCategoryKey(c.key) ? groups.paid.per_month[m] : groups.free.per_month[m];
      g.rev += x.rev; g.cost += x.cost;
    }
  }
  for (const k of ['paid', 'free']) {
    const g = groups[k];
    g.gross = g.rev - g.cost;
    g.margin = g.rev > 0 ? Math.round(g.gross / g.rev * 1000) / 10 : null;
    g.mix = detail.total_rev > 0 ? Math.round(g.rev / detail.total_rev * 1000) / 10 : null;
  }
  detail.groups = groups;
}

// 模型 B：無費（不收費）類別「以成本計營收」——把無費類別的 rev 改成其 cost，
// 使「無費營收＝無費成本、無費毛利＝0」，總營收＝有費營收＋無費成本。
// 有費類別維持原 total_untaxed 營收。之後重算 total_rev / mix / gross / groups。
function applyModelB(detail, monthsList) {
  for (const c of detail.categories) {
    if (c.paid) continue;
    detail.totals[c.key].rev = detail.totals[c.key].cost;
    for (const m of monthsList) {
      const x = detail.per_month[m] && detail.per_month[m][c.key];
      if (x) x.rev = x.cost;
    }
  }
  detail.total_rev = detail.categories.reduce((s, c) => s + detail.totals[c.key].rev, 0);
  for (const c of detail.categories) {
    const t = detail.totals[c.key];
    t.gross = t.rev - t.cost;   // 無費→0，有費→正常
    t.mix = detail.total_rev > 0 ? Math.round(t.rev / detail.total_rev * 1000) / 10 : null;
  }
  addPaidFreeGroups(detail, monthsList);
}

const round1 = v => Math.round(v * 10) / 10;
const pct1 = (v, base) => (base > 0 ? Math.round(v / base * 1000) / 10 : null);

/**
 * 主入口：算出某年 from~to 月的預算參數。
 * @param {number} year
 * @param {number} from  起始月 1~12
 * @param {number} to    結束月 1~12
 * @param {string} branch AMA/AMC/AMD/AME 或 ALL
 * @param {object} opts  { project:'workday' } 時，把 to+1~12 月用「工作天數推估」補上：
 *                 各月總營收＝日產能(from~to Σ營收÷Σ工作天數)×該月工作天數；
 *                 營收結構/成本率/單車產值沿用 from~to 實際，台數＝日均台數×工作天數。
 */
async function computeBudgetParams(year, from, to, branch, opts = {}) {
  const branches = resolveBranches(branch);
  const [p0, p1] = periodRange(year, from, to);
  const months = [];
  for (let m = from; m <= to; m++) months.push(m);

  const cols = await detectColumns();
  const idCol = pickIdCol(cols);

  const [monthlyActuals, monthlyCost, monthlyTotal, monthlyUnits, breakdown, wd] = await Promise.all([
    getMonthlyActuals(year, branches, months),   // {m:{paid,bodywork,general,extended}}
    getMonthlyCostActuals(year, branches),        // {m:cost}
    getMonthlyTotalRevenue(year, branches, p0, p1),
    idCol ? getMonthlyUnits(branches, p0, p1, idCol) : Promise.resolve(null),
    getAccountTypeBreakdown(cols, branches, p0, p1, months),  // 各帳類 營收/成本/毛利 明細（含逐月細分類）
    getWorkdays(year, branch),                    // 工作天數（手動覆寫優先，否則月曆預設）
  ]);
  // 工作天數採共用來源（與全年預估「工作天數推估法」一致；財務手動覆寫優先）
  const monthlyDays = {};
  const daysManual = months.some(m => wd.source[m] === 'manual');
  for (const m of months) monthlyDays[m] = wd.map[m] || 0;

  // 模型 B：無費以成本計營收（總營收＝有費營收＋無費成本）。有 account_type 明細時套用，
  // 並讓總營收/逐月營收改由（調整後）明細推導，確保「無費營收＝無費成本」對得上。
  const det = breakdown && breakdown.detail;
  if (det) applyModelB(det, months);
  const sumDet = (m, field) => det.categories.reduce((s, cat) => {
    const x = det.per_month[m] && det.per_month[m][cat.key];
    return s + (x ? x[field] : 0);
  }, 0);

  // 逐月彙整
  let paid = 0, bw = 0, gen = 0, ext = 0, totalRev = 0, cost = 0, days = 0, units = 0;
  const perMonth = {};
  for (const m of months) {
    const a = monthlyActuals[m] || { paid: 0, bodywork: 0, general: 0, extended: 0 };
    const tr = det ? sumDet(m, 'rev') : (monthlyTotal[m] || 0);   // 無費以成本計
    const c = det ? sumDet(m, 'cost') : (monthlyCost[m] || 0);
    const d = monthlyDays[m] || 0;
    const u = monthlyUnits ? (monthlyUnits[m] || 0) : null;
    paid += a.paid; bw += a.bodywork; gen += a.general; ext += a.extended;
    totalRev += tr; cost += c; days += d; if (u != null) units += u;
    perMonth[m] = {
      paid: a.paid, bodywork: a.bodywork, general: a.general, extended: a.extended,
      total: tr, cost: c, workdays: d, units: u,
      per_car_overall: u > 0 ? Math.round(tr / u) : null,
    };
  }

  // ── 全年版：to+1~12 月用「工作天數推估」補上（驅動因子沿用 from~to 實際）──
  let projectedMonths = [];
  if (opts.project === 'workday' && to < 12 && totalRev > 0) {
    for (let m = to + 1; m <= 12; m++) projectedMonths.push(m);
    const dailyRev = days > 0 ? totalRev / days : 0;
    const dailyUnits = (monthlyUnits && days > 0) ? units / days : null;
    const costRatioTotal = totalRev > 0 ? cost / totalRev : 0;
    const shares = { paid: paid / totalRev, bodywork: bw / totalRev, general: gen / totalRev, extended: ext / totalRev };
    const detDrivers = {};
    if (det) for (const c of det.categories) {
      const t = det.totals[c.key];
      detDrivers[c.key] = { frac: det.total_rev > 0 ? t.rev / det.total_rev : 0, costRatio: t.rev > 0 ? t.cost / t.rev : 0 };
    }
    for (const pm of projectedMonths) {
      const wdays = wd.map[pm] || 0;
      const projTotal = dailyRev * wdays;
      const projUnits = dailyUnits != null ? Math.round(dailyUnits * wdays) : null;
      let projCost = 0;
      if (det) {
        det.per_month[pm] = {};
        for (const c of det.categories) {
          const dd = detDrivers[c.key];
          const rv = projTotal * dd.frac;
          const ct = rv * dd.costRatio;
          det.per_month[pm][c.key] = { rev: rv, cost: ct };
          projCost += ct;
        }
      } else { projCost = projTotal * costRatioTotal; }
      perMonth[pm] = {
        paid: projTotal * shares.paid, bodywork: projTotal * shares.bodywork,
        general: projTotal * shares.general, extended: projTotal * shares.extended,
        total: projTotal, cost: projCost, workdays: wdays, units: projUnits,
        per_car_overall: projUnits > 0 ? Math.round(projTotal / projUnits) : null,
        projected: true,
      };
      paid += projTotal * shares.paid; bw += projTotal * shares.bodywork;
      gen += projTotal * shares.general; ext += projTotal * shares.extended;
      totalRev += projTotal; cost += projCost; days += wdays;
      if (monthlyUnits && projUnits != null) units += projUnits;
      months.push(pm);
    }
    // 重算 detail 合計與占比（全年）
    if (det) {
      const newTot = {};
      for (const c of det.categories) {
        let rv = 0, ct = 0;
        for (const m of months) { const x = det.per_month[m] && det.per_month[m][c.key]; if (x) { rv += x.rev; ct += x.cost; } }
        newTot[c.key] = { rev: rv, cost: ct, gross: rv - ct, mix: totalRev > 0 ? Math.round(rv / totalRev * 1000) / 10 : null };
      }
      det.totals = newTot; det.total_rev = totalRev;
      addPaidFreeGroups(det, months);   // 有費/無費 分組重算為全年
    }
  }

  // 有費營收 / 無費（以成本計）：有明細時採分組值；無明細時退回舊邏輯
  const paidRev = det ? det.groups.paid.rev : paid;
  const freeRev = det ? det.groups.free.rev : Math.max(0, totalRev - paid);
  const base = totalRev > 0 ? totalRev : paidRev;      // 占比分母（防 0）
  const grossProfit = totalRev - cost;
  const monthsCount = months.length || 1;
  const unitsTotal = monthlyUnits ? units : null;

  return {
    year, from, to,
    project: opts.project === 'workday' && projectedMonths.length ? 'workday' : null,
    projected_months: projectedMonths,
    branch: String(branch || '').toUpperCase(),
    branches,
    basis: {
      // 透明標明台數/工作天數的實際來源
      workdays: daysManual ? '財務手動輸入（部分月份）＋月曆預設（週一~五）' : '月曆預設（週一~五，未扣國定假日；可於下方手動覆寫）',
      workdays_source: daysManual ? 'manual' : 'calendar',
      units: idCol ? `DMS 識別欄 ${idCol}（不重複計數）` : '無可用工單/車輛欄位 → 台數無法計算',
      units_source: idCol ? 'distinct' : 'unavailable',
    },
    months,
    per_month: perMonth,
    revenue: {
      total: totalRev,                      // 總營收 = 有費營收 + 無費成本（模型B）
      paid: paidRev, general: gen, bodywork: bw, extended: ext, warranty_other: freeRev,
      // 占比（分母＝總營收）
      mix: {
        paid: pct1(paidRev, base),
        general: pct1(gen, base),
        bodywork: pct1(bw, base),
        extended: pct1(ext, base),
        warranty_other: pct1(freeRev, base),
      },
    },
    cost,
    gross_profit: grossProfit,
    gross_margin: pct1(grossProfit, totalRev),
    workdays: { total: days, avg_per_month: round1(days / monthsCount) },
    units: unitsTotal != null ? {
      total: unitsTotal,
      per_day: days > 0 ? round1(unitsTotal / days) : null,
      per_month: round1(unitsTotal / monthsCount),
    } : null,
    per_car: unitsTotal > 0 ? {
      overall: Math.round(totalRev / unitsTotal),   // 整體單車產值 = 總營收 / 台數
      paid: Math.round(paidRev / unitsTotal),       // 有費客單價 = 有費營收 / 台數
    } : null,
    // 各帳類（保固/善意/內帳/票券/一般/保險/延保…）營收 + 料件成本 + 毛利明細
    breakdown,
  };
}

module.exports = {
  computeBudgetParams,
  detectColumns,
  pickDateCol,
  pickIdCol,
  weekdaysInMonth,
};
