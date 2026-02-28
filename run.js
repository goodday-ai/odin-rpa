"use strict";

const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto("https://example.com", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  await browser.close();
})();
