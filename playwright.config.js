"use strict";

const { defineConfig } = require("@playwright/test");
const testTimeoutMsRaw = Number(process.env.ODIN_TEST_TIMEOUT_MS || "240000");
const testTimeoutMs = Number.isFinite(testTimeoutMsRaw) ? Math.max(120000, Math.min(1800000, Math.trunc(testTimeoutMsRaw))) : 240000;
// ✅ 中文註解：目前 OWL multi-hotel 同步流程是單一 test case。
// 若啟用 Playwright 自動 retry，任一館失敗都會觸發整輪重跑，短時間重複掃描館別風險較高。
// 因此預設關閉 retry，僅保留 ODIN_TEST_RETRIES 供人工排障時臨時開啟。
const testRetriesRaw = Number(process.env.ODIN_TEST_RETRIES || "0");
const testRetries = Number.isFinite(testRetriesRaw) ? Math.max(0, Math.min(2, Math.trunc(testRetriesRaw))) : 0;

module.exports = defineConfig({
  testDir: "./tests",
  timeout: testTimeoutMs,
  expect: { timeout: 30000 },

  retries: testRetries,
  workers: 1,
  fullyParallel: false,

  reporter: [
    ["line"],
    ["html", { open: "never" }]
  ],

  use: {
    headless: true,
    viewport: { width: 1280, height: 720 },
    actionTimeout: 30000,
    navigationTimeout: 120000,
    screenshot: "only-on-failure",
    video: "off",
    trace: "retain-on-failure"
  },

  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" }
    }
  ]
});
