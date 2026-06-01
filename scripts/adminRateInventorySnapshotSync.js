// 功能：Admin Rate Inventory Snapshot Sync v1 的獨立 CLI 入口。
// 責任：載入 Playwright chromium 並執行 goodday 單品牌價格庫存快照同步，不接 Google Sheet、GAS、LINE 或既有訂單流程。
// 關聯模組：lib/adminRateInventorySnapshot/runRateInventorySnapshotSync.js 包含主要流程；package.json script 會呼叫本檔。
// 關鍵流程：require chromium → runRateInventorySnapshotSync → 依成功/controlled stop/程式錯誤設定 process.exitCode。

const { chromium } = require("playwright");
const { runRateInventorySnapshotSync } = require("../lib/adminRateInventorySnapshot/runRateInventorySnapshotSync");
const { sanitizeAdminRateInventorySnapshot } = require("../lib/adminRateInventoryFetcher/sanitizeAdminRateInventorySnapshot");

runRateInventorySnapshotSync({ chromium })
  .then((result) => {
    process.exitCode = result.exitCode;
  })
  .catch((error) => {
    console.error("admin_rate_inventory_snapshot_sync_error", JSON.stringify(sanitizeAdminRateInventorySnapshot({ stoppedReason: "internal_error", message: String(error.message || error) })));
    process.exitCode = 1;
  });
