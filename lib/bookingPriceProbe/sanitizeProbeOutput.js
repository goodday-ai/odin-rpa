// 功能：對 Booking Price Probe 最終輸出做最後一層敏感資料清理。
// 責任：移除 cookie、authorization、bearer、token、email、phone、訂單編號、uuid 等敏感 key/value。
// 關聯模組：runBookingPriceProbe 寫檔前必須呼叫；unit test 直接驗證本模組防線。
// 關鍵流程：遞迴白名單化安全欄位 → 移除敏感 key → URL 字串轉安全 info → 建立 controlled stop payload。

const { safeUrlInfo } = require("./safeUrlInfo");

const SENSITIVE_RE = /(cookie|authorization|bearer|token|secret|password|email|phone|mobile|tel|姓名|電話|信箱|訂單編號|order_serial|order_no|uuid|identity)/i;
const URL_LIKE_RE = /^https?:\/\//i;

function sanitizeString(value) {
  const text = String(value);
  if (SENSITIVE_RE.test(text) || /@/.test(text) || /\+?\d[\d\s().-]{7,}/.test(text)) return "";
  if (URL_LIKE_RE.test(text)) {
    const info = safeUrlInfo(text);
    return `${info.origin}${info.pathname}`;
  }
  return text;
}

const SAFE_STRING_KEYS = new Set([
  "tenant", "bookingUrlOrigin", "bookingUrlPath", "probeStart", "probeEnd", "lang", "capturedAt",
  "stoppedReason", "method", "contentType", "requestUrlOrigin", "requestUrlPath", "sourcePath",
  "type", "topLevelType", "path", "outputPath",
]);

function sanitizeValue(value, keyName = "") {
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item)).filter((item) => item !== undefined);
  if (!value || typeof value !== "object") {
    if (typeof value !== "string") return value;
    // 已知安全欄位是探測參數或 URL 分解結果；保留日期 / origin / path，仍阻擋敏感關鍵字。
    if (SAFE_STRING_KEYS.has(keyName) || /Origin$|Path$/.test(keyName)) return SENSITIVE_RE.test(value) ? "" : value;
    return sanitizeString(value);
  }

  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_RE.test(key)) continue;
    if (key === "body" || key === "rawBody" || key === "responseBody" || key === "headers") continue;
    output[key] = sanitizeValue(child, key);
  }
  return output;
}

function sanitizeProbeOutput(output) {
  return sanitizeValue(output);
}

function createControlledStopOutput(config, stoppedReason, extra = {}) {
  const bookingInfo = safeUrlInfo(config.bookingUrl || "");
  return sanitizeProbeOutput({
    ok: false,
    tenant: config.tenant || "",
    bookingUrlOrigin: bookingInfo.origin,
    bookingUrlPath: bookingInfo.pathname,
    probeStart: config.start || "",
    probeEnd: config.end || "",
    adult: config.adult ?? 1,
    child: config.child ?? 0,
    infant: config.infant ?? 0,
    lang: config.lang || "zh_TW",
    capturedAt: new Date().toISOString(),
    durationMs: extra.durationMs || 0,
    stoppedReason,
    summary: {
      responseSeenCount: extra.responseSeenCount || 0,
      jsonResponseCount: extra.jsonResponseCount || 0,
      candidateCount: extra.candidateCount || 0,
      normalizedOfferCount: extra.normalizedOfferCount || 0,
      skipped: {
        nonJson: extra.skipped?.nonJson || 0,
        non200: extra.skipped?.non200 || 0,
        originNotAllowed: extra.skipped?.originNotAllowed || 0,
        bodyTooLarge: extra.skipped?.bodyTooLarge || 0,
        jsonParseFailed: extra.skipped?.jsonParseFailed || 0,
      },
    },
    minPriceSummary: { hasPrice: false, minPrice: null, currency: "", offerCount: 0 },
    candidates: [],
    normalizedOffers: [],
  });
}

module.exports = {
  SENSITIVE_RE,
  sanitizeProbeOutput,
  createControlledStopOutput,
};
