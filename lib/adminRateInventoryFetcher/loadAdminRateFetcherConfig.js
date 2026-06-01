// 功能：讀取 Admin Rate Inventory Fetcher Dry Run 的環境變數設定。
// 責任：集中治理 dry-run 啟用旗標、tenant、hotelId、日期區間、語系、輸出路徑與安全大小上限。
// 關聯模組：runAdminRateInventoryFetcherDryRun 啟動時先呼叫本模組；buildCalendarsApiRequest 會做 API contract 驗證。
// 關鍵流程：env → 字串/數值正規化 → validateAdminRateFetcherConfig 回傳可控錯誤清單。

function numberFromEnv(env, key, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function loadAdminRateFetcherConfig(env = process.env) {
  return {
    enabled: env.ADMIN_RATE_FETCHER_ENABLED === "1",
    tenant: String(env.ADMIN_RATE_FETCHER_TENANT || "").trim(),
    hotelId: String(env.ADMIN_RATE_FETCHER_HOTEL_ID || "").trim(),
    start: String(env.ADMIN_RATE_FETCHER_START || "").trim(),
    end: String(env.ADMIN_RATE_FETCHER_END || "").trim(),
    lang: String(env.ADMIN_RATE_FETCHER_LANG || "zh_TW").trim() || "zh_TW",
    outDir: String(env.ADMIN_RATE_FETCHER_OUT_DIR || "out").trim() || "out",
    timeoutMs: numberFromEnv(env, "ADMIN_RATE_FETCHER_TIMEOUT_MS", 15000, { min: 3000, max: 120000 }),
    maxJsonBytes: numberFromEnv(env, "ADMIN_RATE_FETCHER_MAX_JSON_BYTES", 2000000, { min: 1000, max: 5000000 }),
    origin: "https://www.owlting.com",
  };
}

function validateAdminRateFetcherConfig(config) {
  const errors = [];
  if (!config.enabled) errors.push("ADMIN_RATE_FETCHER_ENABLED must be 1");
  if (!config.tenant) errors.push("ADMIN_RATE_FETCHER_TENANT is required");
  if (!/^\d+$/.test(String(config.hotelId || ""))) errors.push("ADMIN_RATE_FETCHER_HOTEL_ID must be numeric");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(config.start || ""))) errors.push("ADMIN_RATE_FETCHER_START must be YYYY-MM-DD");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(config.end || ""))) errors.push("ADMIN_RATE_FETCHER_END must be YYYY-MM-DD");
  if (config.start && config.end && /^\d{4}-\d{2}-\d{2}$/.test(config.start) && /^\d{4}-\d{2}-\d{2}$/.test(config.end) && config.start >= config.end) {
    errors.push("ADMIN_RATE_FETCHER_START must be before ADMIN_RATE_FETCHER_END");
  }
  return errors;
}

module.exports = {
  loadAdminRateFetcherConfig,
  validateAdminRateFetcherConfig,
  numberFromEnv,
};
