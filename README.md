# odin-rpa

Owlting 房況抓取 Worker（Playwright + GitHub Actions）

## GAS Web App 範本

本專案提供可直接貼到 Apps Script 的同步腳本：

- `gas/odin_sheet_webapp.gs`

功能包含：

- 電話欄位 (`電話`) 強制純文字（保留前導 `0`）
- Upsert 僅更新有異動的列（同內容會略過）
- 批次更新連續列，降低 Apps Script 寫入次數
- 欄位防呆對齊（依 `columns` 對齊、缺欄補空值）
- 每次手動/排程同步時，更新每個年度分頁 `B1` 為最後更新時間（台北時區）

## 目前「是否只寫異動」的注意事項

- **GAS 端**：是，只會更新有差異的既有列，未變更會 `skippedSame`。
- **Playwright 端（`tests/orderDetailCapture.spec.js`）**：目前仍會把當次抓到的 `rows` 全量送到 GAS；不是先在前端只送 changed rows。
- 因此整體上仍有節流效果（GAS 不會重寫相同列），但請求 payload 本身仍是全量。
