// 功能：Admin Rate Inventory Fetcher Dry Run 的獨立 CLI 入口。
// 責任：載入 Playwright chromium 並依 ADMIN_RATE_FETCHER_TENANT 執行單品牌或 ALL sequential dry-run，不接入 odin-sync、GAS、data branch、LINE 或排程。
// 關聯模組：lib/adminRateInventoryFetcher/runAdminRateInventoryFetcherDryRun.js 處理單品牌；runAdminRateInventoryBatchDryRun.js 處理 ALL 多品牌盤點；package.json script 會呼叫本檔。
// 關鍵流程：require chromium → 判斷 tenant=ALL → run single/batch dry-run → 依 controlled stop / 程式錯誤設定 process.exitCode。

const { chromium } = require("playwright");
const { runAdminRateInventoryFetcherDryRun } = require("../lib/adminRateInventoryFetcher/runAdminRateInventoryFetcherDryRun");
const { runAdminRateInventoryBatchDryRun } = require("../lib/adminRateInventoryFetcher/runAdminRateInventoryBatchDryRun");
const { sanitizeAdminRateInventorySnapshot } = require("../lib/adminRateInventoryFetcher/sanitizeAdminRateInventorySnapshot");

const runner = String(process.env.ADMIN_RATE_FETCHER_TENANT || "").trim().toUpperCase() === "ALL"
  ? runAdminRateInventoryBatchDryRun
  : runAdminRateInventoryFetcherDryRun;

runner({ chromium })
  .then((result) => {
    process.exitCode = result.exitCode;
  })
  .catch((error) => {
    console.error("admin_rate_inventory_fetcher_dryrun_error", JSON.stringify(sanitizeAdminRateInventorySnapshot({ stoppedReason: "internal_error", message: String(error.message || error) })));
    process.exitCode = 1;
  });
