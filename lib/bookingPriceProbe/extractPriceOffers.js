// 功能：從候選 JSON 中萃取非敏感的房價摘要與最低價資訊。
// 責任：只輸出房型、專案、rate plan、價格、幣別、可售狀態、庫存與 sourcePath。
// 關聯模組：runBookingPriceProbe 對候選 API response 呼叫本模組，sanitizeProbeOutput 會再次保護輸出。
// 關鍵流程：遞迴掃描物件 → 找價格欄位 → 向父層脈絡繼承房型/專案名稱 → 限量輸出 normalizedOffers。

const SENSITIVE_KEY_RE = /(cookie|authorization|bearer|token|secret|password|email|phone|mobile|tel|姓名|電話|信箱|訂單編號|order_serial|order_no|uuid|identity)/i;
const ROOM_NAME_KEYS = ["roomName", "room_name", "name", "roomType", "room_type", "room_config_name", "roomConfigName"];
const PLAN_NAME_KEYS = ["planName", "plan_name", "packageName", "package_name", "projectName", "promotionName", "title"];
const RATE_PLAN_KEYS = ["ratePlanName", "rate_plan_name", "ratePlan", "rate_plan", "rateName"];
const PRICE_KEYS = ["price", "amount", "total", "subtotal", "salePrice", "sellingPrice", "rateAmount"];
const CURRENCY_KEYS = ["currency", "currencyCode", "curr"];
const AVAILABLE_KEYS = ["available", "availability", "bookable", "isAvailable", "canBook"];
const INVENTORY_KEYS = ["inventory", "stock", "quantity", "vacancy", "remaining", "roomsLeft"];

function normalizedKey(key) {
  return String(key || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function getByKeySet(object, keys) {
  if (!object || typeof object !== "object" || Array.isArray(object)) return undefined;
  const wanted = new Set(keys.map(normalizedKey));
  for (const [key, value] of Object.entries(object)) {
    if (SENSITIVE_KEY_RE.test(key)) continue;
    if (wanted.has(normalizedKey(key))) return value;
  }
  return undefined;
}

function toSafeText(value) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const text = String(value).trim();
  if (!text || SENSITIVE_KEY_RE.test(text)) return "";
  if (/@/.test(text) || /\+?\d[\d\s().-]{7,}/.test(text)) return "";
  return text.slice(0, 80);
}

function toPrice(value) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[,\s]/g, "");
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function toAvailable(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value > 0;
  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    if (["true", "yes", "y", "available", "bookable"].includes(normalized)) return true;
    if (["false", "no", "n", "soldout", "sold_out", "unavailable"].includes(normalized)) return false;
  }
  return null;
}

function toInventory(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

function pathFor(parentPath, key) {
  if (/^\d+$/.test(String(key))) return `${parentPath}[${key}]`;
  return `${parentPath}.${key}`;
}

function contextFromObject(object, parentContext) {
  const roomName = toSafeText(getByKeySet(object, ROOM_NAME_KEYS)) || parentContext.roomName || "";
  const planName = toSafeText(getByKeySet(object, PLAN_NAME_KEYS)) || parentContext.planName || "";
  const ratePlanName = toSafeText(getByKeySet(object, RATE_PLAN_KEYS)) || parentContext.ratePlanName || "";
  const currency = toSafeText(getByKeySet(object, CURRENCY_KEYS)) || parentContext.currency || "";
  const availableValue = getByKeySet(object, AVAILABLE_KEYS);
  const inventoryValue = getByKeySet(object, INVENTORY_KEYS);
  const available = toAvailable(availableValue);
  const inventory = toInventory(inventoryValue);
  return {
    roomName,
    planName,
    ratePlanName,
    currency,
    available: available === null ? parentContext.available : available,
    inventory: inventory === null ? parentContext.inventory : inventory,
  };
}

function findObjectPrice(object) {
  for (const key of PRICE_KEYS) {
    const value = getByKeySet(object, [key]);
    const price = toPrice(value);
    if (price !== null) return price;
  }
  return null;
}

function extractPriceOffers(json, options = {}) {
  const maxOffers = Number.isInteger(options.maxOffers) ? options.maxOffers : 20;
  const offers = [];
  const seen = new Set();

  function visit(node, path, context) {
    if (offers.length >= maxOffers || !node || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${path}[${index}]`, context));
      return;
    }

    const nextContext = contextFromObject(node, context);
    const price = findObjectPrice(node);
    if (price !== null) {
      offers.push({
        roomName: nextContext.roomName || "",
        planName: nextContext.planName || "",
        ratePlanName: nextContext.ratePlanName || "",
        price,
        currency: nextContext.currency || "",
        available: nextContext.available === null || nextContext.available === undefined ? null : nextContext.available,
        inventory: nextContext.inventory === null || nextContext.inventory === undefined ? null : nextContext.inventory,
        sourcePath: path,
      });
    }

    for (const [key, value] of Object.entries(node)) {
      if (SENSITIVE_KEY_RE.test(key)) continue;
      visit(value, pathFor(path, key), nextContext);
    }
  }

  visit(json, "$", { roomName: "", planName: "", ratePlanName: "", currency: "", available: null, inventory: null });
  const minPrice = offers.length ? Math.min(...offers.map((offer) => offer.price)) : null;
  const minOffer = offers.find((offer) => offer.price === minPrice);
  return {
    offers,
    minPriceSummary: {
      hasPrice: offers.length > 0,
      minPrice,
      currency: minOffer ? minOffer.currency || "" : "",
      offerCount: offers.length,
    },
  };
}

module.exports = {
  extractPriceOffers,
  toPrice,
  toSafeText,
  SENSITIVE_KEY_RE,
};
