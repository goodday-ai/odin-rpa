// 功能：對 Admin Rate Inventory Fetcher Dry Run snapshot 做最終敏感資料清理與稽核輔助。
// 責任：移除 authorization/bearer/token/cookie/email/phone/order/uuid/rawBody/headers 等 key/value，保留 hotelId 與 capturedAt 等安全營運欄位。
// 關聯模組：runAdminRateInventoryFetcherDryRun 寫檔前必須呼叫；workflow audit 與 unit test 驗證本模組防線。
// 關鍵流程：敏感 key 判斷 → URL 降級 → 遞迴清理 → 建立 controlled stop payload → 掃描 artifact 文字。

const fs = require("node:fs");
const path = require("node:path");
const { safeAdminUrlInfo, isSensitiveName } = require("../adminRateInventoryProbe/safeAdminUrlInfo");

const SENSITIVE_VALUE_RE = /(authorization|bearer|token|cookie|secret|password|email|phone|mobile|\btel\b|order|order_no|order_serial|uuid|identity|customer|guest|rawbody|headers)/i;
const URL_LIKE_RE = /^https?:\/\//i;
const SAFE_STRING_KEYS = new Set([
  "tenant", "hotelId", "rangeStart", "rangeEnd", "currency", "source", "capturedAt", "stoppedReason", "origin", "path", "sourcePath", "date",
  "salesUnitId", "salesUnitName", "roomTypeId", "roomTypeName", "planId", "planName", "channel", "reason", "topLevelType",
]);

function isSensitiveKey(key) {
  if (!key) return false;
  if (["rawBody", "headers", "body", "responseBody"].includes(key)) return true;
  return isSensitiveName(key);
}

function sanitizeString(value, keyName = "") {
  const text = String(value);
  // 中文註解：hotelId/capturedAt/origin/path/sourcePath 等白名單欄位可保留安全格式；其他自由文字若像個資或 token 便清空。
  if (SAFE_STRING_KEYS.has(keyName)) return SENSITIVE_VALUE_RE.test(text) ? "" : text;
  if (URL_LIKE_RE.test(text)) {
    const info = safeAdminUrlInfo(text);
    return `${info.origin}${info.pathname}`;
  }
  if (SENSITIVE_VALUE_RE.test(text) || /@/.test(text) || /\+?\d[\d\s().-]{7,}/.test(text)) return "";
  return text;
}

function sanitizeValue(value, keyName = "") {
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item)).filter((item) => item !== undefined && item !== "");
  if (!value || typeof value !== "object") {
    if (typeof value !== "string") return value;
    return sanitizeString(value, keyName);
  }
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (isSensitiveKey(key)) continue;
    const sanitized = sanitizeValue(child, key);
    if (sanitized !== undefined) output[key] = sanitized;
  }
  return output;
}

function sanitizeAdminRateInventorySnapshot(snapshot) {
  return sanitizeValue(snapshot);
}

function createControlledStopSnapshot(config = {}, stoppedReason, extra = {}) {
  return sanitizeAdminRateInventorySnapshot({
    ok: false,
    tenant: config.tenant || "",
    hotelId: config.hotelId || "",
    rangeStart: config.start || "",
    rangeEnd: config.end || "",
    currency: "",
    source: "owlting_admin_calendars",
    request: extra.request || { origin: "https://www.owlting.com", path: config.hotelId ? `/booking/v2/admin/hotels/${config.hotelId}/calendars` : "", queryKeys: ["during_start_date", "during_end_date", "lang"] },
    capturedAt: new Date().toISOString(),
    durationMs: extra.durationMs || 0,
    stoppedReason,
    summary: extra.summary || { itemCount: 0, dateCount: 0, salesUnitCount: 0, channelCount: 0, minPrice: null, maxPrice: null, availableItemCount: 0, zeroInventoryItemCount: 0, closedItemCount: 0, unknownInventoryItemCount: 0 },
    items: [],
    warnings: (extra.warnings || [{ reason: stoppedReason }]).slice(0, 50),
    shapeSummary: extra.shapeSummary,
    truncated: Boolean(extra.truncated),
  });
}

function auditSanitizedAdminRateInventorySnapshot(snapshot) {
  const text = JSON.stringify(snapshot);
  const forbidden = /(authorization|bearer|token|cookie|secret|password|email|phone|mobile|\btel\b|order|uuid|customer|guest|headers|rawBody)/i;
  if (forbidden.test(text)) throw new Error("sanitized admin rate inventory snapshot contains forbidden sensitive marker");
  return true;
}

function auditSanitizedAdminRateInventoryOutDir(outDir = "out") {
  const files = fs.readdirSync(outDir)
    // 中文註解：同一套 sanitizer audit 同時服務 dry-run 與正式 snapshot sync artifact，workflow 只呼叫本 helper，不在 YAML 內重寫敏感字掃描規則。
    .filter((file) => /^(admin_rate_inventory_fetcher_dryrun_|rate_inventory_snapshot_sync_).*\.json$/.test(file))
    .map((file) => path.join(outDir, file));
  if (files.length === 0) throw new Error("No admin rate inventory artifacts found");
  for (const file of files) {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    auditSanitizedAdminRateInventorySnapshot(parsed);
  }
  return files;
}

module.exports = {
  SENSITIVE_VALUE_RE,
  sanitizeAdminRateInventorySnapshot,
  createControlledStopSnapshot,
  auditSanitizedAdminRateInventorySnapshot,
  auditSanitizedAdminRateInventoryOutDir,
};
