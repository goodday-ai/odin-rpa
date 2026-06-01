// 功能：Admin Rate Inventory Network Probe 的獨立 CLI 入口。
// 責任：載入 Playwright chromium 並執行單次後台房價庫存 network probe，不接入既有 odin-sync、GAS、data branch 或排程。
// 關聯模組：lib/adminRateInventoryProbe/runAdminRateInventoryProbe.js 包含主要流程；package.json script 會呼叫本檔。
// 關鍵流程：require chromium → runAdminRateInventoryProbe → 依 controlled stop / 程式錯誤設定 process.exitCode。

const { chromium } = require("playwright");
const { runAdminRateInventoryProbe } = require("../lib/adminRateInventoryProbe/runAdminRateInventoryProbe");
const { sanitizeAdminRateProbeOutput } = require("../lib/adminRateInventoryProbe/sanitizeAdminRateProbeOutput");

runAdminRateInventoryProbe({ chromium })
  .then((result) => {
    process.exitCode = result.exitCode;
  })
  .catch((error) => {
    console.error("admin_rate_inventory_probe_error", JSON.stringify(sanitizeAdminRateProbeOutput({ stoppedReason: "internal_error", message: String(error.message || error) })));
    process.exitCode = 1;
  });
