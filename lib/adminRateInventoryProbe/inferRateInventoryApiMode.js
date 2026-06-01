// 功能：依 request query/path 與 JSON shape 推論後台房價庫存 API 是 range/month/day 或未知型態。
// 責任：用可擴充的訊號組合判斷 API 粒度，不依賴單一硬編碼 endpoint 例外。
// 關聯模組：detectRateInventoryCandidate 產生 detectedFields/sampleShape 後呼叫本模組；unit test 覆蓋主要模式。
// 關鍵流程：正規化 query keys → 統計日期/月訊號 → 評估房價庫存欄位完整度 → 回傳 apiMode/confidence/reasons。

function normalizeKey(key) {
  return String(key || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function hasAny(normalizedKeys, terms) {
  return normalizedKeys.some((key) => terms.some((term) => key === normalizeKey(term) || key.includes(normalizeKey(term))));
}

function allInSameMonth(dateValues) {
  const dates = Array.from(dateValues || []).filter(Boolean);
  if (dates.length < 2) return false;
  const months = new Set(dates.map((date) => String(date).slice(0, 7)));
  return months.size === 1;
}

function hasRateInventorySignals(detectedFields = {}) {
  const hasCommercial = Boolean(detectedFields.hasPrice || detectedFields.hasInventory || detectedFields.hasAvailability);
  const hasStructure = Boolean(detectedFields.hasDate || detectedFields.hasMonth || detectedFields.hasRoom || detectedFields.hasRoomConfig || detectedFields.hasChannel || detectedFields.hasPlan);
  return hasCommercial && hasStructure;
}

function inferRateInventoryApiMode({ requestQueryKeys = [], requestUrlPath = "", detectedFields = {}, sampleShape = {} } = {}) {
  const normalizedKeys = requestQueryKeys.map(normalizeKey);
  const path = String(requestUrlPath || "").toLowerCase();
  const dateValues = Array.isArray(sampleShape.dateValues) ? sampleShape.dateValues : [];
  const dateValueCount = Number(sampleShape.dateValueCount || dateValues.length || 0);
  const monthValueCount = Number(sampleShape.monthValueCount || 0);
  const reasons = [];

  const hasRangeQuery = hasAny(normalizedKeys, ["start", "end", "from", "to", "date_start", "date_end", "start_date", "end_date", "range"]);
  const hasMonthQuery = hasAny(normalizedKeys, ["month", "months", "year_month", "year", "ym"]);
  const hasSingleDateQuery = hasAny(normalizedKeys, ["date", "day"]);
  const pathHasMonth = /\b\d{4}-\d{2}\b/.test(path);
  const fieldsComplete = Boolean((detectedFields.hasPrice || detectedFields.hasInventory || detectedFields.hasAvailability) && (detectedFields.hasDate || detectedFields.hasMonth) && (detectedFields.hasRoom || detectedFields.hasRoomConfig || detectedFields.hasChannel || detectedFields.hasPlan));

  if (!hasRateInventorySignals(detectedFields)) {
    return { apiMode: "not_rate_inventory", confidence: "high", reasons: ["missing rate/inventory/date/room signal combination"] };
  }

  if (hasRangeQuery) reasons.push("requestQueryKeys include start/end/from/to/range");
  if (hasMonthQuery) reasons.push("requestQueryKeys include month/year_month/year");
  if (pathHasMonth) reasons.push("request path contains YYYY-MM");
  if (dateValueCount > 1) reasons.push("response contains multiple date values");
  if (dateValueCount === 1) reasons.push("response contains single date value");
  if (allInSameMonth(dateValues)) reasons.push("response contains same-month date values");
  if (fieldsComplete) reasons.push("detectedFields has price/inventory-or-availability with date and room-like fields");

  // 中文註解：range 優先於 month/day，因為 start/end 類 query 能明確表示後台可用區間查詢。
  if (hasRangeQuery && dateValueCount > 1 && fieldsComplete) {
    return { apiMode: "range_api", confidence: "high", reasons };
  }
  if (hasRangeQuery && hasRateInventorySignals(detectedFields)) {
    return { apiMode: "range_api", confidence: fieldsComplete ? "medium" : "low", reasons };
  }

  if ((hasMonthQuery || pathHasMonth) && (dateValueCount > 1 || monthValueCount > 0) && fieldsComplete) {
    return { apiMode: "month_api", confidence: dateValueCount >= 20 || allInSameMonth(dateValues) ? "high" : "medium", reasons };
  }
  if ((hasMonthQuery || pathHasMonth) && hasRateInventorySignals(detectedFields)) {
    return { apiMode: "month_api", confidence: "medium", reasons };
  }

  if (hasSingleDateQuery && !hasRangeQuery && !hasMonthQuery && dateValueCount <= 1) {
    return { apiMode: "day_api", confidence: fieldsComplete ? "medium" : "low", reasons };
  }

  return { apiMode: "unknown", confidence: fieldsComplete ? "medium" : "low", reasons: reasons.length ? reasons : ["rate/inventory signals exist but request granularity is unclear"] };
}

module.exports = {
  inferRateInventoryApiMode,
  normalizeKey,
};
