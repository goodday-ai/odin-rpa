// 功能：建立 Booking Price Probe 的安全 network diagnostics 摘要。
// 責任：只統計 origin、media type、HTTP status 與去識別化 URL 樣本，不讀取 body、不保留 headers 或 query value。
// 關聯模組：runBookingPriceProbe 在每個 Playwright response 事件呼叫本模組；sanitizeProbeOutput 會在寫檔前再做最後清理。
// 關鍵流程：recordResponse → 安全解析 URL → 更新 top-N 統計與樣本 → toJSON 產出 artifact diagnostics。

const { safeUrlInfo } = require("./safeUrlInfo");

const API_LIKE_KEYWORDS = [
  "api",
  "graphql",
  "room",
  "rooms",
  "rate",
  "price",
  "plan",
  "package",
  "availability",
  "inventory",
  "vacancy",
  "booking",
  "product",
  "hotel",
  "search",
  "calendar",
];

const SENSITIVE_URL_PART_RE = /(cookie|authorization|bearer|token|secret|password|email|phone|mobile|tel|order|uuid)/i;

function normalizeContentType(contentType) {
  const mediaType = String(contentType || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  return mediaType || "unknown";
}

function increment(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function topCounts(map, keyName, limit) {
  return Array.from(map.entries())
    .map(([key, count]) => ({ [keyName]: key, count }))
    .sort((a, b) => b.count - a.count || String(a[keyName]).localeCompare(String(b[keyName])))
    .slice(0, limit);
}

function originSummary(originCounts, allowlist, limit = 20) {
  return topCounts(originCounts, "origin", limit).map((entry) => ({
    origin: entry.origin,
    count: entry.count,
    allowed: allowlist.has(entry.origin),
  }));
}

// 中文註解：query value 永遠不進入 diagnostics；敏感 query key 也在這裡移除，避免 sanitizer 成為唯一防線。
function safeQueryKeys(queryKeys) {
  return Array.from(new Set(queryKeys || []))
    .filter((key) => key && !SENSITIVE_URL_PART_RE.test(String(key)))
    .sort();
}

// 中文註解：path 本身若含 token/email/order/uuid 等敏感字，整筆樣本不輸出，避免暴露識別型路徑。
function buildSafeSample({ url, status, contentType, allowed, skipReason }) {
  const info = safeUrlInfo(url);
  if (!info.origin || !info.pathname) return null;
  if (SENSITIVE_URL_PART_RE.test(info.pathname)) return null;
  const sample = {
    origin: info.origin,
    path: info.pathname,
    queryKeys: safeQueryKeys(info.queryKeys),
    status,
    contentType: normalizeContentType(contentType),
  };
  if (typeof allowed === "boolean") sample.allowed = allowed;
  if (skipReason) sample.skipReason = skipReason;
  return sample;
}

function isApiLikePath({ url }) {
  const info = safeUrlInfo(url);
  const haystack = [info.pathname, ...(info.queryKeys || [])].join(" ").toLowerCase();
  return API_LIKE_KEYWORDS.some((keyword) => haystack.includes(keyword));
}

function createNetworkDiagnostics({ allowlistOrigins = [] } = {}) {
  const allowlist = new Set(allowlistOrigins);
  const originCounts = new Map();
  const contentTypeCounts = new Map();
  const statusCounts = new Map();
  const blockedOriginSamples = [];
  const nonJsonSamples = [];
  const apiLikePathSamples = [];

  function pushSample(samples, sample, limit) {
    if (!sample || samples.length >= limit) return;
    const signature = JSON.stringify(sample);
    if (samples.some((existing) => JSON.stringify(existing) === signature)) return;
    samples.push(sample);
  }

  return {
    // 中文註解：只傳入已由 response event 取得的 metadata；此函式不觸碰 body，也不保存 headers 物件。
    recordResponse({ url, status, contentType, skipReason = "" }) {
      const info = safeUrlInfo(url);
      const normalizedContentType = normalizeContentType(contentType);
      const allowed = allowlist.has(info.origin);
      increment(originCounts, info.origin || "unknown");
      increment(contentTypeCounts, normalizedContentType);
      increment(statusCounts, Number(status) || 0);

      const sampleBase = { url, status, contentType: normalizedContentType, allowed, skipReason };
      if (skipReason === "origin_not_allowed") {
        pushSample(blockedOriginSamples, buildSafeSample({ ...sampleBase, allowed: undefined, skipReason: "" }), 20);
      }

      const nonJsonSample = buildSafeSample(sampleBase);
      if (skipReason === "non_json" && nonJsonSample) {
        // 中文註解：API-like non-json 較能幫助排查 content-type 判斷，因此排在一般靜態資源前面。
        if (isApiLikePath({ url })) nonJsonSamples.unshift(nonJsonSample);
        else pushSample(nonJsonSamples, nonJsonSample, 20);
        if (nonJsonSamples.length > 20) nonJsonSamples.length = 20;
      }

      if (isApiLikePath({ url })) {
        pushSample(apiLikePathSamples, buildSafeSample(sampleBase), 30);
      }
    },
    toJSON() {
      return {
        originSummary: originSummary(originCounts, allowlist, 20),
        contentTypeSummary: topCounts(contentTypeCounts, "contentType", 20),
        statusSummary: topCounts(statusCounts, "status", 20),
        blockedOriginSamples,
        nonJsonSamples,
        apiLikePathSamples,
      };
    },
  };
}

module.exports = {
  API_LIKE_KEYWORDS,
  SENSITIVE_URL_PART_RE,
  buildSafeSample,
  createNetworkDiagnostics,
  isApiLikePath,
  normalizeContentType,
};
