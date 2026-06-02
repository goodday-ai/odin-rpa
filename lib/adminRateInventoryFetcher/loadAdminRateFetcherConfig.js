// 功能：讀取 Admin Rate Inventory Fetcher Dry Run 的環境變數與 rateInventoryTenants JSON 設定。
// 責任：集中治理 dry-run 啟用旗標、tenant/ALL 模式、hotelId、日期區間、disabled tenant 盤點開關、批次上限與安全大小上限。
// 關聯模組：runAdminRateInventoryFetcherDryRun 與 runAdminRateInventoryBatchDryRun 啟動時先呼叫本模組；buildCalendarsApiRequest 會做 API contract 驗證。
// 關鍵流程：env → 讀取 config/rateInventoryTenants.json（可選）→ tenant 設定覆寫/補值 → 日期與數值正規化 → validateAdminRateFetcherConfig 回傳可控錯誤清單。

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_CONFIG_PATH = "config/rateInventoryTenants.json";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function numberFromEnv(env, key, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function booleanFromEnv(env, key, fallback = false) {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const normalized = String(raw).trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
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

function todayUtc(env) {
  if (env.ADMIN_RATE_FETCHER_TODAY) return parseDateOnly(env.ADMIN_RATE_FETCHER_TODAY, "ADMIN_RATE_FETCHER_TODAY");
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function loadTenantFile(configPath = DEFAULT_CONFIG_PATH) {
  const absolutePath = path.resolve(configPath || DEFAULT_CONFIG_PATH);
  const tenants = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  if (!tenants || typeof tenants !== "object" || Array.isArray(tenants)) throw new Error("rate inventory tenant config must be an object");
  return { absolutePath, tenants };
}

function normalizeTenantEntry(tenantKey, tenantConfig = {}) {
  return {
    tenantKey,
    enabled: tenantConfig.enabled === true,
    tenant: String(tenantConfig.tenant || tenantKey).trim() || tenantKey,
    hotelId: String(tenantConfig.hotelId || "").trim(),
    displayName: String(tenantConfig.displayName || tenantConfig.tenant || tenantKey).trim() || tenantKey,
    days: Number.isFinite(Number(tenantConfig.days)) ? Math.trunc(Number(tenantConfig.days)) : undefined,
    currency: String(tenantConfig.currency || "TWD").trim() || "TWD",
  };
}

function resolveDates(env, { days, maxDays }) {
  const envStart = String(env.ADMIN_RATE_FETCHER_START || "").trim();
  const envEnd = String(env.ADMIN_RATE_FETCHER_END || "").trim();
  if (envStart && envEnd) return { start: envStart, end: envEnd };

  const startDate = envStart ? parseDateOnly(envStart, "ADMIN_RATE_FETCHER_START") : todayUtc(env);
  const safeDays = Math.max(1, Math.min(maxDays, Math.trunc(Number(days) || maxDays)));
  // 中文註解：dry-run artifact 需要盤點 N 個曆日，因此自動 end 採 inclusive window：end = start + days - 1。
  const endDate = envEnd ? parseDateOnly(envEnd, "ADMIN_RATE_FETCHER_END") : addUtcDays(startDate, safeDays - 1);
  return { start: formatDateOnly(startDate), end: formatDateOnly(endDate) };
}

function loadAdminRateFetcherConfig(env = process.env) {
  const configPath = String(env.ADMIN_RATE_FETCHER_CONFIG_PATH || "").trim();
  const tenantInput = String(env.ADMIN_RATE_FETCHER_TENANT || "").trim();
  const includeDisabled = booleanFromEnv(env, "ADMIN_RATE_FETCHER_INCLUDE_DISABLED", false);
  const maxDays = numberFromEnv(env, "ADMIN_RATE_FETCHER_MAX_DAYS", 92, { min: 1, max: 120 });

  let configFile = null;
  let tenantEntry = null;
  let configLoadError = "";
  if (configPath) {
    try {
      configFile = loadTenantFile(configPath);
      if (tenantInput && tenantInput.toUpperCase() !== "ALL" && configFile.tenants[tenantInput]) {
        tenantEntry = normalizeTenantEntry(tenantInput, configFile.tenants[tenantInput]);
      }
    } catch (error) {
      configLoadError = String(error.message || error);
    }
  }

  const tenantDays = tenantEntry?.days || maxDays;
  const days = numberFromEnv(env, "ADMIN_RATE_FETCHER_DAYS", tenantDays, { min: 1, max: maxDays });
  const dates = resolveDates(env, { days, maxDays });

  return {
    enabled: env.ADMIN_RATE_FETCHER_ENABLED === "1",
    tenant: tenantEntry?.tenant || tenantInput,
    tenantKey: tenantEntry?.tenantKey || tenantInput,
    tenantMode: tenantInput.toUpperCase() === "ALL" ? "ALL" : "single",
    hotelId: tenantEntry?.hotelId || String(env.ADMIN_RATE_FETCHER_HOTEL_ID || "").trim(),
    displayName: tenantEntry?.displayName || String(env.ADMIN_RATE_FETCHER_DISPLAY_NAME || tenantInput).trim(),
    days,
    maxDays,
    start: dates.start,
    end: dates.end,
    currency: tenantEntry?.currency || String(env.ADMIN_RATE_FETCHER_CURRENCY || "TWD").trim() || "TWD",
    lang: String(env.ADMIN_RATE_FETCHER_LANG || "zh_TW").trim() || "zh_TW",
    outDir: String(env.ADMIN_RATE_FETCHER_OUT_DIR || "out").trim() || "out",
    timeoutMs: numberFromEnv(env, "ADMIN_RATE_FETCHER_TIMEOUT_MS", 15000, { min: 3000, max: 120000 }),
    maxJsonBytes: numberFromEnv(env, "ADMIN_RATE_FETCHER_MAX_JSON_BYTES", 2000000, { min: 1000, max: 5000000 }),
    origin: "https://www.owlting.com",
    configPath: configFile?.absolutePath || (configPath ? path.resolve(configPath) : ""),
    configLoadError,
    configTenantFound: Boolean(tenantEntry),
    configTenantEnabled: tenantEntry ? tenantEntry.enabled : undefined,
    includeDisabled,
    maxTenantsPerRun: numberFromEnv(env, "ADMIN_RATE_FETCHER_MAX_TENANTS_PER_RUN", 1, { min: 1, max: 50 }),
    batchDelayMs: numberFromEnv(env, "ADMIN_RATE_FETCHER_BATCH_DELAY_MS", 1500, { min: 0, max: 60000 }),
    continueOnControlledStop: booleanFromEnv(env, "ADMIN_RATE_FETCHER_CONTINUE_ON_CONTROLLED_STOP", true),
  };
}

function listAdminRateFetcherTenantConfigs(env = process.env) {
  const configPath = String(env.ADMIN_RATE_FETCHER_CONFIG_PATH || DEFAULT_CONFIG_PATH).trim() || DEFAULT_CONFIG_PATH;
  const { absolutePath, tenants } = loadTenantFile(configPath);
  return Object.entries(tenants).map(([tenantKey, tenantConfig]) => ({ ...normalizeTenantEntry(tenantKey, tenantConfig), configPath: absolutePath }));
}

function validateAdminRateFetcherConfig(config) {
  const errors = [];
  if (!config.enabled) errors.push("ADMIN_RATE_FETCHER_ENABLED must be 1");
  if (config.configLoadError) errors.push(`ADMIN_RATE_FETCHER_CONFIG_PATH failed: ${config.configLoadError}`);
  if (!config.tenant) errors.push("ADMIN_RATE_FETCHER_TENANT is required");
  if (config.tenantMode === "ALL") errors.push("ADMIN_RATE_FETCHER_TENANT=ALL must use batch dry-run");
  if (config.configPath && config.tenant && !config.configTenantFound) errors.push(`ADMIN_RATE_FETCHER_TENANT not found: ${config.tenant}`);
  if (config.configTenantFound && config.configTenantEnabled === false && !config.includeDisabled) errors.push("tenant disabled; set ADMIN_RATE_FETCHER_INCLUDE_DISABLED=true for dry-run inventory");
  if (!/^\d+$/.test(String(config.hotelId || ""))) errors.push("ADMIN_RATE_FETCHER_HOTEL_ID must be numeric");
  if (!DATE_RE.test(String(config.start || ""))) errors.push("ADMIN_RATE_FETCHER_START must be YYYY-MM-DD");
  if (!DATE_RE.test(String(config.end || ""))) errors.push("ADMIN_RATE_FETCHER_END must be YYYY-MM-DD");
  if (config.start && config.end && DATE_RE.test(config.start) && DATE_RE.test(config.end) && config.start >= config.end) {
    errors.push("ADMIN_RATE_FETCHER_START must be before ADMIN_RATE_FETCHER_END");
  }
  if (config.days > config.maxDays) errors.push("ADMIN_RATE_FETCHER_DAYS must be <= ADMIN_RATE_FETCHER_MAX_DAYS");
  return errors;
}

module.exports = {
  DEFAULT_CONFIG_PATH,
  addUtcDays,
  booleanFromEnv,
  formatDateOnly,
  listAdminRateFetcherTenantConfigs,
  loadAdminRateFetcherConfig,
  loadTenantFile,
  normalizeTenantEntry,
  numberFromEnv,
  parseDateOnly,
  validateAdminRateFetcherConfig,
};
