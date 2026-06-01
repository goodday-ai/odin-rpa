// 功能：Admin Rate Inventory Fetcher Dry Run 的獨立 CLI 入口。
// 責任：載入 Playwright chromium 並執行單次後台 calendars range API dry-run，不接入 odin-sync、GAS、data branch、LINE 或排程。
// 關聯模組：lib/adminRateInventoryFetcher/runAdminRateInventoryFetcherDryRun.js 包含主要流程；package.json script 會呼叫本檔。
// 關鍵流程：require chromium → runAdminRateInventoryFetcherDryRun → 依 controlled stop / 程式錯誤設定 process.exitCode。

const { chromium } = require("playwright");
const { runAdminRateInventoryFetcherDryRun } = require("../lib/adminRateInventoryFetcher/runAdminRateInventoryFetcherDryRun");
const { sanitizeAdminRateInventorySnapshot } = require("../lib/adminRateInventoryFetcher/sanitizeAdminRateInventorySnapshot");

runAdminRateInventoryFetcherDryRun({ chromium })
  .then((result) => {
    process.exitCode = result.exitCode;
  })
  .catch((error) => {
    console.error("admin_rate_inventory_fetcher_dryrun_error", JSON.stringify(sanitizeAdminRateInventorySnapshot({ stoppedReason: "internal_error", message: String(error.message || error) })));
    process.exitCode = 1;
  });
