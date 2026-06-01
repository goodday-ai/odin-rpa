// 功能：對 Admin Rate Inventory Probe 最終輸出做最後一層敏感資料清理。
// 責任：移除 authorization/bearer/token/cookie/order/email/phone/uuid/rawBody/headers 等 key/value，並將 URL 字串降級成 origin+path。
// 關聯模組：runAdminRateInventoryProbe 寫檔前必須呼叫；unit test 與 workflow audit 驗證本模組防線。
// 關鍵流程：敏感 key 判斷 → 遞迴清理 → URL 安全化 → 建立 controlled stop payload。

const { safeAdminUrlInfo, isSensitiveName } = require("./safeAdminUrlInfo");

const SENSITIVE_VALUE_RE = /(authorization|bearer|token|cookie|secret|password|email|phone|mobile|\btel\b|order|order_no|order_serial|uuid|identity|customer|guest|rawbody|headers)/i;
const URL_LIKE_RE = /^https?:\/\//i;

function isSensitiveKey(key) {
  if (!key) return false;
  if (key === "rawBody" || key === "headers" || key === "body" || key === "responseBody") return true;
  return isSensitiveName(key);
}

function sanitizeString(value) {
  const text = String(value);
  // 中文註解：URL 字串先降級成 origin+path，避免 query value 裡的 token 讓整個安全 URL 被清空。
  if (URL_LIKE_RE.test(text)) {
    const info = safeAdminUrlInfo(text);
    return `${info.origin}${info.pathname}`;
  }
  if (SENSITIVE_VALUE_RE.test(text) || /@/.test(text) || /\+?\d[\d\s().-]{7,}/.test(text)) return "";
  return text;
}

const SAFE_STRING_KEYS = new Set([
  "tenant", "hotelId", "targetUrlOrigin", "targetUrlPath", "probeStart", "probeEnd", "capturedAt", "stoppedReason",
  "method", "contentType", "requestUrlOrigin", "requestUrlPath", "origin", "path", "apiMode", "confidence", "recommendedNextStep", "reason", "type", "topLevelType", "skipReason", "lang",
]);

function sanitizeValue(value, keyName = "") {
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item)).filter((item) => item !== undefined && item !== "");
  if (!value || typeof value !== "object") {
    if (typeof value !== "string") return value;
    if (SAFE_STRING_KEYS.has(keyName) || /Origin$|Path$/.test(keyName)) return SENSITIVE_VALUE_RE.test(value) ? "" : value;
    return sanitizeString(value);
  }
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (isSensitiveKey(key)) continue;
    output[key] = sanitizeValue(child, key);
  }
  return output;
}

function sanitizeAdminRateProbeOutput(output) {
  return sanitizeValue(output);
}

function emptySummary(extra = {}) {
  return {
    responseSeenCount: extra.responseSeenCount || 0,
    jsonResponseCount: extra.jsonResponseCount || 0,
    candidateCount: extra.candidateCount || 0,
    rangeApiCandidateCount: extra.rangeApiCandidateCount || 0,
    monthApiCandidateCount: extra.monthApiCandidateCount || 0,
    dayApiCandidateCount: extra.dayApiCandidateCount || 0,
    skipped: {
      nonJson: extra.skipped?.nonJson || 0,
      non200: extra.skipped?.non200 || 0,
      originNotAllowed: extra.skipped?.originNotAllowed || 0,
      bodyTooLarge: extra.skipped?.bodyTooLarge || 0,
      jsonParseFailed: extra.skipped?.jsonParseFailed || 0,
    },
  };
}

function createControlledStopOutput(config = {}, stoppedReason, extra = {}) {
  const targetInfo = safeAdminUrlInfo(config.targetUrl || "");
  return sanitizeAdminRateProbeOutput({
    ok: false,
    tenant: config.tenant || "",
    hotelId: config.hotelId || "",
    targetUrlOrigin: targetInfo.origin,
    targetUrlPath: targetInfo.pathname,
    probeStart: config.start || "",
    probeEnd: config.end || "",
    capturedAt: new Date().toISOString(),
    durationMs: extra.durationMs || 0,
    stoppedReason,
    summary: emptySummary(extra),
    decision: {
      recommendedNextStep: "inspect_probe_output",
      apiMode: "unknown",
      confidence: "low",
      reason: stoppedReason,
    },
    diagnostics: extra.diagnostics || {
      originSummary: [],
      contentTypeSummary: [],
      statusSummary: [],
      apiLikePathSamples: [],
      blockedOriginSamples: [],
      nonJsonSamples: [],
    },
    candidates: [],
  });
}

module.exports = {
  SENSITIVE_VALUE_RE,
  sanitizeAdminRateProbeOutput,
  createControlledStopOutput,
  emptySummary,
};
