// 功能：執行一次獨立的 Admin Rate Inventory Network Probe，登入後台並攔截房價庫存設定頁 JSON response。
// 責任：控制 Playwright lifecycle、登入/token capture、response 過濾、候選 API 偵測、sanitized JSON 寫檔與 exit 分類。
// 關聯模組：scripts/adminRateInventoryProbe.js 注入 chromium；adminRateInventoryProbe/* 模組提供 config/login/diagnostics/detect/sanitize。
// 關鍵流程：load config → validate → login → page.on(response) → goto target URL → capture window → analyze → write out/admin_rate_inventory_probe_*.json。

const fs = require("node:fs/promises");
const path = require("node:path");
const { loadAdminRateProbeConfig, validateAdminRateProbeConfig } = require("./loadAdminRateProbeConfig");
const { adminLoginAndCaptureAuth, hasCredentials } = require("./adminLoginAndCaptureAuth");
const { safeAdminUrlInfo } = require("./safeAdminUrlInfo");
const { createAdminNetworkDiagnostics, normalizeContentType } = require("./adminNetworkDiagnostics");
const { detectRateInventoryCandidate } = require("./detectRateInventoryCandidate");
const { sanitizeAdminRateProbeOutput, createControlledStopOutput } = require("./sanitizeAdminRateProbeOutput");

const CONTROLLED_STOP_REASONS = new Set([
  "no_candidate_api_detected",
  "not_rate_inventory_page",
  "missing_target_url",
  "remote_403",
  "remote_429",
  "remote_captcha",
  "remote_login_redirect",
  "capture_timeout",
]);

const ERROR_REASONS = new Set([
  "invalid_config",
  "missing_credentials",
  "browser_launch_error",
  "login_failed",
  "auth_capture_failed",
  "output_write_error",
  "internal_error",
]);

function isJsonContentType(contentType) {
  return /(^|[/+;\s])json($|[;+\s])/i.test(String(contentType || "")) || /application\/json/i.test(String(contentType || ""));
}

function classifyStopReason({ status, url }) {
  const safe = String(url || "").toLowerCase();
  if (status === 403) return "remote_403";
  if (status === 429) return "remote_429";
  if (safe.includes("captcha") || safe.includes("challenge") || safe.includes("cf-chl") || safe.includes("cloudflare")) return "remote_captcha";
  if (safe.includes("login") || safe.includes("signin") || safe.includes("sign-in")) return "remote_login_redirect";
  return "";
}

function safeLog(eventName, payload = {}) {
  console.log(eventName, JSON.stringify(sanitizeAdminRateProbeOutput(payload)));
}

function safeOutputPath(config) {
  const safeTenant = String(config.tenant || "tenant").replace(/[^a-zA-Z0-9_-]/g, "_") || "tenant";
  const safeHotelId = String(config.hotelId || "hotel").replace(/[^0-9]/g, "_") || "hotel";
  const safeStart = String(config.start || "start").replace(/[^0-9-]/g, "_");
  const safeEnd = String(config.end || "end").replace(/[^0-9-]/g, "_");
  return path.join(config.outDir || "out", `admin_rate_inventory_probe_${safeTenant}_${safeHotelId}_${safeStart}_${safeEnd}.json`);
}

function outputExitCode(stoppedReason) {
  if (ERROR_REASONS.has(stoppedReason)) return 1;
  if (CONTROLLED_STOP_REASONS.has(stoppedReason)) return 0;
  return 0;
}

async function writeProbeOutput(config, output) {
  const outputPath = safeOutputPath(config);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(sanitizeAdminRateProbeOutput(output), null, 2)}\n`, "utf8");
  return outputPath;
}

function buildDecision(candidates) {
  const priority = { range_api: 4, month_api: 3, day_api: 2, unknown: 1, not_rate_inventory: 0 };
  const best = [...candidates].sort((a, b) => {
    const byMode = (priority[b.apiModeInference?.apiMode] || 0) - (priority[a.apiModeInference?.apiMode] || 0);
    if (byMode) return byMode;
    return (b.score || 0) - (a.score || 0);
  })[0];

  if (!best) {
    return { recommendedNextStep: "inspect_probe_output", apiMode: "unknown", confidence: "low", reason: "no candidate API detected" };
  }
  const apiMode = best.apiModeInference.apiMode;
  return {
    recommendedNextStep: apiMode === "range_api" || apiMode === "month_api" ? "build_fetcher" : "inspect_probe_output",
    apiMode,
    confidence: best.apiModeInference.confidence,
    reason: `found candidate with ${apiMode} and score ${best.score}`,
  };
}

function countByMode(candidates, mode) {
  return candidates.filter((candidate) => candidate.apiModeInference?.apiMode === mode).length;
}

function buildBaseOutput({ config, startedAt, durationMs, stoppedReason, stats, diagnostics, candidates }) {
  const targetInfo = safeAdminUrlInfo(config.targetUrl || "");
  return sanitizeAdminRateProbeOutput({
    ok: stoppedReason === "capture_window_completed",
    tenant: config.tenant,
    hotelId: config.hotelId,
    targetUrlOrigin: targetInfo.origin,
    targetUrlPath: targetInfo.pathname,
    probeStart: config.start,
    probeEnd: config.end,
    capturedAt: new Date(startedAt).toISOString(),
    durationMs,
    stoppedReason,
    summary: {
      responseSeenCount: stats.responseSeenCount,
      jsonResponseCount: stats.jsonResponseCount,
      candidateCount: candidates.length,
      rangeApiCandidateCount: countByMode(candidates, "range_api"),
      monthApiCandidateCount: countByMode(candidates, "month_api"),
      dayApiCandidateCount: countByMode(candidates, "day_api"),
      skipped: stats.skipped,
    },
    decision: buildDecision(candidates),
    diagnostics: diagnostics || {
      originSummary: [],
      contentTypeSummary: [],
      statusSummary: [],
      apiLikePathSamples: [],
      blockedOriginSamples: [],
      nonJsonSamples: [],
    },
    candidates,
  });
}

async function runAdminRateInventoryProbe({ chromium, env = process.env } = {}) {
  const startedAt = Date.now();
  const config = loadAdminRateProbeConfig(env);
  safeLog("admin_rate_inventory_probe_start", { tenant: config.tenant, hotelId: config.hotelId, probeStart: config.start, probeEnd: config.end });

  const validationErrors = validateAdminRateProbeConfig(config);
  if (validationErrors.length) {
    const output = createControlledStopOutput(config, "invalid_config", { durationMs: Date.now() - startedAt, validationErrors });
    const outputPath = await writeProbeOutput(config, output);
    return { output, outputPath, exitCode: 1 };
  }

  if (!config.targetUrl) {
    const output = createControlledStopOutput(config, "missing_target_url", { durationMs: Date.now() - startedAt });
    const outputPath = await writeProbeOutput(config, output);
    safeLog("admin_rate_inventory_probe_stop", { tenant: config.tenant, hotelId: config.hotelId, stoppedReason: "missing_target_url" });
    return { output, outputPath, exitCode: 0 };
  }

  const targetInfo = safeAdminUrlInfo(config.targetUrl);
  if (!config.allowlistOrigins.includes(targetInfo.origin)) {
    const output = createControlledStopOutput(config, "invalid_config", { durationMs: Date.now() - startedAt });
    const outputPath = await writeProbeOutput(config, output);
    safeLog("admin_rate_inventory_probe_error", { tenant: config.tenant, hotelId: config.hotelId, stoppedReason: "invalid_config", message: "target origin not allowed" });
    return { output, outputPath, exitCode: 1 };
  }

  if (!hasCredentials(env)) {
    const output = createControlledStopOutput(config, "missing_credentials", { durationMs: Date.now() - startedAt });
    const outputPath = await writeProbeOutput(config, output);
    return { output, outputPath, exitCode: 1 };
  }

  let browser;
  const stats = {
    responseSeenCount: 0,
    jsonResponseCount: 0,
    skipped: { nonJson: 0, non200: 0, originNotAllowed: 0, bodyTooLarge: 0, jsonParseFailed: 0 },
  };
  const diagnostics = createAdminNetworkDiagnostics({ allowlistOrigins: config.allowlistOrigins });
  const jsonResponses = [];
  let stoppedReason = "capture_window_completed";

  try {
    try {
      browser = await chromium.launch({ headless: true });
    } catch (error) {
      const output = createControlledStopOutput(config, "browser_launch_error", { durationMs: Date.now() - startedAt });
      const outputPath = await writeProbeOutput(config, output);
      safeLog("admin_rate_inventory_probe_error", { stoppedReason: "browser_launch_error", message: String(error.message || error) });
      return { output, outputPath, exitCode: 1 };
    }

    const page = await browser.newPage();
    const { baseHeaders } = await adminLoginAndCaptureAuth({ page, env, lang: config.lang, timeoutMs: config.timeoutMs });

    // 中文註解：確認已建立 baseHeaders，但第一版只靠頁面導覽自然觸發 API，不額外用 page.request 轟炸 endpoint。
    if (!baseHeaders || !baseHeaders.authorization) {
      const error = new Error("Base admin headers were not established");
      error.code = "auth_capture_failed";
      throw error;
    }

    page.on("response", async (response) => {
      const request = response.request();
      const url = response.url();
      const status = response.status();
      const contentType = response.headers()["content-type"] || "";
      const info = safeAdminUrlInfo(url);
      const allowed = config.allowlistOrigins.includes(info.origin);
      stats.responseSeenCount += 1;

      let skipReason = "";
      const classified = classifyStopReason({ status, url });
      if (classified && stoppedReason === "capture_window_completed") stoppedReason = classified;
      if (!allowed) {
        skipReason = "origin_not_allowed";
        stats.skipped.originNotAllowed += 1;
      } else if (status < 200 || status >= 300) {
        skipReason = "non_200";
        stats.skipped.non200 += 1;
      } else if (!isJsonContentType(contentType)) {
        skipReason = "non_json";
        stats.skipped.nonJson += 1;
      }
      diagnostics.recordResponse({ url, status, contentType, skipReason });
      if (skipReason || jsonResponses.length >= config.maxJsonResponses) return;

      try {
        const bodyBuffer = await response.body();
        if (bodyBuffer.length > config.maxJsonBytes) {
          stats.skipped.bodyTooLarge += 1;
          return;
        }
        const json = JSON.parse(bodyBuffer.toString("utf8"));
        stats.jsonResponseCount += 1;
        jsonResponses.push({ url, method: request.method(), status, contentType: normalizeContentType(contentType), json });
      } catch (_error) {
        stats.skipped.jsonParseFailed += 1;
      }
    });

    try {
      await page.goto(config.targetUrl, { waitUntil: "domcontentloaded", timeout: config.timeoutMs });
    } catch (error) {
      const message = String(error.message || error).toLowerCase();
      if (message.includes("timeout")) stoppedReason = "capture_timeout";
      else throw error;
    }

    await page.waitForTimeout(config.captureWindowMs);
    const candidates = jsonResponses
      .map((item) => detectRateInventoryCandidate(item))
      .filter((candidate) => candidate._isCandidate)
      .sort((a, b) => b.score - a.score)
      .slice(0, config.maxCandidates)
      .map(({ _isCandidate, ...candidate }) => candidate);

    if (stoppedReason === "capture_window_completed" && candidates.length === 0) stoppedReason = "no_candidate_api_detected";
    const output = buildBaseOutput({
      config,
      startedAt,
      durationMs: Date.now() - startedAt,
      stoppedReason,
      stats,
      diagnostics: diagnostics.toJSON(),
      candidates,
    });
    const outputPath = await writeProbeOutput(config, output);
    safeLog("admin_rate_inventory_probe_output_written", { tenant: config.tenant, hotelId: config.hotelId, outputPath: path.basename(outputPath), stoppedReason });
    return { output, outputPath, exitCode: outputExitCode(stoppedReason) };
  } catch (error) {
    const reason = ERROR_REASONS.has(error.code) ? error.code : "internal_error";
    const output = createControlledStopOutput(config, reason, { durationMs: Date.now() - startedAt, diagnostics: diagnostics.toJSON(), skipped: stats.skipped });
    const outputPath = await writeProbeOutput(config, output);
    safeLog("admin_rate_inventory_probe_error", { stoppedReason: reason, message: String(error.message || error) });
    return { output, outputPath, exitCode: outputExitCode(reason) };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = {
  CONTROLLED_STOP_REASONS,
  ERROR_REASONS,
  buildBaseOutput,
  buildDecision,
  classifyStopReason,
  isJsonContentType,
  outputExitCode,
  runAdminRateInventoryProbe,
  safeOutputPath,
  writeProbeOutput,
};
