// 功能：執行一次獨立的 Admin Rate Inventory Fetcher Dry Run，登入後直接呼叫 calendars range API 並輸出標準化 snapshot。
// 責任：控制 Playwright lifecycle、Bearer/baseHeaders capture、單次 API fetch、JSON 大小/狀態檢查、normalize/sanitize/write artifact 與 exit 分類。
// 關聯模組：scripts/adminRateInventoryFetcherDryRun.js 注入 chromium；adminRateInventoryProbe/adminLoginAndCaptureAuth 提供既有登入能力。
// 關鍵流程：load config → validate → launch/login/auth capture → build calendars API request → single request.get → normalize → sanitize → write out/admin_rate_inventory_fetcher_dryrun_*.json。

const fs = require("node:fs/promises");
const path = require("node:path");
const { loadAdminRateFetcherConfig, validateAdminRateFetcherConfig } = require("./loadAdminRateFetcherConfig");
const { buildCalendarsApiRequest } = require("./buildCalendarsApiRequest");
const { normalizeCalendarsRateInventory } = require("./normalizeCalendarsRateInventory");
const { sanitizeAdminRateInventorySnapshot, createControlledStopSnapshot } = require("./sanitizeAdminRateInventorySnapshot");
const { buildUniquePlanItems, buildUniquePlans } = require("./summarizeAdminRateInventoryUniquePlans");
const { adminLoginAndCaptureAuth, hasCredentials } = require("../adminRateInventoryProbe/adminLoginAndCaptureAuth");

const CONTROLLED_STOP_REASONS = new Set([
  "remote_403",
  "remote_429",
  "remote_captcha",
  "remote_login_redirect",
  "no_rate_inventory_items",
  "parse_no_supported_shape",
]);

const ERROR_REASONS = new Set([
  "invalid_config",
  "missing_credentials",
  "browser_launch_error",
  "login_failed",
  "auth_capture_failed",
  "fetch_error",
  "json_parse_failed",
  "output_write_error",
  "internal_error",
]);

function safeLog(eventName, payload = {}) {
  console.log(eventName, JSON.stringify(sanitizeAdminRateInventorySnapshot(payload)));
}

function outputExitCode(stoppedReason) {
  if (ERROR_REASONS.has(stoppedReason)) return 1;
  if (CONTROLLED_STOP_REASONS.has(stoppedReason)) return 0;
  return 0;
}

function safeOutputPath(config) {
  const safeTenant = String(config.tenant || "tenant").replace(/[^a-zA-Z0-9_-]/g, "_") || "tenant";
  const safeHotelId = String(config.hotelId || "hotel").replace(/[^0-9]/g, "_") || "hotel";
  const safeStart = String(config.start || "start").replace(/[^0-9-]/g, "_");
  const safeEnd = String(config.end || "end").replace(/[^0-9-]/g, "_");
  return path.join(config.outDir || "out", `admin_rate_inventory_fetcher_dryrun_${safeTenant}_${safeHotelId}_${safeStart}_${safeEnd}.json`);
}

async function writeFetcherOutput(config, output) {
  const outputPath = safeOutputPath(config);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(sanitizeAdminRateInventorySnapshot(output), null, 2)}\n`, "utf8");
  return outputPath;
}

function classifyRemoteStop({ status, url, contentType }) {
  const safe = String(url || "").toLowerCase();
  const type = String(contentType || "").toLowerCase();
  if (status === 403) return "remote_403";
  if (status === 429) return "remote_429";
  if (safe.includes("captcha") || safe.includes("challenge") || safe.includes("cf-chl") || safe.includes("cloudflare")) return "remote_captcha";
  if (safe.includes("login") || safe.includes("signin") || safe.includes("sign-in") || (status >= 300 && status < 400 && safe.includes("auth"))) return "remote_login_redirect";
  if (type.includes("text/html") && /login|signin|captcha|challenge/.test(safe)) return "remote_login_redirect";
  return "";
}

function isJsonContentType(contentType) {
  return /(^|[/+;\s])json($|[;+\s])/i.test(String(contentType || "")) || /application\/json/i.test(String(contentType || ""));
}

function baseSnapshot({ config, request, startedAt, durationMs, normalized, stoppedReason }) {
  return sanitizeAdminRateInventorySnapshot({
    ok: !stoppedReason,
    tenant: config.tenant,
    hotelId: config.hotelId,
    rangeStart: config.start,
    rangeEnd: config.end,
    displayName: config.displayName || "",
    currency: normalized.currency || config.currency || "",
    uniquePlans: buildUniquePlans(normalized.items, { currency: normalized.currency || config.currency || "" }),
    uniquePlanItems: buildUniquePlanItems(normalized.items, { currency: normalized.currency || config.currency || "" }),
    source: "owlting_admin_calendars",
    request: request.safe,
    capturedAt: new Date(startedAt).toISOString(),
    durationMs,
    stoppedReason: stoppedReason || undefined,
    summary: normalized.summary,
    items: normalized.items,
    warnings: normalized.warnings || [],
    shapeSummary: normalized.shapeSummary,
    truncated: normalized.truncated || undefined,
  });
}

async function fetchCalendarsJson({ page, url, baseHeaders, timeoutMs, maxJsonBytes }) {
  let response;
  try {
    // 中文註解：第一版明確限制為單次 GET，不做 retry，避免對後台 API 造成轟炸。
    response = await page.request.get(url, { headers: baseHeaders, timeout: timeoutMs, maxRedirects: 0 });
  } catch (error) {
    error.code = "fetch_error";
    throw error;
  }

  const status = response.status();
  const contentType = response.headers()["content-type"] || "";
  const remoteStop = classifyRemoteStop({ status, url: response.url(), contentType });
  if (remoteStop) return { stoppedReason: remoteStop, status, contentType };
  if (status !== 200) return { stoppedReason: "fetch_error", status, contentType };
  if (!isJsonContentType(contentType)) return { stoppedReason: "json_parse_failed", status, contentType };

  const body = await response.body();
  if (body.length > maxJsonBytes) return { stoppedReason: "fetch_error", status, contentType, bodyTooLarge: true };
  try {
    return { json: JSON.parse(body.toString("utf8")), status, contentType };
  } catch (error) {
    error.code = "json_parse_failed";
    throw error;
  }
}

async function runAdminRateInventoryFetcherDryRun({ chromium, env = process.env } = {}) {
  const startedAt = Date.now();
  const config = loadAdminRateFetcherConfig(env);
  safeLog("admin_rate_inventory_fetcher_dryrun_start", { tenant: config.tenant, hotelId: config.hotelId, rangeStart: config.start, rangeEnd: config.end });

  let request;
  try {
    const validationErrors = validateAdminRateFetcherConfig(config);
    if (validationErrors.length > 0) {
      const output = createControlledStopSnapshot(config, "invalid_config", { warnings: validationErrors.map((reason) => ({ reason })) });
      const outputPath = await writeFetcherOutput(config, output);
      return { exitCode: 1, stoppedReason: "invalid_config", outputPath, output };
    }
    request = buildCalendarsApiRequest({ origin: config.origin, hotelId: config.hotelId, start: config.start, end: config.end, lang: config.lang, maxDays: config.maxDays });
  } catch (error) {
    const output = createControlledStopSnapshot(config, "invalid_config", { durationMs: Date.now() - startedAt, warnings: [{ reason: String(error.message || error) }] });
    const outputPath = await writeFetcherOutput(config, output).catch(() => "");
    return { exitCode: 1, stoppedReason: "invalid_config", outputPath, output };
  }

  if (!hasCredentials(env)) {
    const output = createControlledStopSnapshot(config, "missing_credentials", { request: request.safe, durationMs: Date.now() - startedAt });
    const outputPath = await writeFetcherOutput(config, output);
    return { exitCode: 1, stoppedReason: "missing_credentials", outputPath, output };
  }

  let browser;
  try {
    try {
      browser = await chromium.launch({ headless: true });
    } catch (error) {
      const output = createControlledStopSnapshot(config, "browser_launch_error", { request: request.safe, durationMs: Date.now() - startedAt, warnings: [{ reason: String(error.message || error).slice(0, 120) }] });
      const outputPath = await writeFetcherOutput(config, output);
      return { exitCode: 1, stoppedReason: "browser_launch_error", outputPath, output };
    }

    const page = await browser.newPage();
    let auth;
    try {
      auth = await adminLoginAndCaptureAuth({ page, env, lang: config.lang, timeoutMs: config.timeoutMs });
    } catch (error) {
      const reason = error.code === "auth_capture_failed" ? "auth_capture_failed" : "login_failed";
      const output = createControlledStopSnapshot(config, reason, { request: request.safe, durationMs: Date.now() - startedAt, warnings: [{ reason }] });
      const outputPath = await writeFetcherOutput(config, output);
      return { exitCode: 1, stoppedReason: reason, outputPath, output };
    }

    const fetched = await fetchCalendarsJson({ page, url: request.url, baseHeaders: auth.baseHeaders, timeoutMs: config.timeoutMs, maxJsonBytes: config.maxJsonBytes });
    if (fetched.stoppedReason) {
      const output = createControlledStopSnapshot(config, fetched.stoppedReason, {
        request: request.safe,
        durationMs: Date.now() - startedAt,
        warnings: [{ reason: fetched.bodyTooLarge ? "body_too_large" : fetched.stoppedReason }],
      });
      const outputPath = await writeFetcherOutput(config, output);
      return { exitCode: outputExitCode(fetched.stoppedReason), stoppedReason: fetched.stoppedReason, outputPath, output };
    }

    const normalized = normalizeCalendarsRateInventory(fetched.json, { currency: config.currency || "" });
    const stoppedReason = normalized.items.length === 0 ? (normalized.stoppedReason || "no_rate_inventory_items") : "";
    const output = baseSnapshot({ config, request, startedAt, durationMs: Date.now() - startedAt, normalized, stoppedReason });
    const outputPath = await writeFetcherOutput(config, output);
    safeLog("admin_rate_inventory_fetcher_dryrun_done", { tenant: config.tenant, hotelId: config.hotelId, stoppedReason: stoppedReason || "completed", outputPath });
    return { exitCode: outputExitCode(stoppedReason), stoppedReason: stoppedReason || "completed", outputPath, output };
  } catch (error) {
    const reason = error.code && ERROR_REASONS.has(error.code) ? error.code : "internal_error";
    let outputPath = "";
    const output = createControlledStopSnapshot(config, reason, { request: request.safe, durationMs: Date.now() - startedAt, warnings: [{ reason }] });
    try {
      outputPath = await writeFetcherOutput(config, output);
    } catch (_writeError) {
      return { exitCode: 1, stoppedReason: "output_write_error", outputPath: "", output };
    }
    return { exitCode: 1, stoppedReason: reason, outputPath, output };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = {
  CONTROLLED_STOP_REASONS,
  ERROR_REASONS,
  classifyRemoteStop,
  isJsonContentType,
  outputExitCode,
  safeOutputPath,
  writeFetcherOutput,
  runAdminRateInventoryFetcherDryRun,
};
