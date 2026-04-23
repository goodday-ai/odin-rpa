"use strict";

require("dotenv").config();
const { test, expect } = require("@playwright/test");
const fs = require("fs");
const path = require("path");
const { format, addDays, parseISO, isValid } = require("date-fns");

/**
 * ✅ 功能（多館別輪巡版）：
 * - Playwright 登入 Owlting 後台 → 捕捉 Bearer
 * - 列出可管理館別（hotelId / 名稱）
 * - 支援 ODIN_HOTEL_IDS=5720,6323,... 逐館輪巡
 * - 逐館打 calendar_list → 產出 sheet-ready JSON（每館獨立輸出檔）
 * - ✅ 寫入 Google Sheet（GAS Web App）→ 依入住年份建分頁、訂單編號 upsert
 *
 * ✅ 取消單刪除（重要）：
 * - 第一輪常用 ODIN_ORDER_STATUS=normal → API 多半不會回傳取消單
 * - ✅ 新增第二輪掃描：ODIN_CANCEL_SCAN=1 時，用 ODIN_CANCEL_ORDER_STATUS 清單再抓一次取消單
 * - 只收集 cancelledOrderNos，並一併 POST 給 GAS 讓 GAS 刪掉 Sheet 舊資料
 *
 * ✅ 本次新增：Order Detail 快取（減少 API 重複打）
 * - 目的：plan_name(專案名稱) / room_config_name(房型) / phone(電話) 這三項「綁訂單編號、極少變動」
 * - 作法：
 *   1) 每館別維護一份快取：data/odin/cache/detail_cache_<hotelId>.json
 *   2) 若訂單編號已存在快取 → 不打 detail，直接用快取補欄位
 *   3) 若訂單編號不在快取 → 才打 detail，並寫回快取（commit 回 repo）
 *
 * ✅ 重要輸出（out/）：
 * - out/orders_sheet_ready_<hotelId>.json
 * - out/orders_last_snapshot_<hotelId>.json（每館獨立）
 *
 * ✅ SSOT（repo 內）：
 * - data/odin/latest/orders_sheet_ready_<hotelId>.json（包含電話）
 * - data/odin/cache/detail_cache_<hotelId>.json（detail 快取）
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

  function taipeiNowHour() {
    const dtf = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Taipei",
      hour: "2-digit",
      hour12: false
    });
    const h = Number(dtf.format(new Date()));
    return Number.isFinite(h) ? h : -1;
  }

  function clampInt(n, min, max, fallback) {
    const x = Number(n);
    if (!Number.isFinite(x)) return fallback;
    const v = Math.trunc(x);
    if (v < min) return min;
    if (v > max) return max;
    return v;
  }
  // ✅ 中文註解：在節流與重試等策略上加入小抖動，降低固定節奏特徵。
  function randomIntInclusive(min, max) {
    const a = Math.trunc(Number(min));
    const b = Math.trunc(Number(max));
    if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const span = hi - lo + 1;
    return lo + Math.floor(Math.random() * span);
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
  const hotelThrottleMinMs = clampInt(process.env.ODIN_HOTEL_THROTTLE_MIN_MS || String(throttleMs), 0, 5000, throttleMs);
  const hotelThrottleMaxMs = clampInt(process.env.ODIN_HOTEL_THROTTLE_MAX_MS || String(hotelThrottleMinMs), 0, 5000, hotelThrottleMinMs);

  // ✅ API 請求逾時（避免單一請求拖到整體測試逾時）
  const apiTimeoutMsRaw = Number(process.env.ODIN_API_TIMEOUT_MS || "20000");
  const apiTimeoutMs = Number.isFinite(apiTimeoutMsRaw) ? Math.max(3000, Math.min(120000, apiTimeoutMsRaw)) : 20000;
  const cancelApiTimeoutMsRaw = Number(process.env.ODIN_CANCEL_API_TIMEOUT_MS || String(apiTimeoutMs));
  const cancelApiTimeoutMs = Number.isFinite(cancelApiTimeoutMsRaw) ? Math.max(3000, Math.min(120000, cancelApiTimeoutMsRaw)) : apiTimeoutMs;

  // ✅ 是否要打 detail 補欄位（預設開）
  const fetchDetail = String(process.env.ODIN_FETCH_DETAIL || "1") === "1";
  const detailThrottleMsRaw = Number(process.env.ODIN_DETAIL_THROTTLE_MS || "0");
  const detailThrottleMs = Number.isFinite(detailThrottleMsRaw) ? Math.max(0, Math.min(3000, detailThrottleMsRaw)) : 0;
  const detailThrottleMinMsBase = clampInt(process.env.ODIN_DETAIL_THROTTLE_MIN_MS || String(detailThrottleMs), 0, 5000, detailThrottleMs);
  const detailThrottleMaxMsBase = clampInt(process.env.ODIN_DETAIL_THROTTLE_MAX_MS || String(detailThrottleMinMsBase), 0, 5000, detailThrottleMinMsBase);

  // ✅ 策略一（寫入 Sheet）：GAS Web App
  const writeSheet = String(process.env.ODIN_WRITE_SHEET || "1") === "1";

  // ✅ 第二輪：取消單掃描（只收 cancelledOrderNos）
  const cancelScan = String(process.env.ODIN_CANCEL_SCAN || "0") === "1";
  const cancelOrderStatusList = String(process.env.ODIN_CANCEL_ORDER_STATUS || "cancelled,void,invalid")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // ✅ Detail Cache：是否強制刷新（預設不刷新，只打新訂單）
  // - ODIN_DETAIL_FORCE_REFRESH=1：不管有沒有快取都重打（一般不用）
  const detailForceRefresh = String(process.env.ODIN_DETAIL_FORCE_REFRESH || "0") === "1";

  // ✅ 每日定時 full detail refresh（台北時區）
  // - 預設 6 點；設空字串可停用
  // - 命中該小時時，等效 ODIN_DETAIL_FORCE_REFRESH=1
  const refreshHourRaw = String(process.env.ODIN_DETAIL_REFRESH_HOUR || "6").trim();
  const refreshHour = refreshHourRaw === "" ? -1 : clampInt(refreshHourRaw, 0, 23, 6);
  const nowTaipeiHour = taipeiNowHour();
  const isScheduledDetailRefreshWindow = refreshHour >= 0 && nowTaipeiHour === refreshHour;
  const detailForceRefreshEffective = detailForceRefresh || isScheduledDetailRefreshWindow;

  // ✅ 每日 6 點（或 refreshHour）可切到「全量覆寫模式」：不做 changedOnly、不掃 cancel，直接全量覆寫 Sheet
  // ⚠️ 安全閥：若不是 ODIN_YEAR 年度模式，預設不允許全量覆寫，避免只抓到「區間資料」卻把整年歷史刪掉。
  const fullRewriteEnabled = String(process.env.ODIN_SCHEDULED_FULL_REWRITE || "1") === "1";
  const allowPartialRangeFullRewrite = String(process.env.ODIN_ALLOW_PARTIAL_FULL_REWRITE || "0") === "1";
  const scheduledFullRewriteByClock =
    isScheduledDetailRefreshWindow &&
    fullRewriteEnabled &&
    (useYearMode || allowPartialRangeFullRewrite);
  const changedOnlyBase = scheduledFullRewriteByClock ? false : changedOnly;
  const cancelScanBase = scheduledFullRewriteByClock ? false : cancelScan;

  // ✅ 安全全量覆寫（Safe Full Rewrite）門檻：
  // - 只有在定時 full rewrite 視窗內才會啟用
  // - 若本輪 rows 明顯少於前次 snapshot，則自動降級成「全量 upsert（不清表）」
  const fullRewriteMinRatioRaw = Number(process.env.ODIN_FULL_REWRITE_MIN_RATIO || "0.98");
  const fullRewriteMinRatio = Number.isFinite(fullRewriteMinRatioRaw)
    ? Math.max(0.5, Math.min(1, fullRewriteMinRatioRaw))
    : 0.98;
  const fullRewriteMaxDropRaw = Number(process.env.ODIN_FULL_REWRITE_MAX_DROP || "1");
  const fullRewriteMaxDrop = Number.isFinite(fullRewriteMaxDropRaw)
    ? Math.max(0, Math.min(1000, Math.trunc(fullRewriteMaxDropRaw)))
    : 1;

  // ✅ 在 full refresh 時段提高 detail 節流（避免多館別打太快）
  // - 非 full refresh 時段沿用 ODIN_DETAIL_THROTTLE_MS
  const refreshThrottleMsRaw = Number(process.env.ODIN_DETAIL_REFRESH_THROTTLE_MS || "800");
  const refreshThrottleMs = Number.isFinite(refreshThrottleMsRaw) ? Math.max(0, Math.min(3000, refreshThrottleMsRaw)) : 800;
  const refreshDetailThrottleMinMs = isScheduledDetailRefreshWindow ? Math.max(detailThrottleMinMsBase, refreshThrottleMs) : detailThrottleMinMsBase;
  const refreshDetailThrottleMaxMs = isScheduledDetailRefreshWindow ? Math.max(detailThrottleMaxMsBase, refreshThrottleMs) : detailThrottleMaxMsBase;
  const detailConcurrency = clampInt(process.env.ODIN_DETAIL_CONCURRENCY || "3", 1, 20, 3);
  const detailCacheStaleDays = clampInt(process.env.ODIN_DETAIL_CACHE_STALE_DAYS || "14", 0, 3650, 14);

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

  // --- GAS 回應診斷：用規則化分類，讓偶發錯誤可快速定位 ---
  // 為何這樣寫：
  // 1) 先以 HTTP 狀態碼 + content-type + body 特徵做分層判斷，避免只靠單一字串硬編碼。
  // 2) 訊息內提供「最可能根因」與「下一步檢查」，降低值班排障時間。
  function _normalizeSnippet_(text, maxLen = 600) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maxLen);
  }

  function _safeUrlInfo_(raw) {
    const gasUrl = _normalizeUrl_(raw);
    try {
      const u = new URL(gasUrl);
      return {
        host: u.host,
        pathnameTail: u.pathname.slice(-48),
        searchLen: u.search.length
      };
    } catch (_) {
      return {
        host: "(invalid-url)",
        pathnameTail: "",
        searchLen: 0
      };
    }
  }

  function _classifyGasHttpFailure_({ http, contentType, text }) {
    const ct = String(contentType || "").toLowerCase();
    const body = String(text || "");
    const bodyLower = body.toLowerCase();
    const isHtmlLike =
      ct.includes("text/html") ||
      /<!doctype html|<html[\s>]/i.test(body) ||
      bodyLower.includes("<title>page not found</title>");

    if (http === 404 && isHtmlLike) {
      return {
        code: "gas_webapp_not_found",
        hint: "GAS URL 可解析但目標 deployment 不存在、版本失效，或 URL 指到錯誤資源。"
      };
    }
    if ((http === 401 || http === 403) && isHtmlLike) {
      return {
        code: "gas_webapp_permission_denied",
        hint: "GAS Web App 存在但權限不足（執行身分 / 存取對象）或呼叫端未被允許。"
      };
    }
    if (http >= 500) {
      return {
        code: "gas_server_error",
        hint: "GAS 伺服端執行失敗，請優先查看 Apps Script Executions 與 Stackdriver 記錄。"
      };
    }

    return {
      code: "gas_unknown_http_error",
      hint: "非 2xx 回應；請檢查 Apps Script 部署、權限、token 與 spreadsheetId。"
    };
  }

  const gasUrlRaw = String(process.env.ODIN_SHEET_WEBAPP_URL || "");
  const sheetToken = String(process.env.ODIN_SHEET_TOKEN || "").trim();
  const spreadsheetId = String(process.env.ODIN_SPREADSHEET_ID || "").trim();

  // ✅ 訂單狀態（你截圖「已成立」）：常見對應 order_status=normal
  const orderStatus = String(process.env.ODIN_ORDER_STATUS || "normal").trim();
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

  // ✅ SSOT 路徑：latest + cache
  const ssotLatestDir = "data/odin/latest";
  const ssotCacheDir = "data/odin/cache";

  function ensureDirSafe(p) {
    try { fs.mkdirSync(p, { recursive: true }); } catch (_) {}
  }

  function cachePathFor(hotelId) {
    return path.join(ssotCacheDir, `detail_cache_${hotelId}.json`);
  }

  function readJsonFileSafe(p, fallback) {
    try {
      if (!fs.existsSync(p)) return fallback;
      const s = fs.readFileSync(p, "utf8");
      const j = JSON.parse(s);
      return j && typeof j === "object" ? j : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function writeJsonFileSafe(p, obj) {
    try {
      ensureDirSafe(path.dirname(p));
      fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
    } catch (_) {}
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
    cancelScanBase ? `ON(${cancelOrderStatusList.join(",") || "empty"})` : "OFF",
    "| changedOnly(raw/resolved)=",
    `${String(process.env.ODIN_CHANGED_ONLY || "") || "(empty)"}/${hotelIds.length ? String(changedOnlyBase) : String(changedOnly)}`,
    "| cancelScan(raw/resolved)=",
    `${String(process.env.ODIN_CANCEL_SCAN || "") || "(empty)"}/${String(cancelScanBase)}`,
    "| detailForceRefresh(raw/resolved)=",
    `${String(process.env.ODIN_DETAIL_FORCE_REFRESH || "") || "(empty)"}/${String(detailForceRefreshEffective)}`,
    "| modeReason=",
    scheduledFullRewriteByClock ? "scheduled_full_rewrite_window" : "normal_mode",
    "| taipeiHour=",
    nowTaipeiHour,
    "| detailRefreshHour=",
    refreshHour >= 0 ? refreshHour : "disabled",
    "| scheduledRefreshWindow=",
    isScheduledDetailRefreshWindow ? "YES" : "NO",
    "| scheduledFullRewrite=",
    scheduledFullRewriteByClock ? "YES" : "NO",
    "| allowPartialFullRewrite=",
    allowPartialRangeFullRewrite ? "YES" : "NO",
    "| fullRewriteMinRatio=",
    fullRewriteMinRatio,
    "| fullRewriteMaxDrop=",
    fullRewriteMaxDrop,
    "| detailCache=",
    fetchDetail ? (detailForceRefreshEffective ? "ON(forceRefresh)" : "ON(newOnly)") : "OFF",
    "| detailThrottleRangeMs=",
    `${refreshDetailThrottleMinMs}-${refreshDetailThrottleMaxMs}`,
    "| hotelThrottleRangeMs=",
    `${hotelThrottleMinMs}-${hotelThrottleMaxMs}`,
    "| detailConcurrency=",
    detailConcurrency,
    "| apiTimeoutMs=",
    apiTimeoutMs,
    "| cancelApiTimeoutMs=",
    cancelApiTimeoutMs
  );

  if (isScheduledDetailRefreshWindow && fullRewriteEnabled && !scheduledFullRewriteByClock) {
    console.log(
      "⚠️ full rewrite skipped: current run is not ODIN_YEAR mode. " +
      "Set ODIN_ALLOW_PARTIAL_FULL_REWRITE=1 if you really want range-based full rewrite."
    );
  }

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
  // 3) ✅ 列出可管理館別（hotelId）
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
      const r = await page.request.get(url, { headers, timeout: apiTimeoutMs });
      const s = r.status();
      const j = await r.json().catch(() => ({}));
      return { ok: s === 200, httpStatus: s, json: j, url };
    } catch (e) {
      return { ok: false, httpStatus: 0, json: {}, url, error: String(e && e.message ? e.message : e) };
    }
  }

  // ✅ 中文註解：偵測疑似風控事件，遇到後本輪保守停止後續館別，避免激進重打。
  function detectAnomalyFromResponse(url, httpStatus, body) {
    const text = JSON.stringify(body || {}).toLowerCase();
    const u = String(url || "").toLowerCase();
    const redirectLike = u.includes("/login") || u.includes("/challenge");
    const challengeLike = text.includes("challenge") || text.includes("captcha");
    if (httpStatus === 403 || httpStatus === 429) return { hit: true, reason: `http_${httpStatus}` };
    if (redirectLike) return { hit: true, reason: "unexpected_login_or_challenge_redirect" };
    if (challengeLike) return { hit: true, reason: "response_contains_challenge" };
    return { hit: false, reason: "" };
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
    const planNames = _uniqNonEmpty_(rooms.map((r) => (r && r.plan_name ? r.plan_name : "")));
    if (planNames.length) return planNames.join("｜");

    const roomNames = _uniqNonEmpty_(rooms.map((r) => (r && r.room_name ? r.room_name : "")));
    if (roomNames.length) return roomNames.join("｜");

    return "";
  }

  function extractRoomTypeFromDetail(detailJson) {
    const d = detailJson && detailJson.data ? detailJson.data : null;
    if (!d) return "";

    const rooms = Array.isArray(d.rooms) ? d.rooms : [];
    const cfgNames = _uniqNonEmpty_(rooms.map((r) => (r && r.room_config_name ? r.room_config_name : "")));
    if (cfgNames.length) return cfgNames.join("｜");

    return "";
  }

  function extractPhoneFromDetail(detailJson) {
    const d = detailJson && detailJson.data ? detailJson.data : null;
    if (!d) return "";

    // 盡量吃常見欄位（不同帳號/語系可能不一樣）
    const v =
      (d.customer && (d.customer.phone || d.customer.mobile || d.customer.tel)) ||
      d.phone ||
      d.mobile ||
      d.tel ||
      "";

    return String(v || "").trim();
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

  // ✅ 參數診斷：輸出「設定要跑」與「實際可管理」的館別，方便排查新增館別卻沒產生 JSON
  const discoveredHotelIdSet = new Set(hotels.map((h) => String(h.id)));
  const missingFromPermission = hotelIds.filter((id) => !discoveredHotelIdSet.has(String(id)));
  fs.writeFileSync(
    `${outDir}/odin_hotels_plan.json`,
    JSON.stringify(
      {
        configuredHotelIds: hotelIds,
        discoveredHotelIds: hotels.map((h) => String(h.id)),
        missingFromPermission
      },
      null,
      2
    ),
    "utf8"
  );

  if (listHotelsOnly) {
    console.log("✅ ODIN_LIST_HOTELS_ONLY=1, stop here.");
    return;
  }

  if (!hotelIds.length) {
    console.log("❌ Missing ODIN_HOTEL_IDS or ODIN_HOTEL_ID. See out/odin_hotels_candidates.json");
    throw new Error("Missing ODIN_HOTEL_IDS (or ODIN_HOTEL_ID)");
  }

  if (missingFromPermission.length) {
    console.log("❌ Configured ODIN_HOTEL_IDS not found in discovered hotels:", missingFromPermission.join(","));
    console.log("ℹ️ See out/odin_hotels_plan.json and out/odin_hotels_candidates.json");
    throw new Error(`Hotel permission mismatch. missing=${missingFromPermission.join(",")}`);
  }

  // -----------------------------
  // 4) 共用工具：calendar_list → sheet-ready
  // -----------------------------
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function runWithConcurrency(items, limit, worker) {
    const n = Array.isArray(items) ? items.length : 0;
    if (!n) return;

    let idx = 0;
    const size = Math.max(1, Math.min(limit || 1, n));

    const runners = Array.from({ length: size }, async () => {
      while (idx < n) {
        const current = idx;
        idx++;
        await worker(items[current], current);
      }
    });

    await Promise.all(runners);
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

  function toNumberSafe(v) {
    const s = toAmount(v);
    if (!s) return NaN;
    const n = Number(s);
    return Number.isFinite(n) ? n : NaN;
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

  function parseYmdSafe(s) {
    const t = String(s || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
    const d = parseISO(t);
    if (!isValid(d)) return null;
    return d;
  }

  function diffDaysFromTodayTaipei(ymd) {
    const target = parseYmdSafe(ymd);
    const today = parseYmdSafe(taipeiTodayYMD());
    if (!target || !today) return Number.POSITIVE_INFINITY;

    const utcTarget = Date.UTC(target.getFullYear(), target.getMonth(), target.getDate());
    const utcToday = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
    const diffMs = utcToday - utcTarget;
    return Math.floor(diffMs / 86400000);
  }

  function pruneDetailCache(detailCacheMap, rows, uniqueCancelled) {
    if (!detailCacheMap || typeof detailCacheMap !== "object") {
      return {
        removedCancelled: 0,
        removedStale: 0,
        staleDays: detailCacheStaleDays,
        activeRowsCount: 0,
        cacheKeysBefore: 0,
        cacheKeysAfter: 0
      };
    }

    const activeKeys = new Set(
      (Array.isArray(rows) ? rows : [])
        .map((r) => stableKey(r))
        .filter(Boolean)
    );
    const cancelledSet = new Set((Array.isArray(uniqueCancelled) ? uniqueCancelled : []).map((x) => String(x || "").trim()).filter(Boolean));
    const cacheKeysBefore = Object.keys(detailCacheMap).length;

    let removedCancelled = 0;
    let removedStale = 0;

    for (const key of Object.keys(detailCacheMap)) {
      if (activeKeys.has(key)) continue;

      if (cancelledSet.has(key)) {
        delete detailCacheMap[key];
        removedCancelled++;
        continue;
      }

      const updatedAt = detailCacheMap[key] && detailCacheMap[key].updatedAt ? detailCacheMap[key].updatedAt : "";
      const staleDays = diffDaysFromTodayTaipei(updatedAt);
      if (detailCacheStaleDays > 0 && staleDays > detailCacheStaleDays) {
        delete detailCacheMap[key];
        removedStale++;
      }
    }

    const cacheKeysAfter = Object.keys(detailCacheMap).length;
    return {
      removedCancelled,
      removedStale,
      staleDays: detailCacheStaleDays,
      activeRowsCount: activeKeys.size,
      cacheKeysBefore,
      cacheKeysAfter
    };
  }

// =======================================================
// ✅ 訂單變動判斷（Snapshot Signature）
// -------------------------------------------------------
// 設計原則：
// - 只依賴 calendar_list API 的資料
// - 不依賴 detail API（電話 / 房型 / 專案名稱）
// - 避免 detail cache 命中時導致 JSON 不更新
//
// 會影響 snapshot 的欄位：
// - 入住日期
// - 退房日期
// - 訂單款項
// - 已收金額
// - 剩餘尾款
//
// 也納入判斷（含 detail 補齊欄位）：
// - 房型
// - 專案名稱
// - 電話
// =======================================================

function stableSig(row) {
  const parts = [
    row["入住日期"],
    row["退房日期"],
    row["訂單款項"],
    row["已收金額"],
    row["剩餘尾款"],
    row["房型"],
    row["專案名稱"],
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
      const msg = String(e && e.message ? e.message : e);
      const msgLower = msg.toLowerCase();
      const errType = msgLower.includes("context closed") ? "context_closed" :
        msgLower.includes("timeout") ? "timeout" : "network_transport";
      throw new Error(
        `GAS POST failed (${errType}): hotelId=${hotelId}\n` +
        "Fix: ODIN_SHEET_WEBAPP_URL 可能含空白/換行/引號，或不是 /exec。\n" +
        `Diag: ${JSON.stringify(diag)}\n` +
        `Err: ${msg}`
      );
    }

    const http = resp.status();
    const text = await resp.text().catch(() => "");
    const headers = resp.headers();
    const contentType = headers["content-type"] || headers["Content-Type"] || "";

    let j = null;
    try { j = JSON.parse(text); } catch (_) {}

    if (http < 200 || http >= 300) {
      const classified = _classifyGasHttpFailure_({ http, contentType, text });
      const diag = _urlDiag_(gasUrlRaw);
      const safeUrl = _safeUrlInfo_(gasUrlRaw);
      throw new Error(
        `GAS sync failed (${classified.code}): hotelId=${hotelId} http=${http}\n` +
        `Hint: ${classified.hint}\n` +
        "Next: 1) 確認 ODIN_SHEET_WEBAPP_URL 是目前 Deployment 的 /exec\n" +
        "      2) Apps Script → Deployments 檢查版本與存取權\n" +
        "      3) Apps Script → Executions 確認是否有命中紀錄\n" +
        `Diag: ${JSON.stringify({ contentType, safeUrl, urlRaw: diag })}\n` +
        `Body: ${_normalizeSnippet_(text)}`
      );
    }

    if (!j || j.ok !== true) {
      throw new Error(
        `GAS sync not ok (gas_app_response_error): hotelId=${hotelId} http=${http}\n` +
        `Body: ${text.slice(0, 800)}`
      );
    }

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
    const hotelStartedAt = Date.now();
    const hotelName = hotelNameById[String(hotelId)] || "";
    const rangeStr = buildRangeStr();

    const rows = [];
    const cancelledOrderNos = [];
    let pageNo = 1;
    let totalPages = 1;
    const timer = { calendarListMs: 0, detailTotalMs: 0, gasSyncMs: 0 };

    const cancelledSkipped = { count: 0 };
    let hotelScheduledFullRewrite = scheduledFullRewriteByClock;
    let hotelChangedOnlyEffective = changedOnlyBase;
    let hotelCancelScanEffective = cancelScanBase;

    // ✅ 讀入「每館別」detail 快取（repo SSOT）
    ensureDirSafe(ssotCacheDir);
    const cachePath = cachePathFor(hotelId);
    const detailCacheMap = readJsonFileSafe(cachePath, {});
    const detailCacheHit = { count: 0 };
    const detailCacheMiss = { count: 0 };
    const detailCacheWrite = { count: 0 };

    // -----------------------------
    // ✅ 第一輪：依 ODIN_ORDER_STATUS 抓「主要訂單」
    // -----------------------------
    while (pageNo <= totalPages) {
      const listUrl = buildListUrl(hotelId, pageNo, rangeStr);
      const listStartedAt = Date.now();
      const listRes = await page.request.get(listUrl, { headers: baseHeaders, timeout: apiTimeoutMs });
      const listStatus = listRes.status();
      const listJson = await listRes.json().catch(() => ({}));
      timer.calendarListMs += Date.now() - listStartedAt;
      const listAnomaly = detectAnomalyFromResponse(listUrl, listStatus, listJson);
      if (listAnomaly.hit) {
        const err = new Error(`ANOMALY_DETECTED: hotelId=${hotelId} page=${pageNo} reason=${listAnomaly.reason}`);
        err.isOwlAnomaly = true;
        throw err;
      }

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

      const pageOrders = [];

      for (const it of listData) {
        const orderSerial = pick(it, ["order_serial", "serial", "orderNo", "order_no", "order_number", "orderNumber"]);
        if (!orderSerial || !String(orderSerial).startsWith("OBE")) continue;
        
        const cancelled = isCancelledOrder(it);
        
        // ✅ 第一輪只做診斷與過濾，不直接加入 cancelledOrderNos
        if (cancelled) {
          console.log("⚠️ primary_list cancelled-like row:", hotelId, String(orderSerial), {
            status: pick(it, ["status", "order_status", "booking_status", "state", "status_text", "order_status_text"])
          });
        }
        
        if (excludeCancelled && cancelled) {
          cancelledSkipped.count++;
          continue;
        }

        pageOrders.push({
          it,
          key: String(orderSerial),
          projectName: pick(it, ["plan_name", "project_name", "rate_plan_name", "source", "order_category"]),
          roomType: pick(it, ["room_names", "room_type_name", "roomTypeName", "room_type"]),
          phone: normalizePhone(pick(it, ["phone", "mobile", "tel", "customer_phone"]))
        });
      }

      if (fetchDetail && pageOrders.length) {
        const detailTargets = [];

        for (const order of pageOrders) {
          const cached = detailCacheMap && detailCacheMap[order.key] ? detailCacheMap[order.key] : null;
          const cacheOk = cached && typeof cached === "object";

          if (cacheOk && !detailForceRefreshEffective) {
            detailCacheHit.count++;
            if (cached.projectName) order.projectName = String(cached.projectName);
            if (cached.roomType) order.roomType = String(cached.roomType);
            if (cached.phone) order.phone = normalizePhone(cached.phone);
            continue;
          }

          detailCacheMiss.count++;
          detailTargets.push(order);
        }

        await runWithConcurrency(detailTargets, detailConcurrency, async (order) => {
          const delayMs = randomIntInclusive(refreshDetailThrottleMinMs, refreshDetailThrottleMaxMs);
          if (delayMs > 0) await sleep(delayMs);

          const detailStartedAt = Date.now();
          const detailRes = await fetchOrderDetail(hotelId, order.key, baseHeaders);
          timer.detailTotalMs += Date.now() - detailStartedAt;
          const detailAnomaly = detectAnomalyFromResponse(detailRes.url, detailRes.httpStatus, detailRes.json);
          if (detailAnomaly.hit) {
            const err = new Error(`ANOMALY_DETECTED: hotelId=${hotelId} order=${order.key} reason=${detailAnomaly.reason}`);
            err.isOwlAnomaly = true;
            throw err;
          }
          if (detailRes.ok && detailRes.json && typeof detailRes.json === "object") {
            const extractedProject = extractProjectNameFromDetail(detailRes.json);
            const extractedRoomType = extractRoomTypeFromDetail(detailRes.json);
            const extractedPhone = extractPhoneFromDetail(detailRes.json);

            if (extractedProject) order.projectName = extractedProject;
            if (extractedRoomType) order.roomType = extractedRoomType;
            if (extractedPhone) order.phone = normalizePhone(extractedPhone);

            detailCacheMap[order.key] = {
              projectName: order.projectName || "",
              roomType: order.roomType || "",
              phone: order.phone || "",
              updatedAt: taipeiTodayYMD()
            };
            detailCacheWrite.count++;
          } else {
            detailCacheMap[order.key] = {
              projectName: order.projectName || "",
              roomType: order.roomType || "",
              phone: order.phone || "",
              updatedAt: taipeiTodayYMD(),
              note: "detail_fetch_failed"
            };
            detailCacheWrite.count++;
          }
        });
      }

      for (const order of pageOrders) {
        const { it, key, projectName, roomType, phone } = order;

        const totalAmountRaw = pick(it, ["total", "total_amount", "amount", "price", "order_total", "order_amount"]);
        const paidAmountRaw = pick(it, ["paid", "paid_amount", "total_paid", "paid_total", "received_amount", "received"]);
        const unpaidAmountRaw = pick(it, ["unpaid", "remain", "unpaid_amount", "remaining_amount", "balance", "balance_due"]);

        const totalAmount = toAmount(totalAmountRaw);

        let paidAmount = toAmount(paidAmountRaw);
        let unpaidAmount = toAmount(unpaidAmountRaw);

        // 盡量補齊金額欄位：若 API 只給了其中兩個值，推算第三個
        const totalN = toNumberSafe(totalAmountRaw);
        const paidN = toNumberSafe(paidAmountRaw);
        const unpaidN = toNumberSafe(unpaidAmountRaw);

        if (!paidAmount && Number.isFinite(totalN) && Number.isFinite(unpaidN)) {
          paidAmount = String(Math.max(0, totalN - unpaidN));
        }

        if (!unpaidAmount && Number.isFinite(totalN) && Number.isFinite(paidN)) {
          unpaidAmount = String(Math.max(0, totalN - paidN));
        }

        const row = {
          訂單日期: toSheetDate(pick(it, ["created_at", "createdAt", "order_created_at", "orderDate", "order_date"])),
          訂單編號: key,
          入住日期: toSheetDate(pick(it, ["sdate", "checkin_date", "checkinDate", "check_in"])),
          退房日期: toSheetDate(pick(it, ["edate", "checkout_date", "checkoutDate", "check_out"])),
          姓名: pick(it, ["fullname", "customer_name", "guest_name", "name", "lastname", "firstname"]),
          房型: roomType || "",
          專案名稱: projectName || "",
          訂單款項: totalAmount,
          已收金額: paidAmount,
          剩餘尾款: unpaidAmount,
          UUID: pick(it, ["uuid", "order_uuid", "id", "order_id"]),
          電話: phone || ""
        };

        if (!row.入住日期 || !row.退房日期) continue;
        rows.push(row);
      }

      pageNo++;
    }

    // =======================================================
    // ✅ 第二輪（可選）：掃描取消單，只收集 cancelledOrderNos
    // =======================================================
    if (hotelCancelScanEffective && cancelOrderStatusList.length) {
      let cancelScanNonCancelledSkipped = 0;
      for (const cancelStatus of cancelOrderStatusList) {
        let cp = 1;
        let ctp = 1;

        while (cp <= ctp) {
          const cancelUrl = buildListUrl(hotelId, cp, rangeStr, cancelStatus);

          let cancelRes;
          try {
            cancelRes = await page.request.get(cancelUrl, { headers: baseHeaders, timeout: cancelApiTimeoutMs });
          } catch (e) {
            const errMsg = String(e && e.message ? e.message : e);
            console.warn(`⚠️ cancel_scan request timeout: hotelId=${hotelId} status=${cancelStatus} page=${cp} err=${errMsg}`);
            break;
          }

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
            // ✅ 保險：即使第二輪用 cancel status 查詢，仍再次驗證該筆真的為取消單
            // 避免 API 在某些狀況回混合狀態，導致正常單被誤送到 cancelledOrderNos。
            if (!isCancelledOrder(it)) {
              cancelScanNonCancelledSkipped++;
              continue;
            }
            cancelledOrderNos.push(String(orderSerial));
          }

          cp++;
        }
      }
      if (cancelScanNonCancelledSkipped > 0) {
        console.log("⚠️ cancel_scan skipped non-cancelled rows:", hotelId, "count =", cancelScanNonCancelledSkipped);
      }
    }

    const uniqueCancelled = Array.from(new Set(cancelledOrderNos));
    const pruneResult = pruneDetailCache(detailCacheMap, rows, uniqueCancelled);

    // ✅ 先落 out/
    const sheetReadyPath = `${outDir}/orders_sheet_ready_${hotelId}.json`;
    fs.writeFileSync(
      sheetReadyPath,
      JSON.stringify({ hotelId, hotelName, rangeStr, columns, rows }, null, 2),
      "utf8"
    );

    // ✅ SSOT：同步寫到 repo（latest）
    ensureDirSafe(ssotLatestDir);
    try { fs.copyFileSync(sheetReadyPath, path.join(ssotLatestDir, `orders_sheet_ready_${hotelId}.json`)); } catch (_) {}

    // ✅ SSOT：寫回 detail cache（repo）
    writeJsonFileSafe(cachePath, detailCacheMap);

    console.log("✅ wrote:", sheetReadyPath, "rows =", rows.length);
    if (excludeCancelled) console.log("🚫 cancelled skipped:", hotelId, "count =", cancelledSkipped.count);
    console.log("🧾 detailCache:", hotelId, "hit =", detailCacheHit.count, "miss =", detailCacheMiss.count, "write =", detailCacheWrite.count);
    console.log("🧹 detailCache housekeeping:", hotelId, pruneResult);
    const snapshotPath = snapshotPathFor(hotelId);
    const prevSnapshot = readSnapshotSafe(snapshotPath);
    const prevSnapshotCount = Object.keys(prevSnapshot).length;

    if (hotelScheduledFullRewrite) {
      let blockedReason = "";
      if (rows.length === 0) {
        blockedReason = "rows=0";
      } else if (prevSnapshotCount > 0) {
        const minByRatio = Math.ceil(prevSnapshotCount * fullRewriteMinRatio);
        const minByDrop = Math.max(0, prevSnapshotCount - fullRewriteMaxDrop);

        // ✅ 採用更嚴格門檻：
        // 必須同時滿足比例與最大掉筆數，才允許 full rewrite
        // 換句話說，取兩者較嚴格的那個門檻
        const minRequired = Math.max(minByRatio, minByDrop);

        if (rows.length < minRequired) {
          blockedReason =
            `rows=${rows.length} < minRequired=${minRequired} ` +
            `(minByRatio=${minByRatio}, minByDrop=${minByDrop}, prev=${prevSnapshotCount})`;
        }
      }

      if (blockedReason) {
        hotelScheduledFullRewrite = false;
        hotelChangedOnlyEffective = false; // fallback: 全量 upsert（不清表、不用 changedOnly）
        hotelCancelScanEffective = false;
        console.log("⚠️ FULL_REWRITE_BLOCKED_FALLBACK_TO_UPSERT:", hotelId, blockedReason);
      } else {
        console.log("✅ FULL_REWRITE_ALLOWED:", hotelId, `rows=${rows.length}`, `prevSnapshot=${prevSnapshotCount}`);
      }
    }

    console.log("🧾 cancelScan:", hotelCancelScanEffective ? "ON" : "OFF", "| cancelIncoming(unique) =", uniqueCancelled.length);

    let rowsToSync = rows;

    if (hotelChangedOnlyEffective) {
      const prev = prevSnapshot;
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

      rowsToSync = out;
      console.log("✅ changedOnly=1:", hotelId, "changed rows =", out.length, "snapshot =", snapshotPath);
    } else {
      // 非 changedOnly（含 full rewrite 與 blocked fallback）仍更新 snapshot，供下輪完整性檢查
      const next = {};
      for (const r of rows) {
        const k = stableKey(r);
        if (!k) continue;
        next[k] = stableSig(r);
      }
      writeSnapshotSafe(snapshotPath, next);
    }

    const gasStartedAt = Date.now();
    await syncToSheetOrThrow(
      {
        token: sheetToken,
        spreadsheetId,
        hotelId,
        hotelName,
        columns,
        rows: rowsToSync,
        cancelledOrderNos: uniqueCancelled,
        replaceAllRows: hotelScheduledFullRewrite,
        rangeStr
      },
      hotelId,
      hotelName
    );
    timer.gasSyncMs += Date.now() - gasStartedAt;

    console.log("🧾 sync payload:", hotelId, "rows =", rowsToSync.length, "(total rows =", rows.length + ")", "| mode=", hotelScheduledFullRewrite ? "FULL_REWRITE" : (hotelChangedOnlyEffective ? "CHANGED_ONLY" : "UPSERT"));

    if (!rows.length) {
      console.log("⚠️ rows=0:", hotelId, hotelName ? `(${hotelName})` : "", "可能區間內沒訂單或被過濾");
    }
    console.log("⏱️ hotel timing:", hotelId, {
      calendar_list_ms: timer.calendarListMs,
      detail_total_ms: timer.detailTotalMs,
      gas_sync_ms: timer.gasSyncMs,
      total_ms: Date.now() - hotelStartedAt
    });
  }

  // -----------------------------
  // 5) ✅ 多館別輪巡
  // -----------------------------
  console.log("🧭 hotels to run:", hotelIds.join(","));
  let stopRemainingHotels = false;
  for (let i = 0; i < hotelIds.length; i++) {
    const hid = hotelIds[i];
    if (stopRemainingHotels) {
      console.log("⏹️ skip hotel due to earlier anomaly:", hid);
      continue;
    }
    try {
      await runOneHotel(hid);
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      if (e && e.isOwlAnomaly) {
        stopRemainingHotels = true;
        console.error("🛑 OWL anomaly detected. stop remaining hotels in this run.", { hotelId: hid, error: msg });
        throw e;
      }
      throw e;
    }

    if (i < hotelIds.length - 1) {
      const hotelDelayMs = randomIntInclusive(hotelThrottleMinMs, hotelThrottleMaxMs);
      if (hotelDelayMs > 0) {
        await page.waitForTimeout(hotelDelayMs);
      }
    }
  }

  console.log("✅ done:", hotelIds.length, "hotels");
});
