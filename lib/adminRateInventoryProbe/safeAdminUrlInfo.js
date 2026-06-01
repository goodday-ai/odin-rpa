// 功能：將 Admin Rate Inventory Probe 涉及的後台網址轉成安全摘要。
// 責任：只保留 origin、path 與 query key names，永遠不輸出 query value 或 token/cookie 類敏感片段。
// 關聯模組：runAdminRateInventoryProbe、adminNetworkDiagnostics、detectRateInventoryCandidate 都以本模組建立 URL 安全欄位。
// 關鍵流程：解析 URL → 移除敏感 query key → 排序去重 → 回傳可序列化安全資訊。

const SENSITIVE_PART_RE = /(^|[_-])(cookie|authorization|bearer|token|secret|password|email|phone|mobile|tel|order|order_no|order_serial|uuid|identity|customer|guest|headers|rawbody)([_-]|$)/i;

function isSensitiveName(name) {
  const text = String(name || "");
  const compact = text.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().replace(/[^a-z0-9]/g, "_");
  return SENSITIVE_PART_RE.test(compact);
}

function safeAdminUrlInfo(input) {
  try {
    const parsed = input instanceof URL ? input : new URL(String(input));
    return {
      origin: parsed.origin,
      pathname: parsed.pathname || "/",
      queryKeys: Array.from(new Set(Array.from(parsed.searchParams.keys()).filter((key) => !isSensitiveName(key)))).sort(),
    };
  } catch (_error) {
    return { origin: "", pathname: "", queryKeys: [] };
  }
}

function toAdminRequestUrlFields(input) {
  const info = safeAdminUrlInfo(input);
  return {
    requestUrlOrigin: info.origin,
    requestUrlPath: info.pathname,
    requestQueryKeys: info.queryKeys,
  };
}

module.exports = {
  SENSITIVE_PART_RE,
  isSensitiveName,
  safeAdminUrlInfo,
  toAdminRequestUrlFields,
};
