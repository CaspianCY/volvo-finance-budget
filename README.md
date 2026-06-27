# volvo-finance-budget

Volvo 服務廠 **全年損益預算編列 / 推估** 網站（精簡獨立版）。

從現有 DMS 平台的同一個 Postgres 讀取實際營收、成本與目標，把「已實現月份的實際」加上「後續月份的推估」組成全年預估，向下延伸到**毛利／營業淨利**，並讓財務在頁面上**編列預算、存成版本**。

## 損益結構

```
營收（四大營收）
− 營業成本
= 毛利（毛利率 = 毛利 / 營收）
− 營業費用
= 營業淨利（淨利率 = 營業淨利 / 營收）
```

## 功能

- **四大營收**（有費 / 鈑烤 / 一般 / 延保）逐月 × 全年。
- **營收實際 + 推估**：已實現月份採 DMS 實際（`repair_income`）；後續月份三種推估法
  - `今年度目標` — `revenue_targets` 月目標
  - `1~N月平均` — 已實現月份平均往後鋪
  - `保守(取低)` — 逐項取目標與平均較低者（反映車市不佳、年度目標難達成）
- **營業成本**：已實現月份預設帶 DMS 料件成本（`repair_income.parts_cost`，**僅含料件、不含工資／外包等**）；
  後續月份以「成本率 ＝ 已實現月份成本 ÷ 營收」乘該月營收推估。編列模式下**所有月份（含已實現）皆可手動覆寫**，
  方便補列 DMS 沒有的工資／外包成本。
- **營業費用**：DMS 無此資料，**全部由財務手動編列**（每月皆可填，含已實現月份），未填以 0 計。
- **毛利 / 毛利率 / 營業淨利 / 淨利率**：依上述結構自動計算，逐月與全年皆顯示。
- **預算編列（版本化）**：後續月份的營收、以及所有月份的營業成本與營業費用可手動編輯並存成獨立版本
  （`revenue_budget_plan`），**不覆蓋**官方月目標；可載回 / 刪除 / 切換版本。實際月份的**營收**永遠以 DMS 為準。
- **匯出 CSV**（完整損益表，含 BOM，Excel 直接開）。

## 資料來源（與 DMS 平台共用同一個 Postgres）

| 表 | 用途 | 本服務 |
|----|------|--------|
| `repair_income`   | 各期各廠實際營收 + 料件成本（`parts_cost`） | 只讀 |
| `revenue_targets` | 各期各廠四大營收月目標 | 只讀 |
| `income_config` / `parts_sales` | 營收歸類輔助 | 只讀 |
| `revenue_budget_plan` | 財務編列的預算版本（含 `cost` / `expense` 欄） | **讀寫**（本服務 init 建立） |

> 因此本服務**不是**全新獨立資料庫，需指向 DMS 平台同一個 Postgres 才有數字。

## 快速開始

```bash
npm install
cp .env.example .env      # 填入 POSTGRES_CONNECTION_STRING
npm start                 # 預設 http://localhost:3000
```

啟動時會自動 `CREATE TABLE IF NOT EXISTS revenue_budget_plan`，並以 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 補上損益用的 `cost` / `expense` 欄（舊資料庫可平滑升級，既有版本資料不受影響；其餘讀取表沿用既有）。

## 確認有沒有連到內網資料庫

| 方式 | 怎麼看 |
|------|--------|
| 啟動 log | 連上印 `[init] revenue_budget_plan ready`；連不上印 `[init] DB 初始化失敗… ECONNREFUSED …` |
| `GET /healthz` | 即時 ping DB。`db_connected:true` ＝ 此刻連得到，並回報 `target`(host:port/db，去敏)、`database`、`db_user`、`server_time`；連不到回 `503` 與 `db_error` |
| `GET /db-check` | 確認連到的是**正確的內網 DMS 庫**：逐表回報 `repair_income / revenue_targets / income_config / parts_sales / revenue_budget_plan` 是否存在與概略筆數，並給 `looks_like_dms`、`has_data` 判斷 |

```bash
curl -s localhost:3000/healthz | jq
curl -s localhost:3000/db-check | jq      # tables 全 exists 且 has_data:true 才是真的接到 DMS
```

> 兩個診斷端點不需登入、不在 `/api` 的就緒閘門後面，DB 還沒起來時也能用來除錯。`target` 只顯示 host/DB，不含帳密。

**前端也有狀態列**：預算頁最上方一進來就自動呼叫 `/db-check`，用紅／黃／綠燈即時顯示有沒有連到資料庫、連到哪顆、DMS 來源表在不在與筆數，並附「🔄 重新檢查」。綠燈＝連上且 DMS 來源就緒；黃燈＝連上但找不到來源表或來源表沒資料（預算頁不會有數字）；紅燈＝連不到。

## 環境變數

| 變數 | 說明 |
|------|------|
| `POSTGRES_CONNECTION_STRING` | 必填，指向 DMS 同一個 Postgres |
| `POSTGRES_SSL` | `false`(預設) / `require` / `strict` |
| `PORT` | 服務埠，預設 `3000` |

## API

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/api/budget-projection?year=&branch=&method=[&version=]` | 全年預估表（含 `pnl` 損益區塊；帶 version 疊加編列值） |
| GET | `/api/budget-projection/compare?year=&branch=` | 三種推估法全年合計並列 |
| GET | `/api/budget-projection/plan?year=&branch=&version=` | 取某版本編列值（含 `cost` / `expense`） |
| GET | `/api/budget-projection/plan/versions?year=&branch=` | 列出版本 |
| PUT | `/api/budget-projection/plan` | 儲存編列版本（`items[]` 每月可帶 `paid/bodywork/general/extended/cost/expense`） |
| DELETE | `/api/budget-projection/plan?year=&branch=&version=` | 刪除版本 |

`branch`：`AMA` / `AMC` / `AMD` / `AME` / `ALL`（四廠合計）。

`GET /api/budget-projection` 回應的 `pnl` 區塊提供逐月與全年的 `revenue / cost / gross / expense / net`、
`cost_ratio`、`gross_margin`、`net_margin`；`basis.cost_actual`（DMS 各月料件成本）與 `basis.cost_ratio`
供前端編列時即時試算。

## 注意

- **無登入 / 無權限控管**：定位為內部財務工具。若要對外，請在反向代理層加存取控管。
- 寫入端點（編列）任何人可呼叫，請勿直接曝露於公網。
