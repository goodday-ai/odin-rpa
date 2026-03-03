"use strict";

require("dotenv").config();
const { test, expect } = require("@playwright/test");
const fs = require("fs");
const { format, addDays, parseISO, isValid } = require("date-fns");

/**
 * ✅ 功能（多館別輪巡版）：
 * - Playwright 登入 Owlting 後台 → 捕捉 Bearer
 * - 方法二：用 Bearer 列出帳號可管理的所有管別（hotelId / 名稱）
 * - 支援 ODIN_HOTEL_IDS=5720,6323,... 逐館輪巡
 * - 逐館打 calendar_list → 產出 sheet-ready JSON（每館獨立輸出檔）
 * - ✅ 策略一：每館產出後立即 POST 到 GAS Web App → 寫入 Google Sheet（依入住年份建分頁、訂單編號 upsert）
 *
 * ✅ 升級點（對應你截圖）：
 * - ✅ 全年度模式：ODIN_YEAR=2026 → during_checkin_date=2026-01-01,2026-12-31
 * - ✅ 訂單狀態：ODIN_ORDER_STATUS=normal（UI「已成立」常見對應 normal）
 * - ✅ 排序：年度模式預設 order_by=id + sort_by=asc（可用 env 覆寫）
 * - ✅ 自動翻頁：依 pagination.total_pages 把所有頁抓完（limit=200 減少頁數）
 *
 * ✅ 取消單刪除（重要）：
 * - 第一輪常用 ODIN_ORDER_STATUS=normal → API 多半不會回傳取消單
 * - ✅ 新增第二輪掃描：ODIN_CANCEL_SCAN=1 時，會用 ODIN_CANCEL_ORDER_STATUS 清單再抓一次取消單
 * - 只收集 cancelledOrderNos，並一併 POST 給 GAS 讓 GAS 刪掉 Sheet 舊資料
 *
 * ✅ 重要輸出（全部放在 out/）：
 * - out/odin_me_raw.json
 * - out/odin_hotels_list_raw.json
 * - out/odin_hotels_candidates.json
 * - out/orders_calendar_list_raw_<hotelId>_p<page>.json（每頁都留存，方便你追查）
 * - out/orders_calendar_list_cancel_<hotelId>_<status>_p<page>.json（取消掃描用）
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
    return dtf.format(new Date()); // yyyy-mm-dd
  }

  function clampInt(n, min, max, fallback) {
    const x = Number(n);
    if (!Number.isFinite(x)) return fallback;
    const v = Math.trunc(x);
    if (v < min) return min;
    if (v > max) return max;
    return v;
  }

  function isYearString(s) {
    const t = String(s || "").trim();
    if (!/^\d{4}$/.test(t)) return false;
    const y = Number(t);
    return y >= 2000 && y <= 2100;
  }

  const outDir = (process.env.ODIN_OUT_DIR || "out").trim() || "out";
  fs.mkdirSync(outDir, { recursive: true });

  // ✅ 年度模式：ODIN_YEAR=2026 → 自動抓 2026-01-01 ~ 2026-12-31（忽略 ODIN_DAYS）
  const yearEnv = String(process.env.ODIN_YEAR || "").trim();
  const useYearMode = isYearString(yearEnv);

  const startDate = String(process.env.ODIN_START_DATE || taipeiTodayYMD()).trim() || taipeiTodayYMD();
  const startDateISO = parseISO(startDate);
  if (!isValid(startDateISO)) throw new Error(`Invalid ODIN_START_DATE: ${startDate} (expect YYYY-MM-DD)`);

  // ✅ ODIN_DAYS：支援 1~180（年度模式會忽略）
  const days = clampInt(process.env.ODIN_DAYS || "90", 1, 180, 90);

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

  const fetchDetail = String(process.env.ODIN_FETCH_DETAIL || "1") === "1"; // ✅ 取訂單 detail 補「專案名稱(方案/Plan)」
  const detailThrottleMsRaw = Number(process.env.ODIN_DETAIL_THROTTLE_MS || "0");
  const detailThrottleMs = Number.isFinite(detailThrottleMsRaw) ? Math.max(0, Math.min(3000, detailThrottleMsRaw)) : 0;

  // ✅ 策略一（寫入 Sheet）：GAS Web App
  const writeSheet = String(process.env.ODIN_WRITE_SHEET || "0") === "1";

  // ✅ 第二輪：取消單掃描（只收 cancelledOrderNos）
  // - 只有開 ODIN_CANCEL_SCAN=1 才會跑
  // - 例：ODIN_CANCEL_ORDER_STATUS=cancelled,void,invalid
  const cancelScan = String(process.env.ODIN_CANCEL_SCAN || "0") === "1";
  const cancelOrderStatusList = String(process.env.ODIN_CANCEL_ORDER_STATUS || "cancelled,void,invalid")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // --- URL 治理：去空白/去引號/診斷資訊（不洩漏內容） ---
  function _normalizeUrl_(raw) {
    let s = String(raw || "").trim();
    s = s.replace(/^"+/, "").replace(/"+$/, "");
    s = s.replace(/^'+/, "").replace(/'+$/, "");
    return s;
  }

  function _urlDiag_(raw) {
    const s = String(raw || "");
    return {
      len: s.length,
      trimmedLen: s.trim().length,
      hasSpace: /\s/.test(s),
      hasNewline: /[\r\n]/.test(s),
      head: s.slice(0, 12),
      tail: s.slice(-12)
    };
  }

  function _assertValidGasUrl_(raw) {
    const gasUrl = _normalizeUrl_(raw);
    const diag = _urlDiag_(raw);

    if (!gasUrl) {
      throw new Error(
        "Missing ODIN_SHEET_WEBAPP_URL.\n" +
        "Fix: GitHub Secrets → ODIN_SHEET_WEBAPP_URL 必須是完整 https URL，且結尾為 /exec。\n" +
        `Diag: ${JSON.stringify(diag)}`
      );
    }

    let u;
    try {
      u = new URL(gasUrl);
    } catch (_) {
      throw new Error(
        "Invalid ODIN_SHEET_WEBAPP_URL (cannot be parsed as URL).\n" +
        "Fix: 請移除空白/換行/引號，格式應類似 https://script.google.com/macros/s/.../exec\n" +
        `Diag: ${JSON.stringify(diag)}`
      );
    }

    if (u.protocol !== "https:") {
      throw new Error(
        "Invalid ODIN_SHEET_WEBAPP_URL (protocol must be https).\n" +
        `Got: ${u.protocol}\n` +
        `Diag: ${JSON.stringify(diag)}`
      );
    }

    if (!/\/exec$/.test(u.pathname)) {
      throw new Error(
        "Invalid ODIN_SHEET_WEBAPP_URL (must end with /exec).\n" +
        `Got pathname: ${u.pathname}\n` +
        `Diag: ${JSON.stringify(diag)}`
      );
    }

    return gasUrl;
  }

  const gasUrlRaw = String(process.env.ODIN_SHEET_WEBAPP_URL || "");
  const sheetToken = String(process.env.ODIN_SHEET_TOKEN || "").trim();
  const spreadsheetId = String(process.env.ODIN_SPREADSHEET_ID || "").trim();

  // ✅ 訂單狀態（你截圖「已成立」）：常見對應 order_status=normal
  const orderStatus = String(process.env.ODIN_ORDER_STATUS || "normal").trim(); // UI「已成立」在 DevTools 常見對應 normal
  const orderBy = String(process.env.ODIN_ORDER_BY || (useYearMode ? "id" : "checkin")).trim();
  const sortBy = String(process.env.ODIN_SORT_BY || (useYearMode ? "asc" : "")).trim();

  // 多館別：優先 ODIN_HOTEL_IDS（逗號清單），否則退回 ODIN_HOTEL_ID
  const hotelIdsRaw = String(process.env.ODIN_HOTEL_IDS || "").trim();
  const hotelIdEnv = String(process.env.ODIN_HOTEL_ID || "").trim();

  const hotelIds = hotelIdsRaw
    ? hotelIdsRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : hotelIdEnv
      ? [hotelIdEnv]
      : [];

  // Snapshot 檔名：允許使用者指定模板
  const snapshotPathEnv = String(process.env.ODIN_SNAPSHOT_PATH || "").trim();

  function normalizeSnapshotPath(p) {
    if (!p) return "";
    if (!p.startsWith("/") && !p.includes(":/") && !p.startsWith(outDir + "/")) return `${outDir}/${p}`;
    return p;
  }

  function snapshotPathFor(hotelId) {
    if (snapshotPathEnv) {
      const baseInput = normalizeSnapshotPath(snapshotPathEnv);

      if (baseInput.includes("{hotelId}")) return baseInput.replace(/\{hotelId\}/g, String(hotelId));

      if (hotelIds.length > 1) {
        const m = baseInput.match(/^(.*?)(\.[^.]+)?$/);
        const base = m ? m[1] : baseInput;
        const ext = m && m[2] ? m[2] : ".json";
        return `${base}_${hotelId}${ext}`;
      }

      return baseInput;
    }

    return `${outDir}/orders_last_snapshot_${hotelId}.json`;
  }

  console.log(
    "🧾 sheet write mode:",
    writeSheet ? "ON" : "OFF",
    "| gasUrl=",
    String(gasUrlRaw || "").trim() ? "set" : "missing",
    "| sheetToken=",
    sheetToken ? "set" : "missing",
    "| spreadsheetId=",
    spreadsheetId ? "set" : "missing",
    "| mode=",
    useYearMode ? `YEAR(${yearEnv})` : `DAYS(${days})`,
    "| order_status=",
    orderStatus || "(empty)",
    "| order_by=",
    orderBy || "(empty)",
    "| sort_by=",
    sortBy || "(empty)",
    "| cancelScan=",
    cancelScan ? `ON(${cancelOrderStatusList.join(",") || "empty"})` : "OFF"
  );

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

  // =======================================================
  // ✅ 訂單 detail：取真實「方案/Plan 名稱」當作「專案名稱」
  // =======================================================
  function _uniqNonEmpty_(arr) {
    const out = [];
    const seen = new Set();
    for (const v of Array.isArray(arr) ? arr : []) {
      const s = String(v == null ? "" : v).trim();
      if (!s) continue;
      if (seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }
    return out;
  }

  function extractProjectNameFromDetail(detailJson) {
    const d = detailJson && detailJson.data ? detailJson.data : null;
    if (!d) return "";

    const rooms = Array.isArray(d.rooms) ? d.rooms : [];
    const planNames = _uniqNonEmpty_(rooms.map(r => r && r.plan_name ? r.plan_name : ""));
    if (planNames.length) return planNames.join("｜");

    const roomNames = _uniqNonEmpty_(rooms.map(r => r && r.room_name ? r.room_name : ""));
    if (roomNames.length) return roomNames.join("｜");

    return "";
  }

  function extractRoomTypeFromDetail(detailJson) {
    const d = detailJson && detailJson.data ? detailJson.data : null;
    if (!d) return "";

    const rooms = Array.isArray(d.rooms) ? d.rooms : [];
    const cfgNames = _uniqNonEmpty_(rooms.map(r => r && r.room_config_name ? r.room_config_name : ""));
    if (cfgNames.length) return cfgNames.join("｜");

    return "";
  }

  async function fetchOrderDetail(hotelId, orderSerial, headers) {
    const url = `https://www.owlting.com/booking/v2/admin/hotels/${hotelId}/orders/${encodeURIComponent(orderSerial)}/detail?lang=zh_TW&_=${Date.now()}`;
    return fetchJsonSafe(url, headers);
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
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function pick(obj, keys) {
    for (const k of keys) {
      if (obj && Object.prototype.hasOwnProperty.call(obj, k) && obj[k] != null) return obj[k];
    }
    return "";
  }

  function toSheetDate(v) {
    const s = String(v || "").trim();
    if (!s) return "";

    // 統一轉成 yyyy/MM/dd，避免同欄位同時出現 - 與 /
    const m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
    if (m) {
      const y = m[1];
      const mm = m[2].padStart(2, "0");
      const dd = m[3].padStart(2, "0");
      return `${y}/${mm}/${dd}`;
    }

    return s;
  }

  function toAmount(v) {
    if (v == null) return "";
    return String(v).replace(/,/g, "").trim();
  }

  // ✅ 電話正規化：
  // - 去除：所有空格、以及「-」
  // - 開頭是 +886 / 886：轉成 0 開頭
  // - 若轉換後變成 00 開頭：刪掉第一個 0（避免 00xxxxxxxx）
  function normalizePhone(raw) {
    let s = String(raw == null ? "" : raw).trim();
    if (!s) return "";

    s = s.replace(/[\s-]+/g, "");

    if (s.startsWith("+886")) s = "0" + s.slice(4);
    if (s.startsWith("886")) s = "0" + s.slice(3);

    if (s.startsWith("00")) s = s.slice(1);

    return s;
  }

  // ✅ 取消單判斷：只看「明確欄位/旗標」
  function getStatusText(it) {
    const v = pick(it, [
      "status",
      "order_status",
      "booking_status",
      "state",
      "orderState",
      "order_state",
      "status_text",
      "order_status_text",
      "booking_status_text"
    ]);
    if (v == null) return "";
    return String(v).trim().toLowerCase();
  }

  function isCancelledOrder(it) {
    const s = getStatusText(it);
    if (s) {
      if (cancelStatusSet.includes(s)) return true;
      if (s.includes("cancel")) return true;
      if (s.includes("void")) return true;
      if (s.includes("invalid")) return true;
      if (s.includes("取消")) return true;
      if (s.includes("作廢")) return true;
    }

    const flag = pick(it, ["is_cancelled", "is_canceled", "cancelled", "canceled", "voided", "is_void"]);
    if (flag === true || String(flag).toLowerCase() === "true") return true;

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

  async function syncToSheetOrThrow(payload, hotelId, hotelName) {
    if (!writeSheet) return;

    if (!sheetToken) throw new Error("Missing ODIN_SHEET_TOKEN (GitHub Secrets)");
    if (!spreadsheetId) throw new Error("Missing ODIN_SPREADSHEET_ID (GitHub Secrets)");

    const gasUrl = _assertValidGasUrl_(gasUrlRaw);

    let resp;
    try {
      resp = await page.request.post(gasUrl, {
        data: payload,
        headers: { "content-type": "application/json" }
      });
    } catch (e) {
      const diag = _urlDiag_(gasUrlRaw);
      throw new Error(
        `GAS POST failed (request error): hotelId=${hotelId}\n` +
        "Fix: ODIN_SHEET_WEBAPP_URL 可能含空白/換行/引號，或不是 /exec。\n" +
        `Diag: ${JSON.stringify(diag)}\n` +
        `Err: ${String(e && e.message ? e.message : e)}`
      );
    }

    const http = resp.status();
    const text = await resp.text().catch(() => "");

    let j = null;
    try { j = JSON.parse(text); } catch (_) {}

    if (http < 200 || http >= 300) {
      throw new Error(
        `GAS sync failed: hotelId=${hotelId} http=${http}\n` +
        "Tip: 去 Apps Script → Executions 看伺服端錯誤\n" +
        `Body: ${text.slice(0, 800)}`
      );
    }

    if (!j || j.ok !== true) {
      throw new Error(
        `GAS sync not ok: hotelId=${hotelId} http=${http}\n` +
        `Body: ${text.slice(0, 800)}`
      );
    }
    // ✅ 加在這裡（通過 ok 檢查後，印回傳內容）
    console.log("📦 GAS resp:", text.slice(0, 1200));
    console.log("✅ sheet synced:", hotelId, hotelName ? `(${hotelName})` : "");
  }

  function buildRangeStr() {
    if (useYearMode) {
      const y = Number(yearEnv);
      return `${y}-01-01,${y}-12-31`;
    }

    const from = startDateISO;
    const to = addDays(from, days - 1);
    return `${format(from, "yyyy-MM-dd")},${format(to, "yyyy-MM-dd")}`;
  }

  function buildListUrl(hotelId, pageNo, rangeStr, orderStatusOverride) {
    const listLimit = 200;

    const status = orderStatusOverride != null ? String(orderStatusOverride).trim() : String(orderStatus || "").trim();

    return (
      `https://www.owlting.com/booking/v2/admin/hotels/${encodeURIComponent(hotelId)}/orders/calendar_list` +
      `?lang=${encodeURIComponent(lang)}` +
      `&limit=${listLimit}` +
      `&page=${encodeURIComponent(String(pageNo))}` +
      (status ? `&order_status=${encodeURIComponent(status)}` : ``) +
      `&order_by=${encodeURIComponent(orderBy || "checkin")}` +
      (sortBy ? `&sort_by=${encodeURIComponent(sortBy)}` : ``) +
      `&during_checkin_date=${encodeURIComponent(rangeStr)}` +
      `&_=${Date.now()}`
    );
  }

  async function runOneHotel(hotelId) {
    const hotelName = hotelNameById[String(hotelId)] || "";
    const rangeStr = buildRangeStr();

    const rows = [];
    const cancelledOrderNos = [];
    let pageNo = 1;
    let totalPages = 1;

    const cancelledSkipped = { count: 0 };

    const detailCache = new Map();
    const roomTypeCache = new Map();

    // -----------------------------
    // ✅ 第一輪：依 ODIN_ORDER_STATUS 抓「主要訂單」
    // -----------------------------
    while (pageNo <= totalPages) {
      const listUrl = buildListUrl(hotelId, pageNo, rangeStr);

      const listRes = await page.request.get(listUrl, { headers: baseHeaders });
      const listStatus = listRes.status();
      const listJson = await listRes.json().catch(() => ({}));

      fs.writeFileSync(
        `${outDir}/orders_calendar_list_raw_${hotelId}_p${pageNo}.json`,
        JSON.stringify({ url: listUrl, httpStatus: listStatus, body: listJson }, null, 2),
        "utf8"
      );

      if (listStatus !== 200 || !listJson || typeof listJson !== "object") {
        throw new Error(`calendar_list failed: hotelId=${hotelId} page=${pageNo} http=${listStatus}`);
      }
      if (typeof listJson.status === "number" && listJson.status !== 0) {
        throw new Error(`calendar_list not ok: hotelId=${hotelId} page=${pageNo} body.status=${listJson.status}`);
      }

      const pg = listJson.pagination && typeof listJson.pagination === "object" ? listJson.pagination : {};
      const tp = pg.total_pages != null ? Number(pg.total_pages) : 1;
      totalPages = Number.isFinite(tp) && tp > 0 ? tp : 1;

      const listData = Array.isArray(listJson.data) ? listJson.data : [];
      console.log("✅ calendar_list:", hotelId, hotelName ? `(${hotelName})` : "", `page=${pageNo}/${totalPages}`, "items =", listData.length);

      for (const it of listData) {
        const orderSerial = pick(it, ["order_serial", "serial", "orderNo", "order_no", "order_number", "orderNumber"]);
        if (!orderSerial || !String(orderSerial).startsWith("OBE")) continue;

        const cancelled = isCancelledOrder(it);
        if (cancelled) cancelledOrderNos.push(String(orderSerial));

        if (excludeCancelled && cancelled) {
          cancelledSkipped.count++;
          continue;
        }

        let projectName = pick(it, ["plan_name", "project_name", "rate_plan_name", "source", "order_category"]);

        let roomType = "";
        if (fetchDetail) {
          const key = String(orderSerial);

          if (detailCache.has(key)) projectName = detailCache.get(key);
          if (roomTypeCache.has(key)) roomType = roomTypeCache.get(key);

          if (!detailCache.has(key) || !roomTypeCache.has(key)) {
            if (detailThrottleMs > 0) await sleep(detailThrottleMs);

            const detailRes = await fetchOrderDetail(hotelId, key, baseHeaders);
            if (detailRes.ok && detailRes.json && typeof detailRes.json === "object") {
              const extractedProject = extractProjectNameFromDetail(detailRes.json);
              const extractedRoomType = extractRoomTypeFromDetail(detailRes.json);

              if (extractedProject) projectName = extractedProject;
              if (extractedRoomType) roomType = extractedRoomType;

              detailCache.set(key, projectName || "");
              roomTypeCache.set(key, roomType || "");
            } else {
              detailCache.set(key, projectName || "");
              roomTypeCache.set(key, roomType || "");
            }
          }
        }

        const row = {
          訂單日期: toSheetDate(pick(it, ["created_at", "createdAt", "order_created_at", "orderDate", "order_date"])),
          訂單編號: String(orderSerial),
          入住日期: toSheetDate(pick(it, ["sdate", "checkin_date", "checkinDate", "check_in"])),
          退房日期: toSheetDate(pick(it, ["edate", "checkout_date", "checkoutDate", "check_out"])),
          姓名: pick(it, ["fullname", "customer_name", "guest_name", "name", "lastname", "firstname"]),
          房型: roomType || pick(it, ["room_names", "room_type_name", "roomTypeName", "room_type"]),
          專案名稱: projectName,
          訂單款項: toAmount(pick(it, ["total", "total_amount", "amount", "price"])),
          已收金額: toAmount(pick(it, ["paid", "paid_amount"])),
          剩餘尾款: toAmount(pick(it, ["unpaid", "remain", "unpaid_amount"])),
          UUID: pick(it, ["uuid", "order_uuid", "id", "order_id"]),
          電話: normalizePhone(pick(it, ["phone", "mobile", "tel", "customer_phone"]))
        };

        if (!row.入住日期 || !row.退房日期) continue;
        rows.push(row);
      }

      pageNo++;
    }

    // =======================================================
    // ✅ 第二輪（可選）：掃描取消單，只收集 cancelledOrderNos
    // - 因為第一輪常用 order_status=normal，API 不一定回傳取消單
    // =======================================================
    if (cancelScan && cancelOrderStatusList.length) {
      for (const cancelStatus of cancelOrderStatusList) {
        let cp = 1;
        let ctp = 1;

        while (cp <= ctp) {
          const cancelUrl = buildListUrl(hotelId, cp, rangeStr, cancelStatus);

          const cancelRes = await page.request.get(cancelUrl, { headers: baseHeaders });
          const cancelHttp = cancelRes.status();
          const cancelJson = await cancelRes.json().catch(() => ({}));

          fs.writeFileSync(
            `${outDir}/orders_calendar_list_cancel_${hotelId}_${cancelStatus}_p${cp}.json`,
            JSON.stringify({ url: cancelUrl, httpStatus: cancelHttp, body: cancelJson }, null, 2),
            "utf8"
          );

          if (cancelHttp !== 200 || !cancelJson || typeof cancelJson !== "object") break;
          if (typeof cancelJson.status === "number" && cancelJson.status !== 0) break;

          const cpg = cancelJson.pagination && typeof cancelJson.pagination === "object" ? cancelJson.pagination : {};
          const ctpRaw = cpg.total_pages != null ? Number(cpg.total_pages) : 1;
          ctp = Number.isFinite(ctpRaw) && ctpRaw > 0 ? ctpRaw : 1;

          const cancelData = Array.isArray(cancelJson.data) ? cancelJson.data : [];
          for (const it of cancelData) {
            const orderSerial = pick(it, ["order_serial", "serial", "orderNo", "order_no", "order_number", "orderNumber"]);
            if (!orderSerial || !String(orderSerial).startsWith("OBE")) continue;
            cancelledOrderNos.push(String(orderSerial));
          }

          cp++;
        }
      }
    }

    const sheetReadyPath = `${outDir}/orders_sheet_ready_${hotelId}.json`;
    fs.writeFileSync(
      sheetReadyPath,
      JSON.stringify({ hotelId, hotelName, rangeStr, columns, rows }, null, 2),
      "utf8"
    );
    
    // ✅ SSOT：同步寫一份到 repo（包含電話）
    const dataDir = "data/odin/latest";
    try { fs.mkdirSync(dataDir, { recursive: true }); } catch (_) {}
    try { fs.copyFileSync(sheetReadyPath, `${dataDir}/orders_sheet_ready_${hotelId}.json`); } catch (_) {}
    
    const uniqueCancelled = Array.from(new Set(cancelledOrderNos));

    console.log("✅ wrote:", sheetReadyPath, "rows =", rows.length);
    if (excludeCancelled) console.log("🚫 cancelled skipped:", hotelId, "count =", cancelledSkipped.count);
    if (cancelScan) console.log("🧹 cancelled scanned:", hotelId, "unique =", uniqueCancelled.length);

    await syncToSheetOrThrow(
      {
        token: sheetToken,
        spreadsheetId,
        hotelId,
        hotelName,
        columns,
        rows,
        cancelledOrderNos: uniqueCancelled,
        rangeStr
      },
      hotelId,
      hotelName
    );

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

      const changedPath = `${outDir}/orders_sheet_ready_changed_${hotelId}.json`;
      fs.writeFileSync(
        changedPath,
        JSON.stringify({ hotelId, hotelName, rangeStr, columns, rows: out }, null, 2),
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
