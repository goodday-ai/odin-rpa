"use strict";

require("dotenv").config();
const { test, expect } = require("@playwright/test");
const fs = require("fs");
const { format, addDays, parseISO } = require("date-fns");

/**
 * ✅ 功能（多館別輪巡版）：
 * - Playwright 登入 Owlting 後台 → 捕捉 Bearer
 * - 方法二：用 Bearer 列出帳號可管理的所有管別（hotelId / 名稱）
 * - 支援 ODIN_HOTEL_IDS=5720,6323,... 逐館輪巡
 * - 逐館打 calendar_list → 產出 sheet-ready JSON（每館獨立輸出檔）
 *
 * ✅ 重要輸出（全部放在 out/）：
 * - out/odin_me_raw.json
 * - out/odin_hotels_list_raw.json
 * - out/odin_hotels_candidates.json
 * - out/orders_calendar_list_raw_<hotelId>.json
 * - out/orders_sheet_ready_<hotelId>.json
 * - out/orders_sheet_ready_changed_<hotelId>.json（ODIN_CHANGED_ONLY=1）
 * - out/orders_last_snapshot_<hotelId>.json（每館獨立）
 * - out/diag_no_bearer.png（若 Bearer 抓不到）
 */

test("odin capture orders by API (calendar_list -> sheet-ready) [multi-hotel]", async ({ page }) => {
  const email = process.env.ODIN_EMAIL || "";
  const password = process.env.ODIN_PASSWORD || "";
  if (!email || !password) throw new Error("Missing ODIN_EMAIL or ODIN_PASSWORD");

  // ======================
  // ✅ 0) 參數治理
  // ======================
  function taipeiTodayYMD() {
    const dtf = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Taipei",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    });
    return dtf.format(new Date());
  }

  const outDir = (process.env.ODIN_OUT_DIR || "out").trim() || "out";
  fs.mkdirSync(outDir, { recursive: true });

  const startDate = process.env.ODIN_START_DATE || taipeiTodayYMD();
  const daysRaw = Number(process.env.ODIN_DAYS || "90");
  const days = daysRaw === 60 || daysRaw === 90 ? daysRaw : 90;
  const lang = process.env.ODIN_LANG || "zh_tw";

  const listHotelsOnly = String(process.env.ODIN_LIST_HOTELS_ONLY || "0") === "1";

  const excludeCancelled = String(process.env.ODIN_EXCLUDE_CANCELLED || "0") === "1";
  const cancelStatusSet = String(process.env.ODIN_CANCEL_STATUS || "cancelled,canceled,void,invalid")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const changedOnly = String(process.env.ODIN_CHANGED_ONLY || "0") === "1";

  const throttleMsRaw = Number(process.env.ODIN_THROTTLE_MS || "250");
  const throttleMs = Number.isFinite(throttleMsRaw) ? Math.max(0, Math.min(3000, throttleMsRaw)) : 250;

  // 多館別：優先 ODIN_HOTEL_IDS（逗號清單），否則退回 ODIN_HOTEL_ID
  const hotelIdsRaw = String(process.env.ODIN_HOTEL_IDS || "").trim();
  const hotelIdEnv = String(process.env.ODIN_HOTEL_ID || "").trim();

  const hotelIds = hotelIdsRaw
    ? hotelIdsRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : hotelIdEnv
      ? [hotelIdEnv]
      : [];

  // Snapshot 檔名：允許使用者指定模板
  // - 若 ODIN_SNAPSHOT_PATH 含 {hotelId} → 直接替換
  // - 若沒含且為多館別 → 自動在檔名插入 _<hotelId>
  const snapshotPathEnv = String(process.env.ODIN_SNAPSHOT_PATH || "").trim();

  function snapshotPathFor(hotelId) {
    if (snapshotPathEnv) {
      if (snapshotPathEnv.includes("{hotelId}")) return snapshotPathEnv.replace(/\{hotelId\}/g, String(hotelId));
      if (hotelIds.length > 1) {
        const m = snapshotPathEnv.match(/^(.*?)(\.[^.]+)?$/);
        const base = m ? m[1] : snapshotPathEnv;
        const ext = m && m[2] ? m[2] : ".json";
        return `${base}_${hotelId}${ext}`;
      }
      return snapshotPathEnv;
    }
    return `${outDir}/orders_last_snapshot_${hotelId}.json`;
  }
  // ======================

  const loginUrl =
    "https://auth.owlting.com/project/d0b8b1335b7beb195f5f9b7626e83341/login?redirect=https://api.owlting.com/booking/v2/admin/sso";

  // -----------------------------
  // 1) 登入
  // -----------------------------
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

  // -----------------------------
  // 2) 捕捉 Bearer token
  // -----------------------------
  let bearer = "";

  page.on("request", (req) => {
    try {
      const url = req.url();
      if (!/owlting\.com\/booking\/v2\/admin\//i.test(url)) return;

      const h = req.headers();
      const a = h.authorization || h.Authorization || "";
      if (a && typeof a === "string" && a.toLowerCase().startsWith("bearer ")) {
        if (!bearer) bearer = a;
      }
    } catch (_) {}
  });

  await page.waitForTimeout(1200);

  if (!bearer) {
    const probeUrl = `https://www.owlting.com/booking/v2/admin/me?lang=${encodeURIComponent(lang)}&_=${Date.now()}`;
    await page.evaluate(async (u) => {
      try { await fetch(u, { method: "GET", credentials: "include" }); } catch (_) {}
    }, probeUrl);

    for (let i = 0; i < 40; i++) {
      if (bearer) break;
      await page.waitForTimeout(250);
    }
  }

  if (!bearer) {
    await page.screenshot({ path: `${outDir}/diag_no_bearer.png`, fullPage: true });
    throw new Error(`Bearer token not captured. See ${outDir}/diag_no_bearer.png`);
  }

  console.log("✅ bearer captured:", bearer.slice(0, 14) + "***" + bearer.slice(-8));

  const baseHeaders = {
    authorization: bearer,
    "x-requested-with": "XMLHttpRequest",
    accept: "application/json, text/javascript, */*; q=0.01",
    "accept-language": "zh-TW,zh;q=0.9,en;q=0.6"
  };

  fs.writeFileSync(
    `${outDir}/diag_bearer_seen.json`,
    JSON.stringify({ ok: true, bearerMasked: bearer.slice(0, 14) + "***" + bearer.slice(-8) }, null, 2),
    "utf8"
  );

  // -----------------------------
  // 3) ✅ 方法二：列出可管理的管別（hotelId）
  // -----------------------------
  function pushCandidate(out, obj) {
    if (!obj || typeof obj !== "object") return;

    const id = obj.id != null ? String(obj.id) : obj.hotel_id != null ? String(obj.hotel_id) : "";
    if (!id || !/^\d+$/.test(id)) return;

    const name = obj.name != null ? String(obj.name) : obj.hotel_name != null ? String(obj.hotel_name) : "";
    const code = obj.code != null ? String(obj.code) : obj.hotel_code != null ? String(obj.hotel_code) : "";

    const item = { id, name, code };

    const exists = out.find((x) => x && x.id === id);
    if (!exists) out.push(item);
  }

  async function fetchJsonSafe(url, headers) {
    try {
      const r = await page.request.get(url, { headers });
      const s = r.status();
      const j = await r.json().catch(() => ({}));
      return { ok: s === 200, httpStatus: s, json: j, url };
    } catch (e) {
      return { ok: false, httpStatus: 0, json: {}, url, error: String(e && e.message ? e.message : e) };
    }
  }

  async function discoverHotels() {
    const candidates = [];

    const meUrl = `https://www.owlting.com/booking/v2/admin/me?lang=${encodeURIComponent(lang)}&_=${Date.now()}`;
    const meRes = await fetchJsonSafe(meUrl, baseHeaders);
    fs.writeFileSync(`${outDir}/odin_me_raw.json`, JSON.stringify(meRes, null, 2), "utf8");

    try {
      const body = meRes && meRes.json ? meRes.json : {};
      const pool = [];

      if (Array.isArray(body.hotels)) pool.push(...body.hotels);
      if (Array.isArray(body.data && body.data.hotels)) pool.push(...body.data.hotels);
      if (Array.isArray(body.hotel_permissions)) pool.push(...body.hotel_permissions);
      if (Array.isArray(body.data && body.data.hotel_permissions)) pool.push(...body.data.hotel_permissions);
      if (Array.isArray(body.accessible_hotels)) pool.push(...body.accessible_hotels);
      if (Array.isArray(body.data && body.data.accessible_hotels)) pool.push(...body.data.accessible_hotels);

      for (const it of pool) {
        pushCandidate(candidates, it);
        if (it && it.hotel) pushCandidate(candidates, it.hotel);
      }
    } catch (_) {}

    const hotelsUrl = `https://www.owlting.com/booking/v2/admin/hotels?lang=${encodeURIComponent(lang)}&_=${Date.now()}`;
    const hotelsRes = await fetchJsonSafe(hotelsUrl, baseHeaders);
    fs.writeFileSync(`${outDir}/odin_hotels_list_raw.json`, JSON.stringify(hotelsRes, null, 2), "utf8");

    try {
      const body = hotelsRes && hotelsRes.json ? hotelsRes.json : {};
      const pool = [];

      if (Array.isArray(body.data)) pool.push(...body.data);
      if (Array.isArray(body.hotels)) pool.push(...body.hotels);
      if (Array.isArray(body.data && body.data.hotels)) pool.push(...body.data.hotels);

      for (const it of pool) pushCandidate(candidates, it);
    } catch (_) {}

    candidates.sort((a, b) => Number(a.id) - Number(b.id));

    fs.writeFileSync(`${outDir}/odin_hotels_candidates.json`, JSON.stringify({ ok: true, candidates }, null, 2), "utf8");

    console.log("✅ hotels candidates:", candidates.length);
    for (const h of candidates.slice(0, 20)) console.log(" -", h.id, h.name || "(no name)", h.code ? `(${h.code})` : "");
    if (candidates.length > 20) console.log(" ... (more in out/odin_hotels_candidates.json)");

    return candidates;
  }

  const hotels = await discoverHotels();
  const hotelNameById = {};
  for (const h of hotels) hotelNameById[String(h.id)] = String(h.name || "");

  if (listHotelsOnly) {
    console.log("✅ ODIN_LIST_HOTELS_ONLY=1, stop here.");
    return;
  }

  if (!hotelIds.length) {
    console.log("❌ Missing ODIN_HOTEL_IDS or ODIN_HOTEL_ID. See out/odin_hotels_candidates.json");
    throw new Error("Missing ODIN_HOTEL_IDS (or ODIN_HOTEL_ID)");
  }

  // -----------------------------
  // 4) 共用工具：calendar_list → sheet-ready
  // -----------------------------
  function pick(obj, keys) {
    for (const k of keys) {
      if (obj && Object.prototype.hasOwnProperty.call(obj, k) && obj[k] != null) return obj[k];
    }
    return "";
  }

  function toSheetDate(v) {
    const s = String(v || "");
    if (!s) return "";
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.replace(/-/g, "/").slice(0, 10);
    if (/^\d{4}\/\d{2}\/\d{2}/.test(s)) return s.slice(0, 10);
    return s;
  }

  function toAmount(v) {
    if (v == null) return "";
    const s = String(v).replace(/,/g, "").trim();
    return s;
  }

  function getStatusText(it) {
    const v = pick(it, ["status", "order_status", "booking_status", "state", "orderState", "order_state"]);
    if (v == null) return "";
    return String(v).trim().toLowerCase();
  }

  function isCancelledOrder(it) {
    const s = getStatusText(it);
    if (!s) return false;
    if (cancelStatusSet.includes(s)) return true;
    if (s.includes("cancel")) return true;
    return false;
  }

  const columns = ["訂單日期", "訂單編號", "入住日期", "退房日期", "姓名", "房型", "專案名稱", "訂單款項", "已收金額", "剩餘尾款", "UUID", "電話"];

  function stableKey(row) {
    return String(row["訂單編號"] || "");
  }

  function stableSig(row) {
    const parts = [
      row["入住日期"],
      row["退房日期"],
      row["姓名"],
      row["房型"],
      row["專案名稱"],
      row["訂單款項"],
      row["已收金額"],
      row["剩餘尾款"],
      row["電話"]
    ];
    return parts.map((x) => String(x || "")).join("|");
  }

  function readSnapshotSafe(p) {
    try {
      if (!fs.existsSync(p)) return {};
      const j = JSON.parse(fs.readFileSync(p, "utf8"));
      return j && typeof j === "object" ? j : {};
    } catch (_) {
      return {};
    }
  }

  function writeSnapshotSafe(p, mapObj) {
    try { fs.writeFileSync(p, JSON.stringify(mapObj, null, 2), "utf8"); } catch (_) {}
  }

  async function runOneHotel(hotelId) {
    const hotelName = hotelNameById[String(hotelId)] || "";

    const from = parseISO(startDate);
    const to = addDays(from, days - 1);
    const rangeStr = `${format(from, "yyyy-MM-dd")},${format(to, "yyyy-MM-dd")}`;

    const listUrl =
      `https://www.owlting.com/booking/v2/admin/hotels/${encodeURIComponent(hotelId)}/orders/calendar_list` +
      `?lang=${encodeURIComponent(lang)}` +
      `&limit=200` +
      `&page=1` +
      `&order_by=checkin` +
      `&during_checkin_date=${encodeURIComponent(rangeStr)}` +
      `&_=${Date.now()}`;

    const listRes = await page.request.get(listUrl, { headers: baseHeaders });
    const listStatus = listRes.status();
    const listJson = await listRes.json().catch(() => ({}));

    fs.writeFileSync(
      `${outDir}/orders_calendar_list_raw_${hotelId}.json`,
      JSON.stringify({ url: listUrl, httpStatus: listStatus, body: listJson }, null, 2),
      "utf8"
    );

    if (listStatus !== 200 || !listJson || typeof listJson !== "object") {
      throw new Error(`calendar_list failed: hotelId=${hotelId} http=${listStatus}`);
    }
    if (typeof listJson.status === "number" && listJson.status !== 0) {
      throw new Error(`calendar_list not ok: hotelId=${hotelId} body.status=${listJson.status}`);
    }

    const listData = Array.isArray(listJson.data) ? listJson.data : [];
    console.log("✅ calendar_list:", hotelId, hotelName ? `(${hotelName})` : "", "items =", listData.length);

    const rows = [];

    for (const it of listData) {
      const orderSerial = pick(it, ["order_serial", "serial", "orderNo", "order_no", "order_number", "orderNumber"]);
      if (!orderSerial || !String(orderSerial).startsWith("OBE")) continue;

      if (excludeCancelled && isCancelledOrder(it)) continue;

      const row = {
        訂單日期: toSheetDate(pick(it, ["created_at", "createdAt", "order_created_at", "orderDate", "order_date"])),
        訂單編號: String(orderSerial),
        入住日期: toSheetDate(pick(it, ["sdate", "checkin_date", "checkinDate", "check_in"])),
        退房日期: toSheetDate(pick(it, ["edate", "checkout_date", "checkoutDate", "check_out"])),
        姓名: pick(it, ["fullname", "customer_name", "guest_name", "name", "lastname", "firstname"]),
        房型: pick(it, ["room_names", "room_type_name", "roomTypeName", "room_type"]),
        專案名稱: pick(it, ["source", "order_category", "plan_name", "project_name", "rate_plan_name"]),
        訂單款項: toAmount(pick(it, ["total", "total_amount", "amount", "price"])),
        已收金額: toAmount(pick(it, ["paid", "paid_amount"])),
        剩餘尾款: toAmount(pick(it, ["unpaid", "remain", "unpaid_amount"])),
        UUID: pick(it, ["uuid", "order_uuid", "id", "order_id"]),
        電話: pick(it, ["phone", "mobile", "tel", "customer_phone"])
      };

      if (!row.入住日期 || !row.退房日期) continue;
      rows.push(row);
    }

    fs.writeFileSync(
      `${outDir}/orders_sheet_ready_${hotelId}.json`,
      JSON.stringify({ hotelId, hotelName, startDate, days, columns, rows }, null, 2),
      "utf8"
    );

    console.log("✅ wrote:", `${outDir}/orders_sheet_ready_${hotelId}.json`, "rows =", rows.length);

    if (changedOnly) {
      const snapshotPath = snapshotPathFor(hotelId);
      const prev = readSnapshotSafe(snapshotPath);
      const next = {};
      const out = [];

      for (const r of rows) {
        const k = stableKey(r);
        if (!k) continue;
        const sig = stableSig(r);
        next[k] = sig;
        if (!prev[k] || prev[k] !== sig) out.push(r);
      }

      writeSnapshotSafe(snapshotPath, next);

      fs.writeFileSync(
        `${outDir}/orders_sheet_ready_changed_${hotelId}.json`,
        JSON.stringify({ hotelId, hotelName, startDate, days, columns, rows: out }, null, 2),
        "utf8"
      );

      console.log("✅ changedOnly=1:", hotelId, "changed rows =", out.length, "snapshot =", snapshotPath);
    }

    if (!rows.length) {
      console.log("⚠️ rows=0:", hotelId, hotelName ? `(${hotelName})` : "", "可能區間內沒訂單或被過濾");
    }
  }

  // -----------------------------
  // 5) ✅ 多館別輪巡
  // -----------------------------
  console.log("🧭 hotels to run:", hotelIds.join(","));
  for (let i = 0; i < hotelIds.length; i++) {
    const hid = hotelIds[i];
    await runOneHotel(hid);

    if (i < hotelIds.length - 1 && throttleMs > 0) {
      await page.waitForTimeout(throttleMs);
    }
  }

  console.log("✅ done:", hotelIds.length, "hotels");
});
