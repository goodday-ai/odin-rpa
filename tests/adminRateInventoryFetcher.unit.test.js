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
