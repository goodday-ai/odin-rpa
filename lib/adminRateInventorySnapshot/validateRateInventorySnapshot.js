// 功能：驗證 Admin Rate Inventory Snapshot Sync v1 是否可覆蓋 latest。
// 責任：將 publish 前必須滿足的 ok/range/allowlist/truncated/sanitized audit 條件集中成可測試規則。
// 關聯模組：publishRateInventorySnapshot 寫入 latest 前呼叫；unit test 驗證 controlled stop、空資料、stale range 都會被拒絕。
// 關鍵流程：結構檢查 → tenant/hotel/range 檢查 → allowlist 檢查 → summary 一致性 → sanitizer audit。

const { auditSanitizedAdminRateInventorySnapshot } = require("../adminRateInventoryFetcher/sanitizeAdminRateInventorySnapshot");
const { inclusiveDaysBetween, parseDateOnly } = require("./loadRateInventorySnapshotConfig");

function allowedSet(values) {
  return new Set((values || []).map((value) => String(value || "")));
}


function validateRateInventorySnapshotPublishCandidate(snapshot) {
  const errors = [];
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return ["snapshot must be an object"];

  // 中文註解：workflow publish candidate 的契約是 LINE 可直接讀取的正式 snapshot root，不是 artifact wrapper；因此只驗證 snapshot 必備欄位，不要求 published/latestPath/dataBranch。
  if (snapshot.version !== "rate_inventory_snapshot_v1") errors.push("version must be rate_inventory_snapshot_v1");
  if (snapshot.ok !== true) errors.push("ok must be true");
  if (!snapshot.tenant) errors.push("tenant is required");
  if (!snapshot.hotelId) errors.push("hotelId is required");
  if (!snapshot.rangeStart) errors.push("rangeStart is required");
  if (!snapshot.rangeEnd) errors.push("rangeEnd is required");
  if (!snapshot.capturedAt || Number.isNaN(Date.parse(snapshot.capturedAt))) errors.push("capturedAt must be a valid ISO timestamp");
  if (!snapshot.currency) errors.push("currency is required");
  if (!snapshot.summary || typeof snapshot.summary !== "object" || Array.isArray(snapshot.summary)) {
    errors.push("summary is required");
  } else if (snapshot.summary.truncated === true) {
    errors.push("summary.truncated must not be true");
  }
  if (!Array.isArray(snapshot.items) || snapshot.items.length === 0) errors.push("items must not be empty");

  try {
    auditSanitizedAdminRateInventorySnapshot(snapshot);
  } catch (error) {
    errors.push(`sanitized audit failed: ${error.message || error}`);
  }
  return Array.from(new Set(errors));
}

function assertRateInventorySnapshotPublishCandidate(snapshot) {
  const errors = validateRateInventorySnapshotPublishCandidate(snapshot);
  if (errors.length > 0) {
    const error = new Error(`invalid rate inventory publish candidate: ${errors.join("; ")}`);
    error.code = "publish_candidate_validation_failed";
    error.validationErrors = errors;
    throw error;
  }
  return true;
}

function validateRateInventorySnapshotForPublish(snapshot, config) {
  const errors = [];
  if (!snapshot || typeof snapshot !== "object") return ["snapshot must be an object"];
  if (snapshot.version !== "rate_inventory_snapshot_v1") errors.push("version must be rate_inventory_snapshot_v1");
  if (snapshot.ok !== true) errors.push("ok must be true");
  if (snapshot.tenant !== config.tenant) errors.push(`tenant must be ${config.tenant}`);
  if (snapshot.hotelId !== config.hotelId) errors.push(`hotelId must be ${config.hotelId}`);
  if (!snapshot.capturedAt || Number.isNaN(Date.parse(snapshot.capturedAt))) errors.push("capturedAt must be a valid ISO timestamp");
  if (!Array.isArray(snapshot.items) || snapshot.items.length === 0) errors.push("items must not be empty");
  if (!snapshot.summary || typeof snapshot.summary !== "object") errors.push("summary is required");
  if (snapshot.summary && snapshot.summary.itemCount <= 0) errors.push("summary.itemCount must be > 0");
  if (snapshot.summary && snapshot.summary.truncated !== false) errors.push("summary.truncated must be false");

  try {
    const rangeDays = inclusiveDaysBetween(parseDateOnly(snapshot.rangeStart, "rangeStart"), parseDateOnly(snapshot.rangeEnd, "rangeEnd"));
    if (rangeDays !== config.days) errors.push(`range must cover ${config.days} days`);
    if (snapshot.rangeStart !== config.start || snapshot.rangeEnd !== config.end) errors.push("rangeStart/rangeEnd must match current sync window");
  } catch (error) {
    errors.push(String(error.message || error));
  }

  const allowedPlanIds = allowedSet(config.publishPlanIdAllowlist);
  const allowedSalesUnitIds = allowedSet(config.publishSalesUnitIdAllowlist);
  for (const item of snapshot.items || []) {
    if (!allowedPlanIds.has(String(item.planId || ""))) errors.push(`item planId is not publish-allowed: ${item.planId || ""}`);
    if (!allowedSalesUnitIds.has(String(item.salesUnitId || ""))) errors.push(`item salesUnitId is not publish-allowed: ${item.salesUnitId || ""}`);
  }

  if (snapshot.summary && Array.isArray(snapshot.items)) {
    if (snapshot.summary.itemCount !== snapshot.items.length) errors.push("summary.itemCount must equal items.length");
    const dateCount = new Set(snapshot.items.map((item) => item.date).filter(Boolean)).size;
    const planCount = new Set(snapshot.items.map((item) => item.planId).filter(Boolean)).size;
    const salesUnitCount = new Set(snapshot.items.map((item) => item.salesUnitId).filter(Boolean)).size;
    if (snapshot.summary.dateCount !== dateCount) errors.push("summary.dateCount mismatch");
    if (snapshot.summary.planCount !== planCount) errors.push("summary.planCount mismatch");
    if (snapshot.summary.salesUnitCount !== salesUnitCount) errors.push("summary.salesUnitCount mismatch");
  }

  try {
    auditSanitizedAdminRateInventorySnapshot(snapshot);
  } catch (error) {
    errors.push(`sanitized audit failed: ${error.message || error}`);
  }
  return Array.from(new Set(errors));
}

function assertRateInventorySnapshotPublishable(snapshot, config) {
  const errors = validateRateInventorySnapshotForPublish(snapshot, config);
  if (errors.length > 0) {
    const error = new Error(`rate inventory snapshot is not publishable: ${errors.join("; ")}`);
    error.code = "publish_validation_failed";
    error.validationErrors = errors;
    throw error;
  }
  return true;
}

module.exports = {
  assertRateInventorySnapshotPublishable,
  assertRateInventorySnapshotPublishCandidate,
  validateRateInventorySnapshotForPublish,
  validateRateInventorySnapshotPublishCandidate,
};
