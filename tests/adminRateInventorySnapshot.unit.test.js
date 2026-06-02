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
  validateRateInventorySnapshotConfig,
} = require("../lib/adminRateInventorySnapshot/loadRateInventorySnapshotConfig");
const { publishRateInventorySnapshot, latestSnapshotPath, publishCandidatePath } = require("../lib/adminRateInventorySnapshot/publishRateInventorySnapshot");
const { buildSnapshotCalendarsRequest } = require("../lib/adminRateInventorySnapshot/runRateInventorySnapshotSync");
const { runRateInventorySnapshotBatchSync } = require("../lib/adminRateInventorySnapshot/runRateInventorySnapshotBatchSync");
const {
  assertRateInventorySnapshotPublishCandidate,
  validateRateInventorySnapshotForPublish,
  validateRateInventorySnapshotPublishCandidate,
} = require("../lib/adminRateInventorySnapshot/validateRateInventorySnapshot");

function baseEnv(extra = {}) {
  return {
    RATE_INVENTORY_SYNC_ENABLED: "1",
    RATE_INVENTORY_TENANT: "goodday",
    RATE_INVENTORY_CONFIG_PATH: "config/rateInventoryTenants.json",
    RATE_INVENTORY_TODAY: "2026-06-01",
    RATE_INVENTORY_DAYS: "120",
    RATE_INVENTORY_MAX_DAYS: "120",
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
  assert.equal(config.days, 120);
  assert.equal(config.maxDays, 120);
  assert.equal(config.end, "2026-09-28");
  assert.deepEqual(validateRateInventorySnapshotConfig(config), []);
  assert.deepEqual(config.publishPlanIdAllowlist, ["42144", "42145", "42166"]);
  assert.deepEqual(config.publishSalesUnitIdAllowlist, ["26669"]);
});

test("accepts goodday 120-day sync window and maxDays", () => {
  const config = sampleConfig({ RATE_INVENTORY_DAYS: "120", RATE_INVENTORY_MAX_DAYS: "120" });
  assert.equal(config.days, 120);
  assert.equal(config.maxDays, 120);
  assert.equal(config.start, "2026-06-01");
  assert.equal(config.end, "2026-09-28");
});

test("snapshot sync passes config.maxDays=120 to buildCalendarsApiRequest", () => {
  const config = sampleConfig({ RATE_INVENTORY_TODAY: "2026-06-02", RATE_INVENTORY_DAYS: "120", RATE_INVENTORY_MAX_DAYS: "120" });
  const request = buildSnapshotCalendarsRequest(config);

  assert.equal(config.start, "2026-06-02");
  assert.equal(config.end, "2026-09-29");
  assert.match(request.url, /during_start_date=2026-06-02/);
  assert.match(request.url, /during_end_date=2026-09-29/);
});

test("goodday days=120 no longer throws range must be <= 92 days", () => {
  const config = sampleConfig({ RATE_INVENTORY_TODAY: "2026-06-02", RATE_INVENTORY_DAYS: "120", RATE_INVENTORY_MAX_DAYS: "120" });

  assert.doesNotThrow(() => buildSnapshotCalendarsRequest(config));
});

test("rejects tenant days greater than maxDays during config validation", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rate-inventory-max-days-"));
  const configPath = path.join(tmpDir, "tenants.json");
  // 中文註解：刻意不設定 RATE_INVENTORY_DAYS，讓 tenant.days 直接進入驗證，確保超過 maxDays 不會被默默允許。
  fs.writeFileSync(
    configPath,
    JSON.stringify({ goodday: { enabled: true, tenant: "goodday", hotelId: "5720", days: 121, publishPlanIdAllowlist: ["42166"], publishSalesUnitIdAllowlist: ["26669"] } }),
    "utf8",
  );
  const config = loadRateInventorySnapshotConfig(baseEnv({ RATE_INVENTORY_CONFIG_PATH: configPath, RATE_INVENTORY_DAYS: "" }));
  assert.equal(config.days, 121);
  assert.match(validateRateInventorySnapshotConfig(config).join("\n"), /RATE_INVENTORY_DAYS must be <= RATE_INVENTORY_MAX_DAYS/);
});

test("multi-brand tenant inventory config enables selected publish allowlists", () => {
  const tenants = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "rateInventoryTenants.json"), "utf8"));
  const expected = {
    goodday: { plans: ["42144", "42145", "42166"], salesUnits: ["26669"] },
    mozhouse: { plans: ["29021", "30102", "42263"], salesUnits: ["27443", "27444", "27475"] },
    houseapt: { plans: ["34646", "40119"], salesUnits: ["30637", "30717"] },
    houseresidence: { plans: ["40071", "43777"], salesUnits: ["32440"] },
    lunarhaven: { plans: ["40073", "40684"], salesUnits: ["32438"] },
    nightph: { plans: ["35157"], salesUnits: ["31168"] },
    sunmoon: { plans: ["37738", "42691", "44175"], salesUnits: ["32439"] },
    triplesuite: { plans: ["41445"], salesUnits: ["30274"] },
  };

  for (const [tenantKey, allowlists] of Object.entries(expected)) {
    assert.equal(tenants[tenantKey].enabled, true, `${tenantKey} must be enabled`);
    assert.equal(tenants[tenantKey].days, 120, `${tenantKey} must keep 120-day inventory horizon`);
    assert.deepEqual(tenants[tenantKey].publishPlanIdAllowlist, allowlists.plans, `${tenantKey} plan allowlist must match approved dry-run planIds`);
    assert.deepEqual(tenants[tenantKey].publishSalesUnitIdAllowlist, allowlists.salesUnits, `${tenantKey} sales-unit allowlist must match approved dry-run salesUnitIds`);
  }
});

test("all enabled tenant configs have non-empty publish allowlists and 120-day horizon", () => {
  const tenants = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "rateInventoryTenants.json"), "utf8"));
  const enabledTenants = Object.values(tenants).filter((tenant) => tenant.enabled);

  assert.equal(enabledTenants.length, Object.keys(tenants).length);
  for (const tenant of enabledTenants) {
    assert.equal(tenant.days, 120, `${tenant.tenant} must use 120 days`);
    assert.ok(tenant.publishPlanIdAllowlist.length > 0, `${tenant.tenant} must have publishPlanIdAllowlist`);
    assert.ok(tenant.publishSalesUnitIdAllowlist.length > 0, `${tenant.tenant} must have publishSalesUnitIdAllowlist`);
  }
});

test("newly enabled mozhouse tenant loads as syncable with approved allowlists", () => {
  const config = loadEnabledTenantConfig(baseEnv({
    RATE_INVENTORY_TENANT: "mozhouse",
    RATE_INVENTORY_TENANT_ALLOWLIST: "mozhouse",
    RATE_INVENTORY_PUBLISH_ENABLED: "1",
  }));

  assert.equal(config.enabled, true);
  assert.equal(config.tenant, "mozhouse");
  assert.equal(config.days, 120);
  assert.deepEqual(config.publishPlanIdAllowlist, ["29021", "30102", "42263"]);
  assert.deepEqual(config.publishSalesUnitIdAllowlist, ["27443", "27444", "27475"]);
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

test("publish candidate root snapshot without published=true is accepted", () => {
  const config = sampleConfig();
  const snapshot = sampleSnapshot(config);
  assert.equal(Object.prototype.hasOwnProperty.call(snapshot, "published"), false);
  assert.deepEqual(validateRateInventorySnapshotPublishCandidate(snapshot), []);
  assert.equal(assertRateInventorySnapshotPublishCandidate(snapshot), true);
});

test("publish candidate with version=rate_inventory_snapshot_v1 and ok=true is accepted", () => {
  const config = sampleConfig();
  const snapshot = { ...sampleSnapshot(config), version: "rate_inventory_snapshot_v1", ok: true };
  assert.deepEqual(validateRateInventorySnapshotPublishCandidate(snapshot), []);
});

test("publish candidate artifact wrapper without snapshot root is rejected", () => {
  const config = sampleConfig();
  const wrapper = {
    published: true,
    latestPath: "data/odin/rate_inventory/latest/rate_inventory_goodday.json",
    dataBranch: "odin-data",
    snapshot: sampleSnapshot(config),
  };
  const errors = validateRateInventorySnapshotPublishCandidate(wrapper);
  assert.match(errors.join("\n"), /version must be rate_inventory_snapshot_v1/);
  assert.match(errors.join("\n"), /ok must be true/);
  assert.match(errors.join("\n"), /items must not be empty/);
});

test("publish candidate with summary.truncated=true is rejected", () => {
  const config = sampleConfig();
  const snapshot = { ...sampleSnapshot(config), summary: { ...sampleSnapshot(config).summary, truncated: true } };
  const errors = validateRateInventorySnapshotPublishCandidate(snapshot);
  assert.match(errors.join("\n"), /summary\.truncated must not be true/);
});

test("publish candidate with empty items is rejected", () => {
  const config = sampleConfig();
  const snapshot = { ...sampleSnapshot(config), items: [], summary: { ...sampleSnapshot(config).summary, itemCount: 0 } };
  const errors = validateRateInventorySnapshotPublishCandidate(snapshot);
  assert.match(errors.join("\n"), /items must not be empty/);
});

test("publish candidate with wrong version is rejected", () => {
  const config = sampleConfig();
  const snapshot = { ...sampleSnapshot(config), version: "artifact_wrapper_v1" };
  const errors = validateRateInventorySnapshotPublishCandidate(snapshot);
  assert.match(errors.join("\n"), /version must be rate_inventory_snapshot_v1/);
});

test("publishes valid snapshot to safe candidate path", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rate-inventory-publish-"));
  const latestDir = fs.mkdtempSync(path.join(os.tmpdir(), "rate-inventory-latest-"));
  const config = sampleConfig({ RATE_INVENTORY_LATEST_DIR: latestDir, RATE_INVENTORY_PUBLISH_CANDIDATE_DIR: tmpDir });
  const snapshot = sampleSnapshot(config);
  const result = await publishRateInventorySnapshot(snapshot, config);
  assert.equal(result.published, true);
  assert.equal(result.latestPath, path.join(latestDir, "rate_inventory_goodday.json"));
  assert.equal(result.candidatePath, path.join(tmpDir, "rate_inventory_goodday.json"));
  assert.equal(fs.existsSync(result.latestPath), false);
  const written = JSON.parse(fs.readFileSync(result.candidatePath, "utf8"));
  assert.equal(written.version, "rate_inventory_snapshot_v1");
  assert.equal(written.ok, true);
  assert.equal(Object.prototype.hasOwnProperty.call(written, "published"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(written, "snapshot"), false);
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

test("loads GitHub boolean publish input and tenant allowlist", () => {
  const config = sampleConfig({ RATE_INVENTORY_PUBLISH_ENABLED: "true", RATE_INVENTORY_TENANT_ALLOWLIST: "goodday" });
  assert.equal(config.publishEnabled, true);
  assert.deepEqual(config.tenantAllowlist, ["goodday"]);
  assert.equal(config.maxTenantsPerRun, 1);
});

test("stops before login when tenant is not allowlisted", () => {
  assert.throws(
    () => loadEnabledTenantConfig(baseEnv({ RATE_INVENTORY_TENANT_ALLOWLIST: "other" })),
    /tenant_not_allowed/,
  );
  assert.throws(
    () => loadEnabledTenantConfig(baseEnv({ RATE_INVENTORY_TENANT: "other", RATE_INVENTORY_TENANT_ALLOWLIST: "goodday" })),
    /tenant_not_allowed/,
  );
});

test("loads ALL tenant mode and respects eligibility filters", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rate-inventory-all-config-"));
  const configPath = path.join(tmpDir, "tenants.json");
  fs.writeFileSync(configPath, JSON.stringify({
    goodday: { enabled: true, tenant: "goodday", hotelId: "5720", days: 120, publishPlanIdAllowlist: ["42166"], publishSalesUnitIdAllowlist: ["26669"] },
    disabled: { enabled: false, tenant: "disabled", hotelId: "1", days: 120, publishPlanIdAllowlist: ["p"], publishSalesUnitIdAllowlist: ["s"] },
    missingPlans: { enabled: true, tenant: "missingPlans", hotelId: "2", days: 120, publishPlanIdAllowlist: [], publishSalesUnitIdAllowlist: ["s"] },
    missingSalesUnits: { enabled: true, tenant: "missingSalesUnits", hotelId: "3", days: 120, publishPlanIdAllowlist: ["p"], publishSalesUnitIdAllowlist: [] },
    mozhouse: { enabled: true, tenant: "mozhouse", hotelId: "5816", days: 120, publishPlanIdAllowlist: ["29021"], publishSalesUnitIdAllowlist: ["27443"] },
  }), "utf8");

  const config = loadRateInventorySnapshotConfig(baseEnv({
    RATE_INVENTORY_CONFIG_PATH: configPath,
    RATE_INVENTORY_TENANT: "ALL",
    RATE_INVENTORY_TENANT_ALLOWLIST: "goodday,mozhouse,missingPlans,missingSalesUnits,disabled",
    RATE_INVENTORY_MAX_TENANTS_PER_RUN: "8",
    RATE_INVENTORY_BATCH_DELAY_MS: "123",
    RATE_INVENTORY_CONTINUE_ON_CONTROLLED_STOP: "true",
  }));

  assert.equal(config.mode, "ALL");
  assert.equal(config.batchDelayMs, 123);
  assert.equal(config.continueOnControlledStop, true);
  assert.deepEqual(config.tenants.map((tenant) => tenant.tenant), ["goodday", "mozhouse"]);
});

test("ALL mode respects RATE_INVENTORY_TENANT_ALLOWLIST and maxTenantsPerRun", () => {
  const config = loadRateInventorySnapshotConfig(baseEnv({
    RATE_INVENTORY_TENANT: "ALL",
    RATE_INVENTORY_TENANT_ALLOWLIST: "mozhouse,houseapt,triplesuite",
    RATE_INVENTORY_MAX_TENANTS_PER_RUN: "2",
  }));

  assert.deepEqual(config.tenants.map((tenant) => tenant.tenant), ["mozhouse", "houseapt"]);
  assert.equal(config.tenantCount, 2);
});

test("ALL mode returns no_enabled_tenants when no eligible tenant remains", () => {
  const config = loadRateInventorySnapshotConfig(baseEnv({
    RATE_INVENTORY_TENANT: "ALL",
    RATE_INVENTORY_TENANT_ALLOWLIST: "not-in-config",
    RATE_INVENTORY_MAX_TENANTS_PER_RUN: "8",
  }));

  assert.equal(config.tenantCount, 0);
  assert.equal(config.stoppedReason, "no_enabled_tenants");
});

test("batch runner executes tenants sequentially and writes per-tenant result summary", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rate-inventory-batch-"));
  const calls = [];
  const result = await runRateInventorySnapshotBatchSync({
    chromium: {},
    env: baseEnv({
      RATE_INVENTORY_TENANT: "ALL",
      RATE_INVENTORY_TENANT_ALLOWLIST: "goodday,mozhouse",
      RATE_INVENTORY_MAX_TENANTS_PER_RUN: "2",
      RATE_INVENTORY_OUT_DIR: tmpDir,
      RATE_INVENTORY_BATCH_DELAY_MS: "5",
      RATE_INVENTORY_CONTINUE_ON_CONTROLLED_STOP: "true",
    }),
    sleep: async (ms) => calls.push(`delay:${ms}`),
    runner: async ({ config }) => {
      calls.push(config.tenant);
      return { ok: true, published: false, stoppedReason: "publish_disabled", outputPath: path.join(tmpDir, `${config.tenant}.json`), summary: { itemCount: 1, truncated: false }, tenant: config.tenant, hotelId: config.hotelId, displayName: config.displayName };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["goodday", "delay:5", "mozhouse"]);
  assert.equal(result.summary.results.length, 2);
  assert.equal(result.summary.results[0].tenant, "goodday");
  assert.equal(fs.existsSync(result.outputPath), true);
});

test("controlled stop continues when continueOnControlledStop=true", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rate-inventory-controlled-"));
  const calls = [];
  const result = await runRateInventorySnapshotBatchSync({
    chromium: {},
    env: baseEnv({
      RATE_INVENTORY_TENANT: "ALL",
      RATE_INVENTORY_TENANT_ALLOWLIST: "goodday,mozhouse",
      RATE_INVENTORY_MAX_TENANTS_PER_RUN: "2",
      RATE_INVENTORY_OUT_DIR: tmpDir,
      RATE_INVENTORY_BATCH_DELAY_MS: "0",
      RATE_INVENTORY_CONTINUE_ON_CONTROLLED_STOP: "true",
    }),
    sleep: async () => {},
    runner: async ({ config }) => {
      calls.push(config.tenant);
      return config.tenant === "goodday"
        ? { ok: false, published: false, stoppedReason: "remote_429", outputPath: path.join(tmpDir, "goodday.json"), summary: {} }
        : { ok: true, published: false, stoppedReason: "publish_disabled", outputPath: path.join(tmpDir, "mozhouse.json"), summary: { itemCount: 1, truncated: false } };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["goodday", "mozhouse"]);
  assert.equal(result.summary.results[0].stoppedReason, "remote_429");
});

test("fatal error stops batch", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rate-inventory-fatal-"));
  const calls = [];
  const result = await runRateInventorySnapshotBatchSync({
    chromium: {},
    env: baseEnv({
      RATE_INVENTORY_TENANT: "ALL",
      RATE_INVENTORY_TENANT_ALLOWLIST: "goodday,mozhouse",
      RATE_INVENTORY_MAX_TENANTS_PER_RUN: "2",
      RATE_INVENTORY_OUT_DIR: tmpDir,
      RATE_INVENTORY_BATCH_DELAY_MS: "0",
      RATE_INVENTORY_CONTINUE_ON_CONTROLLED_STOP: "true",
    }),
    sleep: async () => {},
    runner: async ({ config }) => {
      calls.push(config.tenant);
      return { ok: false, published: false, stoppedReason: "missing_credentials", outputPath: path.join(tmpDir, `${config.tenant}.json`), summary: {} };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.stoppedReason, "missing_credentials");
  assert.deepEqual(calls, ["goodday"]);
});

test("publish=false does not write publish candidates", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rate-inventory-no-publish-"));
  const config = sampleConfig({ RATE_INVENTORY_PUBLISH_ENABLED: "false", RATE_INVENTORY_PUBLISH_CANDIDATE_DIR: tmpDir });
  const result = await publishRateInventorySnapshot(sampleSnapshot(config), config);
  assert.equal(result.published, false);
  assert.equal(result.skippedReason, "publish_disabled");
  assert.equal(fs.existsSync(publishCandidatePath(config)), false);
});

test("publish=true writes candidates for valid snapshots only", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rate-inventory-valid-candidate-"));
  const config = sampleConfig({ RATE_INVENTORY_PUBLISH_ENABLED: "true", RATE_INVENTORY_PUBLISH_CANDIDATE_DIR: tmpDir });
  await publishRateInventorySnapshot(sampleSnapshot(config), config);
  assert.equal(fs.existsSync(publishCandidatePath(config)), true);
});

test("invalid or truncated tenant does not produce publish candidate", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rate-inventory-invalid-candidate-"));
  const config = sampleConfig({ RATE_INVENTORY_PUBLISH_ENABLED: "true", RATE_INVENTORY_PUBLISH_CANDIDATE_DIR: tmpDir });
  const invalidSnapshot = { ...sampleSnapshot(config, { ...sampleNormalized(), truncated: true }), ok: false };
  await assert.rejects(() => publishRateInventorySnapshot(invalidSnapshot, config), /not publishable/);
  assert.equal(fs.existsSync(publishCandidatePath(config)), false);
});
