// 功能：將 dry-run fetcher 的 normalized calendars items 轉換成 LINE 可讀的正式價格庫存 snapshot。
// 責任：只保留允許 publish 的 planId/salesUnitId、移除 dry-run diagnostics/sourcePath，並計算 v1 summary。
// 關聯模組：runRateInventorySnapshotSync 在 normalizeCalendarsRateInventory 後呼叫；validateRateInventorySnapshot 會驗證本模組輸出的 publish contract。
// 關鍵流程：normalized.items → allowlist filter → 欄位白名單映射 → summary 計算 → sanitize audit 前的 clean snapshot。

function uniqueCount(items, keyName) {
  return new Set(items.map((item) => item[keyName]).filter(Boolean)).size;
}

function computeSnapshotSummary(items, truncated = false) {
  const prices = items.map((item) => item.price).filter((price) => typeof price === "number" && Number.isFinite(price));
  return {
    itemCount: items.length,
    dateCount: uniqueCount(items, "date"),
    salesUnitCount: uniqueCount(items, "salesUnitId"),
    planCount: uniqueCount(items, "planId"),
    minPrice: prices.length ? Math.min(...prices) : null,
    maxPrice: prices.length ? Math.max(...prices) : null,
    truncated: Boolean(truncated),
  };
}

function optionalBoolean(value) {
  return typeof value === "boolean" ? value : false;
}

function buildSnapshotItem(item, currency) {
  // 中文註解：正式 snapshot 採欄位白名單，不從 normalized item 展開複製，避免 sourcePath/diagnostics 外洩。
  return {
    date: String(item.date || ""),
    salesUnitId: String(item.salesUnitId || item.roomTypeId || ""),
    salesUnitName: String(item.salesUnitName || item.roomTypeName || ""),
    planId: String(item.planId || ""),
    planName: String(item.planName || item.channel || ""),
    price: typeof item.price === "number" ? item.price : Number(item.price),
    currency: String(item.currency || currency || ""),
    inventory: item.inventory === null || item.inventory === undefined ? null : Number(item.inventory),
    available: item.available === null || item.available === undefined ? null : Boolean(item.available),
    minLos: item.minLos === null || item.minLos === undefined ? null : Number(item.minLos),
    cta: optionalBoolean(item.cta),
    ctd: optionalBoolean(item.ctd),
  };
}

function compareSnapshotItems(a, b) {
  return a.date.localeCompare(b.date) || a.salesUnitId.localeCompare(b.salesUnitId) || a.planId.localeCompare(b.planId) || a.planName.localeCompare(b.planName);
}

function buildRateInventorySnapshot({ config, normalized, capturedAt = new Date().toISOString() }) {
  const planAllowlist = new Set((config.publishPlanIdAllowlist || []).map(String));
  const salesUnitAllowlist = new Set((config.publishSalesUnitIdAllowlist || []).map(String));

  const filteredItems = (normalized.items || [])
    .filter((item) => planAllowlist.has(String(item.planId || "")))
    .filter((item) => salesUnitAllowlist.has(String(item.salesUnitId || item.roomTypeId || "")))
    .map((item) => buildSnapshotItem(item, config.currency))
    .filter((item) => item.date && item.salesUnitId && item.planId && Number.isFinite(item.price))
    .sort(compareSnapshotItems);

  const truncated = Boolean(normalized.truncated) || filteredItems.length > config.maxItems;
  const items = filteredItems.slice(0, config.maxItems);

  return {
    version: "rate_inventory_snapshot_v1",
    ok: items.length > 0 && !truncated,
    tenant: config.tenant,
    hotelId: config.hotelId,
    displayName: config.displayName,
    rangeStart: config.start,
    rangeEnd: config.end,
    currency: config.currency,
    source: "owlting_admin_calendars",
    capturedAt,
    publishPolicy: {
      mode: "plan_id_allowlist",
      planIds: [...planAllowlist],
      salesUnitIds: [...salesUnitAllowlist],
    },
    summary: computeSnapshotSummary(items, truncated),
    items,
  };
}

module.exports = {
  buildRateInventorySnapshot,
  computeSnapshotSummary,
};
