"use strict";

const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  timeout: 240000,
  expect: { timeout: 30000 },

  retries: 1,
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
