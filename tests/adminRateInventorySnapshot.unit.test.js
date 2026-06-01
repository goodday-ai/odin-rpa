// 功能：Admin Rate Inventory Snapshot Sync v1 的單元測試。
// 責任：驗證 goodday config、allowlist filter、clean snapshot、publish guard 與 sanitizer audit，確保失敗不覆蓋 latest。
// 關聯模組：lib/adminRateInventorySnapshot/* 與既有 adminRateInventoryFetcher sanitizer/normalizer；package.json 的 test:admin-rate-inventory-snapshot 指向本檔。
// 關鍵流程：建立假 normalized items → build snapshot → validate/publish 到暫存 latest → 斷言 controlled stop 與敏感資訊防線。

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { normalizeCalendarsRateInventory } = require("../lib/adminRateInventoryFetcher/normalizeCalendarsRateInventory");
const {
  sanitizeAdminRateInventorySnapshot,
  auditSanitizedAdminRateInventorySnapshot,
} = require("../lib/adminRateInventoryFetcher/sanitizeAdminRateInventorySnapshot");
const { buildRateInventorySnapshot } = require("../lib/adminRateInventorySnapshot/buildRateInventorySnapshot");
const {
  loadEnabledTenantConfig,
  loadRateInventorySnapshotConfig,
} = require("../lib/adminRateInventorySnapshot/loadRateInventorySnapshotConfig");
const { publishRateInventorySnapshot, latestSnapshotPath } = require("../lib/adminRateInventorySnapshot/publishRateInventorySnapshot");
const { validateRateInventorySnapshotForPublish } = require("../lib/adminRateInventorySnapshot/validateRateInventorySnapshot");

function baseEnv(extra = {}) {
  return {
    RATE_INVENTORY_SYNC_ENABLED: "1",
    RATE_INVENTORY_TENANT: "goodday",
    RATE_INVENTORY_CONFIG_PATH: "config/rateInventoryTenants.json",
    RATE_INVENTORY_TODAY: "2026-06-01",
    RATE_INVENTORY_DAYS: "92",
    RATE_INVENTORY_MAX_DAYS: "92",
    RATE_INVENTORY_MAX_ITEMS: "5000",
    RATE_INVENTORY_OUT_DIR: "out",
    RATE_INVENTORY_LANG: "zh_TW",
    RATE_INVENTORY_TIMEOUT_MS: "15000",
    RATE_INVENTORY_PUBLISH_ENABLED: "1",
    RATE_INVENTORY_DATA_BRANCH: "odin-data",
    RATE_INVENTORY_LATEST_DIR: "data/odin/rate_inventory/latest",
    ...extra,
  };
}

function sampleConfig(extraEnv = {}) {
  return loadEnabledTenantConfig(baseEnv(extraEnv));
}

function sampleNormalized() {
  return {
    ok: true,
    truncated: false,
    currency: "TWD",
    summary: { itemCount: 5, truncated: false },
    items: [
      { date: "2026-06-01", salesUnitId: "26669", salesUnitName: "獨享包棟私墅", roomTypeId: "26669", planId: "42166", planName: "獨享包棟", price: 24000, currency: "TWD", inventory: 1, available: true, minLos: 1, cta: false, ctd: false, sourcePath: "$.data[0].calendar[0].plans.42166" },
      { date: "2026-06-01", salesUnitId: "26669", salesUnitName: "獨享包棟私墅", roomTypeId: "26669", planId: "42144", planName: "官網專案 A", price: 16000, currency: "TWD", inventory: 1, available: true, minLos: 1, cta: false, ctd: false, sourcePath: "$.data[0].calendar[0].plans.42144" },
      { date: "2026-06-02", salesUnitId: "26669", salesUnitName: "獨享包棟私墅", roomTypeId: "26669", planId: "42145", planName: "官網專案 B", price: 18000, currency: "TWD", inventory: 0, available: false, minLos: 2, cta: true, ctd: false, sourcePath: "$.data[0].calendar[1].plans.42145" },
      { date: "2026-06-02", salesUnitId: "26669", salesUnitName: "獨享包棟私墅", roomTypeId: "26669", planId: "99999", planName: "Booking", price: 99999, currency: "TWD", inventory: 1, available: true, sourcePath: "$.debug.token" },
      { date: "2026-06-02", salesUnitId: "99999", salesUnitName: "其他房型", roomTypeId: "99999", planId: "42166", planName: "獨享包棟", price: 12345, currency: "TWD", inventory: 1, available: true, sourcePath: "$.debug.cookie" },
    ],
  };
}

function sampleSnapshot(config = sampleConfig(), normalized = sampleNormalized()) {
  return buildRateInventorySnapshot({ config, normalized, capturedAt: "2026-06-01T01:00:00.000Z" });
}

test("loads goodday config", () => {
  const config = sampleConfig();
  assert.equal(config.enabled, true);
  assert.equal(config.tenant, "goodday");
  assert.equal(config.hotelId, "5720");
  assert.equal(config.displayName, "良辰吉日");
  assert.equal(config.start, "2026-06-01");
  assert.equal(config.end, "2026-08-31");
  assert.deepEqual(config.publishPlanIdAllowlist, ["42144", "42145", "42166"]);
  assert.deepEqual(config.publishSalesUnitIdAllowlist, ["26669"]);
});

test("rejects disabled tenant", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rate-inventory-config-"));
  const configPath = path.join(tmpDir, "tenants.json");
  fs.writeFileSync(configPath, JSON.stringify({ goodday: { enabled: false, tenant: "goodday", hotelId: "5720", publishPlanIdAllowlist: ["42166"], publishSalesUnitIdAllowlist: ["26669"] } }), "utf8");
  assert.throws(() => loadEnabledTenantConfig(baseEnv({ RATE_INVENTORY_CONFIG_PATH: configPath })), /tenant disabled/);
  const disabledConfig = loadRateInventorySnapshotConfig(baseEnv({ RATE_INVENTORY_CONFIG_PATH: configPath }));
  assert.equal(disabledConfig.tenant, "goodday");
});

test("filters items by publishPlanIdAllowlist", () => {
  const snapshot = sampleSnapshot();
  assert.deepEqual([...new Set(snapshot.items.map((item) => item.planId))].sort(), ["42144", "42145", "42166"]);
  assert.equal(snapshot.items.some((item) => item.planId === "99999"), false);
});

test("filters items by publishSalesUnitIdAllowlist", () => {
  const snapshot = sampleSnapshot();
  assert.deepEqual([...new Set(snapshot.items.map((item) => item.salesUnitId))], ["26669"]);
  assert.equal(snapshot.items.some((item) => item.salesUnitId === "99999"), false);
});

test("builds clean snapshot without dry-run diagnostics", () => {
  const snapshot = sampleSnapshot();
  const text = JSON.stringify(snapshot);
  assert.equal(text.includes("sourcePath"), false);
  assert.equal(text.includes("shapeSummary"), false);
  assert.equal(text.includes("warnings"), false);
  assert.equal(text.includes("diagnostics"), false);
  assert.equal(text.includes("headers"), false);
  assert.equal(text.includes("rawBody"), false);
  assert.equal(text.includes("token"), false);
  assert.equal(text.includes("cookie"), false);
});

test("computes minPrice/maxPrice/dateCount/planCount", () => {
  const snapshot = sampleSnapshot();
  assert.equal(snapshot.summary.itemCount, 3);
  assert.equal(snapshot.summary.dateCount, 2);
  assert.equal(snapshot.summary.salesUnitCount, 1);
  assert.equal(snapshot.summary.planCount, 3);
  assert.equal(snapshot.summary.minPrice, 16000);
  assert.equal(snapshot.summary.maxPrice, 24000);
  assert.equal(snapshot.summary.truncated, false);
});

test("rejects truncated snapshot for publish", () => {
  const config = sampleConfig();
  const snapshot = sampleSnapshot(config, { ...sampleNormalized(), truncated: true });
  const errors = validateRateInventorySnapshotForPublish(snapshot, config);
  assert.match(errors.join("\n"), /truncated/);
});

test("rejects empty items for publish", () => {
  const config = sampleConfig();
  const snapshot = sampleSnapshot(config, { ok: true, truncated: false, items: [] });
  const errors = validateRateInventorySnapshotForPublish(snapshot, config);
  assert.match(errors.join("\n"), /items must not be empty|itemCount/);
});

test("rejects stale / invalid range", () => {
  const config = sampleConfig();
  const snapshot = { ...sampleSnapshot(config), rangeStart: "2026-06-02", rangeEnd: "2026-09-01" };
  const errors = validateRateInventorySnapshotForPublish(snapshot, config);
  assert.match(errors.join("\n"), /rangeStart\/rangeEnd must match current sync window/);
});

test("publishes valid snapshot to latest path", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rate-inventory-publish-"));
  const config = sampleConfig({ RATE_INVENTORY_LATEST_DIR: tmpDir });
  const snapshot = sampleSnapshot(config);
  const result = await publishRateInventorySnapshot(snapshot, config);
  assert.equal(result.published, true);
  assert.equal(result.latestPath, path.join(tmpDir, "rate_inventory_goodday.json"));
  const written = JSON.parse(fs.readFileSync(result.latestPath, "utf8"));
  assert.equal(written.tenant, "goodday");
  assert.equal(written.summary.truncated, false);
  assert.deepEqual([...new Set(written.items.map((item) => item.salesUnitId))], ["26669"]);
});

test("does not publish on controlled stop", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rate-inventory-latest-"));
  const config = sampleConfig({ RATE_INVENTORY_LATEST_DIR: tmpDir });
  const latestPath = latestSnapshotPath(config);
  fs.mkdirSync(path.dirname(latestPath), { recursive: true });
  fs.writeFileSync(latestPath, "{\"old\":true}\n", "utf8");

  const stoppedSnapshot = { ...sampleSnapshot(config), ok: false, stoppedReason: "remote_429" };
  await assert.rejects(() => publishRateInventorySnapshot(stoppedSnapshot, config), /not publishable/);
  assert.equal(fs.readFileSync(latestPath, "utf8"), "{\"old\":true}\n");
});

test("sanitizer removes token/cookie/email/phone/order/uuid/headers/rawBody", () => {
  const sanitized = sanitizeAdminRateInventorySnapshot({
    hotelId: "5720",
    capturedAt: "2026-06-01T01:00:00.000Z",
    request: { url: "https://www.owlting.com/booking/v2/admin/hotels/5720/calendars?token=secret" },
    headers: { authorization: "Bearer secret" },
    rawBody: "secret body",
    token: "secret-token",
    cookie: "sid=secret",
    email: "guest@example.com",
    phone: "+886 912 345 678",
    orderNo: "OBE123456",
    uuid: "550e8400-e29b-41d4-a716-446655440000",
    nested: { value: "plain text" },
  });
  const text = JSON.stringify(sanitized);
  assert.equal(text.includes("secret"), false);
  assert.equal(text.includes("guest@example.com"), false);
  assert.equal(text.includes("912"), false);
  assert.equal(text.includes("OBE123456"), false);
  assert.equal(text.includes("550e8400"), false);
  assert.equal(text.includes("headers"), false);
  assert.equal(text.includes("rawBody"), false);
  auditSanitizedAdminRateInventorySnapshot(sanitized);
});

test("keeps capturedAt and hotelId", () => {
  const sanitized = sanitizeAdminRateInventorySnapshot({ hotelId: "5720", capturedAt: "2026-06-01T01:00:00.000Z" });
  assert.equal(sanitized.hotelId, "5720");
  assert.equal(sanitized.capturedAt, "2026-06-01T01:00:00.000Z");
});

test("manual normalized payload can build publishable goodday snapshot", () => {
  const config = sampleConfig();
  const normalized = normalizeCalendarsRateInventory({
    data: [
      {
        room_id: "26669",
        room_name: "獨享包棟私墅",
        calendar: [
          {
            date: "2026-06-01",
            count: 1,
            max_stock_count: 1,
            is_lock: false,
            plans: {
              42166: { name: "獨享包棟", price: 24000, currency: "TWD", is_allow_booking: true, min_los: 1, cta: false, ctd: false },
              99999: { name: "Booking", price: 99999, currency: "TWD", is_allow_booking: true },
            },
          },
        ],
      },
    ],
  });
  const snapshot = sampleSnapshot(config, normalized);
  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.items[0].planId, "42166");
  assert.equal(validateRateInventorySnapshotForPublish(snapshot, config).length, 0);
});
