// 功能：將 Booking Price Probe 涉及的網址轉成安全摘要，只保留 origin、pathname 與 query key。
// 責任：避免 log / JSON 輸出完整 query value、cookie 或 token 類敏感片段。
// 關聯模組：buildProbeUrl、runBookingPriceProbe、detectPriceApiCandidate 會使用本模組建立安全 URL 欄位。
// 關鍵流程：解析 URL → 排序 query key → 回傳可序列化的安全資訊；解析失敗時只回傳空值。

function safeUrlInfo(input) {
  try {
    const parsed = input instanceof URL ? input : new URL(String(input));
    return {
      origin: parsed.origin,
      pathname: parsed.pathname || "/",
      queryKeys: Array.from(new Set(Array.from(parsed.searchParams.keys()))).sort(),
    };
  } catch (_error) {
    return { origin: "", pathname: "", queryKeys: [] };
  }
}

function toRequestUrlFields(input) {
  const info = safeUrlInfo(input);
  return {
    requestUrlOrigin: info.origin,
    requestUrlPath: info.pathname,
    requestQueryKeys: info.queryKeys,
  };
}

module.exports = {
  safeUrlInfo,
  toRequestUrlFields,
};
