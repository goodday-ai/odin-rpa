// tests/orderDetailCapture.spec.js
"use strict";

/**
 * Odin｜Capture Orders by API (calendar_list -> detail -> sheet-ready)
 * ---------------------------------------------------
 * 目標（穩、快、可維護）：
 * 1) Playwright 只做一件事：登入拿到短期 Bearer Token
 * 2) 後續全部改用 API：calendar_list + detail，避免模擬點網頁（省時間、降低 UI 變動風險）
 * 3) 支援多館別輪巡、全年度/區間模式、取消單第二輪掃描、增量寫入（changedOnly）
 *
 * ✅ 你在意的痛點（這版直接處理）：
 * - 取消單 API 真實值是 order_status=cancel（不是 cancelled/canceled/void/invalid）
 * - Playwright 不再「跑網頁流程」抓資料，只拿 token
 *
 * 產出（可被 workflow commit 到 odin-data 分支）：
 * - data/odin/latest/orders_sheet_ready_{hotelId}.json
 * - data/odin/cache/detail_cache_{hotelId}.json
 * - out/orders_last_snapshot_{hotelId}.json（增量比對用）
 *
 * 環境變數（GitHub Actions env / secrets）：
 * - ODIN_EMAIL / ODIN_PASSWORD（必填）
 * - ODIN_HOTEL_IDS（必填，逗號分隔）
 * - ODIN_YEAR（可選，空值=台北當年度；有值=抓該年度 01-01~12-31）
 * - ODIN_DAYS（可選，若 ODIN_YEAR 为空，則抓「未來 N 天」；預設 120）
 * - ODIN_LANG（預設 zh_TW）
 * - ODIN_THROTTLE_MS（多館別節流，預設 250）
 * - ODIN_EXCLUDE_CANCELLED（預設 1；正常單那輪排除取消單）
 * - ODIN_CANCEL_SCAN（預設 1；第二輪掃取消單）
 * - ODIN_CANCEL_ORDER_STATUS（預設 cancel；⚠️ Odin 真實 API）
 * - ODIN_CHANGED_ONLY（預設 1；只送變動 rows 給 GAS）
 * - ODIN_SNAPSHOT_PATH（預設 out/orders_last_snapshot_{hotelId}.json）
 * - ODIN_WRITE_SHEET（預設 1）
 * - ODIN_SHEET_WEBAPP_URL / ODIN_SHEET_TOKEN / ODIN_SPREADSHEET_ID（寫入 Google Sheet 用）
 */

const fs = require("fs");
const path = require("path");
const { test, expect } = require("@playwright/test");

/** ---------------------------
 * ✅ 極簡 log（單行、好 grep）
 * -------------------------- */
function log(msg, obj, level) {
  const lv = level || "CORE";
  const t = new Date().toISOString().replace("T", " ").replace("Z", "Z");
  if (obj !== undefined) console.log(`${t} [${lv}] ${msg} ${safeJson(obj)}`);
  else console.log(`${t} [${lv}] ${msg}`);
}

function safeJson(obj) {
  try { return JSON.stringify(obj); } catch (_) { return String(obj); }
}

function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

function mustEnv(name) {
  const v = String(process.env[name] || "").trim();
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function envStr(name, defv) {
  const v = process.env[name];
  if (v === undefined || v === null) return defv;
  const s = String(v).trim();
  return s === "" ? defv : s;
}

function envBool(name, defv) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return !!defv;
  const s = String(raw).trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function envInt(name, defv) {
  const s = envStr(name, "");
  if (!s) return defv;
  const n = Number(s);
  return Number.isFinite(n) ? n : defv;
}

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeJson(filePath, obj) {
  mkdirp(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8");
}

function readJsonOr(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const s = fs.readFileSync(filePath, "utf8");
    return JSON.parse(s);
  } catch (_) {
    return fallback;
  }
}

function asArrayCsv(s) {
  const raw = String(s || "").trim();
  if (!raw) return [];
  return raw.split(",").map(function(x) { return String(x || "").trim(); }).filter(Boolean);
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function ymd(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function rangeFromYearOrDays(tzYear, days) {
  const now = new Date();
  if (tzYear) {
    const y = Number(tzYear);
    const start = `${y}-01-01`;
    const end = `${y}-12-31`;
    return { start, end, mode: "year" };
  }
  const start = ymd(now);
  const endDate = new Date(now.getTime() + Number(days) * 86400000);
  const end = ymd(endDate);
  return { start, end, mode: "days" };
}

/** ---------------------------
 * ✅ Odin API helpers
 * -------------------------- */
function baseUrl() {
  return "https://www.owlting.com/booking/v2/admin";
}

function buildHotelsUrl(lang) {
  return `${baseUrl()}/hotels?lang=${encodeURIComponent(lang)}&_=${Date.now()}`;
}

function buildMeUrl(lang) {
  return `${baseUrl()}/me?lang=${encodeURIComponent(lang)}&_=${Date.now()}`;
}

function buildCalendarListUrl(hotelId, lang, limit, page, duringStart, duringEnd, orderStatus, orderBy, sortBy) {
  const qs =
    `lang=${encodeURIComponent(lang)}` +
    `&limit=${encodeURIComponent(String(limit))}` +
    `&page=${encodeURIComponent(String(page))}` +
    `&during_checkin_date=${encodeURIComponent(`${duringStart},${duringEnd}`)}` +
    `&order_status=${encodeURIComponent(orderStatus)}` +
    `&order_by=${encodeURIComponent(orderBy)}` +
    `&sort_by=${encodeURIComponent(sortBy)}` +
    `&_=${Date.now()}`;
  return `${baseUrl()}/hotels/${encodeURIComponent(String(hotelId))}/orders/calendar_list?${qs}`;
}

function buildOrderDetailUrl(hotelId, orderSerial, lang) {
  return `${baseUrl()}/hotels/${encodeURIComponent(String(hotelId))}/orders/${encodeURIComponent(String(orderSerial))}/detail?lang=${encodeURIComponent(lang)}&_=${Date.now()}`;
}

function normalizeCancelOrderStatusList(rawList) {
  // ⚠️ Odin 真實 API：已取消 = order_status=cancel
  // 為了兼容舊設定（cancelled/canceled/void/invalid），統一導回 cancel。
  const list = Array.isArray(rawList) ? rawList.map(function(s) { return String(s || "").trim().toLowerCase(); }).filter(Boolean) : [];
  if (!list.length) return ["cancel"];
  if (list.includes("cancel")) return ["cancel"];
  const legacy = ["cancelled", "canceled", "void", "invalid"];
  const hitLegacy = list.some(function(x) { return legacy.includes(x); });
  if (hitLegacy) return ["cancel"];
  return list;
}

async function apiGetJson(request, url, extra) {
  const res = await request.get(url, extra || {});
  const status = res.status();
  const headers = res.headers();
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch (_) { body = { _raw: text }; }
  return { url, httpStatus: status, headers, body };
}

/** ---------------------------
 * ✅ Bearer capture via Playwright login
 * -------------------------- */
async function captureBearerByLogin(page, lang, email, password) {
  // 只需要 token：避免後續 UI 流程拖慢/不穩
  const loginUrl = `https://www.owlting.com/booking/admin/login/?l=${encodeURIComponent(lang)}`;
  let bearer = "";

  page.on("request", function(req) {
    try {
      const h = req.headers();
      const auth = String(h.authorization || h.Authorization || "").trim();
      if (auth && auth.toLowerCase().startsWith("bearer ")) bearer = auth;
    } catch (_) {}
  });

  await page.goto(loginUrl, { waitUntil: "domcontentloaded" });

  // Odin 後台 UI 常見欄位 name=email/password；若 UI 調整，這裡是唯一需要改的地方
  await page.getByRole("textbox").first().fill(email);
  await page.getByRole("textbox").nth(1).fill(password);

  // 嘗試點擊登入按鈕：中/英文都兼容
  const btn = page.getByRole("button").filter({ hasText: /登入|Login/i }).first();
  await Promise.all([
    page.waitForLoadState("networkidle"),
    btn.click()
  ]);

  // 強制打一個 API，確保產生 Bearer（避免 UI 只跳頁但還沒觸發 API）
  try {
    await page.goto(`https://www.owlting.com/booking/admin/?l=${encodeURIComponent(lang)}&p=order`, { waitUntil: "networkidle" });
  } catch (_) {}

  // 等一下讓 request listener 吃到 Authorization
  for (let i = 0; i < 30 && !bearer; i++) await sleep(200);

  if (!bearer) throw new Error("Bearer capture failed (no Authorization: Bearer ... seen)");
  return bearer;
}

/** ---------------------------
 * ✅ Rows → Sheet-ready model
 * -------------------------- */
function toSheetReadyPayload(hotelId, hotelName, rows, cancelledOrderNos) {
  // columns：固定成你 Sheet/ GAS 已使用的中文欄位
  const columns = [
    "訂單編號",
    "訂單日期",
    "入住日期",
    "退房日期",
    "旅客姓名",
    "電話",
    "成人",
    "兒童",
    "嬰兒",
    "來源",
    "訂單分類",
    "訂單狀態",
    "幣別",
    "總額",
    "已付",
    "未付",
    "付款方式",
    "付款參考",
    "備註"
  ];

  const mapped = rows.map(function(r) {
    return {
      "訂單編號": String(r.order_serial || "").trim(),
      "訂單日期": String((r.created_at || "").slice(0, 10)).trim(),
      "入住日期": String(r.sdate || "").trim(),
      "退房日期": String(r.edate || "").trim(),
      "旅客姓名": String(r.fullname || (String(r.lastname || "") + " " + String(r.firstname || ""))).trim(),
      "電話": String(r.phone || "").trim(),
      "成人": r.guest_adult,
      "兒童": r.guest_children,
      "嬰兒": r.guest_infant,
      "來源": r.source,
      "訂單分類": r.order_category,
      "訂單狀態": r.order_status,
      "幣別": r.currency,
      "總額": r.total,
      "已付": r.paid,
      "未付": r.unpaid,
      "付款方式": r.payment_name,
      "付款參考": r.payment_reference,
      "備註": r.note
    };
  });

  return {
    hotelId: String(hotelId),
    hotelName: String(hotelName || ""),
    columns,
    rows: mapped,
    cancelledOrderNos: Array.isArray(cancelledOrderNos) ? cancelledOrderNos : []
  };
}

function fingerprintRows(rows) {
  // 用「訂單編號」作 key，比對是否有變動
  const out = {};
  for (const r of Array.isArray(rows) ? rows : []) {
    const k = String(r["訂單編號"] || "").trim();
    if (!k) continue;
    out[k] = safeJson(r);
  }
  return out;
}

function diffChangedRows(currentRows, lastSnapshot) {
  const cur = fingerprintRows(currentRows);
  const old = lastSnapshot || {};
  const changed = [];
  let sameCount = 0;

  for (const k of Object.keys(cur)) {
    if (old[k] === cur[k]) sameCount++;
    else changed.push(k);
  }

  // 刪除不在 current 的 key（通常是取消單/過期單）交由 cancelledOrderNos 處理，不走這條
  return { changedKeys: changed, sameCount, total: Object.keys(cur).length };
}

/** ---------------------------
 * ✅ Main test
 * -------------------------- */
test("odin capture orders by API (calendar_list -> sheet-ready)", async ({ page, request }) => {
  const lang = envStr("ODIN_LANG", "zh_TW");
  const email = mustEnv("ODIN_EMAIL");
  const password = mustEnv("ODIN_PASSWORD");
  const hotelIds = asArrayCsv(mustEnv("ODIN_HOTEL_IDS"));

  const throttleMs = envInt("ODIN_THROTTLE_MS", 250);
  const excludeCancelled = envBool("ODIN_EXCLUDE_CANCELLED", true);

  const cancelScan = envBool("ODIN_CANCEL_SCAN", true);
  const cancelOrderStatusList = normalizeCancelOrderStatusList(
    asArrayCsv(envStr("ODIN_CANCEL_ORDER_STATUS", "cancel"))
  );

  const writeSheet = envBool("ODIN_WRITE_SHEET", true);
  const changedOnly = envBool("ODIN_CHANGED_ONLY", true);

  const year = envStr("ODIN_YEAR", "");
  const days = envInt("ODIN_DAYS", 120);
  const during = rangeFromYearOrDays(year, days);

  const outDir = envStr("ODIN_OUT_DIR", "out");
  const dataLatestDir = "data/odin/latest";
  const dataCacheDir = "data/odin/cache";

  mkdirp(outDir);
  mkdirp(dataLatestDir);
  mkdirp(dataCacheDir);

  log("🧭 runtime", {
    lang,
    hotelIdsCount: hotelIds.length,
    during,
    excludeCancelled,
    cancelScan,
    cancelOrderStatusList,
    throttleMs,
    writeSheet,
    changedOnly
  }, "CORE");

  // 1) Playwright login → bearer
  const bearer = await captureBearerByLogin(page, lang, email, password);
  log("✅ bearer captured", { tokenPreview: bearer.slice(0, 16) + "***" }, "CORE");

  // 2) API context (帶 Authorization)
  const api = await request.newContext({
    extraHTTPHeaders: {
      Authorization: bearer,
      Accept: "application/json, text/javascript, */*; q=0.01",
      "X-Requested-With": "XMLHttpRequest",
      Referer: `https://www.owlting.com/booking/admin/?l=${encodeURIComponent(lang)}&p=order`
    }
  });

  // 3) me / hotels（寫 raw 方便診斷）
  const meRes = await apiGetJson(api, buildMeUrl(lang));
  writeJson(path.join(outDir, "odin_me_raw.json"), meRes);
  expect(meRes.httpStatus).toBe(200);

  const hotelsRes = await apiGetJson(api, buildHotelsUrl(lang));
  writeJson(path.join(outDir, "odin_hotels_list_raw.json"), hotelsRes);
  expect(hotelsRes.httpStatus).toBe(200);

  const hotelNameById = {};
  try {
    const list = (hotelsRes.body && hotelsRes.body.data) ? hotelsRes.body.data : [];
    for (const h of list) {
      const id = String(h && h.id != null ? h.id : "").trim();
      const name = String(h && h.name != null ? h.name : "").trim();
      if (id) hotelNameById[id] = name;
    }
  } catch (_) {}

  // 4) 每館別：抓 normal + detail → sheet-ready
  const limit = 200;
  const orderBy = "id";
  const sortBy = "asc";

  for (let hi = 0; hi < hotelIds.length; hi++) {
    const hotelId = hotelIds[hi];
    const hotelName = hotelNameById[hotelId] || "";

    const detailCachePath = path.join(dataCacheDir, `detail_cache_${hotelId}.json`);
    const detailCache = readJsonOr(detailCachePath, {});

    let detailHit = 0;
    let detailMiss = 0;
    let detailWrite = 0;

    const normalStatus = excludeCancelled ? "normal" : "all";
    const allItems = [];

    let pageNo = 1;
    let totalPages = 1;

    while (pageNo <= totalPages) {
      const url = buildCalendarListUrl(hotelId, lang, limit, pageNo, during.start, during.end, normalStatus, orderBy, sortBy);
      const res = await apiGetJson(api, url);
      writeJson(path.join(outDir, `orders_calendar_list_raw_${hotelId}_page${pageNo}.json`), res);

      if (res.httpStatus !== 200 || !res.body || res.body.status !== 0) {
        throw new Error(`calendar_list failed: hotelId=${hotelId} page=${pageNo} http=${res.httpStatus} bodyStatus=${res.body && res.body.status}`);
      }

      const data = Array.isArray(res.body.data) ? res.body.data : [];
      for (const it of data) allItems.push(it);

      const pag = res.body.pagination || {};
      totalPages = Number(pag.total_pages || 1) || 1;
      pageNo++;
      if (throttleMs) await sleep(throttleMs);
    }

    // detail（有 cache 的跳過）
    const enriched = [];
    for (const it of allItems) {
      const orderSerial = String(it && it.order_serial ? it.order_serial : "").trim();
      if (!orderSerial) continue;

      if (detailCache[orderSerial]) {
        detailHit++;
        enriched.push(detailCache[orderSerial]);
        continue;
      }

      detailMiss++;
      const detailUrl = buildOrderDetailUrl(hotelId, orderSerial, lang);
      const detailRes = await apiGetJson(api, detailUrl);

      if (detailRes.httpStatus !== 200 || !detailRes.body || detailRes.body.status !== 0) {
        // detail 有時候會被權限/資料異常卡住：保留最小資料讓流程不中斷
        log("⚠️ detail failed, fallback to list item", { hotelId, orderSerial, http: detailRes.httpStatus, bodyStatus: detailRes.body && detailRes.body.status }, "DEV");
        enriched.push(it);
        continue;
      }

      const detail = detailRes.body && detailRes.body.data ? detailRes.body.data : it;
      detailCache[orderSerial] = detail;
      detailWrite++;
      enriched.push(detail);

      if (throttleMs) await sleep(Math.min(200, throttleMs));
    }

    // 寫回 detail cache
    writeJson(detailCachePath, detailCache);
    log("🧾 detailCache", { hotelId, hit: detailHit, miss: detailMiss, write: detailWrite }, "CORE");

    // 5) 取消單第二輪：只拿「訂單編號」key，交給 GAS 刪除
    const cancelledOrderNos = [];
    if (cancelScan) {
      const cancelSet = {};
      for (const st of cancelOrderStatusList) {
        let cPage = 1;
        let cTotal = 1;

        while (cPage <= cTotal) {
          const cUrl = buildCalendarListUrl(hotelId, lang, limit, cPage, during.start, during.end, st, orderBy, sortBy);
          const cRes = await apiGetJson(api, cUrl);
          writeJson(path.join(outDir, `orders_calendar_list_cancel_${hotelId}_${st}_page${cPage}.json`), cRes);

          if (cRes.httpStatus !== 200 || !cRes.body || cRes.body.status !== 0) break;

          const cData = Array.isArray(cRes.body.data) ? cRes.body.data : [];
          for (const it of cData) {
            const k = String(it && it.order_serial ? it.order_serial : "").trim();
            if (k) cancelSet[k] = true;
          }

          const pag = cRes.body.pagination || {};
          cTotal = Number(pag.total_pages || 1) || 1;
          cPage++;
          if (throttleMs) await sleep(throttleMs);
        }
      }

      for (const k of Object.keys(cancelSet)) cancelledOrderNos.push(k);
      log("🧾 cancelScan", { hotelId, on: true, cancelIncomingUnique: cancelledOrderNos.length, orderStatus: cancelOrderStatusList }, "CORE");
    } else {
      log("🧾 cancelScan", { hotelId, on: false }, "CORE");
    }

    // 6) 轉成 sheet-ready（rows）
    const payload = toSheetReadyPayload(hotelId, hotelName, enriched, cancelledOrderNos);

    // 7) changedOnly：只送變動 rows，減少 GAS 負擔
    const snapshotPathTpl = envStr("ODIN_SNAPSHOT_PATH", path.join(outDir, "orders_last_snapshot_{hotelId}.json"));
    const snapshotPath = snapshotPathTpl.replace("{hotelId}", String(hotelId));
    const lastSnap = readJsonOr(snapshotPath, {});
    const fp = fingerprintRows(payload.rows);
    const diff = diffChangedRows(payload.rows, lastSnap);

    let outgoing = payload;
    if (changedOnly) {
      const changedSet = {};
      for (const k of diff.changedKeys) changedSet[k] = true;
      outgoing = Object.assign({}, payload, {
        rows: payload.rows.filter(function(r) {
          const k = String(r["訂單編號"] || "").trim();
          return !!changedSet[k];
        })
      });
    }

    writeJson(snapshotPath, fp);

    writeJson(path.join(dataLatestDir, `orders_sheet_ready_${hotelId}.json`), payload);
    writeJson(path.join(outDir, `orders_sheet_ready_${hotelId}.json`), payload);
    if (changedOnly) writeJson(path.join(outDir, `orders_sheet_ready_changed_${hotelId}.json`), outgoing);

    log("✅ sheet-ready", {
      hotelId,
      hotelName,
      rows: payload.rows.length,
      changedOnly,
      changedRows: outgoing.rows.length,
      snapshot: snapshotPath
    }, "CORE");

    // 8) 寫入 GAS
    if (writeSheet) {
      const webappUrl = mustEnv("ODIN_SHEET_WEBAPP_URL");
      const sheetToken = mustEnv("ODIN_SHEET_TOKEN");
      const spreadsheetId = envStr("ODIN_SPREADSHEET_ID", "");

      const gasPayload = {
        token: sheetToken,
        spreadsheetId: spreadsheetId || undefined,
        items: [outgoing]
      };

      const gasRes = await api.post(webappUrl, {
        headers: { "Content-Type": "application/json" },
        data: gasPayload,
        timeout: 240000
      });

      const gasText = await gasRes.text();
      log("📦 GAS resp", gasText ? gasText.slice(0, 800) : "", "CORE");
    }

    if (throttleMs) await sleep(throttleMs);
  }

  await api.dispose();
});
