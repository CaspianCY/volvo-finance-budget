/**
 * lib/revenueActual.js
 * -------------------------------------------------------------
 * 從 DMS 實績資料計算某期某廠的歷史實際值，主要給「去年實績」自動
 * fallback 用：*_last_year / last_year_value 若為 NULL，API 讀取時就直
 * 接用這裡的 helper 算上年同月的實績補上，不用再手動上傳 Excel。
 *
 * - `computeAllRevenues(period, branch)` — 四大營收（有費/鈑烤/一般/延
 *   保，單位：元），來源 repair_income + parts_sales
 * - `computePerfActualForMetric(metric, period, branch)` — 單一業績指標
 *   的實績，依 metric.metric_type 切換 repair_income / parts /
 *   tech_wage / boutique 查詢
 * - `prevYearPeriod(period)` — YYYYMM → 上一年同月
 *
 * 邏輯沿用 routes/bonus.js 的 computeRevenueActual / computePerfActual。
 */
const pool = require('../db/pool');

async function computeAllRevenues(period, branch) {
  const cfgRow = await pool.query(
    `SELECT config_value FROM income_config WHERE config_key='external_sales_category'`
  );
  const extCat = cfgRow.rows[0]?.config_value || '外賣';

  const riRes = await pool.query(`
    SELECT account_type, SUM(total_untaxed) AS total,
      SUM(CASE WHEN COALESCE(bodywork_income,0)>0 OR COALESCE(paint_income,0)>0
           THEN total_untaxed ELSE 0 END) AS with_bw,
      SUM(CASE WHEN COALESCE(bodywork_income,0)=0 AND COALESCE(paint_income,0)=0
           THEN total_untaxed ELSE 0 END) AS without_bw
    FROM repair_income WHERE period=$1 AND branch=$2
    GROUP BY account_type
  `, [period, branch]);

  const extRes = await pool.query(`
    SELECT COALESCE(SUM(sale_price_untaxed),0) AS ext
    FROM parts_sales WHERE period=$1 AND branch=$2 AND category=$3
  `, [period, branch, extCat]);

  const ext      = parseFloat(extRes.rows[0]?.ext || 0);
  const findType = kw => riRes.rows.find(r => r.account_type?.includes(kw));
  const gen      = findType('一般');
  const ins      = findType('保險');
  const extW     = findType('延保');
  const vou      = findType('票');

  const bw_ins   = parseFloat(ins?.total     || 0);
  const bw_self  = parseFloat(gen?.with_bw   || 0);
  const bw_tot   = bw_ins + bw_self;
  const ext_rev  = parseFloat(extW?.total    || 0);
  const gen_nobw = parseFloat(gen?.without_bw || 0);
  const vou_tot  = parseFloat(vou?.total     || 0);
  const gen_tot  = gen_nobw + vou_tot + ext;
  const paid_tot = gen_tot + bw_tot + ext_rev;

  return { paid: paid_tot, bodywork: bw_tot, general: gen_tot, extended: ext_rev };
}

// period=YYYYMM → 上一年同月 YYYY-1 MM
function prevYearPeriod(period) {
  const y = parseInt(period.slice(0, 4));
  return `${y - 1}${period.slice(4)}`;
}

// 有沒有上年同月的 DMS 實績可以算
async function hasPrevYearSource(period, branch) {
  const ly = prevYearPeriod(period);
  const r = await pool.query(
    `SELECT 1 FROM repair_income WHERE period=$1 AND branch=$2 LIMIT 1`,
    [ly, branch]
  );
  return r.rowCount > 0;
}

// ── 業績指標：計算某期某廠該指標的實績（可多廠合計）──
async function computePerfActualForMetric(metric, period, branch) {
  const filters  = metric.filters || [];
  const BRANCHES = branch && ['AMA','AMC','AMD'].includes(branch) ? [branch] : ['AMA','AMC','AMD'];
  let total = 0;
  for (const br of BRANCHES) {
    let actual = 0;
    try {
      if (metric.metric_type === 'repair_income') {
        const acTypes = filters.filter(f => f.type === 'account_type').map(f => f.value);
        const c = [`period=$1`, `branch=$2`]; const p = [period, br]; let i = 3;
        if (acTypes.length) { c.push(`account_type=ANY($${i++})`); p.push(acTypes); }
        const r = await pool.query(
          `SELECT COALESCE(SUM(total_untaxed),0) AS v FROM repair_income WHERE ${c.join(' AND ')}`, p
        );
        actual = parseFloat(r.rows[0]?.v || 0);
      } else if (metric.metric_type === 'parts') {
        const cc = filters.filter(f => f.type === 'category_code').map(f => f.value);
        const fc = filters.filter(f => f.type === 'function_code').map(f => f.value);
        const pn = filters.filter(f => f.type === 'part_number').map(f => f.value);
        const pt = filters.filter(f => f.type === 'part_type').map(f => f.value);
        const c = [`period=$1`, `branch=$2`]; const p = [period, br]; let i = 3;
        if (cc.length) { c.push(`category_code=ANY($${i++})`); p.push(cc); }
        if (fc.length) { c.push(`function_code=ANY($${i++})`); p.push(fc); }
        if (pn.length) { c.push(`part_number=ANY($${i++})`);   p.push(pn); }
        if (pt.length) { c.push(`part_type=ANY($${i++})`);     p.push(pt); }
        const fld = metric.stat_field === 'qty' ? 'SUM(sale_qty)'
                  : metric.stat_field === 'count' ? 'COUNT(*)'
                  : 'SUM(sale_price_untaxed)';
        const r = await pool.query(
          `SELECT COALESCE(${fld},0) AS v FROM parts_sales WHERE ${c.join(' AND ')}`, p
        );
        actual = parseFloat(r.rows[0]?.v || 0);
      } else if (metric.metric_type === 'tech_wage') {
        const workCodes = filters.filter(f => f.type === 'work_code');
        const acTypes   = filters.filter(f => f.type === 'account_type').map(f => f.value);
        const c = [`period=$1`, `branch=$2`]; const p = [period, br]; let i = 3;
        if (acTypes.length) { c.push(`account_type=ANY($${i++})`); p.push(acTypes); }
        if (workCodes.length) {
          for (const f of workCodes) {
            if (f.value.includes('-')) {
              const [from, to] = f.value.split('-');
              c.push(`work_code BETWEEN $${i++} AND $${i++}`); p.push(from.trim(), to.trim());
            } else {
              c.push(`work_code=$${i++}`); p.push(f.value);
            }
          }
        }
        const statExpr = metric.stat_field === 'amount' ? 'SUM(wage)'
                       : metric.stat_field === 'hours'  ? 'SUM(standard_hours)'
                       : 'COUNT(DISTINCT work_order)';
        const r = await pool.query(
          `SELECT COALESCE(${statExpr},0) AS v FROM tech_performance WHERE ${c.join(' AND ')}`, p
        );
        actual = parseFloat(r.rows[0]?.v || 0);
      } else if (metric.metric_type === 'boutique') {
        const bt = filters.filter(f => f.type === 'boutique_type').map(f => f.value);
        const ac = filters.filter(f => f.type === 'account_type').map(f => f.value);
        const c = [`ps.period=$1`, `ps.branch=$2`]; const p = [period, br]; let i = 3;
        if (bt.length) { c.push(`pc.part_type=ANY($${i++})`); p.push(bt); }
        else           { c.push(`pc.part_type IN ('精品','配件')`); }
        if (ac.length) { c.push(`ps.part_type=ANY($${i++})`); p.push(ac); }
        const r = await pool.query(
          `SELECT COALESCE(SUM(ps.sale_price_untaxed),0) AS v
           FROM parts_sales ps JOIN parts_catalog pc ON ps.part_number=pc.part_number
           WHERE ${c.join(' AND ')}`, p
        );
        actual = parseFloat(r.rows[0]?.v || 0);
      } else if (metric.metric_type === 'repair_subfield') {
        const VALID_COLS = new Set([
          'bodywork_income','paint_income','engine_wage','parts_income',
          'accessories_income','boutique_income','carwash_income',
          'outsource_income','addon_income','total_untaxed','parts_cost'
        ]);
        const acTypes   = filters.filter(f => f.type === 'account_type').map(f => f.value);
        const subfields = filters.filter(f => f.type === 'subfield' && VALID_COLS.has(f.value)).map(f => f.value);
        const woMode    = filters.find(f => f.type === 'wo_mode')?.value || 'sum';
        if (subfields.length) {
          const p = [period, br]; let i = 3;
          let where = `period=$1 AND branch=$2`;
          if (acTypes.length) { where += ` AND account_type=ANY($${i++})`; p.push(acTypes); }
          let q;
          if (woMode === 'wo_has') {
            const hasCond = subfields.map(c => `COALESCE(${c},0)>0`).join(' OR ');
            q = `SELECT COALESCE(SUM(total_untaxed),0) AS v FROM repair_income WHERE ${where} AND (${hasCond})`;
          } else if (woMode === 'wo_exclude') {
            const excCond = subfields.map(c => `COALESCE(${c},0)=0`).join(' AND ');
            q = `SELECT COALESCE(SUM(total_untaxed),0) AS v FROM repair_income WHERE ${where} AND (${excCond})`;
          } else {
            const sumExpr = subfields.map(c => `COALESCE(${c},0)`).join('+');
            q = `SELECT COALESCE(SUM(${sumExpr}),0) AS v FROM repair_income WHERE ${where}`;
          }
          const r = await pool.query(q, p);
          actual = parseFloat(r.rows[0]?.v || 0);
        }
      }
    } catch (e) { /* ignore, treat as 0 */ }
    total += actual;
  }
  return total;
}

module.exports = {
  computeAllRevenues,
  computePerfActualForMetric,
  prevYearPeriod,
  hasPrevYearSource,
};
