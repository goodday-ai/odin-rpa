// 功能：Booking Price Probe 的純 unit tests，不進行真實網路或 Playwright live probe。
// 責任：驗證 URL 治理、候選 API 偵測、價格摘要萃取、JSON shape 摘要、敏感資料清理與停止分類。
// 關聯模組：lib/bookingPriceProbe/*；避免改動 tests/orderDetailCapture.spec.js 的既有 runtime 行為。
// 關鍵流程：使用 node:test 與 assert/strict，透過 fixture JSON 覆蓋 scorer/extractor/sanitizer 高風險邏輯。

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildProbeUrl } = require("../lib/bookingPriceProbe/buildProbeUrl");
const { safeUrlInfo } = require("../lib/bookingPriceProbe/safeUrlInfo");
const { detectPriceApiCandidate } = require("../lib/bookingPriceProbe/detectPriceApiCandidate");
const { extractPriceOffers } = require("../lib/bookingPriceProbe/extractPriceOffers");
const { summarizeJsonShape } = require("../lib/bookingPriceProbe/summarizeJsonShape");
const { sanitizeProbeOutput, createControlledStopOutput } = require("../lib/bookingPriceProbe/sanitizeProbeOutput");
const { classifyStopReason, outputExitCode } = require("../lib/bookingPriceProbe/runBookingPriceProbe");

function validConfig(overrides = {}) {
  return {
    bookingUrl: "https://booking.owlting.com/good.day?keep=remove-me",
    start: "2026-06-02",
    end: "2026-06-03",
    adult: 1,
    child: 0,
    infant: 0,
    lang: "zh_TW",
    ...overrides,
  };
}

test("buildProbeUrl accepts valid bookingUrl/start/end/guest counts", () => {
  const url = new URL(buildProbeUrl(validConfig()));
  assert.equal(url.origin, "https://booking.owlting.com");
  assert.equal(url.pathname, "/good.day");
  assert.equal(url.searchParams.get("start"), "2026-06-02");
  assert.equal(url.searchParams.get("end"), "2026-06-03");
  assert.equal(url.searchParams.get("adult"), "1");
  assert.equal(url.searchParams.get("child"), "0");
  assert.equal(url.searchParams.get("infant"), "0");
  assert.equal(url.searchParams.get("lang"), "zh_TW");
});

test("buildProbeUrl rejects invalid date", () => {
  assert.throws(() => buildProbeUrl(validConfig({ start: "2026-02-30" })), /invalid_config:date_must_be_yyyy_mm_dd/);
});

test("buildProbeUrl rejects start >= end", () => {
  assert.throws(() => buildProbeUrl(validConfig({ start: "2026-06-03", end: "2026-06-03" })), /start_must_be_before_end/);
  assert.throws(() => buildProbeUrl(validConfig({ start: "2026-06-04", end: "2026-06-03" })), /start_must_be_before_end/);
});

test("buildProbeUrl rejects adult < 1", () => {
  assert.throws(() => buildProbeUrl(validConfig({ adult: 0 })), /adult_must_be_at_least_1/);
});

test("buildProbeUrl rejects child/infant < 0", () => {
  assert.throws(() => buildProbeUrl(validConfig({ child: -1 })), /child_must_be_at_least_0/);
  assert.throws(() => buildProbeUrl(validConfig({ infant: -1 })), /infant_must_be_at_least_0/);
});

test("buildProbeUrl only emits query keys start/end/lang/adult/child/infant", () => {
  const url = new URL(buildProbeUrl(validConfig()));
  assert.deepEqual(Array.from(url.searchParams.keys()).sort(), ["adult", "child", "end", "infant", "lang", "start"]);
  assert.equal(url.searchParams.has("keep"), false);
});

test("safeUrlInfo strips query values and keeps only query keys", () => {
  const info = safeUrlInfo("https://www.booking-owlnest.com/api/rate?start=2026-06-02&token=secret&adult=1");
  assert.deepEqual(info, {
    origin: "https://www.booking-owlnest.com",
    pathname: "/api/rate",
    queryKeys: ["adult", "start", "token"],
  });
  assert.equal(JSON.stringify(info).includes("secret"), false);
  assert.equal(JSON.stringify(info).includes("2026-06-02"), false);
});

test("detectPriceApiCandidate detects room/rate/price/availability keys", () => {
  const candidate = detectPriceApiCandidate({
    url: "https://www.booking-owlnest.com/api/rooms/ratePlans?start=2026-06-02",
    json: {
      rooms: [{ roomName: "雙人房", ratePlans: [{ planName: "官網專案", price: 3600, currency: "TWD", available: true, inventory: 1 }] }],
    },
  });
  assert.equal(candidate.detectedFields.hasRoomType, true);
  assert.equal(candidate.detectedFields.hasPlanName, true);
  assert.equal(candidate.detectedFields.hasPrice, true);
  assert.equal(candidate.detectedFields.hasAvailability, true);
  assert.equal(candidate.detectedFields.hasInventory, true);
  assert.ok(candidate.score >= 20);
});

test("detectPriceApiCandidate returns low score for unrelated JSON", () => {
  const candidate = detectPriceApiCandidate({
    url: "https://www.booking-owlnest.com/api/ping",
    json: { ok: true, message: "pong", version: 1 },
  });
  assert.equal(candidate.score, 0);
  assert.equal(candidate.detectedFields.hasPrice, false);
});

test("extractPriceOffers extracts min price from nested room/plan-like payload", () => {
  const result = extractPriceOffers({
    data: {
      rooms: [
        { roomName: "雙人房", currency: "TWD", plans: [{ planName: "官網專案", price: 3600, available: true, inventory: 1 }] },
        { roomName: "家庭房", currency: "TWD", plans: [{ planName: "早鳥專案", amount: "4200", available: true, stock: 2 }] },
      ],
    },
  });
  assert.equal(result.offers.length, 2);
  assert.equal(result.minPriceSummary.hasPrice, true);
  assert.equal(result.minPriceSummary.minPrice, 3600);
  assert.equal(result.minPriceSummary.currency, "TWD");
  assert.equal(result.offers[0].sourcePath, "$.data.rooms[0].plans[0]");
});

test("extractPriceOffers does not expose email/phone/order fields", () => {
  const result = extractPriceOffers({
    roomName: "雙人房",
    price: 3600,
    email: "guest@example.com",
    phone: "0912345678",
    order_no: "ABCD1234",
    currency: "TWD",
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("guest@example.com"), false);
  assert.equal(serialized.includes("0912345678"), false);
  assert.equal(serialized.includes("ABCD1234"), false);
});

test("summarizeJsonShape outputs keys/types only, not raw scalar values", () => {
  const shape = summarizeJsonShape({ email: "guest@example.com", price: 3600, nested: { phone: "0912345678" } });
  const serialized = JSON.stringify(shape);
  assert.equal(serialized.includes("guest@example.com"), false);
  assert.equal(serialized.includes("0912345678"), false);
  assert.equal(serialized.includes("3600"), false);
  assert.ok(serialized.includes("type"));
});

test("sanitizeProbeOutput removes cookie/authorization/bearer/token/email/phone", () => {
  const output = sanitizeProbeOutput({
    cookie: "a=b",
    authorization: "Bearer abc",
    token: "secret-token",
    nested: { email: "guest@example.com", phone: "0912345678", safe: "ok" },
  });
  const serialized = JSON.stringify(output);
  assert.equal(serialized.includes("cookie"), false);
  assert.equal(serialized.includes("authorization"), false);
  assert.equal(serialized.includes("Bearer"), false);
  assert.equal(serialized.includes("secret-token"), false);
  assert.equal(serialized.includes("guest@example.com"), false);
  assert.equal(serialized.includes("0912345678"), false);
  assert.equal(output.nested.safe, "ok");
});

test("stop classifier detects 403/429/login/challenge/captcha", () => {
  assert.equal(classifyStopReason({ status: 403, url: "https://booking.owlting.com/good.day" }), "remote_403");
  assert.equal(classifyStopReason({ status: 429, url: "https://booking.owlting.com/good.day" }), "remote_429");
  assert.equal(classifyStopReason({ status: 200, url: "https://example.com/login" }), "remote_login_redirect");
  assert.equal(classifyStopReason({ status: 200, url: "https://example.com/challenge" }), "remote_captcha");
  assert.equal(classifyStopReason({ status: 200, url: "https://example.com/captcha" }), "remote_captcha");
});

test("controlled stop returns safe ok=false payload", () => {
  const payload = createControlledStopOutput({
    tenant: "goodday",
    bookingUrl: "https://booking.owlting.com/good.day?start=2026-06-02&token=secret",
    start: "2026-06-02",
    end: "2026-06-03",
    adult: 1,
    child: 0,
    infant: 0,
    lang: "zh_TW",
  }, "remote_429");
  assert.equal(payload.ok, false);
  assert.equal(payload.stoppedReason, "remote_429");
  assert.equal(payload.bookingUrlOrigin, "https://booking.owlting.com");
  assert.equal(payload.bookingUrlPath, "/good.day");
  assert.equal(JSON.stringify(payload).includes("secret"), false);
  assert.equal(outputExitCode("remote_429"), 0);
  assert.equal(outputExitCode("invalid_config"), 1);
});
