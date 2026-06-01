// 功能：Admin Rate Inventory Fetcher Dry Run 的單元測試。
// 責任：驗證 calendars API request contract、generic normalizer、snapshot sanitizer 與 controlled stop 安全性。
// 關聯模組：lib/adminRateInventoryFetcher/*；package.json 的 test:admin-rate-inventory-fetcher 指向本檔。
// 關鍵流程：建構假資料 → 執行 request builder/normalizer/sanitizer → 斷言輸出不含敏感資訊且 summary 正確。

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildCalendarsApiRequest } = require("../lib/adminRateInventoryFetcher/buildCalendarsApiRequest");
const { normalizeCalendarsRateInventory } = require("../lib/adminRateInventoryFetcher/normalizeCalendarsRateInventory");
const {
  sanitizeAdminRateInventorySnapshot,
  createControlledStopSnapshot,
  auditSanitizedAdminRateInventorySnapshot,
} = require("../lib/adminRateInventoryFetcher/sanitizeAdminRateInventorySnapshot");

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

test("buildCalendarsApiRequest rejects range > 92 days", () => {
  assert.throws(() => buildCalendarsApiRequest({ origin: "https://www.owlting.com", hotelId: "5720", start: "2026-06-01", end: "2026-09-02" }), /range must be <= 92 days/);
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
  assert.doesNotThrow(() => auditSanitizedAdminRateInventorySnapshot(snapshot));
});
