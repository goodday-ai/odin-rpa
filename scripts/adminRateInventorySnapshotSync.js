// 功能：Admin Rate Inventory Snapshot Sync v1 的獨立 CLI 入口。
// 責任：載入 Playwright chromium，依 RATE_INVENTORY_TENANT 執行單品牌或 tenant=ALL sequential 價格庫存快照同步，不接 Google Sheet、GAS、LINE 或既有訂單流程。
// 關聯模組：lib/adminRateInventorySnapshot/runRateInventorySnapshotSync.js 與 runRateInventorySnapshotBatchSync.js 包含主要流程；package.json script 會呼叫本檔。
// 關鍵流程：require chromium → 判斷 tenant=ALL → run single/batch sync → 依成功/controlled stop/程式錯誤設定 process.exitCode。

const { chromium } = require("playwright");
const { runRateInventorySnapshotSync } = require("../lib/adminRateInventorySnapshot/runRateInventorySnapshotSync");
const { runRateInventorySnapshotBatchSync } = require("../lib/adminRateInventorySnapshot/runRateInventorySnapshotBatchSync");
const { sanitizeAdminRateInventorySnapshot } = require("../lib/adminRateInventoryFetcher/sanitizeAdminRateInventorySnapshot");

const isAllTenantMode = String(process.env.RATE_INVENTORY_TENANT || "").trim().toUpperCase() === "ALL";
const runner = isAllTenantMode ? runRateInventorySnapshotBatchSync : runRateInventorySnapshotSync;

runner({ chromium })
  .then((result) => {
    process.exitCode = result.exitCode;
  })
  .catch((error) => {
    console.error("admin_rate_inventory_snapshot_sync_error", JSON.stringify(sanitizeAdminRateInventorySnapshot({ stoppedReason: "internal_error", message: String(error.message || error) })));
    process.exitCode = 1;
  });
