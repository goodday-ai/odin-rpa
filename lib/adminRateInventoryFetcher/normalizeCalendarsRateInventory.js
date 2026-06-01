// 功能：將 Owlting calendars API JSON 以 context-aware traversal 轉為標準化價格庫存 snapshot。
// 責任：在不輸出 raw response 的前提下，沿著 room → date/calendar → plan/channel 巢狀結構萃取安全欄位。
// 關聯模組：runAdminRateInventoryFetcherDryRun 在取得 JSON 後呼叫；sanitizeAdminRateInventorySnapshot 負責最後安全清理。
// 關鍵流程：預掃 data[].stocks 庫存 → 深度遍歷累積 context → 將同 room/date 庫存合併 price item → 計算 summary/diagnostics。

const DATE_KEYS = new Set(["date", "day", "calendar_date", "during_date", "start_date", "end_date"]);
const PRICE_KEYS = new Set(["price", "amount", "rate", "sell_price", "base_price", "channel_price", "room_price"]);
const INVENTORY_KEYS = new Set(["inventory", "stock", "quantity", "available_count", "remain", "remaining", "vacancy", "count"]);
const MAX_INVENTORY_KEYS = new Set(["max_stock_count", "max_inventory", "max_stock", "total_stock"]);
const AVAILABILITY_KEYS = new Set(["availability", "available", "is_available", "status", "enabled", "closed", "sold_out"]);
const ROOM_ID_KEYS = new Set(["room_id", "room_type_id", "room_config_id", "roomtypeid", "roomconfigid", "sales_unit_id", "salesunitid"]);
const ROOM_NAME_KEYS = new Set(["room_name", "roomname", "room_type_name", "roomtypename", "room_config_name", "roomconfigname", "sales_unit_name", "salesunitname"]);
const PLAN_ID_KEYS = new Set(["plan_id", "planid", "base_plan_id", "baseplanid"]);
const PLAN_NAME_KEYS = new Set(["plan_name", "planname"]);
const CHANNEL_NAME_KEYS = new Set(["channel_name", "channelname", "channel"]);
const NAME_KEYS = new Set(["name", "title"]);
const CURRENCY_KEYS = new Set(["currency", "currency_code"]);

const MAX_ITEMS = 500;
const MAX_WARNINGS = 50;
const MAX_PRICE = 10000000;

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

function safeNonNegativeInteger(value) {
  const numeric = safeNumber(value);
  if (numeric === null || numeric < 0) return null;
  return Math.floor(numeric);
}

function safePositivePrice(value) {
  const numeric = safeNumber(value);
  if (numeric === null || numeric <= 0 || numeric > MAX_PRICE) return null;
  return numeric;
}

function safeDate(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4}-\d{2}-\d{2})(?:[T\s].*)?$/);
  if (!match) return "";
  const parsed = new Date(`${match[1]}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== match[1]) return "";
  return match[1];
}

function pathChild(path, key, isArrayIndex = false) {
  const safeKey = String(key).replace(/'/g, "");
  const next = isArrayIndex ? `${path}[${safeKey}]` : `${path}.${safeKey}`;
  return next.length > 120 ? `${next.slice(0, 117)}...` : next;
}

function isNumericKey(key) {
  return /^\d+$/.test(String(key || ""));
}

function createEmptyContext() {
  return {
    date: "",
    price: null,
    inventory: null,
    maxInventory: null,
    currency: "",
    salesUnitId: "",
    salesUnitName: "",
    roomTypeId: "",
    roomTypeName: "",
    planId: "",
    planName: "",
    channel: "",
    minLos: null,
    cta: null,
    ctd: null,
    isLock: null,
    isAllowUpdate: null,
    isAllowBooking: null,
    explicitAvailable: null,
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

function hasAnyKey(object, keys) {
  return Object.keys(object).some((key) => keys.has(keyToken(key)));
}

function isDateContextObject(object) {
  return hasAnyKey(object, DATE_KEYS) || hasAnyKey(object, MAX_INVENTORY_KEYS) || ["is_lock", "is_allow_update", "day_of_week"].some((key) => Object.prototype.hasOwnProperty.call(object, key));
}

function isPlanContextObject(object) {
  return hasAnyKey(object, PRICE_KEYS) || hasAnyKey(object, PLAN_ID_KEYS) || hasAnyKey(object, PLAN_NAME_KEYS) || ["is_ota_plan", "is_flexible_plan", "is_allow_booking", "min_los", "cta", "ctd"].some((key) => Object.prototype.hasOwnProperty.call(object, key));
}

function isRoomContextObject(object) {
  return hasAnyKey(object, ROOM_ID_KEYS) || hasAnyKey(object, ROOM_NAME_KEYS);
}

function hasPlanPayload(object) {
  return isPlainObject(object) && (hasAnyKey(object, PRICE_KEYS) || hasAnyKey(object, CURRENCY_KEYS) || hasAnyKey(object, NAME_KEYS) || Object.prototype.hasOwnProperty.call(object, "is_allow_booking"));
}

function getRoomStockId(context) {
  return context.roomTypeId || context.salesUnitId || "";
}

function makeStockKey(roomId, date) {
  return roomId && date ? `${roomId}|${date}` : "";
}

function isStocksKey(key) {
  return keyToken(key) === "stocks";
}

function isStocksPath(path) {
  return String(path || "").includes(".stocks[");
}

function pickFirst(object, tokens) {
  for (const [rawKey, rawValue] of Object.entries(object)) {
    if (rawValue && typeof rawValue === "object") continue;
    if (tokens.has(keyToken(rawKey))) return rawValue;
  }
  return undefined;
}

function collectLocalContext(object, options = {}) {
  const local = createEmptyContext();
  const isRoom = isRoomContextObject(object);
  const isDate = isDateContextObject(object);
  const isPlan = isPlanContextObject(object) || Boolean(options.numericPlanId);

  // 中文註解：先判斷物件角色，再處理 generic id/name，避免 Owlting 的 plan.name 被誤當成 room name。
  if (isRoom) {
    const roomId = pickFirst(object, ROOM_ID_KEYS);
    const roomName = pickFirst(object, ROOM_NAME_KEYS);
    if (roomId !== undefined) {
      const id = truncateText(roomId, 64);
      local.salesUnitId = id;
      local.roomTypeId = id;
    }
    if (roomName !== undefined) {
      const name = truncateText(roomName);
      local.salesUnitName = name;
      local.roomTypeName = name;
    }
  }

  if (options.numericPlanId) local.planId = truncateText(options.numericPlanId, 64);

  for (const [rawKey, rawValue] of Object.entries(object)) {
    if (rawValue && typeof rawValue === "object") continue;
    const token = keyToken(rawKey);
    const date = safeDate(rawValue);

    if (DATE_KEYS.has(token) && date) local.date = date;
    if (PRICE_KEYS.has(token)) {
      const price = safePositivePrice(rawValue);
      if (price !== null) local.price = price;
    }
    if (INVENTORY_KEYS.has(token)) {
      const inventory = safeNonNegativeInteger(rawValue);
      if (inventory !== null) local.inventory = inventory;
    }
    if (MAX_INVENTORY_KEYS.has(token)) {
      const maxInventory = safeNonNegativeInteger(rawValue);
      if (maxInventory !== null) local.maxInventory = maxInventory;
    }
    if (AVAILABILITY_KEYS.has(token)) {
      const available = availabilityFromValue(token, rawValue);
      if (available !== null) local.explicitAvailable = available;
    }
    if (CURRENCY_KEYS.has(token)) local.currency = truncateText(rawValue, 12);

    if (token === "is_lock" && typeof rawValue === "boolean") local.isLock = rawValue;
    if (token === "is_allow_update" && typeof rawValue === "boolean") local.isAllowUpdate = rawValue;
    if (token === "is_allow_booking" && typeof rawValue === "boolean") local.isAllowBooking = rawValue;
    if (token === "min_los") {
      const minLos = safeNonNegativeInteger(rawValue);
      if (minLos !== null) local.minLos = minLos;
    }
    if (token === "cta" && typeof rawValue === "boolean") local.cta = rawValue;
    if (token === "ctd" && typeof rawValue === "boolean") local.ctd = rawValue;

    if (isPlan && (PLAN_ID_KEYS.has(token) || token === "id")) local.planId = truncateText(rawValue, 64);
    if (!isPlan && isRoom && ROOM_ID_KEYS.has(token)) {
      const id = truncateText(rawValue, 64);
      local.salesUnitId = id;
      local.roomTypeId = id;
    }

    if (isPlan && (PLAN_NAME_KEYS.has(token) || CHANNEL_NAME_KEYS.has(token) || NAME_KEYS.has(token))) {
      const name = truncateText(rawValue);
      if (!local.planName) local.planName = name;
      if (!local.channel) local.channel = name;
    } else if (PLAN_NAME_KEYS.has(token)) {
      local.planName = truncateText(rawValue);
    } else if (CHANNEL_NAME_KEYS.has(token)) {
      local.channel = truncateText(rawValue);
    }
  }

  return local;
}

function shapeSummary(root) {
  const summary = {
    topLevelType: Array.isArray(root) ? "array" : typeof root,
    topLevelKeys: [],
    objectCount: 0,
    arrayCount: 0,
    maxDepth: 0,
    scalarKeySamples: [],
    datePathSamples: [],
    pricePathSamples: [],
    inventoryPathSamples: [],
    roomPathSamples: [],
    numericKeyPathSamples: [],
  };
  if (isPlainObject(root)) summary.topLevelKeys = Object.keys(root).slice(0, 30).map((key) => keyToken(key));
  const scalarKeys = new Set();

  function addSample(key, path) {
    if (summary[key].length < 20) summary[key].push(String(path).slice(0, 120));
  }

  function walk(value, path, depth) {
    summary.maxDepth = Math.max(summary.maxDepth, depth);
    if (Array.isArray(value)) {
      summary.arrayCount += 1;
      value.slice(0, 50).forEach((item, index) => walk(item, pathChild(path, index, true), depth + 1));
      return;
    }
    if (isPlainObject(value)) {
      summary.objectCount += 1;
      for (const [key, child] of Object.entries(value)) {
        const token = keyToken(key);
        const childPath = pathChild(path, key, false);
        if (isNumericKey(key) && isPlainObject(child)) addSample("numericKeyPathSamples", childPath);
        if (!child || typeof child !== "object") {
          scalarKeys.add(token);
          if (DATE_KEYS.has(token)) addSample("datePathSamples", childPath);
          if (PRICE_KEYS.has(token)) addSample("pricePathSamples", childPath);
          if (INVENTORY_KEYS.has(token) || MAX_INVENTORY_KEYS.has(token)) addSample("inventoryPathSamples", childPath);
          if (ROOM_ID_KEYS.has(token) || ROOM_NAME_KEYS.has(token)) addSample("roomPathSamples", childPath);
        }
        walk(child, childPath, depth + 1);
      }
    }
  }

  walk(root, "$", 0);
  summary.scalarKeySamples = Array.from(scalarKeys).filter(Boolean).slice(0, 80);
  return summary;
}

function itemFromContext(context, sourcePath) {
  if (!context.date || context.price === null) return null;
  if (!context.salesUnitName && !context.roomTypeName && !context.planName && !context.channel) return null;

  const inventory = context.inventory;
  const maxInventory = context.maxInventory;
  // 中文註解：缺庫存時保留 unknown(null)，避免將沒有 stocks 的 plan item 誤判成客滿 0。
  const available = inventory === null
    ? (context.isAllowBooking === false || context.explicitAvailable === false ? false : null)
    : inventory > 0 && context.isLock !== true && context.isAllowBooking !== false && context.explicitAvailable !== false;
  const item = {
    date: context.date,
    salesUnitId: context.salesUnitId || "",
    salesUnitName: context.salesUnitName || context.roomTypeName || "",
    roomTypeId: context.roomTypeId || context.salesUnitId || "",
    roomTypeName: context.roomTypeName || context.salesUnitName || "",
    planId: context.planId || "",
    planName: context.planName || "",
    channel: context.channel || context.planName || "",
    price: context.price,
    currency: context.currency || "",
    inventory,
    maxInventory,
    available,
    sourcePath: String(sourcePath || "$").slice(0, 120),
  };
  if (context.minLos !== null) item.minLos = context.minLos;
  if (context.cta !== null) item.cta = context.cta;
  if (context.ctd !== null) item.ctd = context.ctd;
  return item;
}

function computeSummary(items, truncated = false) {
  const dates = new Set();
  const salesUnits = new Set();
  const channels = new Set();
  const prices = [];
  let availableItemCount = 0;
  let zeroInventoryItemCount = 0;
  let minLosCount = 0;
  let closedItemCount = 0;
  let unknownInventoryItemCount = 0;
  for (const item of items) {
    if (item.date) dates.add(item.date);
    if (item.salesUnitId || item.salesUnitName) salesUnits.add(item.salesUnitId || item.salesUnitName);
    if (item.channel) channels.add(item.channel);
    if (typeof item.price === "number") prices.push(item.price);
    if (item.available === true) availableItemCount += 1;
    if (item.inventory === 0) zeroInventoryItemCount += 1;
    if (item.minLos !== undefined && item.minLos !== null) minLosCount += 1;
    if (item.available === false) closedItemCount += 1;
    if (item.inventory === null || item.inventory === undefined) unknownInventoryItemCount += 1;
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
    minLosCount,
    closedItemCount,
    unknownInventoryItemCount,
    truncated,
  };
}

function collectStocksByRoomDate(payload) {
  const stocksByRoomDate = new Map();
  const stockKeys = new Set();

  function rememberStock(roomContext, stock, path) {
    if (!isPlainObject(stock)) return;
    const date = safeDate(pickFirst(stock, DATE_KEYS));
    const roomId = getRoomStockId(roomContext);
    const key = makeStockKey(roomId, date);
    if (!key) return;

    // 中文註解：Owlting stocks[] 是 room/date 級庫存，稍後用同 room_id + date 合併到 plans[].plan_items[]。
    stocksByRoomDate.set(key, {
      inventory: safeNonNegativeInteger(pickFirst(stock, INVENTORY_KEYS)),
      maxInventory: safeNonNegativeInteger(pickFirst(stock, MAX_INVENTORY_KEYS)),
      isLock: typeof stock.is_lock === "boolean" ? stock.is_lock : null,
      sourcePath: String(path || "$"),
      matched: false,
    });
    stockKeys.add(key);
  }

  function walk(value, inheritedContext, path, depth = 0) {
    if (depth > 12) return;
    if (Array.isArray(value)) {
      value.forEach((child, index) => walk(child, inheritedContext, pathChild(path, index, true), depth + 1));
      return;
    }
    if (!isPlainObject(value)) return;

    const context = mergeContext(inheritedContext, collectLocalContext(value));
    for (const [key, child] of Object.entries(value)) {
      if (isStocksKey(key) && Array.isArray(child)) {
        child.forEach((stock, index) => rememberStock(context, stock, pathChild(pathChild(path, key, false), index, true)));
        continue;
      }
      if (child && typeof child === "object") walk(child, context, pathChild(path, key, false), depth + 1);
    }
  }

  walk(payload, createEmptyContext(), "$", 0);
  return { stocksByRoomDate, stockKeys };
}

function normalizeCalendarsRateInventory(payload, options = {}) {
  const warnings = [];
  const items = [];
  let truncated = false;
  const { stocksByRoomDate, stockKeys } = collectStocksByRoomDate(payload);
  const planStockKeys = new Set();

  function addWarning(reason, path) {
    if (warnings.length < MAX_WARNINGS) warnings.push({ reason, sourcePath: String(path || "$").slice(0, 120) });
  }

  function walk(value, inheritedContext, path, depth = 0, keyHint = "") {
    if (depth > 24 || items.length >= MAX_ITEMS) {
      truncated = true;
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((child, index) => walk(child, inheritedContext, pathChild(path, index, true), depth + 1, String(index)));
      return;
    }
    if (!isPlainObject(value)) return;

    const numericPlanId = isNumericKey(keyHint) && hasPlanPayload(value) ? keyHint : "";
    const local = collectLocalContext(value, { numericPlanId });
    const context = mergeContext(inheritedContext, local);
    const stockKey = makeStockKey(getRoomStockId(context), context.date);
    const stock = stockKey ? stocksByRoomDate.get(stockKey) : null;
    if (stock && isPlanContextObject(value) && context.price !== null) {
      // 中文註解：price item 本身通常只有日期/價格，庫存需從同 room/date 的 stocks[] 補回來。
      context.inventory = stock.inventory;
      context.maxInventory = stock.maxInventory;
      context.isLock = stock.isLock;
      stock.matched = true;
      planStockKeys.add(stockKey);
    }
    const isDate = isDateContextObject(value);
    const isPlan = isPlanContextObject(value) || Boolean(numericPlanId);

    // 中文註解：warning 只記 path，不記錄 response value，維持 dry-run artifact 不含 raw body 或個資。
    if (isDate && context.inventory === null && context.maxInventory !== null) addWarning("inventory missing but max_stock_count exists", path);
    if (isDate && context.isAllowUpdate === false) addWarning("is_allow_update=false", path);
    if (isPlan && context.date === "") addWarning("price plan exists but missing date context", path);
    if (numericPlanId && !context.planName && !context.channel) addWarning("dynamic numeric key without name", path);
    if (isPlan && context.price === null) addWarning("price missing", path);
    if (isPlan && !context.currency) addWarning("currency missing", path);

    const item = itemFromContext(context, path);
    if (item) items.push(item);

    const childObjectEntries = Object.entries(value).filter(([, child]) => child && typeof child === "object");
    const hasChildPlan = childObjectEntries.some(([key, child]) => {
      if (Array.isArray(child)) return child.some((entry) => isPlainObject(entry) && isPlanContextObject(entry));
      return isPlainObject(child) && (isPlanContextObject(child) || Object.entries(child).some(([grandKey, grandChild]) => isNumericKey(grandKey) && hasPlanPayload(grandChild)) || (isNumericKey(key) && hasPlanPayload(child)));
    });
    if (isDate && !isPlan && !hasChildPlan && !isStocksPath(path)) addWarning("date context exists but no price plans", path);

    for (const [key, child] of childObjectEntries) {
      walk(child, context, pathChild(path, key, false), depth + 1, key);
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

  for (const item of deduped) {
    const key = makeStockKey(item.roomTypeId || item.salesUnitId, item.date);
    if (key && stockKeys.size > 0 && !stockKeys.has(key)) addWarning("plan item exists but no matching stock for same room/date", item.sourcePath);
  }
  for (const [key, stock] of stocksByRoomDate.entries()) {
    if (!stock.matched && !planStockKeys.has(key)) addWarning("stock exists but no matching plan item for same room/date", stock.sourcePath);
  }

  if (deduped.length === 0) addWarning("parse_no_supported_shape", "$");
  const summary = computeSummary(deduped, truncated);
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
