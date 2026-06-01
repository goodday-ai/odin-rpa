// 功能：讀取 Admin Rate Inventory Snapshot Sync v1 的 tenant JSON 與環境變數設定。
// 責任：集中處理 goodday 單品牌設定、92 天日期區間、安全上限與 publish 旗標，避免同步流程直接讀散落 env。
// 關聯模組：runRateInventorySnapshotSync 啟動時呼叫本模組；buildRateInventorySnapshot 與 publishRateInventorySnapshot 使用回傳的 allowlist/publish 設定。
// 關鍵流程：env → tenant config JSON → 數值/日期正規化 → 啟用狀態與 allowlist 驗證 → 回傳可測試的純資料 config。

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_CONFIG_PATH = "config/rateInventoryTenants.json";
const DEFAULT_TENANT = "goodday";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function numberFromEnv(env, key, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function parseDateOnly(value, fieldName = "date") {
  const text = String(value || "").trim();
  if (!DATE_RE.test(text)) throw new Error(`${fieldName} must be YYYY-MM-DD`);
  const date = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) throw new Error(`${fieldName} must be a valid date`);
  return date;
}

function addUtcDays(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function formatDateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function inclusiveDaysBetween(start, end) {
  return Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
}

function loadTenantFile(configPath) {
  const absolutePath = path.resolve(configPath || DEFAULT_CONFIG_PATH);
  const parsed = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("rate inventory tenant config must be an object");
  return { absolutePath, tenants: parsed };
}

function stringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

function loadRateInventorySnapshotConfig(env = process.env) {
  const configPath = String(env.RATE_INVENTORY_CONFIG_PATH || DEFAULT_CONFIG_PATH).trim() || DEFAULT_CONFIG_PATH;
  const tenantKey = String(env.RATE_INVENTORY_TENANT || DEFAULT_TENANT).trim() || DEFAULT_TENANT;
  const { absolutePath, tenants } = loadTenantFile(configPath);
  const tenantConfig = tenants[tenantKey];
  if (!tenantConfig) throw new Error(`RATE_INVENTORY_TENANT not found: ${tenantKey}`);

  const maxDays = numberFromEnv(env, "RATE_INVENTORY_MAX_DAYS", 92, { min: 1, max: 92 });
  const tenantDays = Number.isFinite(Number(tenantConfig.days)) ? Number(tenantConfig.days) : 92;
  const days = numberFromEnv(env, "RATE_INVENTORY_DAYS", tenantDays, { min: 1, max: maxDays });
  const today = env.RATE_INVENTORY_TODAY ? parseDateOnly(env.RATE_INVENTORY_TODAY, "RATE_INVENTORY_TODAY") : new Date();
  const startDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const endDate = addUtcDays(startDate, days - 1);

  const config = {
    enabled: env.RATE_INVENTORY_SYNC_ENABLED === "1",
    publishEnabled: env.RATE_INVENTORY_PUBLISH_ENABLED === "1",
    tenant: String(tenantConfig.tenant || tenantKey).trim(),
    tenantKey,
    hotelId: String(tenantConfig.hotelId || "").trim(),
    displayName: String(tenantConfig.displayName || tenantKey).trim(),
    days,
    maxDays,
    start: formatDateOnly(startDate),
    end: formatDateOnly(endDate),
    currency: String(tenantConfig.currency || "TWD").trim() || "TWD",
    lang: String(env.RATE_INVENTORY_LANG || "zh_TW").trim() || "zh_TW",
    outDir: String(env.RATE_INVENTORY_OUT_DIR || "out").trim() || "out",
    timeoutMs: numberFromEnv(env, "RATE_INVENTORY_TIMEOUT_MS", 15000, { min: 3000, max: 120000 }),
    maxItems: numberFromEnv(env, "RATE_INVENTORY_MAX_ITEMS", 5000, { min: 1, max: 50000 }),
    dataBranch: String(env.RATE_INVENTORY_DATA_BRANCH || "odin-data").trim() || "odin-data",
    latestDir: String(env.RATE_INVENTORY_LATEST_DIR || "data/odin/rate_inventory/latest").trim() || "data/odin/rate_inventory/latest",
    origin: "https://www.owlting.com",
    configPath: absolutePath,
    publishPlanIdAllowlist: stringArray(tenantConfig.publishPlanIdAllowlist),
    publishSalesUnitIdAllowlist: stringArray(tenantConfig.publishSalesUnitIdAllowlist),
  };
  return config;
}

function validateRateInventorySnapshotConfig(config) {
  const errors = [];
  if (!config.enabled) errors.push("RATE_INVENTORY_SYNC_ENABLED must be 1");
  if (config.tenant !== "goodday") errors.push("RATE_INVENTORY_TENANT must resolve to goodday");
  if (!/^\d+$/.test(String(config.hotelId || ""))) errors.push("hotelId must be numeric");
  if (config.hotelId !== "5720") errors.push("goodday hotelId must be 5720");
  if (!DATE_RE.test(config.start)) errors.push("rangeStart must be YYYY-MM-DD");
  if (!DATE_RE.test(config.end)) errors.push("rangeEnd must be YYYY-MM-DD");
  if (DATE_RE.test(config.start) && DATE_RE.test(config.end)) {
    const actualDays = inclusiveDaysBetween(parseDateOnly(config.start, "rangeStart"), parseDateOnly(config.end, "rangeEnd"));
    if (actualDays !== config.days) errors.push(`range must cover exactly ${config.days} days`);
    if (config.days > config.maxDays) errors.push("RATE_INVENTORY_DAYS must be <= RATE_INVENTORY_MAX_DAYS");
  }
  if (config.publishPlanIdAllowlist.length === 0) errors.push("publishPlanIdAllowlist is required");
  if (config.publishSalesUnitIdAllowlist.length === 0) errors.push("publishSalesUnitIdAllowlist is required");
  return errors;
}

function loadEnabledTenantConfig(env = process.env) {
  const config = loadRateInventorySnapshotConfig(env);
  const { tenants } = loadTenantFile(config.configPath);
  const tenantConfig = tenants[config.tenantKey];
  if (!tenantConfig || tenantConfig.enabled !== true) throw new Error(`rate inventory tenant disabled: ${config.tenantKey}`);
  return config;
}

module.exports = {
  DEFAULT_CONFIG_PATH,
  DEFAULT_TENANT,
  addUtcDays,
  formatDateOnly,
  inclusiveDaysBetween,
  loadEnabledTenantConfig,
  loadRateInventorySnapshotConfig,
  parseDateOnly,
  validateRateInventorySnapshotConfig,
};
