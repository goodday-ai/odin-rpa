// 功能：Admin Rate Inventory Fetcher Dry Run 的單元測試。
// 責任：驗證 calendars API request contract、generic normalizer、snapshot sanitizer 與 controlled stop 安全性。
// 關聯模組：lib/adminRateInventoryFetcher/*；package.json 的 test:admin-rate-inventory-fetcher 指向本檔。
// 關鍵流程：建構假資料 → 執行 request builder/normalizer/sanitizer → 斷言輸出不含敏感資訊且 summary 正確。

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildCalendarsApiRequest } = require("../lib/adminRateInventoryFetcher/buildCalendarsApiRequest");
const { normalizeCalendarsRateInventory } = require("../lib/adminRateInventoryFetcher/normalizeCalendarsRateInventory");
const {
  sanitizeAdminRateInventorySnapshot,
  createControlledStopSnapshot,
  auditSanitizedAdminRateInventorySnapshot,
} = require("../lib/adminRateInventoryFetcher/sanitizeAdminRateInventorySnapshot");
const { runAdminRateInventoryFetcherDryRun } = require("../lib/adminRateInventoryFetcher/runAdminRateInventoryFetcherDryRun");

test("buildCalendarsApiRequest builds safe range API URL", () => {
  const request = buildCalendarsApiRequest({
    origin: "https://www.owlting.com",
    hotelId: "5720",
    start: "2026-06-01",
    end: "2026-08-31",
    lang: "zh_TW",
  });

  assert.equal(request.url, "https://www.owlting.com/booking/v2/admin/hotels/5720/calendars?during_start_date=2026-06-01&during_end_date=2026-08-31&lang=zh_TW");
  assert.deepEqual(request.safe, {
    origin: "https://www.owlting.com",
    path: "/booking/v2/admin/hotels/5720/calendars",
    queryKeys: ["during_start_date", "during_end_date", "lang"],
  });
});

test("buildCalendarsApiRequest rejects non numeric hotelId", () => {
  assert.throws(() => buildCalendarsApiRequest({ origin: "https://www.owlting.com", hotelId: "57x0", start: "2026-06-01", end: "2026-06-02" }), /hotelId must be numeric/);
});

test("buildCalendarsApiRequest rejects start >= end", () => {
  assert.throws(() => buildCalendarsApiRequest({ origin: "https://www.owlting.com", hotelId: "5720", start: "2026-06-02", end: "2026-06-02" }), /start must be before end/);
  assert.throws(() => buildCalendarsApiRequest({ origin: "https://www.owlting.com", hotelId: "5720", start: "2026-06-03", end: "2026-06-02" }), /start must be before end/);
});

test("buildCalendarsApiRequest default maxDays remains 92", () => {
  assert.throws(() => buildCalendarsApiRequest({ origin: "https://www.owlting.com", hotelId: "5720", start: "2026-06-01", end: "2026-09-02" }), /range must be <= 92 days/);
});

test("buildCalendarsApiRequest accepts maxDays=120", () => {
  const request = buildCalendarsApiRequest({
    origin: "https://www.owlting.com",
    hotelId: "5720",
    start: "2026-06-01",
    end: "2026-09-29",
    maxDays: 120,
  });
  assert.match(request.url, /during_end_date=2026-09-29/);
});

test("buildCalendarsApiRequest rejects 121 when maxDays=120", () => {
  assert.throws(
    () => buildCalendarsApiRequest({ origin: "https://www.owlting.com", hotelId: "5720", start: "2026-06-01", end: "2026-09-30", maxDays: 120 }),
    /range must be <= 120 days/,
  );
});

test("dry-run behavior remains backward compatible with 92-day default", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rate-inventory-fetcher-dryrun-"));
  const result = await runAdminRateInventoryFetcherDryRun({
    chromium: {},
    env: {
      ADMIN_RATE_FETCHER_ENABLED: "1",
      ADMIN_RATE_FETCHER_TENANT: "goodday",
      ADMIN_RATE_FETCHER_HOTEL_ID: "5720",
      ADMIN_RATE_FETCHER_START: "2026-06-01",
      ADMIN_RATE_FETCHER_END: "2026-09-02",
      ADMIN_RATE_FETCHER_OUT_DIR: tmpDir,
    },
  });

  assert.equal(result.stoppedReason, "invalid_config");
  assert.equal(result.exitCode, 1);
  const output = JSON.parse(fs.readFileSync(result.outputPath, "utf8"));
  assert.match(JSON.stringify(output), /range must be <= 92 days/);
});

test("normalizer extracts date/price/inventory/name from nested calendar-like payload", () => {
  const payload = {
    data: {
      currency_code: "TWD",
      rooms: [
        {
          room_type_id: "room-2f",
          room_type_name: "2F 包層",
          plans: [
            {
              plan_id: "booking-plan",
              plan_name: "Booking",
              channel_name: "Booking",
              calendars: [
                { date: "2026-06-01", sell_price: 24000, inventory: 1, available: true },
                { day: "2026-06-02", price: "18000", remaining: 0, sold_out: true },
              ],
            },
          ],
        },
      ],
    },
  };

  const normalized = normalizeCalendarsRateInventory(payload);
  assert.equal(normalized.ok, true);
  assert.equal(normalized.items.length, 2);
  assert.deepEqual(normalized.items.map((item) => item.date), ["2026-06-01", "2026-06-02"]);
  assert.equal(normalized.items[0].salesUnitName, "2F 包層");
  assert.equal(normalized.items[0].planName, "Booking");
  assert.equal(normalized.items[0].channel, "Booking");
  assert.equal(normalized.items[0].price, 24000);
  assert.equal(normalized.items[0].inventory, 1);
  assert.equal(normalized.items[0].currency, "TWD");
});



test("normalizer extracts Owlting room/date/numeric plan shape", () => {
  const normalized = normalizeCalendarsRateInventory({
    status: "success",
    data: [
      {
        room_id: 57201,
        room_name: "2F 包層",
        calendar: [
          {
            date: "2026-06-01",
            count: 1,
            max_stock_count: 1,
            is_lock: false,
            is_allow_update: true,
            plans: {
              42144: { id: 42144, name: "Booking", price: 24000, currency: "TWD", is_allow_booking: true, min_los: 1, cta: false, ctd: false },
              42145: { name: "Agoda", price: 30000, currency: "TWD", is_allow_booking: false, min_los: 2, cta: true, ctd: false },
            },
          },
          {
            date: "2026-06-02",
            count: 0,
            max_stock_count: 1,
            is_lock: true,
            plans: {
              42144: { name: "Booking", price: 18000, currency: "TWD", is_allow_booking: true, min_los: 1, cta: false, ctd: true },
            },
          },
        ],
      },
    ],
  });

  assert.equal(normalized.ok, true);
  assert.equal(normalized.items.length, 3);
  assert.equal(normalized.items[0].date, "2026-06-01");
  assert.equal(normalized.items[0].salesUnitId, "57201");
  assert.equal(normalized.items[0].salesUnitName, "2F 包層");
  assert.equal(normalized.items[0].roomTypeId, "57201");
  assert.equal(normalized.items[0].roomTypeName, "2F 包層");
  assert.equal(normalized.items[0].planId, "42144");
  assert.equal(normalized.items[0].planName, "Booking");
  assert.equal(normalized.items[0].channel, "Booking");
  assert.equal(normalized.items[0].price, 24000);
  assert.equal(normalized.items[0].currency, "TWD");
  assert.equal(normalized.items[0].inventory, 1);
  assert.equal(normalized.items[0].maxInventory, 1);
  assert.equal(normalized.items[0].available, true);
  assert.equal(normalized.items[0].minLos, 1);
  assert.equal(normalized.items[0].cta, false);
  assert.equal(normalized.items[0].ctd, false);

  const bookingLocked = normalized.items.find((item) => item.date === "2026-06-02" && item.planId === "42144");
  const agodaClosed = normalized.items.find((item) => item.date === "2026-06-01" && item.planId === "42145");
  assert.equal(bookingLocked.available, false);
  assert.equal(agodaClosed.available, false);
  assert.equal(normalized.summary.itemCount, 3);
  assert.equal(normalized.summary.dateCount, 2);
  assert.equal(normalized.summary.salesUnitCount, 1);
  assert.equal(normalized.summary.channelCount, 2);
  assert.equal(normalized.summary.minPrice, 18000);
  assert.equal(normalized.summary.maxPrice, 30000);
  assert.equal(normalized.summary.availableItemCount, 1);
  assert.equal(normalized.summary.zeroInventoryItemCount, 1);
  assert.equal(normalized.summary.minLosCount, 3);
  assert.equal(normalized.summary.closedItemCount, 2);
  assert.equal(normalized.summary.truncated, false);
});


test("normalizer merges data[].stocks into plans[].plan_items by room_id and date", () => {
  const normalized = normalizeCalendarsRateInventory({
    data: [
      {
        room_id: 57201,
        room_name: "2F 包層",
        stocks: [
          { date: "2026-06-01", count: 2, max_stock_count: 5, is_lock: false },
          { date: "2026-06-02", count: 3, max_stock_count: 5, is_lock: true },
          { date: "2026-06-04", count: 1, max_stock_count: 5, is_lock: false },
        ],
        plans: [
          {
            plan_id: 42144,
            plan_name: "Booking",
            plan_items: [
              { date: "2026-06-01", price: 24000, currency: "TWD", is_allow_booking: true },
              { date: "2026-06-02", price: 25000, currency: "TWD", is_allow_booking: true },
              { date: "2026-06-03", price: 26000, currency: "TWD", is_allow_booking: true },
            ],
          },
        ],
      },
    ],
  });

  assert.equal(normalized.ok, true);
  assert.equal(normalized.items.length, 3);

  const open = normalized.items.find((item) => item.date === "2026-06-01");
  assert.equal(open.salesUnitId, "57201");
  assert.equal(open.salesUnitName, "2F 包層");
  assert.equal(open.planName, "Booking");
  assert.equal(open.price, 24000);
  assert.equal(open.currency, "TWD");
  assert.equal(open.inventory, 2);
  assert.equal(open.maxInventory, 5);
  assert.equal(open.available, true);

  const locked = normalized.items.find((item) => item.date === "2026-06-02");
  assert.equal(locked.inventory, 3);
  assert.equal(locked.maxInventory, 5);
  assert.equal(locked.available, false);

  const missingStock = normalized.items.find((item) => item.date === "2026-06-03");
  assert.equal(missingStock.inventory, null);
  assert.equal(missingStock.maxInventory, null);
  assert.equal(missingStock.available, null);

  assert.equal(normalized.summary.availableItemCount, 1);
  assert.equal(normalized.summary.zeroInventoryItemCount, 0);
  assert.equal(normalized.summary.closedItemCount, 1);
  assert.equal(normalized.summary.unknownInventoryItemCount, 1);
  assert.equal(normalized.warnings.some((warning) => warning.reason === "date context exists but no price plans" && warning.sourcePath.includes(".stocks")), false);
  assert.equal(normalized.warnings.some((warning) => warning.reason === "plan item exists but no matching stock for same room/date"), true);
  assert.equal(normalized.warnings.some((warning) => warning.reason === "stock exists but no matching plan item for same room/date"), true);
});



test("normalizer preserves planItemId / planItemName when child object has id/name", () => {
  const normalized = normalizeCalendarsRateInventory({
    data: [
      {
        room_id: "32440",
        room_name: "二臥室套房",
        plans: [
          {
            plan_id: "40070",
            plan_name: "OTA 與官網原始價格",
            plan_items: [
              { id: "pi-1", name: "官網專屬優惠", date: "2026-06-01", price: 9000, currency: "TWD", inventory: 1, is_allow_booking: true },
            ],
          },
        ],
      },
    ],
  });

  assert.equal(normalized.ok, true);
  assert.equal(normalized.items[0].planId, "40070");
  assert.equal(normalized.items[0].planName, "OTA 與官網原始價格");
  assert.equal(normalized.items[0].planItemId, "pi-1");
  assert.equal(normalized.items[0].planItemName, "官網專屬優惠");
});

test("normalizer preserves dynamic numeric key as sourcePlanItemKey", () => {
  const normalized = normalizeCalendarsRateInventory({
    data: [
      {
        room_id: "32440",
        room_name: "二臥室套房",
        plans: [
          {
            plan_id: "40070",
            plan_name: "OTA 與官網原始價格",
            plan_items: {
              42144: { name: "官網專屬優惠", date: "2026-06-01", price: 18000, currency: "TWD", inventory: 1, is_allow_booking: true },
            },
          },
        ],
      },
    ],
  });

  assert.equal(normalized.ok, true);
  assert.equal(normalized.items[0].planId, "40070");
  assert.equal(normalized.items[0].sourcePlanItemKey, "42144");
  assert.equal(normalized.items[0].planItemId, "42144");
  assert.equal(normalized.items[0].planItemName, "官網專屬優惠");
});

test("items include planItemName", () => {
  const normalized = normalizeCalendarsRateInventory({
    data: [{ room_id: "r1", room_name: "Room", plans: [{ plan_id: "p1", plan_name: "Base", plan_items: [{ item_id: "i1", item_name: "早鳥優惠", date: "2026-06-01", price: 1000, currency: "TWD", inventory: 1 }] }] }],
  });

  assert.equal(normalized.items[0].planItemName, "早鳥優惠");
  assert.equal(normalized.items[0].planItemId, "i1");
});

test("uniquePlanItems aggregates by salesUnitId + planId + planItem identity", () => {
  const uniquePlanItems = buildUniquePlanItems([
    { salesUnitId: "32440", salesUnitName: "二臥室套房", planId: "40070", planName: "OTA 與官網原始價格", planItemId: "pi-1", planItemName: "官網專屬優惠", date: "2026-06-01", price: 9000, inventory: 1, available: true, currency: "TWD", minLos: 1 },
    { salesUnitId: "32440", salesUnitName: "二臥室套房", planId: "40070", planName: "OTA 與官網原始價格", planItemId: "pi-1", planItemName: "官網專屬優惠", date: "2026-06-02", price: 12000, inventory: 0, available: false, currency: "TWD", minLos: 2 },
    { salesUnitId: "32440", salesUnitName: "二臥室套房", planId: "40070", planName: "OTA 與官網原始價格", sourcePlanItemKey: "42145", planItemName: "不可取消優惠", date: "2026-06-01", price: 11000, inventory: null, available: null, currency: "TWD", minLos: 1 },
  ]);

  assert.equal(uniquePlanItems.length, 2);
  assert.deepEqual(uniquePlanItems[0], {
    salesUnitId: "32440",
    salesUnitName: "二臥室套房",
    planId: "40070",
    planName: "OTA 與官網原始價格",
    planItemId: "pi-1",
    planItemName: "官網專屬優惠",
    sourcePlanItemKey: "",
    currency: "TWD",
    minPrice: 9000,
    maxPrice: 12000,
    dateCount: 2,
    availableItemCount: 1,
    zeroInventoryItemCount: 1,
    unknownInventoryItemCount: 0,
    minLosValues: [1, 2],
  });
});

test("uniquePlans children summarize uniquePlanItems", () => {
  const uniquePlans = buildUniquePlans([
    { salesUnitId: "32440", salesUnitName: "二臥室套房", planId: "40070", planName: "OTA 與官網原始價格", planItemId: "pi-1", planItemName: "官網專屬優惠", date: "2026-06-01", price: 9000, inventory: 1, available: true, currency: "TWD", minLos: 1 },
    { salesUnitId: "32440", salesUnitName: "二臥室套房", planId: "40070", planName: "OTA 與官網原始價格", planItemId: "pi-2", planItemName: "不可取消優惠", date: "2026-06-01", price: 11000, inventory: 1, available: true, currency: "TWD", minLos: 1 },
  ]);

  assert.equal(uniquePlans.length, 1);
  assert.equal(uniquePlans[0].children.length, 2);
  assert.deepEqual(uniquePlans[0].children.map((child) => child.planItemName), ["官網專屬優惠", "不可取消優惠"]);
  assert.equal(uniquePlans[0].children[0].minPrice, 9000);
  assert.equal(uniquePlans[0].children[0].dateCount, 1);
});

test("sanitizer keeps safe planItemName but removes sensitive values", () => {
  const sanitized = sanitizeAdminRateInventorySnapshot({
    items: [
      { planItemName: "官網專屬優惠", token: "Bearer abc", headers: { authorization: "Bearer abc" } },
      { planItemName: "guest@example.com" },
    ],
  });

  assert.equal(sanitized.items[0].planItemName, "官網專屬優惠");
  assert.equal(sanitized.items[1].planItemName, "");
  assert.equal(JSON.stringify(sanitized).includes("Bearer"), false);
  assert.equal(JSON.stringify(sanitized).includes("headers"), false);
});

test("backward compatibility: payload without subplan still works", () => {
  const normalized = normalizeCalendarsRateInventory({
    data: [{ room_id: "r1", room_name: "Room", plans: [{ plan_id: "p1", plan_name: "Direct", calendars: [{ date: "2026-06-01", price: 1000, currency: "TWD", inventory: 1 }] }] }],
  });
  const uniquePlans = buildUniquePlans(normalized.items);
  const uniquePlanItems = buildUniquePlanItems(normalized.items);

  assert.equal(normalized.ok, true);
  assert.equal(normalized.items[0].planItemName, "");
  assert.equal(uniquePlans.length, 1);
  assert.deepEqual(uniquePlans[0].children, []);
  assert.deepEqual(uniquePlanItems, []);
});

test("normalizer counts zero inventory and unknown inventory without defaulting missing stock to 0", () => {
  const normalized = normalizeCalendarsRateInventory({
    data: [
      {
        room_id: "room-a",
        room_name: "A",
        stocks: [{ date: "2026-06-01", count: 0, max_stock_count: 2, is_lock: false }],
        plans: [{ plan_name: "Direct", plan_items: [{ date: "2026-06-01", price: 1000, currency: "TWD", is_allow_booking: true }, { date: "2026-06-02", price: 1200, currency: "TWD", is_allow_booking: false }] }],
      },
    ],
  });

  const zeroStock = normalized.items.find((item) => item.date === "2026-06-01");
  const missingClosed = normalized.items.find((item) => item.date === "2026-06-02");

  assert.equal(zeroStock.inventory, 0);
  assert.equal(zeroStock.available, false);
  assert.equal(missingClosed.inventory, null);
  assert.equal(missingClosed.available, false);
  assert.equal(normalized.summary.availableItemCount, 0);
  assert.equal(normalized.summary.zeroInventoryItemCount, 1);
  assert.equal(normalized.summary.closedItemCount, 2);
  assert.equal(normalized.summary.unknownInventoryItemCount, 1);
});

test("normalizer limits items to 500 and sets truncated=true", () => {
  const calendar = Array.from({ length: 501 }, (_, index) => ({
    date: `2026-06-${String((index % 28) + 1).padStart(2, "0")}`,
    count: 1,
    max_stock_count: 1,
    plans: {
      [String(42000 + index)]: { name: `Plan ${index}`, price: 1000 + index, currency: "TWD", is_allow_booking: true },
    },
  }));

  const normalized = normalizeCalendarsRateInventory({ data: [{ room_id: "room-a", room_name: "A", calendar }] });

  assert.equal(normalized.items.length, 500);
  assert.equal(normalized.truncated, true);
  assert.equal(normalized.summary.truncated, true);
});

test("shapeSummary includes safe diagnostic path samples", () => {
  const normalized = normalizeCalendarsRateInventory({
    status: "success",
    data: [
      {
        room_id: 57201,
        room_name: "2F 包層",
        calendar: [
          {
            date: "2026-06-01",
            max_stock_count: 1,
            plans: {
              42144: { name: "Booking", price: 0, currency: "TWD" },
            },
          },
        ],
      },
    ],
  });

  assert.equal(normalized.ok, false);
  assert.deepEqual(normalized.shapeSummary.topLevelKeys, ["status", "data"]);
  assert.ok(normalized.shapeSummary.datePathSamples.includes("$.data[0].calendar[0].date"));
  assert.ok(normalized.shapeSummary.pricePathSamples.includes("$.data[0].calendar[0].plans.42144.price"));
  assert.ok(normalized.shapeSummary.inventoryPathSamples.includes("$.data[0].calendar[0].max_stock_count"));
  assert.ok(normalized.shapeSummary.roomPathSamples.includes("$.data[0].room_name"));
  assert.ok(normalized.shapeSummary.numericKeyPathSamples.includes("$.data[0].calendar[0].plans.42144"));
  assert.equal(JSON.stringify(normalized).includes("Booking"), false);
});

test("normalizer computes minPrice/maxPrice/dateCount/itemCount", () => {
  const normalized = normalizeCalendarsRateInventory({
    items: [
      { room_name: "A", channel_name: "Direct", date: "2026-06-01", price: 30000, inventory: 1 },
      { room_name: "A", channel_name: "Direct", date: "2026-06-02", price: 18000, inventory: 0 },
    ],
  });

  assert.equal(normalized.summary.itemCount, 2);
  assert.equal(normalized.summary.dateCount, 2);
  assert.equal(normalized.summary.minPrice, 18000);
  assert.equal(normalized.summary.maxPrice, 30000);
  assert.equal(normalized.summary.availableItemCount, 1);
  assert.equal(normalized.summary.zeroInventoryItemCount, 1);
});

test("normalizer returns parse_no_supported_shape for unrelated payload", () => {
  const normalized = normalizeCalendarsRateInventory({ data: { message: "ok", rows: [{ foo: "bar" }] } });
  assert.equal(normalized.ok, false);
  assert.equal(normalized.stoppedReason, "parse_no_supported_shape");
  assert.equal(normalized.summary.itemCount, 0);
  assert.ok(normalized.shapeSummary.objectCount > 0);
  assert.equal(JSON.stringify(normalized).includes("rawBody"), false);
});

test("sanitizer removes bearer/token/cookie/email/phone/order/uuid", () => {
  const sanitized = sanitizeAdminRateInventorySnapshot({
    ok: true,
    authorization: "Bearer abc",
    token: "abc",
    cookie: "sid=abc",
    email: "guest@example.com",
    phone: "+886 912 345 678",
    orderNo: "A123",
    uuid: "550e8400-e29b-41d4-a716-446655440000",
    headers: { authorization: "Bearer abc" },
    rawBody: { secret: "abc" },
    nested: { name: "safe room", bearerValue: "Bearer abc" },
  });

  const text = JSON.stringify(sanitized);
  assert.equal(text.includes("Bearer"), false);
  assert.equal(text.includes("guest@example.com"), false);
  assert.equal(text.includes("912"), false);
  assert.equal(text.includes("550e8400"), false);
  assert.equal(text.includes("rawBody"), false);
  assert.equal(text.includes("headers"), false);
  assert.equal(sanitized.nested.name, "safe room");
});

test("sanitizer keeps hotelId and capturedAt", () => {
  const sanitized = sanitizeAdminRateInventorySnapshot({ hotelId: "5720", capturedAt: "2026-06-01T05:00:00.000Z", request: { origin: "https://www.owlting.com", path: "/booking/v2/admin/hotels/5720/calendars" } });
  assert.equal(sanitized.hotelId, "5720");
  assert.equal(sanitized.capturedAt, "2026-06-01T05:00:00.000Z");
  assert.equal(sanitized.request.path, "/booking/v2/admin/hotels/5720/calendars");
});

test("controlled stop payload is safe", () => {
  const snapshot = createControlledStopSnapshot(
    { tenant: "goodday", hotelId: "5720", start: "2026-06-01", end: "2026-08-31" },
    "remote_403",
    { warnings: [{ reason: "remote_403", token: "Bearer abc", cookie: "sid=abc" }] },
  );

  assert.equal(snapshot.ok, false);
  assert.equal(snapshot.stoppedReason, "remote_403");
  assert.equal(snapshot.hotelId, "5720");
  assert.equal(snapshot.summary.unknownInventoryItemCount, 0);
  assert.doesNotThrow(() => auditSanitizedAdminRateInventorySnapshot(snapshot));
});

const { loadAdminRateFetcherConfig, validateAdminRateFetcherConfig } = require("../lib/adminRateInventoryFetcher/loadAdminRateFetcherConfig");
const { runAdminRateInventoryBatchDryRun } = require("../lib/adminRateInventoryFetcher/runAdminRateInventoryBatchDryRun");
const { buildUniquePlanItems, buildUniquePlans } = require("../lib/adminRateInventoryFetcher/summarizeAdminRateInventoryUniquePlans");

function writeTenantConfig(tenants) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rate-inventory-tenants-"));
  const configPath = path.join(tmpDir, "tenants.json");
  fs.writeFileSync(configPath, JSON.stringify(tenants, null, 2), "utf8");
  return { tmpDir, configPath };
}

function configEnv(configPath, overrides = {}) {
  return {
    ADMIN_RATE_FETCHER_ENABLED: "1",
    ADMIN_RATE_FETCHER_CONFIG_PATH: configPath,
    ADMIN_RATE_FETCHER_TENANT: "mozhouse",
    ADMIN_RATE_FETCHER_INCLUDE_DISABLED: "true",
    ADMIN_RATE_FETCHER_DAYS: "120",
    ADMIN_RATE_FETCHER_MAX_DAYS: "120",
    ADMIN_RATE_FETCHER_TODAY: "2026-06-02",
    ADMIN_RATE_FETCHER_OUT_DIR: path.dirname(configPath),
    ...overrides,
  };
}

const sampleTenants = {
  goodday: { enabled: true, tenant: "goodday", hotelId: "5720", displayName: "良辰吉日", days: 120, currency: "TWD" },
  mozhouse: { enabled: false, tenant: "mozhouse", hotelId: "5816", displayName: "木子寓所", days: 120, currency: "TWD" },
  lunarhaven: { enabled: false, tenant: "lunarhaven", hotelId: "6721", displayName: "泊月民宿", days: 120, currency: "TWD" },
};

test("loads tenant from rateInventoryTenants config", () => {
  const { configPath } = writeTenantConfig(sampleTenants);
  const config = loadAdminRateFetcherConfig(configEnv(configPath));

  assert.equal(config.tenant, "mozhouse");
  assert.equal(config.tenantKey, "mozhouse");
  assert.equal(config.hotelId, "5816");
  assert.equal(config.displayName, "木子寓所");
  assert.equal(config.currency, "TWD");
});

test("single tenant uses config hotelId", async () => {
  const { configPath, tmpDir } = writeTenantConfig(sampleTenants);
  const result = await runAdminRateInventoryFetcherDryRun({ chromium: {}, env: configEnv(configPath, { ADMIN_RATE_FETCHER_OUT_DIR: tmpDir }) });

  assert.equal(result.stoppedReason, "missing_credentials");
  assert.equal(result.output.hotelId, "5816");
  assert.equal(path.basename(result.outputPath), "admin_rate_inventory_fetcher_dryrun_mozhouse_5816_2026-06-02_2026-09-29.json");
});

test("disabled tenant rejected when includeDisabled=false", async () => {
  const { configPath } = writeTenantConfig(sampleTenants);
  const result = await runAdminRateInventoryFetcherDryRun({ chromium: {}, env: configEnv(configPath, { ADMIN_RATE_FETCHER_INCLUDE_DISABLED: "false" }) });

  assert.equal(result.stoppedReason, "invalid_config");
  assert.match(JSON.stringify(result.output.warnings), /tenant disabled/);
});

test("disabled tenant allowed when includeDisabled=true", () => {
  const { configPath } = writeTenantConfig(sampleTenants);
  const config = loadAdminRateFetcherConfig(configEnv(configPath, { ADMIN_RATE_FETCHER_INCLUDE_DISABLED: "true" }));

  assert.deepEqual(validateAdminRateFetcherConfig(config), []);
  assert.equal(config.hotelId, "5816");
});

test("days=120 passes maxDays=120", () => {
  const { configPath } = writeTenantConfig(sampleTenants);
  const config = loadAdminRateFetcherConfig(configEnv(configPath, { ADMIN_RATE_FETCHER_DAYS: "120", ADMIN_RATE_FETCHER_MAX_DAYS: "120" }));

  assert.equal(config.days, 120);
  assert.equal(config.maxDays, 120);
  assert.equal(config.start, "2026-06-02");
  assert.equal(config.end, "2026-09-29");
  assert.doesNotThrow(() => buildCalendarsApiRequest({ origin: config.origin, hotelId: config.hotelId, start: config.start, end: config.end, lang: config.lang, maxDays: config.maxDays }));
});

test("missing tenant returns invalid_config", async () => {
  const { configPath } = writeTenantConfig(sampleTenants);
  const result = await runAdminRateInventoryFetcherDryRun({ chromium: {}, env: configEnv(configPath, { ADMIN_RATE_FETCHER_TENANT: "missing" }) });

  assert.equal(result.stoppedReason, "invalid_config");
  assert.match(JSON.stringify(result.output.warnings), /not found/);
});

test("ALL mode respects maxTenantsPerRun", async () => {
  const { configPath, tmpDir } = writeTenantConfig(sampleTenants);
  const called = [];
  const result = await runAdminRateInventoryBatchDryRun({
    chromium: {},
    env: configEnv(configPath, { ADMIN_RATE_FETCHER_TENANT: "ALL", ADMIN_RATE_FETCHER_MAX_TENANTS_PER_RUN: "2", ADMIN_RATE_FETCHER_BATCH_DELAY_MS: "0", ADMIN_RATE_FETCHER_OUT_DIR: tmpDir }),
    dryRunRunner: async ({ env }) => {
      called.push(env.ADMIN_RATE_FETCHER_TENANT);
      return { stoppedReason: "completed", outputPath: `out/${env.ADMIN_RATE_FETCHER_TENANT}.json`, output: { ok: true, summary: { itemCount: 1 } } };
    },
  });

  assert.deepEqual(called, ["goodday", "mozhouse"]);
  assert.equal(result.output.tenantCount, 2);
  assert.equal(result.exitCode, 0);
});

test("tenant=ALL with maxTenantsPerRun=1 only runs first eligible tenant", async () => {
  const { configPath, tmpDir } = writeTenantConfig(sampleTenants);
  const called = [];
  await runAdminRateInventoryBatchDryRun({
    chromium: {},
    env: configEnv(configPath, { ADMIN_RATE_FETCHER_TENANT: "ALL", ADMIN_RATE_FETCHER_INCLUDE_DISABLED: "true", ADMIN_RATE_FETCHER_MAX_TENANTS_PER_RUN: "1", ADMIN_RATE_FETCHER_BATCH_DELAY_MS: "0", ADMIN_RATE_FETCHER_OUT_DIR: tmpDir }),
    dryRunRunner: async ({ env }) => {
      called.push(env.ADMIN_RATE_FETCHER_TENANT);
      return { stoppedReason: "completed", outputPath: "out/goodday.json", output: { ok: true, summary: {} } };
    },
  });

  assert.deepEqual(called, ["goodday"]);
});

test("ALL mode sequentially aggregates batch summary", async () => {
  const { configPath, tmpDir } = writeTenantConfig(sampleTenants);
  let active = 0;
  let maxActive = 0;
  const result = await runAdminRateInventoryBatchDryRun({
    chromium: {},
    env: configEnv(configPath, { ADMIN_RATE_FETCHER_TENANT: "ALL", ADMIN_RATE_FETCHER_MAX_TENANTS_PER_RUN: "3", ADMIN_RATE_FETCHER_BATCH_DELAY_MS: "0", ADMIN_RATE_FETCHER_OUT_DIR: tmpDir }),
    dryRunRunner: async ({ env }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return { stoppedReason: env.ADMIN_RATE_FETCHER_TENANT === "lunarhaven" ? "remote_403" : "completed", outputPath: `out/${env.ADMIN_RATE_FETCHER_TENANT}.json`, output: { ok: env.ADMIN_RATE_FETCHER_TENANT !== "lunarhaven", stoppedReason: env.ADMIN_RATE_FETCHER_TENANT === "lunarhaven" ? "remote_403" : undefined, summary: { itemCount: 1 } } };
    },
  });

  assert.equal(maxActive, 1);
  assert.equal(result.output.mode, "ALL");
  assert.equal(result.output.tenantCount, 3);
  assert.equal(result.output.ok, false);
  assert.equal(result.output.results[0].uniquePlanCount, 0);
  assert.equal(result.output.results[0].uniquePlanItemCount, 0);
  assert.equal(result.exitCode, 0);
});

test("ALL mode produces per-tenant results", async () => {
  const { configPath, tmpDir } = writeTenantConfig(sampleTenants);
  const result = await runAdminRateInventoryBatchDryRun({
    chromium: {},
    env: configEnv(configPath, { ADMIN_RATE_FETCHER_TENANT: "ALL", ADMIN_RATE_FETCHER_MAX_TENANTS_PER_RUN: "2", ADMIN_RATE_FETCHER_BATCH_DELAY_MS: "0", ADMIN_RATE_FETCHER_OUT_DIR: tmpDir }),
    dryRunRunner: async ({ env }) => ({ stoppedReason: "completed", outputPath: `out/${env.ADMIN_RATE_FETCHER_TENANT}.json`, output: { ok: true, summary: { dateCount: 120 }, uniquePlans: [{ planId: "p1" }], uniquePlanItems: [{ planItemId: "i1" }, { planItemId: "i2" }] } }),
  });

  assert.deepEqual(result.output.results.map((item) => item.tenant), ["goodday", "mozhouse"]);
  assert.deepEqual(result.output.results.map((item) => item.hotelId), ["5720", "5816"]);
  assert.deepEqual(result.output.results.map((item) => item.uniquePlanCount), [1, 1]);
  assert.deepEqual(result.output.results.map((item) => item.uniquePlanItemCount), [2, 2]);
  assert.ok(fs.existsSync(result.outputPath));
});

test("build uniquePlans from normalized items", () => {
  const uniquePlans = buildUniquePlans([
    { salesUnitId: "26669", salesUnitName: "獨享包棟私墅", planId: "42166", planName: "獨享包棟", date: "2026-06-02", price: 22000, inventory: 1, available: true, currency: "TWD", minLos: 1 },
  ]);

  assert.equal(uniquePlans.length, 1);
  assert.deepEqual(uniquePlans[0], {
    salesUnitId: "26669",
    salesUnitName: "獨享包棟私墅",
    planId: "42166",
    planName: "獨享包棟",
    currency: "TWD",
    minPrice: 22000,
    maxPrice: 22000,
    dateCount: 1,
    availableItemCount: 1,
    zeroInventoryItemCount: 0,
    unknownInventoryItemCount: 0,
    minLosValues: [1],
    children: [],
  });
});

test("uniquePlans aggregates minPrice/maxPrice/dateCount/available counts", () => {
  const uniquePlans = buildUniquePlans([
    { salesUnitId: "26669", salesUnitName: "A", planId: "42166", planName: "P", date: "2026-06-02", price: 24000, inventory: 1, available: true, currency: "TWD", minLos: 1 },
    { salesUnitId: "26669", salesUnitName: "A", planId: "42166", planName: "P", date: "2026-06-03", price: 22000, inventory: 0, available: false, currency: "TWD", minLos: 2 },
    { salesUnitId: "26669", salesUnitName: "A", planId: "42166", planName: "P", date: "2026-06-04", price: 26000, inventory: null, available: null, currency: "TWD", minLos: 1 },
  ]);

  assert.equal(uniquePlans[0].minPrice, 22000);
  assert.equal(uniquePlans[0].maxPrice, 26000);
  assert.equal(uniquePlans[0].dateCount, 3);
  assert.equal(uniquePlans[0].availableItemCount, 1);
  assert.equal(uniquePlans[0].zeroInventoryItemCount, 1);
  assert.equal(uniquePlans[0].unknownInventoryItemCount, 1);
  assert.deepEqual(uniquePlans[0].minLosValues, [1, 2]);
});

test("workflow static: admin-rate-inventory-fetcher-dryrun.yml has required safe inputs and no schedule/publish side effects", () => {
  const workflow = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "admin-rate-inventory-fetcher-dryrun.yml"), "utf8");

  assert.equal(/\bschedule\s*:/.test(workflow), false);
  assert.match(workflow, /Tenant key or ALL/);
  assert.match(workflow, /include_disabled:/);
  assert.match(workflow, /max_tenants_per_run:/);
  assert.match(workflow, /days:[\s\S]*default: "120"/);
  assert.equal(/ODIN_SHEET_/i.test(workflow), false);
  assert.equal(/odin-data/i.test(workflow), false);
});
