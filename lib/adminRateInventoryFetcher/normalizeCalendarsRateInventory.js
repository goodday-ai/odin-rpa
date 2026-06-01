// 功能：將 Owlting calendars API JSON 以 generic traversal 轉為標準化價格庫存 snapshot。
// 責任：在不假設完整 response shape 的前提下，從相鄰 parent/child 物件萃取 date/price/inventory/name/channel/plan/currency。
// 關聯模組：runAdminRateInventoryFetcherDryRun 在取得 JSON 後呼叫；sanitizeAdminRateInventorySnapshot 負責最後安全清理。
// 關鍵流程：深度遍歷 → 彙整祖先 context → 偵測候選欄位 → 建立 item → 計算 summary → 無法解析時回傳 parse_no_supported_shape 與 shape summary。

const DATE_KEYS = new Set(["date", "day", "calendar_date", "during_date", "start_date", "end_date"]);
const PRICE_KEYS = new Set(["price", "amount", "rate", "sell_price", "base_price", "channel_price", "room_price"]);
const INVENTORY_KEYS = new Set(["inventory", "stock", "quantity", "available_count", "remain", "remaining", "vacancy"]);
const AVAILABILITY_KEYS = new Set(["availability", "available", "is_available", "status", "enabled", "closed", "sold_out"]);
const ROOM_NAME_KEYS = new Set(["room_name", "roomname", "room_type_name", "roomtypename", "roomconfigname", "sales_unit_name", "salesunitname"]);
const PLAN_NAME_KEYS = new Set(["plan_name", "planname"]);
const CHANNEL_NAME_KEYS = new Set(["channel_name", "channelname", "channel"]);
const NAME_KEYS = new Set(["name", "title"]);
const CURRENCY_KEYS = new Set(["currency", "currency_code"]);
const ID_KEYS = new Set(["id", "room_id", "roomtypeid", "room_type_id", "sales_unit_id", "salesunitid", "plan_id", "planid"]);

const MAX_ITEMS = 500;
const MAX_WARNINGS = 50;

function keyToken(key) {
  return String(key || "").replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function truncateText(value, max = 80) {
  const text = String(value || "").trim();
  return text.length > max ? text.slice(0, max) : text;
}

function safeNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value.trim());
  return null;
}

function safeDate(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4}-\d{2}-\d{2})(?:[T\s].*)?$/);
  if (!match) return "";
  const parsed = new Date(`${match[1]}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== match[1]) return "";
  return match[1];
}

function pathChild(path, key) {
  const safeKey = String(key).replace(/'/g, "");
  const next = /^\d+$/.test(safeKey) ? `${path}[${safeKey}]` : `${path}.${safeKey}`;
  return next.length > 120 ? `${next.slice(0, 117)}...` : next;
}

function createEmptyContext() {
  return {
    date: "",
    price: null,
    inventory: null,
    available: null,
    currency: "",
    salesUnitId: "",
    salesUnitName: "",
    roomTypeId: "",
    roomTypeName: "",
    planId: "",
    planName: "",
    channel: "",
  };
}

function mergeContext(parent, local) {
  const merged = { ...parent };
  for (const [key, value] of Object.entries(local)) {
    if (value !== "" && value !== null && value !== undefined) merged[key] = value;
  }
  return merged;
}

function availabilityFromValue(key, value) {
  const token = keyToken(key);
  if (typeof value === "boolean") {
    if (token === "closed" || token === "sold_out") return !value;
    return value;
  }
  const text = String(value || "").trim().toLowerCase();
  if (!text) return null;
  if (["available", "open", "enabled", "active", "1", "true"].includes(text)) return true;
  if (["unavailable", "closed", "disabled", "inactive", "sold_out", "soldout", "0", "false"].includes(text)) return false;
  return null;
}

function collectLocalContext(object) {
  const local = createEmptyContext();
  for (const [rawKey, rawValue] of Object.entries(object)) {
    if (rawValue && typeof rawValue === "object") continue;
    const token = keyToken(rawKey);
    const numeric = safeNumber(rawValue);
    const date = safeDate(rawValue);

    // 中文註解：同一物件內的明確欄位優先，避免 generic name 誤覆蓋 plan/channel/room 專用名稱。
    if (DATE_KEYS.has(token) && date) local.date = date;
    if (PRICE_KEYS.has(token) && numeric !== null) local.price = numeric;
    if (INVENTORY_KEYS.has(token) && numeric !== null) local.inventory = numeric;
    if (AVAILABILITY_KEYS.has(token)) {
      const available = availabilityFromValue(token, rawValue);
      if (available !== null) local.available = available;
    }
    if (CURRENCY_KEYS.has(token)) local.currency = truncateText(rawValue, 12);

    if (ROOM_NAME_KEYS.has(token)) {
      local.salesUnitName = truncateText(rawValue);
      local.roomTypeName = truncateText(rawValue);
    } else if (PLAN_NAME_KEYS.has(token)) {
      local.planName = truncateText(rawValue);
    } else if (CHANNEL_NAME_KEYS.has(token)) {
      local.channel = truncateText(rawValue);
    } else if (NAME_KEYS.has(token)) {
      if (!local.salesUnitName) local.salesUnitName = truncateText(rawValue);
    }

    if (ID_KEYS.has(token)) {
      const id = truncateText(rawValue, 64);
      if (token.includes("plan")) local.planId = id;
      else if (token.includes("sales")) local.salesUnitId = id;
      else if (token.includes("room")) local.roomTypeId = id;
    }
  }
  return local;
}

function shapeSummary(root) {
  const summary = { topLevelType: Array.isArray(root) ? "array" : typeof root, topLevelKeys: [], objectCount: 0, arrayCount: 0, maxDepth: 0, scalarKeySamples: [] };
  if (isPlainObject(root)) summary.topLevelKeys = Object.keys(root).slice(0, 30).map((key) => keyToken(key));
  const scalarKeys = new Set();
  function walk(value, depth) {
    summary.maxDepth = Math.max(summary.maxDepth, depth);
    if (Array.isArray(value)) {
      summary.arrayCount += 1;
      for (const item of value.slice(0, 50)) walk(item, depth + 1);
      return;
    }
    if (isPlainObject(value)) {
      summary.objectCount += 1;
      for (const [key, child] of Object.entries(value)) {
        if (!child || typeof child !== "object") scalarKeys.add(keyToken(key));
        walk(child, depth + 1);
      }
    }
  }
  walk(root, 0);
  summary.scalarKeySamples = Array.from(scalarKeys).filter(Boolean).slice(0, 80);
  return summary;
}

function itemFromContext(context, sourcePath) {
  if (!context.date || context.price === null) return null;
  if (context.inventory === null && context.available === null) return null;
  if (!context.salesUnitName && !context.roomTypeName && !context.planName && !context.channel) return null;
  const inventory = context.inventory === null ? (context.available ? 1 : 0) : context.inventory;
  const available = context.available === null ? inventory > 0 : context.available;
  return {
    date: context.date,
    salesUnitId: context.salesUnitId || "",
    salesUnitName: context.salesUnitName || context.roomTypeName || "",
    roomTypeId: context.roomTypeId || "",
    roomTypeName: context.roomTypeName || context.salesUnitName || "",
    planId: context.planId || "",
    planName: context.planName || "",
    channel: context.channel || context.planName || "",
    price: context.price,
    currency: context.currency || "",
    inventory,
    available,
    sourcePath: String(sourcePath || "$.").slice(0, 120),
  };
}

function computeSummary(items) {
  const dates = new Set();
  const salesUnits = new Set();
  const channels = new Set();
  const prices = [];
  let availableItemCount = 0;
  let zeroInventoryItemCount = 0;
  for (const item of items) {
    if (item.date) dates.add(item.date);
    if (item.salesUnitId || item.salesUnitName) salesUnits.add(item.salesUnitId || item.salesUnitName);
    if (item.channel) channels.add(item.channel);
    if (typeof item.price === "number") prices.push(item.price);
    if (item.available) availableItemCount += 1;
    if (Number(item.inventory) === 0) zeroInventoryItemCount += 1;
  }
  return {
    itemCount: items.length,
    dateCount: dates.size,
    salesUnitCount: salesUnits.size,
    channelCount: channels.size,
    minPrice: prices.length ? Math.min(...prices) : null,
    maxPrice: prices.length ? Math.max(...prices) : null,
    availableItemCount,
    zeroInventoryItemCount,
  };
}

function normalizeCalendarsRateInventory(payload, options = {}) {
  const warnings = [];
  const items = [];
  let truncated = false;

  function addWarning(reason, path) {
    if (warnings.length < MAX_WARNINGS) warnings.push({ reason, sourcePath: String(path || "$.").slice(0, 120) });
  }

  function walk(value, inheritedContext, path, depth = 0) {
    if (depth > 24 || items.length >= MAX_ITEMS) {
      truncated = true;
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((child, index) => walk(child, inheritedContext, pathChild(path, index), depth + 1));
      return;
    }
    if (!isPlainObject(value)) return;

    const local = collectLocalContext(value);
    const context = mergeContext(inheritedContext, local);
    const item = itemFromContext(context, path);
    if (item) items.push(item);

    for (const [key, child] of Object.entries(value)) {
      if (child && typeof child === "object") walk(child, context, pathChild(path, key), depth + 1);
    }
  }

  walk(payload, createEmptyContext(), "$", 0);

  const deduped = [];
  const seen = new Set();
  for (const item of items) {
    const key = [item.date, item.salesUnitId, item.salesUnitName, item.roomTypeId, item.planId, item.planName, item.channel, item.price, item.inventory, item.sourcePath].join("|");
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(item);
    }
    if (deduped.length >= MAX_ITEMS) {
      truncated = true;
      break;
    }
  }

  if (deduped.length === 0) addWarning("parse_no_supported_shape", "$");
  const summary = computeSummary(deduped);
  const currency = deduped.find((item) => item.currency)?.currency || options.currency || "";
  return {
    ok: deduped.length > 0,
    stoppedReason: deduped.length > 0 ? "" : "parse_no_supported_shape",
    currency,
    summary,
    items: deduped,
    warnings,
    truncated,
    shapeSummary: deduped.length > 0 ? undefined : shapeSummary(payload),
  };
}

module.exports = {
  MAX_ITEMS,
  MAX_WARNINGS,
  normalizeCalendarsRateInventory,
};
