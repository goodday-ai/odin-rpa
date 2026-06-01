// 功能：Admin Rate Inventory Probe 的單元測試，驗證 config、URL 安全化、候選偵測、API 型態推論與 sanitizer。
// 責任：避免 live probe 進入預設 npm test；僅測純函式與 controlled stop payload，不登入、不觸網、不寫 Sheet。
// 關聯模組：lib/adminRateInventoryProbe/*；package.json 的 test:admin-rate-inventory-probe 指向本檔。
// 關鍵流程：建假資料 → 呼叫 detector/inference/sanitizer → assert 安全輸出與預期 API mode。

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAdminRateProbeConfig, validateAdminRateProbeConfig } = require("../lib/adminRateInventoryProbe/loadAdminRateProbeConfig");
const { safeAdminUrlInfo } = require("../lib/adminRateInventoryProbe/safeAdminUrlInfo");
const { detectRateInventoryCandidate } = require("../lib/adminRateInventoryProbe/detectRateInventoryCandidate");
const { inferRateInventoryApiMode } = require("../lib/adminRateInventoryProbe/inferRateInventoryApiMode");
const { sanitizeAdminRateProbeOutput, createControlledStopOutput } = require("../lib/adminRateInventoryProbe/sanitizeAdminRateProbeOutput");

function makeEnv(overrides = {}) {
  return {
    ADMIN_RATE_PROBE_ENABLED: "1",
    ADMIN_RATE_PROBE_TENANT: "goodday",
    ADMIN_RATE_PROBE_HOTEL_ID: "5720",
    ADMIN_RATE_PROBE_TARGET_URL: "https://www.owlting.com/booking/admin/rate-inventory?hotel_id=5720&token=secret",
    ADMIN_RATE_PROBE_START: "2026-06-01",
    ADMIN_RATE_PROBE_END: "2026-08-31",
    ADMIN_RATE_PROBE_MONTH: "2026-06",
    ...overrides,
  };
}

test("config validates hotelId/start/end/month", () => {
  const config = loadAdminRateProbeConfig(makeEnv());
  assert.equal(config.hotelId, "5720");
  assert.equal(config.month, "2026-06");
  assert.deepEqual(validateAdminRateProbeConfig(config), []);

  const invalid = loadAdminRateProbeConfig(makeEnv({
    ADMIN_RATE_PROBE_HOTEL_ID: "abc",
    ADMIN_RATE_PROBE_START: "2026/06/01",
    ADMIN_RATE_PROBE_END: "2026-05-01",
    ADMIN_RATE_PROBE_MONTH: "202606",
  }));
  const errors = validateAdminRateProbeConfig(invalid).join("\n");
  assert.match(errors, /HOTEL_ID/);
  assert.match(errors, /START/);
  assert.match(errors, /MONTH/);
});

test("safeAdminUrlInfo strips query values and sensitive query keys", () => {
  const info = safeAdminUrlInfo("https://www.owlting.com/booking/v2/admin/rate?month=2026-06&authorization=Bearer%20abc&hotel_id=5720&date=2026-06-01");
  assert.equal(info.origin, "https://www.owlting.com");
  assert.equal(info.pathname, "/booking/v2/admin/rate");
  assert.deepEqual(info.queryKeys, ["date", "hotel_id", "month"]);
  assert.equal(JSON.stringify(info).includes("2026-06"), false);
  assert.equal(JSON.stringify(info).toLowerCase().includes("authorization"), false);
});

test("detectRateInventoryCandidate detects price/inventory/date/room fields", () => {
  const candidate = detectRateInventoryCandidate({
    url: "https://www.owlting.com/booking/v2/admin/hotels/5720/rate_inventory?month=2026-06&lang=zh_TW",
    method: "GET",
    status: 200,
    contentType: "application/json; charset=utf-8",
    json: {
      status: "ok",
      data: [
        { date: "2026-06-01", room_config_id: 1, room_name: "A", price: 3000, inventory: 2, channel_price: 3200, currency: "TWD" },
        { date: "2026-06-02", room_config_id: 1, room_name: "A", price: 3100, inventory: 1, channel_price: 3300, currency: "TWD" },
      ],
    },
  });
  assert.equal(candidate.detectedFields.hasDate, true);
  assert.equal(candidate.detectedFields.hasRoom, true);
  assert.equal(candidate.detectedFields.hasRoomConfig, true);
  assert.equal(candidate.detectedFields.hasPrice, true);
  assert.equal(candidate.detectedFields.hasInventory, true);
  assert.equal(candidate.apiModeInference.apiMode, "month_api");
  assert.ok(candidate.score > 20);
});

test("detectRateInventoryCandidate downranks me/hotels/profile/about endpoints", () => {
  const candidate = detectRateInventoryCandidate({
    url: "https://www.owlting.com/booking/v2/admin/me?lang=zh_TW",
    json: { id: 1, name: "admin", hotels: [{ id: 5720, name: "hotel" }] },
  });
  assert.equal(candidate.apiModeInference.apiMode, "not_rate_inventory");
  assert.equal(candidate._isCandidate, false);
  assert.ok(candidate.score < 0);
});

test("inferRateInventoryApiMode returns range_api for start/end + multiple dates", () => {
  const result = inferRateInventoryApiMode({
    requestQueryKeys: ["start", "end", "lang"],
    detectedFields: { hasDate: true, hasRoom: true, hasPrice: true, hasInventory: true },
    sampleShape: { dateValueCount: 2, dateValues: ["2026-06-01", "2026-06-02"] },
  });
  assert.equal(result.apiMode, "range_api");
  assert.equal(result.confidence, "high");
});

test("inferRateInventoryApiMode returns month_api for month query + many dates", () => {
  const dates = Array.from({ length: 31 }, (_, i) => `2026-06-${String(i + 1).padStart(2, "0")}`);
  const result = inferRateInventoryApiMode({
    requestQueryKeys: ["month"],
    detectedFields: { hasDate: true, hasRoomConfig: true, hasPrice: true, hasInventory: true },
    sampleShape: { dateValueCount: dates.length, dateValues: dates, monthValueCount: 1 },
  });
  assert.equal(result.apiMode, "month_api");
  assert.equal(result.confidence, "high");
});

test("inferRateInventoryApiMode returns day_api for single date only", () => {
  const result = inferRateInventoryApiMode({
    requestQueryKeys: ["date", "lang"],
    detectedFields: { hasDate: true, hasRoom: true, hasPrice: true, hasInventory: true },
    sampleShape: { dateValueCount: 1, dateValues: ["2026-06-01"] },
  });
  assert.equal(result.apiMode, "day_api");
});

test("inferRateInventoryApiMode returns unknown when shape is unclear", () => {
  const result = inferRateInventoryApiMode({
    requestQueryKeys: ["lang"],
    detectedFields: { hasDate: true, hasPrice: true, hasInventory: true },
    sampleShape: { dateValueCount: 3, dateValues: ["2026-06-01", "2026-06-02", "2026-06-03"] },
  });
  assert.equal(result.apiMode, "unknown");
});

test("sanitize output removes authorization/bearer/token/cookie/order/email/phone/uuid", () => {
  const sanitized = sanitizeAdminRateProbeOutput({
    authorization: "Bearer abc",
    cookie: "sid=abc",
    tokenValue: "abc",
    safe: "ok",
    nested: {
      rawBody: { price: 1 },
      headers: { authorization: "Bearer abc" },
      email: "user@example.com",
      phone: "+886912345678",
      uuid: "550e8400-e29b-41d4-a716-446655440000",
      requestUrl: "https://www.owlting.com/path?month=2026-06&token=abc",
    },
  });
  const text = JSON.stringify(sanitized).toLowerCase();
  for (const banned of ["authorization", "bearer", "token", "cookie", "order", "email", "phone", "uuid", "headers", "rawbody", "user@example.com", "+886"]) {
    assert.equal(text.includes(banned), false, banned);
  }
  assert.equal(sanitized.safe, "ok");
  assert.equal(sanitized.nested.requestUrl, "https://www.owlting.com/path");
});

test("controlled stop payload is safe", () => {
  const payload = createControlledStopOutput(loadAdminRateProbeConfig(makeEnv()), "missing_target_url", {
    durationMs: 5,
    diagnostics: {
      originSummary: [],
      contentTypeSummary: [],
      statusSummary: [],
      apiLikePathSamples: [{ origin: "https://www.owlting.com", path: "/booking/v2/admin/rate", queryKeys: ["month"], status: 200, contentType: "application/json" }],
      blockedOriginSamples: [],
      nonJsonSamples: [],
    },
  });
  assert.equal(payload.stoppedReason, "missing_target_url");
  const text = JSON.stringify(payload).toLowerCase();
  assert.equal(text.includes("token"), false);
  assert.equal(text.includes("bearer"), false);
  assert.equal(text.includes("2026-06&"), false);
});
