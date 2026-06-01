// 功能：讀取 Admin Rate Inventory Network Probe 的環境變數設定。
// 責任：集中治理 hotelId、日期區間、月份、target URL、allowlist 與探測限制，避免 live probe 分散解析參數。
// 關聯模組：scripts/adminRateInventoryProbe.js 與 runAdminRateInventoryProbe 啟動時先呼叫本模組。
// 關鍵流程：env → 字串正規化 → 數值預設與上限保護 → validateAdminRateProbeConfig 回傳錯誤清單。

function numberFromEnv(env, key, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function normalizeMonth(value) {
  return String(value || "").trim();
}

function monthFromStart(start) {
  const match = String(start || "").match(/^(\d{4}-\d{2})-\d{2}$/);
  return match ? match[1] : "";
}

function loadAdminRateProbeConfig(env = process.env) {
  const start = String(env.ADMIN_RATE_PROBE_START || "").trim();
  const month = normalizeMonth(env.ADMIN_RATE_PROBE_MONTH || monthFromStart(start));
  return {
    enabled: env.ADMIN_RATE_PROBE_ENABLED === "1",
    tenant: String(env.ADMIN_RATE_PROBE_TENANT || "").trim(),
    hotelId: String(env.ADMIN_RATE_PROBE_HOTEL_ID || "").trim(),
    targetUrl: String(env.ADMIN_RATE_PROBE_TARGET_URL || "").trim(),
    lang: String(env.ADMIN_RATE_PROBE_LANG || "zh_TW").trim() || "zh_TW",
    start,
    end: String(env.ADMIN_RATE_PROBE_END || "").trim(),
    month,
    outDir: String(env.ADMIN_RATE_PROBE_OUT_DIR || "out").trim() || "out",
    timeoutMs: numberFromEnv(env, "ADMIN_RATE_PROBE_TIMEOUT_MS", 15000, { min: 3000, max: 120000 }),
    captureWindowMs: numberFromEnv(env, "ADMIN_RATE_PROBE_CAPTURE_WINDOW_MS", 5000, { min: 500, max: 60000 }),
    maxJsonBytes: numberFromEnv(env, "ADMIN_RATE_PROBE_MAX_JSON_BYTES", 800000, { min: 1000, max: 5000000 }),
    maxJsonResponses: numberFromEnv(env, "ADMIN_RATE_PROBE_MAX_JSON_RESPONSES", 30, { min: 1, max: 200 }),
    maxCandidates: numberFromEnv(env, "ADMIN_RATE_PROBE_MAX_CANDIDATES", 15, { min: 1, max: 100 }),
    allowlistOrigins: String(env.ADMIN_RATE_PROBE_ALLOWLIST_ORIGINS || "https://www.owlting.com,https://api.owlting.com")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  };
}

function validateAdminRateProbeConfig(config) {
  const errors = [];
  // 中文註解：hotelId 只接受數字，避免將自由字串帶入檔名或診斷輸出。
  if (!/^\d+$/.test(String(config.hotelId || ""))) errors.push("ADMIN_RATE_PROBE_HOTEL_ID must be numeric");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(config.start || ""))) errors.push("ADMIN_RATE_PROBE_START must be YYYY-MM-DD");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(config.end || ""))) errors.push("ADMIN_RATE_PROBE_END must be YYYY-MM-DD");
  if (!/^\d{4}-\d{2}$/.test(String(config.month || ""))) errors.push("ADMIN_RATE_PROBE_MONTH must be YYYY-MM");
  if (config.start && config.end && /^\d{4}-\d{2}-\d{2}$/.test(config.start) && /^\d{4}-\d{2}-\d{2}$/.test(config.end) && config.start > config.end) {
    errors.push("ADMIN_RATE_PROBE_START must be <= ADMIN_RATE_PROBE_END");
  }
  if (!Array.isArray(config.allowlistOrigins) || config.allowlistOrigins.length === 0) errors.push("ADMIN_RATE_PROBE_ALLOWLIST_ORIGINS is required");
  return errors;
}

module.exports = {
  loadAdminRateProbeConfig,
  validateAdminRateProbeConfig,
  numberFromEnv,
  monthFromStart,
};
