// 功能：建立 Admin Rate Inventory Probe 的安全 network diagnostics 摘要。
// 責任：只統計 origin、content type、HTTP status 與去識別化 URL 樣本，不讀取 body、不保存 headers/query values。
// 關聯模組：runAdminRateInventoryProbe 在 response event 呼叫；sanitizeAdminRateProbeOutput 寫檔前會再做最後清理。
// 關鍵流程：recordResponse → safeAdminUrlInfo → top-N 統計 → allowed/non-json/api-like 安全樣本。

const { safeAdminUrlInfo, isSensitiveName } = require("./safeAdminUrlInfo");

const API_LIKE_KEYWORDS = [
  "api", "graphql", "booking", "admin", "rate", "price", "inventory", "stock", "availability", "calendar",
  "room", "channel", "plan", "policy", "date", "month", "hotel",
];

function normalizeContentType(contentType) {
  return String(contentType || "").split(";")[0].trim().toLowerCase() || "unknown";
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

function safeQueryKeys(queryKeys) {
  return Array.from(new Set(queryKeys || [])).filter((key) => key && !isSensitiveName(key)).sort();
}

function buildSafeSample({ url, status, contentType, allowed, skipReason }) {
  const info = safeAdminUrlInfo(url);
  if (!info.origin || !info.pathname) return null;
  if (isSensitiveName(info.pathname)) return null;
  const sample = {
    origin: info.origin,
    path: info.pathname,
    queryKeys: safeQueryKeys(info.queryKeys),
    status: Number(status) || 0,
    contentType: normalizeContentType(contentType),
  };
  if (typeof allowed === "boolean") sample.allowed = allowed;
  if (skipReason) sample.skipReason = skipReason;
  return sample;
}

function isApiLikePath({ url }) {
  const info = safeAdminUrlInfo(url);
  const haystack = [info.pathname, ...(info.queryKeys || [])].join(" ").toLowerCase();
  return API_LIKE_KEYWORDS.some((keyword) => haystack.includes(keyword));
}

function createAdminNetworkDiagnostics({ allowlistOrigins = [] } = {}) {
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
    // 中文註解：diagnostics 僅接收 metadata；body/header 永遠不進入此物件，降低外洩風險。
    recordResponse({ url, status, contentType, skipReason = "" }) {
      const info = safeAdminUrlInfo(url);
      const normalizedContentType = normalizeContentType(contentType);
      const allowed = allowlist.has(info.origin);
      increment(originCounts, info.origin || "unknown");
      increment(contentTypeCounts, normalizedContentType);
      increment(statusCounts, Number(status) || 0);

      const sampleBase = { url, status, contentType: normalizedContentType, allowed, skipReason };
      if (skipReason === "origin_not_allowed") pushSample(blockedOriginSamples, buildSafeSample({ ...sampleBase, allowed: undefined, skipReason: "" }), 20);
      if (skipReason === "non_json") pushSample(nonJsonSamples, buildSafeSample(sampleBase), 20);
      if (isApiLikePath({ url })) pushSample(apiLikePathSamples, buildSafeSample(sampleBase), 30);
    },
    toJSON() {
      return {
        originSummary: topCounts(originCounts, "origin", 20).map((entry) => ({ ...entry, allowed: allowlist.has(entry.origin) })),
        contentTypeSummary: topCounts(contentTypeCounts, "contentType", 20),
        statusSummary: topCounts(statusCounts, "status", 20),
        apiLikePathSamples,
        blockedOriginSamples,
        nonJsonSamples,
      };
    },
  };
}

module.exports = {
  API_LIKE_KEYWORDS,
  buildSafeSample,
  createAdminNetworkDiagnostics,
  isApiLikePath,
  normalizeContentType,
};
