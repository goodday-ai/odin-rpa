// 功能：以 URL/query keyword 與 JSON key 語意偵測後台房價庫存設定頁的候選 API。
// 責任：對 rate/inventory/calendar/room/channel/plan/date 訊號打分，輸出安全 endpoint summary，不輸出 raw response body。
// 關聯模組：runAdminRateInventoryProbe 收集 JSON response 後呼叫；inferRateInventoryApiMode 負責 API 粒度判斷。
// 關鍵流程：安全 URL 欄位 → 收集巢狀 key → detectedFields → shape 摘要 → apiMode inference → score 排序。

const { toAdminRequestUrlFields } = require("./safeAdminUrlInfo");
const { summarizeRateInventoryShape, topLevelJsonKeys } = require("./summarizeRateInventoryShape");
const { inferRateInventoryApiMode, normalizeKey } = require("./inferRateInventoryApiMode");

const URL_KEYWORDS = [
  "rate", "rates", "price", "prices", "inventory", "inventories", "stock", "stocks", "availability", "available",
  "calendar", "calendars", "room", "rooms", "room_config", "room_configs", "room_type", "room_types", "channel",
  "channels", "plan", "plans", "policy", "policies", "sale", "sales", "date", "dates", "month", "months", "start", "end", "from", "to",
];

const JSON_KEYWORDS = [
  "date", "dates", "start_date", "end_date", "month", "year_month", "room_id", "room_name", "room_config_id",
  "room_config_name", "room_type", "price", "amount", "rate", "base_price", "sell_price", "channel_price",
  "inventory", "stock", "available", "availability", "quantity", "channel", "plan", "rate_plan", "currency",
];

const LOW_VALUE_PATH_RE = /\/(me|profile|about|config|settings|hotels?)\/?$/i;

const EMPTY_DETECTED_FIELDS = Object.freeze({
  hasDate: false,
  hasDateRange: false,
  hasMonth: false,
  hasRoom: false,
  hasRoomConfig: false,
  hasPrice: false,
  hasInventory: false,
  hasAvailability: false,
  hasChannel: false,
  hasPlan: false,
  hasCurrency: false,
});

function collectJsonKeys(value, limit = 600) {
  const keys = [];
  const seen = new Set();
  function visit(node) {
    if (keys.length >= limit || !node || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node.slice(0, 20)) visit(item);
      return;
    }
    for (const key of Object.keys(node)) {
      keys.push(key);
      visit(node[key]);
      if (keys.length >= limit) break;
    }
  }
  visit(value);
  return keys;
}

function keywordMatches(text, keywords) {
  const haystack = String(text || "").toLowerCase();
  return keywords.filter((keyword) => haystack.includes(String(keyword).toLowerCase()));
}

function detectFields(keys) {
  const normalized = keys.map(normalizeKey);
  const hasAny = (terms) => normalized.some((key) => terms.some((term) => key.includes(normalizeKey(term))));
  return {
    hasDate: hasAny(["date", "dates", "day", "checkin", "checkout"]),
    hasDateRange: hasAny(["startdate", "enddate", "datestart", "dateend", "from", "to", "range"]),
    hasMonth: hasAny(["month", "yearmonth", "ym"]),
    hasRoom: hasAny(["room", "roomid", "roomname", "roomtype"]),
    hasRoomConfig: hasAny(["roomconfig", "roomconfigid", "roomconfigname", "saleunit", "unit"]),
    hasPrice: hasAny(["price", "amount", "rate", "baseprice", "sellprice", "channelprice"]),
    hasInventory: hasAny(["inventory", "stock", "quantity", "qty"]),
    hasAvailability: hasAny(["available", "availability", "vacancy"]),
    hasChannel: hasAny(["channel", "channels", "ota"]),
    hasPlan: hasAny(["plan", "rateplan", "policy", "package"]),
    hasCurrency: hasAny(["currency", "currencycode"]),
  };
}

function scoreCandidate({ matchedUrlKeywords, matchedJsonKeywords, detectedFields, path }) {
  let score = 0;
  score += matchedUrlKeywords.length * 2;
  score += matchedJsonKeywords.length;
  if (detectedFields.hasDate) score += 5;
  if (detectedFields.hasDateRange) score += 4;
  if (detectedFields.hasMonth) score += 4;
  if (detectedFields.hasRoom) score += 5;
  if (detectedFields.hasRoomConfig) score += 5;
  if (detectedFields.hasPrice) score += 8;
  if (detectedFields.hasInventory) score += 8;
  if (detectedFields.hasAvailability) score += 6;
  if (detectedFields.hasChannel) score += 3;
  if (detectedFields.hasPlan) score += 3;
  if (detectedFields.hasCurrency) score += 2;
  // 中文註解：me/profile/hotels/about 多為登入狀態或靜態設定，保留可觀測但大幅降權，避免誤判成正式候選。
  if (LOW_VALUE_PATH_RE.test(path)) score -= 30;
  return score;
}

function detectRateInventoryCandidate({ url, method = "GET", status = 200, contentType = "", json } = {}) {
  const safeUrl = toAdminRequestUrlFields(url || "");
  const urlText = [safeUrl.requestUrlPath, ...(safeUrl.requestQueryKeys || [])].join(" ");
  const keys = collectJsonKeys(json);
  const matchedUrlKeywords = Array.from(new Set(keywordMatches(urlText, URL_KEYWORDS))).sort();
  const matchedJsonKeywords = Array.from(new Set(keywordMatches(keys.join(" "), JSON_KEYWORDS))).sort();
  const detectedFields = { ...EMPTY_DETECTED_FIELDS, ...detectFields(keys) };
  const sampleShape = summarizeRateInventoryShape(json);
  const apiModeInference = inferRateInventoryApiMode({
    requestQueryKeys: safeUrl.requestQueryKeys,
    requestUrlPath: safeUrl.requestUrlPath,
    detectedFields,
    sampleShape,
  });
  const score = scoreCandidate({ matchedUrlKeywords, matchedJsonKeywords, detectedFields, path: safeUrl.requestUrlPath });

  return {
    ...safeUrl,
    method: String(method || "GET").toUpperCase(),
    status: Number(status) || 0,
    contentType: String(contentType || "").split(";")[0].trim().toLowerCase() || "unknown",
    matchedUrlKeywords,
    topLevelJsonKeys: topLevelJsonKeys(json),
    detectedFields,
    apiModeInference,
    sampleShape: {
      type: sampleShape.type,
      topLevelType: sampleShape.topLevelType,
      nestedKeyCount: sampleShape.nestedKeyCount,
      maxDepth: sampleShape.maxDepth,
      dateValueCount: sampleShape.dateValueCount,
    },
    score,
    _isCandidate: score > 0 && apiModeInference.apiMode !== "not_rate_inventory",
  };
}

module.exports = {
  URL_KEYWORDS,
  JSON_KEYWORDS,
  EMPTY_DETECTED_FIELDS,
  collectJsonKeys,
  detectFields,
  detectRateInventoryCandidate,
};
