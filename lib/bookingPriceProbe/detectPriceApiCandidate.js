// 功能：以資料驅動 keyword 與欄位語意偵測可能的房價 / 房型 / 庫存 API response。
// 責任：對 URL 與 JSON key 打分，輸出安全候選摘要，不輸出 raw response body。
// 關聯模組：runBookingPriceProbe 收集 JSON response 後呼叫；extractPriceOffers 只處理高分候選。
// 關鍵流程：收集巢狀 key → keyword 命中 → detectedFields → 加權 score → 回傳候選 summary。

const { toRequestUrlFields } = require("./safeUrlInfo");
const { summarizeJsonShape, topLevelJsonKeys } = require("./summarizeJsonShape");

const URL_KEYWORDS = [
  "room", "rooms", "roomType", "rate", "ratePlan", "plan", "package", "price", "amount",
  "promotion", "availability", "inventory", "vacancy", "booking", "product",
];

const JSON_KEYWORDS = [
  "room", "rooms", "roomType", "room_name", "roomName", "room_config_name", "rate", "ratePlan",
  "rate_plan", "plan", "planName", "plan_name", "package", "price", "amount", "total", "subtotal",
  "discount", "promotion", "available", "availability", "inventory", "stock", "vacancy", "quantity",
  "currency", "date", "checkin", "checkout", "adult", "child", "infant", "guest",
];

const EMPTY_DETECTED_FIELDS = Object.freeze({
  hasRoomType: false,
  hasPlanName: false,
  hasRatePlan: false,
  hasPrice: false,
  hasPromotion: false,
  hasAvailability: false,
  hasInventory: false,
  hasCurrency: false,
  hasDate: false,
  hasGuestCount: false,
});

function normalizeKey(key) {
  return String(key || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function collectJsonKeys(value, limit = 300) {
  const keys = [];
  const seen = new Set();
  function visit(node) {
    if (keys.length >= limit || !node || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node.slice(0, 10)) visit(item);
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
  const hasAny = (terms) => normalized.some((key) => terms.some((term) => key.includes(term)));
  return {
    hasRoomType: hasAny(["roomtype", "roomname", "roomconfigname", "rooms", "room"]),
    hasPlanName: hasAny(["planname", "packagename", "projectname", "promotionname"]),
    hasRatePlan: hasAny(["rateplan", "ratecode"]),
    hasPrice: hasAny(["price", "amount", "total", "subtotal", "sellingprice", "rateamount"]),
    hasPromotion: hasAny(["promotion", "discount", "coupon"]),
    hasAvailability: hasAny(["available", "availability", "vacancy", "bookable"]),
    hasInventory: hasAny(["inventory", "stock", "quantity", "remaining", "roomsleft"]),
    hasCurrency: hasAny(["currency", "curr"]),
    hasDate: hasAny(["date", "checkin", "checkout", "start", "end"]),
    hasGuestCount: hasAny(["adult", "child", "infant", "guest", "pax"]),
  };
}

function scoreCandidate({ matchedUrlKeywords, matchedJsonKeywords, detectedFields }) {
  let score = 0;
  score += matchedUrlKeywords.length * 3;
  score += matchedJsonKeywords.length * 2;
  score += Object.values(detectedFields).filter(Boolean).length * 2;
  if (detectedFields.hasPrice && detectedFields.hasRoomType) score += 5;
  if (detectedFields.hasPrice && (detectedFields.hasPlanName || detectedFields.hasRatePlan)) score += 5;
  if (detectedFields.hasPrice && (detectedFields.hasAvailability || detectedFields.hasInventory)) score += 5;
  return score;
}

function detectPriceApiCandidate({ url, method = "GET", status = 200, contentType = "application/json", json }) {
  const jsonKeys = collectJsonKeys(json);
  const normalizedJsonKeywordSet = new Set(JSON_KEYWORDS.map(normalizeKey));
  const matchedJsonKeywords = Array.from(new Set(
    jsonKeys.filter((key) => normalizedJsonKeywordSet.has(normalizeKey(key)))
  )).sort();
  // 只用 path/query key 參與 URL keyword 偵測，避免 booking 網域本身讓無關 API 被加分。
  const safeUrl = toRequestUrlFields(url);
  const urlKeywordText = `${safeUrl.requestUrlPath} ${safeUrl.requestQueryKeys.join(" ")}`;
  const matchedUrlKeywords = Array.from(new Set(keywordMatches(urlKeywordText, URL_KEYWORDS))).sort();
  const detectedFields = { ...EMPTY_DETECTED_FIELDS, ...detectFields(jsonKeys) };
  const sampleShape = summarizeJsonShape(json);
  const score = scoreCandidate({ matchedUrlKeywords, matchedJsonKeywords, detectedFields });

  return {
    ...safeUrl,
    method,
    status,
    contentType: String(contentType || "").split(";")[0].trim().toLowerCase(),
    matchedUrlKeywords,
    topLevelJsonKeys: topLevelJsonKeys(json),
    detectedFields,
    sampleShape: {
      type: sampleShape.type,
      topLevelType: sampleShape.topLevelType,
      nestedKeyCount: sampleShape.nestedKeyCount,
      maxDepth: sampleShape.maxDepth,
    },
    score,
  };
}

module.exports = {
  URL_KEYWORDS,
  JSON_KEYWORDS,
  EMPTY_DETECTED_FIELDS,
  collectJsonKeys,
  detectFields,
  detectPriceApiCandidate,
  scoreCandidate,
};
