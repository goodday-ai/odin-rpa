// 功能：稽核 Admin Rate Inventory Probe sanitized JSON artifact，確認輸出沒有敏感欄位或敏感型態字串。
// 責任：提供 workflow 與 unit test 共用的最後防線；key/path/queryKeys 嚴格阻擋，value 僅檢查明確敏感型態以避免 metadata 誤判。
// 關聯模組：.github/workflows/admin-rate-inventory-probe.yml、sanitizeAdminRateProbeOutput、tests/adminRateInventoryProbe.unit.test.js。
// 關鍵流程：讀取 out/admin_rate_inventory_probe_*.json → 遞迴檢查 key/path/queryKeys → pattern 檢查字串 value → 回報第一個違規位置。

const fs = require("node:fs");
const path = require("node:path");

const BANNED_KEY_TERMS = [
  "authorization",
  "bearer",
  "token",
  "cookie",
  "secret",
  "password",
  "email",
  "phone",
  "mobile",
  "tel",
  "order",
  "uuid",
  "customer",
  "guest",
  "headers",
  "rawbody",
];

const SAFE_METADATA_PATHS = new Set([
  "$.capturedAt",
  "$.updatedAt",
  "$.probeStart",
  "$.probeEnd",
  "$.durationMs",
  "$.stoppedReason",
  "$.apiMode",
  "$.confidence",
  "$.reason",
  "$.reasons",
  "$.summary",
  "$.decision",
  "$.decision.apiMode",
  "$.decision.confidence",
  "$.decision.reason",
  "$.decision.reasons",
  "$.tenant",
  "$.hotelId",
  "$.contentType",
  "$.status",
  "$.method",
  "$.requestUrlOrigin",
  "$.requestUrlPath",
  "$.targetUrlOrigin",
  "$.targetUrlPath",
]);

const SENSITIVE_VALUE_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._-]+/i,
  /\bauthorization\s*:/i,
  /\bcookie\s*:/i,
  /\bset-cookie\s*:/i,
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
  /\b09\d{8}\b/,
  /\b\+?886[-\s]?\d{8,10}\b/,
  /(?:^|\n)\s*(?:authorization|cookie|set-cookie)\s*:/i,
  /(?:^|\n)\s*[A-Za-z0-9-]+\s*:\s*[^\n]+\n\s*[A-Za-z0-9-]+\s*:/,
];

function normalizeName(name) {
  return String(name || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function nameParts(name) {
  return normalizeName(name).split("_").filter(Boolean);
}

function hasBannedKey(name) {
  const normalized = normalizeName(name);
  const compact = normalized.replace(/_/g, "");
  if (!normalized) return false;
  // 中文註解：key/path/queryKeys 要嚴格阻擋敏感名稱；tel 採 token 比對，避免 hotelId 被誤判成 tel；rawBody 則用 compact 補足 camelCase/底線差異。
  return BANNED_KEY_TERMS.some((term) => {
    if (term === "tel") return nameParts(name).includes(term);
    return normalized.includes(term) || compact.includes(term);
  });
}

function isSafeMetadataPath(trail) {
  return SAFE_METADATA_PATHS.has(trail);
}

function hasSensitiveValue(value) {
  const text = String(value);
  return SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(text));
}

function pathContainsBannedTerm(value) {
  const text = String(value || "");
  const names = [];
  try {
    const parsed = text.startsWith("http://") || text.startsWith("https://")
      ? new URL(text)
      : new URL(text || "/", "https://audit.local");
    names.push(...parsed.pathname.split("/"));
    names.push(...parsed.searchParams.keys());
  } catch (_error) {
    names.push(...text.split(/[/?#&=]+/));
  }
  return names.some((part) => hasBannedKey(part));
}

function shouldInspectPathValue(trail, keyName) {
  const normalizedKey = normalizeName(keyName);
  return normalizedKey === "path"
    || normalizedKey.endsWith("_path")
    || normalizedKey === "request_url"
    || normalizedKey === "target_url"
    || /Path$/.test(String(keyName));
}

function auditSanitizedAdminRateProbeOutput(value, trail = "$", keyName = "") {
  if (keyName && hasBannedKey(keyName)) {
    throw new Error(`Sanitized output audit failed: banned key at ${trail}`);
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => auditSanitizedAdminRateProbeOutput(item, `${trail}[${index}]`, keyName));
    return;
  }

  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      auditSanitizedAdminRateProbeOutput(child, `${trail}.${key}`, key);
    }
    return;
  }

  if (typeof value !== "string") return;

  // 中文註解：queryKeys 與 URL/path 欄位代表遠端 API 介面名稱，需檢查敏感 key 名稱，但不對一般 metadata value 做 substring 掃描。
  if ((normalizeName(keyName).endsWith("query_keys") || shouldInspectPathValue(trail, keyName)) && pathContainsBannedTerm(value)) {
    throw new Error(`Sanitized output audit failed: banned path/key value at ${trail}`);
  }

  if (!isSafeMetadataPath(trail) && hasSensitiveValue(value)) {
    throw new Error(`Sanitized output audit failed: sensitive value at ${trail}`);
  }
}

function adminRateProbeOutputFiles(outDir = "out") {
  return fs.existsSync(outDir)
    ? fs.readdirSync(outDir).filter((name) => /^admin_rate_inventory_probe_.*\.json$/.test(name))
    : [];
}

function auditSanitizedAdminRateProbeFile(filePath) {
  const json = JSON.parse(fs.readFileSync(filePath, "utf8"));
  auditSanitizedAdminRateProbeOutput(json);
}

function auditSanitizedAdminRateProbeOutDir(outDir = "out") {
  const files = adminRateProbeOutputFiles(outDir);
  if (!files.length) {
    throw new Error("No admin rate inventory probe output JSON found");
  }
  for (const file of files) {
    auditSanitizedAdminRateProbeFile(path.join(outDir, file));
  }
  return files;
}

module.exports = {
  BANNED_KEY_TERMS,
  SAFE_METADATA_PATHS,
  SENSITIVE_VALUE_PATTERNS,
  auditSanitizedAdminRateProbeOutput,
  auditSanitizedAdminRateProbeFile,
  auditSanitizedAdminRateProbeOutDir,
  hasBannedKey,
  hasSensitiveValue,
  isSafeMetadataPath,
};
