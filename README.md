## GAS Web App 範本

本專案提供可直接貼到 Apps Script 的同步腳本：

- `gas/odin_sheet_webapp.gs`

功能包含：

- 電話欄位 (`電話`) 強制純文字（保留前導 `0`）
- Upsert 僅更新有異動的列（同內容會略過）
- 批次更新連續列，降低 Apps Script 寫入次數
- 欄位防呆對齊（依 `columns` 對齊、缺欄補空值）
- 每次手動/排程同步時，更新每個年度分頁 `B1` 為最後更新時間（台北時區）

## 目前「是否只寫異動」的行為

- **GAS 端**：會只更新有差異的既有列，未變更會 `skippedSame`。
- **Playwright 端（`tests/orderDetailCapture.spec.js`）**：當 `ODIN_CHANGED_ONLY=1` 時，會先比對 snapshot，僅把 changed rows POST 到 GAS。
- 即使 changed rows 為 0，仍會送出請求以同步 `cancelledOrderNos`（刪除取消單）與維持流程一致性。
