/**
 * routes/budgetProjection.js   mount: app.use('/api', …)
 * -------------------------------------------------------------
 * 年度營收「全年預估」API（給 budget-projection.html 用）
 *
 *   GET /api/budget-projection?year=2026&branch=AMA&method=target
 *        method: target | average | conservative
 *        → { actual_months, projected_months, rows:{paid,bodywork,...}, totals, basis }
 *
 *   GET /api/budget-projection/compare?year=2026&branch=AMA
 *        → 三種推估法（target / average / conservative）全年合計並列，
 *          方便一眼看出「樂觀目標 vs 平均推估 vs 保守」的差距。
 *
 * 營收來源：repair_income（DMS 實際）+ revenue_targets（今年度目標），
 * 與既有「四大營收」口徑一致。
 */
const router = require('express').Router();
const {
  computeProjection, VALID_METHODS, REAL_BRANCHES,
  getPlan, savePlan, listPlanVersions, deletePlan,
} = require('../lib/budgetProjection');
const { computeBudgetParams } = require('../lib/budgetParams');
const { getWorkdays, saveWorkdays, resetWorkdays } = require('../lib/workdays');

const VALID_BRANCH = new Set([...REAL_BRANCHES, 'ALL']);

// 此模組為財務預算編列用的內部工具：不要求登入、不做廠別存取限制，
// 任何人皆可查看 / 編列任意廠別含四廠合計年份不限（僅做基本 4 位數年份 sanity 檢查）。
const YEAR_MIN = 1990, YEAR_MAX = 2200;

function cleanVersion(v) {
  // 版本名稱：限長度與字元，避免奇怪輸入（中英數 . _ - 空白）
  const s = String(v == null || v === '' ? 'default' : v).trim().slice(0, 50);
  return /^[\w一-龥.\- ]+$/.test(s) ? s : 'default';
}

router.get('/budget-projection', async (req, res) => {
  try {
    const year = parseInt(req.query.year);
    const branch = String(req.query.branch || '').trim().toUpperCase();
    const method = String(req.query.method || 'target').trim();
    const version = req.query.version ? cleanVersion(req.query.version) : null;
    if (!year || year < YEAR_MIN || year > YEAR_MAX) return res.status(400).json({ error: `year 為必填且需介於 ${YEAR_MIN}~${YEAR_MAX}` });
    if (!VALID_BRANCH.has(branch)) return res.status(400).json({ error: 'branch 不在允許清單（AMA/AMC/AMD/AME/ALL）' });
    if (!VALID_METHODS.has(method)) return res.status(400).json({ error: 'method 需為 target / average / conservative / workday / target_pct' });

    // 帶 version 時，把該預算版本的編列值疊在推估上（編過的月份覆寫 method 推估）
    const overrides = version ? await getPlan(year, branch, version) : {};
    // 工作天數推估 / 目標係數法的參數
    const wd = await getWorkdays(year, branch);
    const factor = req.query.factor != null ? parseFloat(req.query.factor) : undefined;
    const result = await computeProjection(year, branch, method, overrides, { workdays: wd.map, factor });
    result.workdays_source = wd.source;
    result.version = version;
    result.has_plan = version ? Object.keys(overrides).length > 0 : false;
    res.json(result);
  } catch (err) {
    console.error('[budget-projection GET]', err);
    res.status(500).json({ error: err.message || '內部錯誤' });
  }
});

// ── 預算參數（從 from~to 月實績反推驅動因子）──
// GET /api/budget-params?year=2026&from=1&to=5&branch=AMA
//   → 工作天數 / 台數 / 單車消費額 / 各項營收金額+占比 / 成本 / 毛利額 / 毛利率
router.get('/budget-params', async (req, res) => {
  try {
    const year = parseInt(req.query.year);
    const branch = String(req.query.branch || '').trim().toUpperCase();
    const from = parseInt(req.query.from || '1');
    const to = parseInt(req.query.to || '5');
    if (!year || year < YEAR_MIN || year > YEAR_MAX) return res.status(400).json({ error: `year 為必填且需介於 ${YEAR_MIN}~${YEAR_MAX}` });
    if (!VALID_BRANCH.has(branch)) return res.status(400).json({ error: 'branch 不在允許清單（AMA/AMC/AMD/AME/ALL）' });
    if (!(from >= 1 && from <= 12) || !(to >= 1 && to <= 12) || from > to) {
      return res.status(400).json({ error: 'from / to 需為 1~12 且 from ≤ to' });
    }
    const project = String(req.query.project || '') === 'workday' ? 'workday' : undefined;
    const result = await computeBudgetParams(year, from, to, branch, { project });
    res.json(result);
  } catch (err) {
    console.error('[budget-params GET]', err);
    res.status(500).json({ error: err.message || '內部錯誤' });
  }
});

// ── 工作天數（每年每廠每月；推估與參數頁共用）──
// GET /api/workdays?year=&branch=   → { year, branch, days:{m:..}, source:{m:'manual'|'calendar'} }
router.get('/workdays', async (req, res) => {
  try {
    const year = parseInt(req.query.year);
    const branch = String(req.query.branch || '').trim().toUpperCase();
    if (!year || year < YEAR_MIN || year > YEAR_MAX) return res.status(400).json({ error: `year 需介於 ${YEAR_MIN}~${YEAR_MAX}` });
    if (!VALID_BRANCH.has(branch)) return res.status(400).json({ error: 'branch 不在允許清單' });
    const wd = await getWorkdays(year, branch);
    res.json({ year, branch, days: wd.map, source: wd.source });
  } catch (err) {
    console.error('[workdays GET]', err);
    res.status(500).json({ error: err.message || '內部錯誤' });
  }
});

// PUT /api/workdays   body:{year,branch,items:[{month,days}]}
router.put('/workdays', async (req, res) => {
  try {
    const { year, branch, items } = req.body || {};
    const y = parseInt(year);
    const br = String(branch || '').trim().toUpperCase();
    if (!y || y < YEAR_MIN || y > YEAR_MAX) return res.status(400).json({ error: `year 需介於 ${YEAR_MIN}~${YEAR_MAX}` });
    if (!VALID_BRANCH.has(br)) return res.status(400).json({ error: 'branch 不在允許清單' });
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items 為必填' });
    if (items.length > 12) return res.status(400).json({ error: 'items 過多（上限 12 筆）' });
    const written = await saveWorkdays(y, br, items);
    res.json({ status: 'ok', written });
  } catch (err) {
    console.error('[workdays PUT]', err);
    res.status(500).json({ error: err.message || '內部錯誤' });
  }
});

// DELETE /api/workdays?year=&branch=&month=   還原某月為月曆預設
router.delete('/workdays', async (req, res) => {
  try {
    const year = parseInt(req.query.year);
    const branch = String(req.query.branch || '').trim().toUpperCase();
    const month = parseInt(req.query.month);
    if (!year || year < YEAR_MIN || year > YEAR_MAX) return res.status(400).json({ error: `year 需介於 ${YEAR_MIN}~${YEAR_MAX}` });
    if (!VALID_BRANCH.has(branch)) return res.status(400).json({ error: 'branch 不在允許清單' });
    if (!(month >= 1 && month <= 12)) return res.status(400).json({ error: 'month 需為 1~12' });
    const deleted = await resetWorkdays(year, branch, month);
    res.json({ status: 'ok', deleted });
  } catch (err) {
    console.error('[workdays DELETE]', err);
    res.status(500).json({ error: err.message || '內部錯誤' });
  }
});

// ── 預算版本（編列）讀寫 ──
// GET    /api/budget-projection/plan?year=&branch=&version=   取某版本編列值
router.get('/budget-projection/plan', async (req, res) => {
  try {
    const year = parseInt(req.query.year);
    const branch = String(req.query.branch || '').trim().toUpperCase();
    const version = cleanVersion(req.query.version);
    if (!year || year < YEAR_MIN || year > YEAR_MAX) return res.status(400).json({ error: `year 需介於 ${YEAR_MIN}~${YEAR_MAX}` });
    if (!VALID_BRANCH.has(branch)) return res.status(400).json({ error: 'branch 不在允許清單' });
    const plan = await getPlan(year, branch, version);
    res.json({ year, branch, version, plan });
  } catch (err) {
    console.error('[budget-projection plan GET]', err);
    res.status(500).json({ error: err.message || '內部錯誤' });
  }
});

// GET    /api/budget-projection/plan/versions?year=&branch=   列出版本
router.get('/budget-projection/plan/versions', async (req, res) => {
  try {
    const year = parseInt(req.query.year);
    const branch = String(req.query.branch || '').trim().toUpperCase();
    if (!year || year < YEAR_MIN || year > YEAR_MAX) return res.status(400).json({ error: `year 需介於 ${YEAR_MIN}~${YEAR_MAX}` });
    if (!VALID_BRANCH.has(branch)) return res.status(400).json({ error: 'branch 不在允許清單' });
    const versions = await listPlanVersions(year, branch);
    res.json({ year, branch, versions });
  } catch (err) {
    console.error('[budget-projection versions GET]', err);
    res.status(500).json({ error: err.message || '內部錯誤' });
  }
});

// PUT    /api/budget-projection/plan   body:{year,branch,version,items:[{month,paid,bodywork,general,extended}]}
router.put('/budget-projection/plan', async (req, res) => {
  try {
    const { year, branch, items } = req.body || {};
    const y = parseInt(year);
    const br = String(branch || '').trim().toUpperCase();
    const version = cleanVersion(req.body?.version);
    if (!y || y < YEAR_MIN || y > YEAR_MAX) return res.status(400).json({ error: `year 需介於 ${YEAR_MIN}~${YEAR_MAX}` });
    if (!VALID_BRANCH.has(br)) return res.status(400).json({ error: 'branch 不在允許清單' });
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items 為必填' });
    if (items.length > 24) return res.status(400).json({ error: 'items 過多（上限 24 筆）' });
    const updatedBy = req.user?.username || 'anonymous';
    const written = await savePlan(y, br, version, items, updatedBy);
    req._audit_detail = `budget-plan save year=${y} branch=${br} version=${version} rows=${written}`;
    res.json({ status: 'ok', year: y, branch: br, version, written });
  } catch (err) {
    console.error('[budget-projection plan PUT]', err);
    res.status(500).json({ error: err.message || '內部錯誤' });
  }
});

// DELETE /api/budget-projection/plan?year=&branch=&version=   刪整個版本
router.delete('/budget-projection/plan', async (req, res) => {
  try {
    const year = parseInt(req.query.year);
    const branch = String(req.query.branch || '').trim().toUpperCase();
    const version = cleanVersion(req.query.version);
    if (!year || year < YEAR_MIN || year > YEAR_MAX) return res.status(400).json({ error: `year 需介於 ${YEAR_MIN}~${YEAR_MAX}` });
    if (!VALID_BRANCH.has(branch)) return res.status(400).json({ error: 'branch 不在允許清單' });
    const deleted = await deletePlan(year, branch, version);
    req._audit_detail = `budget-plan delete year=${year} branch=${branch} version=${version} rows=${deleted}`;
    res.json({ status: 'ok', deleted });
  } catch (err) {
    console.error('[budget-projection plan DELETE]', err);
    res.status(500).json({ error: err.message || '內部錯誤' });
  }
});

// 三法並列比較（全年合計層級）
router.get('/budget-projection/compare', async (req, res) => {
  try {
    const year = parseInt(req.query.year);
    const branch = String(req.query.branch || '').trim().toUpperCase();
    if (!year || year < YEAR_MIN || year > YEAR_MAX) return res.status(400).json({ error: `year 需介於 ${YEAR_MIN}~${YEAR_MAX}` });
    if (!VALID_BRANCH.has(branch)) return res.status(400).json({ error: 'branch 不在允許清單' });

    const methods = ['target', 'average', 'conservative'];
    const results = await Promise.all(methods.map(m => computeProjection(year, branch, m)));
    const compare = {};
    methods.forEach((m, i) => {
      const t = results[i].totals;
      compare[m] = {
        actual_ytd: t.actual_ytd,
        projected_rest: t.projected_rest,
        full_year: t.full_year,
        target_full_year: t.target_full_year,
        gap: t.gap,
        gap_pct: t.gap_pct,
      };
    });
    res.json({
      year, branch,
      actual_months: results[0].actual_months,
      projected_months: results[0].projected_months,
      target_full_year: results[0].totals.target_full_year,
      compare,
    });
  } catch (err) {
    console.error('[budget-projection compare]', err);
    res.status(500).json({ error: err.message || '內部錯誤' });
  }
});

module.exports = router;
