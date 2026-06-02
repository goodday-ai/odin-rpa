// 功能：執行 Admin Rate Inventory Snapshot Sync v1 的完整單品牌同步流程。
// 責任：登入 Owlting 後台、抓 calendars API、normalize、建立 LINE 可讀 snapshot、成功才產生 publish candidate、失敗只寫 out artifact。
// 關聯模組：adminLoginAndCaptureAuth 提供登入；buildCalendarsApiRequest/normalizeCalendarsRateInventory 重用 dry-run fetcher；publishRateInventorySnapshot 寫 latest。
// 關鍵流程：load config → login/auth capture → GET calendars → normalize → build/validate snapshot → artifact → conditional publish → exit code。

const fs = require("node:fs/promises");
const path = require("node:path");
const { buildCalendarsApiRequest } = require("../adminRateInventoryFetcher/buildCalendarsApiRequest");
const { normalizeCalendarsRateInventory } = require("../adminRateInventoryFetcher/normalizeCalendarsRateInventory");
const { sanitizeAdminRateInventorySnapshot, createControlledStopSnapshot } = require("../adminRateInventoryFetcher/sanitizeAdminRateInventorySnapshot");
const { adminLoginAndCaptureAuth, hasCredentials } = require("../adminRateInventoryProbe/adminLoginAndCaptureAuth");
const { buildRateInventorySnapshot } = require("./buildRateInventorySnapshot");
const { loadEnabledTenantConfig, validateRateInventorySnapshotConfig } = require("./loadRateInventorySnapshotConfig");
const { publishRateInventorySnapshot } = require("./publishRateInventorySnapshot");

const CONTROLLED_STOP_REASONS = new Set([
  "remote_403",
  "remote_429",
  "remote_captcha",
  "remote_login_redirect",
  "parse_no_supported_shape",
  "items=0",
  "summary.truncated=true",
  "publish_disabled",
  "tenant_not_allowed",
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
  "sanitized_audit_failed",
  "publish_validation_failed",
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
  const safeStart = String(config.start || "start").replace(/[^0-9-]/g, "_");
  const safeEnd = String(config.end || "end").replace(/[^0-9-]/g, "_");
  return path.join(config.outDir || "out", `rate_inventory_snapshot_sync_${safeTenant}_${safeStart}_${safeEnd}.json`);
}

async function writeArtifact(config, output) {
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

async function fetchCalendarsJson({ page, url, baseHeaders, timeoutMs }) {
  let response;
  try {
    // 中文註解：同步工具沿用 dry-run 的單次 GET 策略，不做 retry，避免後台 API 被排程放大請求量。
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

  try {
    return { json: await response.json(), status, contentType };
  } catch (error) {
    error.code = "json_parse_failed";
    throw error;
  }
}


function buildSnapshotCalendarsRequest(config) {
  // 中文註解：正式 snapshot sync 必須尊重 loadRateInventorySnapshotConfig 計算出的 maxDays，避免底層 request builder 的 dry-run 預設 92 天擋住 120 天同步。
  return buildCalendarsApiRequest({
    origin: config.origin,
    hotelId: config.hotelId,
    start: config.start,
    end: config.end,
    lang: config.lang,
    maxDays: config.maxDays,
  });
}

function controlledStopArtifact(config, stoppedReason, extra = {}) {
  return createControlledStopSnapshot(
    { tenant: config.tenant, hotelId: config.hotelId, start: config.start, end: config.end },
    stoppedReason,
    extra,
  );
}

async function runRateInventorySnapshotSync({ chromium, env = process.env, config: providedConfig } = {}) {
  const startedAt = Date.now();
  let config;
  try {
    config = providedConfig || loadEnabledTenantConfig(env);
    if (config.mode === "ALL") throw new Error("ALL mode must use runRateInventorySnapshotBatchSync");
  } catch (error) {
    const stoppedReason = error.code === "tenant_not_allowed" ? "tenant_not_allowed" : "invalid_config";
    const fallback = { tenant: env.RATE_INVENTORY_TENANT || "goodday", hotelId: "5720", start: "", end: "", outDir: env.RATE_INVENTORY_OUT_DIR || "out" };
    const artifact = controlledStopArtifact(fallback, stoppedReason, { warnings: [{ reason: String(error.message || error) }] });
    const outputPath = await writeArtifact(fallback, artifact).catch(() => "");
    return { ok: false, stoppedReason, exitCode: outputExitCode(stoppedReason), outputPath };
  }

  safeLog("admin_rate_inventory_snapshot_sync_start", { tenant: config.tenant, hotelId: config.hotelId, rangeStart: config.start, rangeEnd: config.end });

  const configErrors = validateRateInventorySnapshotConfig(config);
  if (configErrors.length > 0) {
    const stoppedReason = configErrors.includes("tenant_not_allowed") ? "tenant_not_allowed" : "invalid_config";
    const artifact = controlledStopArtifact(config, stoppedReason, { warnings: configErrors.map((reason) => ({ reason })) });
    const outputPath = await writeArtifact(config, artifact);
    return { ok: false, stoppedReason, exitCode: outputExitCode(stoppedReason), outputPath };
  }
  if (!hasCredentials(env)) {
    const artifact = controlledStopArtifact(config, "missing_credentials");
    const outputPath = await writeArtifact(config, artifact);
    return { ok: false, stoppedReason: "missing_credentials", exitCode: 1, outputPath };
  }

  const request = buildSnapshotCalendarsRequest(config);
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    const artifact = controlledStopArtifact(config, "browser_launch_error", { request: request.safe, warnings: [{ reason: String(error.message || error) }] });
    const outputPath = await writeArtifact(config, artifact);
    return { ok: false, stoppedReason: "browser_launch_error", exitCode: 1, outputPath };
  }

  try {
    const page = await browser.newPage();
    const { baseHeaders } = await adminLoginAndCaptureAuth({ page, env, lang: config.lang, timeoutMs: config.timeoutMs });
    const fetched = await fetchCalendarsJson({ page, url: request.url, baseHeaders, timeoutMs: config.timeoutMs });
    if (fetched.stoppedReason) {
      const artifact = controlledStopArtifact(config, fetched.stoppedReason, { request: request.safe, durationMs: Date.now() - startedAt });
      const outputPath = await writeArtifact(config, artifact);
      return { ok: false, stoppedReason: fetched.stoppedReason, exitCode: outputExitCode(fetched.stoppedReason), outputPath };
    }

    const normalized = normalizeCalendarsRateInventory(fetched.json, { currency: config.currency, maxItems: config.maxItems });
    if (!normalized.ok || normalized.stoppedReason === "parse_no_supported_shape") {
      const artifact = controlledStopArtifact(config, "parse_no_supported_shape", { request: request.safe, summary: normalized.summary, warnings: normalized.warnings, shapeSummary: normalized.shapeSummary });
      const outputPath = await writeArtifact(config, artifact);
      return { ok: false, stoppedReason: "parse_no_supported_shape", exitCode: 0, outputPath };
    }

    const snapshot = sanitizeAdminRateInventorySnapshot(buildRateInventorySnapshot({ config, normalized, capturedAt: new Date(startedAt).toISOString() }));
    let stoppedReason = "";
    if (snapshot.items.length === 0) stoppedReason = "items=0";
    if (snapshot.summary.truncated === true) stoppedReason = "summary.truncated=true";
    if (stoppedReason) {
      const artifact = { ...snapshot, ok: false, stoppedReason, published: false };
      const outputPath = await writeArtifact(config, artifact);
      return { ok: false, stoppedReason, exitCode: 0, outputPath };
    }

    const publishResult = await publishRateInventorySnapshot(snapshot, config);
    const artifact = { ...snapshot, published: publishResult.published, latestPath: publishResult.latestPath, candidatePath: publishResult.candidatePath, dataBranch: publishResult.dataBranch, publishSkippedReason: publishResult.skippedReason };
    const outputPath = await writeArtifact(config, artifact);
    return { ok: true, stoppedReason: publishResult.skippedReason || "", exitCode: 0, outputPath, latestPath: publishResult.latestPath, candidatePath: publishResult.candidatePath, published: publishResult.published, summary: snapshot.summary, tenant: config.tenant, hotelId: config.hotelId, displayName: config.displayName };
  } catch (error) {
    const stoppedReason = error.code || "internal_error";
    const artifact = controlledStopArtifact(config, stoppedReason, { request: request.safe, durationMs: Date.now() - startedAt, warnings: [{ reason: String(error.message || error) }] });
    const outputPath = await writeArtifact(config, artifact);
    return { ok: false, stoppedReason, exitCode: outputExitCode(stoppedReason), outputPath };
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = {
  CONTROLLED_STOP_REASONS,
  ERROR_REASONS,
  classifyRemoteStop,
  fetchCalendarsJson,
  buildSnapshotCalendarsRequest,
  outputExitCode,
  safeOutputPath,
  writeArtifact,
  runRateInventorySnapshotSync,
};
