// 功能：Booking Price Probe 的獨立 CLI 入口，負責載入 Playwright chromium 並執行單次官網價格測試。
// 責任：不使用 storageState、不登入、不設定 authorization header、不接入既有訂單同步流程。
// 關聯模組：lib/bookingPriceProbe/runBookingPriceProbe.js 包含主要流程；package.json script 會呼叫本檔。
// 關鍵流程：require chromium → runBookingPriceProbe → 依 controlled stop / 程式錯誤設定 process.exitCode。

const { chromium } = require("playwright");
const { runBookingPriceProbe } = require("../lib/bookingPriceProbe/runBookingPriceProbe");

runBookingPriceProbe({ chromium })
  .then((result) => {
    process.exitCode = result.exitCode;
  })
  .catch((error) => {
    console.error("booking_price_probe_error", JSON.stringify({ stoppedReason: "internal_error", message: String(error.message || error) }));
    process.exitCode = 1;
  });
