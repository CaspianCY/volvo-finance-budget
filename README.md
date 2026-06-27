# volvo-finance-budget

Volvo 服務廠 **全年營收預算編列 / 推估** 網站（精簡獨立版）。

從現有 DMS 平台的同一個 Postgres 讀取實際營收與目標，把「已實現月份的實際」加上「後續月份的推估」組成全年預估，並讓財務在頁面上**編列預算、存成版本**。

## 功能

- **四大營收**（有費 / 鈑烤 / 一般 / 延保）逐月 × 全年。
- **實際 + 推估**：已實現月份採 DMS 實際（`repair_income`）；後續月份三種推估法
  - `今年度目標` — `revenue_targets` 月目標
  - `1~N月平均` — 已實現月份平均往後鋪
  - `保守(取低)` — 逐項取目標與平均較低者（反映車市不佳、年度目標難達成）
- **預算編列（版本化）**：後續月份可手動編輯並存成獨立版本（`revenue_budget_plan`），
  **不覆蓋**官方月目標；可載回 / 刪除 / 切換版本。實際月份永遠以 DMS 為準。
- **匯出 CSV**（含 BOM，Excel 直接開）。

## 資料來源（與 DMS 平台共用同一個 Postgres）

| 表 | 用途 | 本服務 |
|----|------|--------|
| `repair_income`   | 各期各廠實際營收 | 只讀 |
| `revenue_targets` | 各期各廠四大營收月目標 | 只讀 |
| `income_config` / `parts_sales` | 營收歸類輔助 | 只讀 |
| `revenue_budget_plan` | 財務編列的預算版本 | **讀寫**（本服務 init 建立） |

> 因此本服務**不是**全新獨立資料庫，需指向 DMS 平台同一個 Postgres 才有數字。

## 快速開始

```bash
npm install
cp .env.example .env      # 填入 POSTGRES_CONNECTION_STRING
npm start                 # 預設 http://localhost:3000
```

啟動時會自動 `CREATE TABLE IF NOT EXISTS revenue_budget_plan`（其餘讀取表沿用既有）。

## 環境變數

| 變數 | 說明 |
|------|------|
| `POSTGRES_CONNECTION_STRING` | 必填，指向 DMS 同一個 Postgres |
| `POSTGRES_SSL` | `false`(預設) / `require` / `strict` |
| `PORT` | 服務埠，預設 `3000` |

## API

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/api/budget-projection?year=&branch=&method=[&version=]` | 全年預估表（帶 version 疊加編列值） |
| GET | `/api/budget-projection/compare?year=&branch=` | 三種推估法全年合計並列 |
| GET | `/api/budget-projection/plan?year=&branch=&version=` | 取某版本編列值 |
| GET | `/api/budget-projection/plan/versions?year=&branch=` | 列出版本 |
| PUT | `/api/budget-projection/plan` | 儲存編列版本 |
| DELETE | `/api/budget-projection/plan?year=&branch=&version=` | 刪除版本 |

`branch`：`AMA` / `AMC` / `AMD` / `AME` / `ALL`（四廠合計）。

## 注意

- **無登入 / 無權限控管**：定位為內部財務工具。若要對外，請在反向代理層加存取控管。
- 寫入端點（編列）任何人可呼叫，請勿直接曝露於公網。
