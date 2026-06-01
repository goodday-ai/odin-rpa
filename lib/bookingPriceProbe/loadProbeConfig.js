// 功能：讀取 Booking Price Probe 的環境變數與 bookingUrl 來源設定。
// 責任：實作三段式 bookingUrl 優先序、數值預設、allowlist origins 與輸出路徑設定。
// 關聯模組：scripts/bookingPriceProbe.js 與 runBookingPriceProbe 在啟動時先呼叫本模組。
// 關鍵流程：env → 直接 booking URL → roomTypes path → linegpt data dir/<tenant>/roomTypes.json。

const fs = require("node:fs");
const path = require("node:path");

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_error) {
    return null;
  }
}

function findBookingUrlInObject(value) {
  if (!value || typeof value !== "object") return "";
  if (typeof value.bookingUrl === "string" && value.bookingUrl.trim()) return value.bookingUrl.trim();
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findBookingUrlInObject(item);
      if (found) return found;
    }
    return "";
  }
  for (const child of Object.values(value)) {
    const found = findBookingUrlInObject(child);
    if (found) return found;
  }
  return "";
}

function readBookingUrlFromPath(filePath) {
  if (!filePath) return "";
  const json = readJsonFile(filePath);
  return findBookingUrlInObject(json);
}

function numberFromEnv(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function loadProbeConfig(env = process.env) {
  const tenant = String(env.BOOKING_PRICE_PROBE_TENANT || "").trim();
  const roomTypesPath = String(env.BOOKING_PRICE_PROBE_ROOM_TYPES_PATH || "").trim();
  const linegptDataDir = String(env.BOOKING_PRICE_PROBE_LINEGPT_DATA_DIR || "../linegpt-webhook/data").trim();
  const linegptRoomTypesPath = tenant ? path.join(linegptDataDir, tenant, "roomTypes.json") : "";

  const directBookingUrl = String(env.BOOKING_PRICE_PROBE_BOOKING_URL || "").trim();
  const bookingUrl = directBookingUrl || readBookingUrlFromPath(roomTypesPath) || readBookingUrlFromPath(linegptRoomTypesPath);

  return {
    enabled: env.BOOKING_PRICE_PROBE_ENABLED === "1",
    tenant,
    start: String(env.BOOKING_PRICE_PROBE_START || "").trim(),
    end: String(env.BOOKING_PRICE_PROBE_END || "").trim(),
    adult: env.BOOKING_PRICE_PROBE_ADULT ?? "1",
    child: env.BOOKING_PRICE_PROBE_CHILD ?? "0",
    infant: env.BOOKING_PRICE_PROBE_INFANT ?? "0",
    lang: String(env.BOOKING_PRICE_PROBE_LANG || "zh_TW").trim() || "zh_TW",
    bookingUrl,
    roomTypesPath,
    linegptDataDir,
    outDir: String(env.BOOKING_PRICE_PROBE_OUT_DIR || "out").trim() || "out",
    timeoutMs: numberFromEnv(env, "BOOKING_PRICE_PROBE_TIMEOUT_MS", 8000),
    captureWindowMs: numberFromEnv(env, "BOOKING_PRICE_PROBE_CAPTURE_WINDOW_MS", 3000),
    maxJsonBytes: numberFromEnv(env, "BOOKING_PRICE_PROBE_MAX_JSON_BYTES", 500000),
    maxJsonResponses: numberFromEnv(env, "BOOKING_PRICE_PROBE_MAX_JSON_RESPONSES", 20),
    maxCandidates: numberFromEnv(env, "BOOKING_PRICE_PROBE_MAX_CANDIDATES", 10),
    allowlistOrigins: String(env.BOOKING_PRICE_PROBE_ALLOWLIST_ORIGINS || "https://booking.owlting.com,https://www.booking-owlnest.com")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  };
}

module.exports = {
  findBookingUrlInObject,
  loadProbeConfig,
  readBookingUrlFromPath,
};
