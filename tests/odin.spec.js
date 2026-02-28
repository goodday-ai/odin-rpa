"use strict";

require("dotenv").config();
const { test, expect } = require("@playwright/test");
const fs = require("fs");
const { format, addDays, parseISO } = require("date-fns");

test("odin login and fetch calendar (route capture headers)", async ({ page }) => {
  const email = process.env.ODIN_EMAIL || "";
  const password = process.env.ODIN_PASSWORD || "";
  if (!email || !password) throw new Error("Missing ODIN_EMAIL or ODIN_PASSWORD in .env");

  // ====== 可調整參數 ======
  const hotelId = "5720";
  const startDate = "2026-02-27";
  const days = 60;
  const lang = "en";
  // =======================

  // ✅ 在任何 navigation 之前就先掛攔截（避免錯過最早的 request）
  const calendarPattern = new RegExp(`/booking/v2/admin/hotels/${hotelId}/room_configs/calendar\\?`, "i");
  let capturedHeaders = null;
  let capturedUrl = "";

  await page.route("**/*", async (route) => {
    try {
      const req = route.request();
      const url = req.url();

      if (!capturedHeaders && calendarPattern.test(url)) {
        capturedHeaders = req.headers();
        capturedUrl = url;

        // 只留必要 header（避免超長）
        const h = capturedHeaders || {};
        const keep = {
          authorization: h.authorization || "",
          referer: h.referer || "",
          "accept-language": h["accept-language"] || "",
          "x-requested-with": h["x-requested-with"] || "",
          accept: h.accept || ""
        };

        fs.writeFileSync("calendar_probe.json", JSON.stringify({ url: capturedUrl, headers: keep }, null, 2), "utf8");
        console.log("✅ route captured calendar headers -> calendar_probe.json");
      }
    } catch (_) {}

    await route.continue();
  });

  // 1) 登入
  const loginUrl =
    "https://auth.owlting.com/project/d0b8b1335b7beb195f5f9b7626e83341/login?redirect=https://api.owlting.com/booking/v2/admin/sso";

  await page.goto(loginUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[type="password"]', { timeout: 60000 });

  await page.getByRole("textbox", { name: "Email" }).fill(email);
  await page.locator('input[type="password"]').first().fill(password);

  const loginBtn = page.locator('button:has-text("登入"), button[type="submit"], input[type="submit"]').first();

  await Promise.all([
    page.waitForURL(/owlting\.com\/booking\/admin/i, { timeout: 120000 }),
    loginBtn.click()
  ]);

  await expect(page).toHaveURL(/owlting\.com\/booking\/admin/i);

  // 2) 觸發 calendar（不靠 UI 文字，直接把使用者導到 dashboard 後等它載入）
  await page.waitForTimeout(3000);

  // 如果後台沒有自動打 calendar，我們用「頁面內 fetch」強制觸發一次 request
  if (!capturedHeaders) {
    const probeDate = format(parseISO(startDate), "yyyy-MM-dd");
    const probeUrl = `https://www.owlting.com/booking/v2/admin/hotels/${hotelId}/room_configs/calendar?date=${encodeURIComponent(probeDate)}&lang=${encodeURIComponent(lang)}`;

    await page.evaluate(async (u) => {
      try {
        await fetch(u, { method: "GET", credentials: "include" });
      } catch (_) {}
    }, probeUrl);

    // 給 route 一點時間吃到 request
    for (let i = 0; i < 10; i++) {
      if (capturedHeaders) break;
      await page.waitForTimeout(500);
    }
  }

  if (!capturedHeaders) {
    await page.screenshot({ path: "admin_no_calendar_request.png", fullPage: true });
    throw new Error("Did not capture calendar REQUEST headers. See admin_no_calendar_request.png");
  }

  // 3) 用捕捉到的 headers 重播抓資料
  const h = capturedHeaders || {};
  const replayHeaders = {
    authorization: h.authorization || "",
    "x-requested-with": h["x-requested-with"] || "XMLHttpRequest",
    accept: h.accept || "application/json, text/javascript, */*; q=0.01",
    "accept-language": h["accept-language"] || "en-US",
    referer: h.referer || "https://www.owlting.com/booking/admin/"
  };

  if (!replayHeaders.authorization) {
    fs.writeFileSync("probe_headers_full.json", JSON.stringify(capturedHeaders, null, 2), "utf8");
    throw new Error("Captured calendar request but missing authorization header. See probe_headers_full.json");
  }

  const base = `https://www.owlting.com/booking/v2/admin/hotels/${hotelId}/room_configs/calendar`;
  const from = parseISO(startDate);
  const results = [];

  for (let i = 0; i < days; i++) {
    const d = addDays(from, i);
    const dateStr = format(d, "yyyy-MM-dd");
    const url = `${base}?date=${encodeURIComponent(dateStr)}&lang=${encodeURIComponent(lang)}`;

    const r = await page.request.get(url, { headers: replayHeaders });
    const status = r.status();
    const json = await r.json().catch(() => ({}));

    results.push({ date: dateStr, ok: status === 200 && json && json.status === 0, status, data: json });

    await page.waitForTimeout(250);
  }

  const outName = `calendar_raw_${startDate}_plus${days}d.json`;
  fs.writeFileSync(outName, JSON.stringify({ hotelId, startDate, days, lang, results }, null, 2), "utf8");
  console.log("✅ wrote", outName);
});
