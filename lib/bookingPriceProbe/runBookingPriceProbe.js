// 功能：執行一次獨立的 Booking Price Probe，開啟官網 URL 並攔截 JSON response。
// 責任：控制 Playwright lifecycle、response 過濾、候選 API 偵測、價格摘要萃取、sanitized JSON 寫檔與 exit 分類。
// 關聯模組：scripts/bookingPriceProbe.js 注入 chromium；其他 bookingPriceProbe/* 模組提供 config/url/sanitize/detect/extract。
// 關鍵流程：load config → build URL → launch browser → collect safe JSON → analyze → write out/booking_price_probe_*.json。

const fs = require("node:fs/promises");
const path = require("node:path");
const { buildProbeUrl, parseInteger } = require("./buildProbeUrl");
const { loadProbeConfig } = require("./loadProbeConfig");
const { safeUrlInfo } = require("./safeUrlInfo");
const { detectPriceApiCandidate } = require("./detectPriceApiCandidate");
const { extractPriceOffers } = require("./extractPriceOffers");
const { sanitizeProbeOutput, createControlledStopOutput } = require("./sanitizeProbeOutput");
const { createNetworkDiagnostics } = require("./networkDiagnostics");

const CONTROLLED_STOP_REASONS = new Set([
  "missing_booking_url",
  "no_candidate_api_detected",
  "no_price_found",
  "remote_403",
  "remote_429",
  "remote_captcha",
  "remote_login_redirect",
  "capture_timeout",
  "origin_not_allowed",
]);

const ERROR_REASONS = new Set([
  "invalid_config",
  "browser_launch_error",
  "output_write_error",
  "internal_error",
]);

function safeLog(eventName, payload = {}) {
  console.log(eventName, JSON.stringify(sanitizeProbeOutput(payload)));
}

function classifyStopReason({ status, url }) {
  const safe = String(url || "").toLowerCase();
  if (status === 403) return "remote_403";
  if (status === 429) return "remote_429";
  if (safe.includes("captcha")) return "remote_captcha";
  if (safe.includes("challenge") || safe.includes("cf-chl") || safe.includes("cloudflare")) return "remote_captcha";
  if (safe.includes("login") || safe.includes("signin") || safe.includes("sign-in")) return "remote_login_redirect";
  return "";
}

function isJsonContentType(contentType) {
  return /(^|[/+;\s])json($|[;+\s])/i.test(String(contentType || "")) || /application\/json/i.test(String(contentType || ""));
}

function safeOutputPath(config) {
  const safeTenant = String(config.tenant || "tenant").replace(/[^a-zA-Z0-9_-]/g, "_") || "tenant";
  const safeStart = String(config.start || "start").replace(/[^0-9-]/g, "_");
  const safeEnd = String(config.end || "end").replace(/[^0-9-]/g, "_");
  return path.join(config.outDir || "out", `booking_price_probe_${safeTenant}_${safeStart}_${safeEnd}.json`);
}

function outputExitCode(stoppedReason) {
  if (ERROR_REASONS.has(stoppedReason)) return 1;
  if (CONTROLLED_STOP_REASONS.has(stoppedReason)) return 0;
  return 0;
}

async function writeProbeOutput(config, output) {
  const outputPath = safeOutputPath(config);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(sanitizeProbeOutput(output), null, 2)}\n`, "utf8");
  return outputPath;
}

function buildBaseOutput({ config, startedAt, durationMs, stoppedReason, stats, diagnostics, candidates, normalizedOffers, minPriceSummary }) {
  const bookingInfo = safeUrlInfo(config.bookingUrl || "");
  return sanitizeProbeOutput({
    ok: stoppedReason === "capture_window_completed",
    tenant: config.tenant,
    bookingUrlOrigin: bookingInfo.origin,
    bookingUrlPath: bookingInfo.pathname,
    probeStart: config.start,
    probeEnd: config.end,
    adult: parseInteger("adult", config.adult, 1),
    child: parseInteger("child", config.child, 0),
    infant: parseInteger("infant", config.infant, 0),
    lang: config.lang || "zh_TW",
    capturedAt: new Date(startedAt).toISOString(),
    durationMs,
    stoppedReason,
    summary: {
      responseSeenCount: stats.responseSeenCount,
      jsonResponseCount: stats.jsonResponseCount,
      candidateCount: candidates.length,
      normalizedOfferCount: normalizedOffers.length,
      skipped: stats.skipped,
    },
    minPriceSummary,
    diagnostics: diagnostics || {
      originSummary: [],
      contentTypeSummary: [],
      statusSummary: [],
      blockedOriginSamples: [],
      nonJsonSamples: [],
      apiLikePathSamples: [],
    },
    candidates,
    normalizedOffers,
  });
}

async function runBookingPriceProbe({ chromium, env = process.env } = {}) {
  const startedAt = Date.now();
  let config = loadProbeConfig(env);
  safeLog("booking_price_probe_start", { tenant: config.tenant, probeStart: config.start, probeEnd: config.end });

  if (!config.bookingUrl) {
    const output = createControlledStopOutput(config, "missing_booking_url", { durationMs: Date.now() - startedAt });
    const outputPath = await writeProbeOutput(config, output);
    safeLog("booking_price_probe_stop", { tenant: config.tenant, stoppedReason: "missing_booking_url" });
    safeLog("booking_price_probe_output_written", { tenant: config.tenant, outputPath: path.basename(outputPath) });
    return { output, outputPath, exitCode: 0 };
  }

  let probeUrl;
  try {
    probeUrl = buildProbeUrl(config);
    // 將治理後的整數值回填 config，確保輸出格式穩定。
    config = {
      ...config,
      adult: parseInteger("adult", config.adult, 1),
      child: parseInteger("child", config.child, 0),
      infant: parseInteger("infant", config.infant, 0),
    };
  } catch (error) {
    const reason = "invalid_config";
    const output = createControlledStopOutput(config, reason, { durationMs: Date.now() - startedAt });
    const outputPath = await writeProbeOutput(config, output);
    safeLog("booking_price_probe_error", { tenant: config.tenant, stoppedReason: reason, message: String(error.message || error) });
    return { output, outputPath, exitCode: 1 };
  }

  const bookingInfo = safeUrlInfo(probeUrl);
  if (!config.allowlistOrigins.includes(bookingInfo.origin)) {
    const output = createControlledStopOutput(config, "origin_not_allowed", { durationMs: Date.now() - startedAt });
    const outputPath = await writeProbeOutput(config, output);
    safeLog("booking_price_probe_stop", { tenant: config.tenant, bookingUrlOrigin: bookingInfo.origin, bookingUrlPath: bookingInfo.pathname, stoppedReason: "origin_not_allowed" });
    safeLog("booking_price_probe_output_written", { tenant: config.tenant, outputPath: path.basename(outputPath) });
    return { output, outputPath, exitCode: 0 };
  }

  safeLog("booking_price_probe_config_loaded", {
    tenant: config.tenant,
    bookingUrlOrigin: bookingInfo.origin,
    bookingUrlPath: bookingInfo.pathname,
    probeStart: config.start,
    probeEnd: config.end,
    adult: config.adult,
    child: config.child,
    infant: config.infant,
  });
  safeLog("booking_price_probe_url_built", { tenant: config.tenant, bookingUrlOrigin: bookingInfo.origin, bookingUrlPath: bookingInfo.pathname });

  const allowlist = new Set(config.allowlistOrigins);
  const stats = {
    responseSeenCount: 0,
    jsonResponseCount: 0,
    skipped: { nonJson: 0, non200: 0, originNotAllowed: 0, bodyTooLarge: 0, jsonParseFailed: 0 },
  };
  const diagnostics = createNetworkDiagnostics({ allowlistOrigins: config.allowlistOrigins });
  const jsonResponses = [];
  let stoppedReason = "capture_window_completed";
  let browser;

  try {
    if (!chromium) throw new Error("chromium_not_provided");
    safeLog("booking_price_probe_browser_start", { tenant: config.tenant });
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ locale: "zh-TW", timezoneId: "Asia/Taipei" });
    const page = await context.newPage();

    page.on("response", async (response) => {
      if (stoppedReason !== "capture_window_completed") return;
      stats.responseSeenCount += 1;
      const request = response.request();
      const url = response.url();
      const info = safeUrlInfo(url);
      const status = response.status();
      const headers = response.headers();
      const contentType = headers["content-type"] || "";
      safeLog("booking_price_probe_response_seen", { tenant: config.tenant, requestUrlOrigin: info.origin, requestUrlPath: info.pathname, status });

      const remoteStop = classifyStopReason({ status, url });
      // 中文註解：diagnostics 僅記錄 response metadata；不讀 body、不保存 headers、不輸出 query value。
      const skipReason = remoteStop
        || (status !== 200 ? "non_200" : "")
        || (!isJsonContentType(contentType) ? "non_json" : "")
        || (!allowlist.has(info.origin) ? "origin_not_allowed" : "");
      diagnostics.recordResponse({ url, status, contentType, skipReason });

      if (remoteStop) {
        stoppedReason = remoteStop;
        safeLog("booking_price_probe_stop", { tenant: config.tenant, stoppedReason });
        return;
      }
      if (status !== 200) {
        stats.skipped.non200 += 1;
        safeLog("booking_price_probe_response_skipped", { tenant: config.tenant, requestUrlOrigin: info.origin, requestUrlPath: info.pathname, stoppedReason: "non_200" });
        return;
      }
      if (!isJsonContentType(contentType)) {
        stats.skipped.nonJson += 1;
        return;
      }
      if (!allowlist.has(info.origin)) {
        stats.skipped.originNotAllowed += 1;
        safeLog("booking_price_probe_response_skipped", { tenant: config.tenant, requestUrlOrigin: info.origin, requestUrlPath: info.pathname, stoppedReason: "origin_not_allowed" });
        return;
      }
      if (jsonResponses.length >= config.maxJsonResponses) return;

      const contentLength = Number(headers["content-length"] || 0);
      if (contentLength > config.maxJsonBytes) {
        stats.skipped.bodyTooLarge += 1;
        return;
      }

      let buffer;
      try {
        buffer = await response.body();
      } catch (_error) {
        stats.skipped.jsonParseFailed += 1;
        return;
      }
      if (buffer.byteLength > config.maxJsonBytes) {
        stats.skipped.bodyTooLarge += 1;
        return;
      }

      try {
        const json = JSON.parse(buffer.toString("utf8"));
        stats.jsonResponseCount += 1;
        jsonResponses.push({ url, method: request.method(), status, contentType, json });
      } catch (_error) {
        stats.skipped.jsonParseFailed += 1;
      }
    });

    try {
      await page.goto(probeUrl, { waitUntil: "domcontentloaded", timeout: config.timeoutMs });
      await page.waitForTimeout(config.captureWindowMs);
    } catch (error) {
      if (/timeout/i.test(String(error.message || error))) {
        stoppedReason = "capture_timeout";
      } else {
        stoppedReason = "internal_error";
      }
    }
  } catch (error) {
    stoppedReason = /chromium|browser|executable/i.test(String(error.message || error)) ? "browser_launch_error" : "internal_error";
    safeLog("booking_price_probe_error", { tenant: config.tenant, stoppedReason, message: String(error.message || error) });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  const candidatesWithJson = jsonResponses
    .map((entry) => ({ entry, candidate: detectPriceApiCandidate(entry) }))
    .filter(({ candidate }) => candidate.score > 0)
    .sort((a, b) => b.candidate.score - a.candidate.score)
    .slice(0, config.maxCandidates);

  const candidates = candidatesWithJson.map(({ candidate }) => candidate);
  for (const candidate of candidates) {
    safeLog("booking_price_probe_response_candidate", { tenant: config.tenant, requestUrlOrigin: candidate.requestUrlOrigin, requestUrlPath: candidate.requestUrlPath, candidateCount: candidates.length });
  }

  let normalizedOffers = [];
  for (const { entry } of candidatesWithJson) {
    const extracted = extractPriceOffers(entry.json, { maxOffers: 20 - normalizedOffers.length });
    normalizedOffers = normalizedOffers.concat(extracted.offers);
    if (normalizedOffers.length >= 20) break;
  }
  const minPrice = normalizedOffers.length ? Math.min(...normalizedOffers.map((offer) => offer.price)) : null;
  const minOffer = normalizedOffers.find((offer) => offer.price === minPrice);
  const minPriceSummary = normalizedOffers.length
    ? { hasPrice: true, minPrice, currency: minOffer?.currency || "", offerCount: normalizedOffers.length }
    : { hasPrice: false, minPrice: null, currency: "", offerCount: 0 };

  if (stoppedReason === "capture_window_completed") {
    if (candidates.length === 0) stoppedReason = "no_candidate_api_detected";
    else if (normalizedOffers.length === 0) stoppedReason = "no_price_found";
  }

  const durationMs = Date.now() - startedAt;
  const output = buildBaseOutput({ config, startedAt, durationMs, stoppedReason, stats, diagnostics: diagnostics.toJSON(), candidates, normalizedOffers, minPriceSummary });

  let outputPath = "";
  try {
    outputPath = await writeProbeOutput(config, output);
  } catch (error) {
    stoppedReason = "output_write_error";
    safeLog("booking_price_probe_error", { tenant: config.tenant, stoppedReason, message: String(error.message || error) });
    return { output: { ...output, ok: false, stoppedReason }, outputPath: "", exitCode: 1 };
  }

  safeLog("booking_price_probe_summary", {
    tenant: config.tenant,
    bookingUrlOrigin: bookingInfo.origin,
    bookingUrlPath: bookingInfo.pathname,
    probeStart: config.start,
    probeEnd: config.end,
    adult: config.adult,
    child: config.child,
    infant: config.infant,
    durationMs,
    stoppedReason,
    candidateCount: candidates.length,
    normalizedOfferCount: normalizedOffers.length,
  });
  safeLog("booking_price_probe_output_written", { tenant: config.tenant, outputPath: path.basename(outputPath) });
  return { output, outputPath, exitCode: outputExitCode(stoppedReason) };
}

module.exports = {
  CONTROLLED_STOP_REASONS,
  ERROR_REASONS,
  buildBaseOutput,
  classifyStopReason,
  isJsonContentType,
  outputExitCode,
  runBookingPriceProbe,
  safeOutputPath,
};
