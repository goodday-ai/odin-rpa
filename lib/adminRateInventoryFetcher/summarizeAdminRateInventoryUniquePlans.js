// 功能：彙總 Admin Rate Inventory Fetcher Dry Run 標準化 items 的 unique plan 摘要。
// 責任：以 salesUnitId + planId 聚合價格、日期、可售/零庫存/未知庫存與 minLos，讓盤點 artifact 可快速找出 planId。
// 關聯模組：runAdminRateInventoryFetcherDryRun 會在寫出 dry-run artifact 前呼叫；tests/adminRateInventoryFetcher.unit.test.js 驗證彙總規則。
// 關鍵流程：逐筆 normalized item → 建立 plan group → 累計 Set/計數/min/max → 輸出穩定排序的 uniquePlans 陣列。

function normalizeId(value) {
  return String(value ?? "").trim();
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sortedNumberArray(values) {
  return Array.from(values).sort((left, right) => left - right);
}

function buildUniquePlans(items = [], { currency = "" } = {}) {
  const groups = new Map();

  for (const item of Array.isArray(items) ? items : []) {
    const salesUnitId = normalizeId(item.salesUnitId || item.roomTypeId || item.salesUnitName || item.roomTypeName || "unknown_sales_unit");
    const planId = normalizeId(item.planId || item.planName || item.channel || "unknown_plan");
    const key = `${salesUnitId}::${planId}`;
    if (!groups.has(key)) {
      groups.set(key, {
        salesUnitId,
        salesUnitName: normalizeId(item.salesUnitName || item.roomTypeName),
        planId,
        planName: normalizeId(item.planName || item.channel),
        currency: normalizeId(item.currency || currency),
        minPrice: null,
        maxPrice: null,
        dates: new Set(),
        availableItemCount: 0,
        zeroInventoryItemCount: 0,
        unknownInventoryItemCount: 0,
        minLosValues: new Set(),
      });
    }

    const group = groups.get(key);
    // 中文註解：名稱/幣別可能只在部分 item 出現，因此保留第一個非空值，避免 group 被空字串覆蓋。
    if (!group.salesUnitName && (item.salesUnitName || item.roomTypeName)) group.salesUnitName = normalizeId(item.salesUnitName || item.roomTypeName);
    if (!group.planName && (item.planName || item.channel)) group.planName = normalizeId(item.planName || item.channel);
    if (!group.currency && (item.currency || currency)) group.currency = normalizeId(item.currency || currency);

    const price = numberOrNull(item.price);
    if (price !== null) {
      group.minPrice = group.minPrice === null ? price : Math.min(group.minPrice, price);
      group.maxPrice = group.maxPrice === null ? price : Math.max(group.maxPrice, price);
    }
    if (item.date) group.dates.add(normalizeId(item.date));
    if (item.available === true) group.availableItemCount += 1;

    const inventory = numberOrNull(item.inventory);
    if (inventory === 0) group.zeroInventoryItemCount += 1;
    if (item.inventory === null || item.inventory === undefined || item.available === null || item.available === undefined) group.unknownInventoryItemCount += 1;

    const minLos = numberOrNull(item.minLos);
    if (minLos !== null) group.minLosValues.add(minLos);
  }

  return Array.from(groups.values())
    .map((group) => ({
      salesUnitId: group.salesUnitId,
      salesUnitName: group.salesUnitName,
      planId: group.planId,
      planName: group.planName,
      currency: group.currency,
      minPrice: group.minPrice,
      maxPrice: group.maxPrice,
      dateCount: group.dates.size,
      availableItemCount: group.availableItemCount,
      zeroInventoryItemCount: group.zeroInventoryItemCount,
      unknownInventoryItemCount: group.unknownInventoryItemCount,
      minLosValues: sortedNumberArray(group.minLosValues),
    }))
    // 中文註解：固定排序讓測試與 artifact diff 穩定，ALL batch 盤點後較容易人工比對。
    .sort((left, right) => `${left.salesUnitId}:${left.planId}`.localeCompare(`${right.salesUnitId}:${right.planId}`));
}

module.exports = {
  buildUniquePlans,
};
