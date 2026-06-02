// 功能：讀取 Admin Rate Inventory Snapshot Sync v1 的 tenant JSON 與環境變數設定。
// 責任：集中處理單品牌與 tenant=ALL 批次設定、120 天日期區間、安全上限與 publish 旗標，避免同步流程直接讀散落 env。
// 關聯模組：runRateInventorySnapshotSync/runRateInventorySnapshotBatchSync 啟動時呼叫本模組；buildRateInventorySnapshot 與 publishRateInventorySnapshot 使用回傳的 allowlist/publish 設定。
// 關鍵流程：env → tenant config JSON → 數值/日期正規化 → 啟用狀態與 allowlist 驗證 → 回傳可測試的單品牌或 ALL batch config。

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_CONFIG_PATH = "config/rateInventoryTenants.json";
const DEFAULT_TENANT = "goodday";
const ALL_TENANTS = "ALL";
const DEFAULT_TENANT_ALLOWLIST = "goodday";
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

function csvArray(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function booleanFromEnv(env, key) {
  const normalized = String(env[key] || "").trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

function sharedEnvConfig(env, tenantConfig, tenantKey, absolutePath) {
  const maxDays = numberFromEnv(env, "RATE_INVENTORY_MAX_DAYS", 120, { min: 1, max: 120 });
  const tenantDays = Number.isFinite(Number(tenantConfig.days)) ? Number(tenantConfig.days) : 120;
  const days = numberFromEnv(env, "RATE_INVENTORY_DAYS", tenantDays, { min: 1, max: maxDays });
  const today = env.RATE_INVENTORY_TODAY ? parseDateOnly(env.RATE_INVENTORY_TODAY, "RATE_INVENTORY_TODAY") : new Date();
  const startDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const endDate = addUtcDays(startDate, days - 1);

  return {
    enabled: booleanFromEnv(env, "RATE_INVENTORY_SYNC_ENABLED"),
    publishEnabled: booleanFromEnv(env, "RATE_INVENTORY_PUBLISH_ENABLED"),
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
    publishCandidateDir: String(env.RATE_INVENTORY_PUBLISH_CANDIDATE_DIR || "/tmp/rate-inventory-publish").trim() || "/tmp/rate-inventory-publish",
    origin: "https://www.owlting.com",
    configPath: absolutePath,
    publishPlanIdAllowlist: stringArray(tenantConfig.publishPlanIdAllowlist),
    publishSalesUnitIdAllowlist: stringArray(tenantConfig.publishSalesUnitIdAllowlist),
    tenantAllowlist: csvArray(env.RATE_INVENTORY_TENANT_ALLOWLIST || DEFAULT_TENANT_ALLOWLIST),
    maxTenantsPerRun: numberFromEnv(env, "RATE_INVENTORY_MAX_TENANTS_PER_RUN", 1, { min: 1, max: 50 }),
    batchDelayMs: numberFromEnv(env, "RATE_INVENTORY_BATCH_DELAY_MS", 1500, { min: 0, max: 60000 }),
    continueOnControlledStop: booleanFromEnv(env, "RATE_INVENTORY_CONTINUE_ON_CONTROLLED_STOP"),
  };
}

function buildSingleTenantConfig({ env, tenantKey, tenantConfig, absolutePath }) {
  return sharedEnvConfig(env, tenantConfig, tenantKey, absolutePath);
}

function isTenantEligibleForAll(tenantKey, tenantConfig, tenantAllowlist) {
  return tenantConfig && tenantConfig.enabled === true && tenantAllowlist.includes(tenantKey) && stringArray(tenantConfig.publishPlanIdAllowlist).length > 0 && stringArray(tenantConfig.publishSalesUnitIdAllowlist).length > 0;
}

function loadRateInventorySnapshotConfig(env = process.env) {
  const configPath = String(env.RATE_INVENTORY_CONFIG_PATH || DEFAULT_CONFIG_PATH).trim() || DEFAULT_CONFIG_PATH;
  const tenantKey = String(env.RATE_INVENTORY_TENANT || DEFAULT_TENANT).trim() || DEFAULT_TENANT;
  const { absolutePath, tenants } = loadTenantFile(configPath);
  const tenantAllowlist = csvArray(env.RATE_INVENTORY_TENANT_ALLOWLIST || DEFAULT_TENANT_ALLOWLIST);

  if (tenantKey.toUpperCase() === ALL_TENANTS) {
    const batchBase = sharedEnvConfig(env, { tenant: ALL_TENANTS, hotelId: "" }, ALL_TENANTS, absolutePath);
    const maxTenantsPerRun = batchBase.maxTenantsPerRun;
    // 中文註解：ALL 模式只依設定檔順序挑選 enabled 且 allowlist 完整的 tenant，避免批次流程把未回填 allowlist 的品牌送進正式 publish。
    const selectedTenants = Object.entries(tenants)
      .filter(([key, tenantConfig]) => isTenantEligibleForAll(key, tenantConfig, tenantAllowlist))
      .slice(0, maxTenantsPerRun)
      .map(([key, tenantConfig]) => buildSingleTenantConfig({ env, tenantKey: key, tenantConfig, absolutePath }));

    return {
      ...batchBase,
      mode: ALL_TENANTS,
      tenant: ALL_TENANTS,
      tenantKey: ALL_TENANTS,
      tenantAllowlist,
      tenants: selectedTenants,
      tenantCount: selectedTenants.length,
      stoppedReason: selectedTenants.length === 0 ? "no_enabled_tenants" : "",
    };
  }

  // 中文註解：單品牌模式維持先用 workflow/env allowlist 擋掉非白名單 tenant key，確保 typo 或惡意輸入不會進入登入流程。
  if (!tenantAllowlist.includes(tenantKey)) {
    const error = new Error("tenant_not_allowed");
    error.code = "tenant_not_allowed";
    throw error;
  }

  const tenantConfig = tenants[tenantKey];
  if (!tenantConfig) throw new Error(`RATE_INVENTORY_TENANT not found: ${tenantKey}`);
  return buildSingleTenantConfig({ env, tenantKey, tenantConfig, absolutePath });
}

function validateRateInventorySnapshotConfig(config) {
  const errors = [];
  if (!config.enabled) errors.push("RATE_INVENTORY_SYNC_ENABLED must be 1");
  if (!config.tenantAllowlist.includes(config.tenant)) errors.push("tenant_not_allowed");
  if (!/^\d+$/.test(String(config.hotelId || ""))) errors.push("hotelId must be numeric");
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
  if (config.mode === ALL_TENANTS) return config;
  const { tenants } = loadTenantFile(config.configPath);
  const tenantConfig = tenants[config.tenantKey];
  if (!tenantConfig || tenantConfig.enabled !== true) throw new Error(`rate inventory tenant disabled: ${config.tenantKey}`);
  if (!config.tenantAllowlist.includes(config.tenant)) {
    const error = new Error("tenant_not_allowed");
    error.code = "tenant_not_allowed";
    throw error;
  }
  return config;
}

module.exports = {
  ALL_TENANTS,
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
