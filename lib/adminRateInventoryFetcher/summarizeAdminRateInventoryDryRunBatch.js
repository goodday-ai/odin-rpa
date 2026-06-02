// 功能：建立 Admin Rate Inventory Fetcher ALL dry-run 的 batch summary artifact。
// 責任：把每個 tenant dry-run 結果整理成安全、短版、可稽核的 results 陣列，避免人工掃描多個大型 items artifact。
// 關聯模組：runAdminRateInventoryBatchDryRun 逐品牌執行後呼叫；sanitizeAdminRateInventorySnapshot 負責最終敏感資料清理。
// 關鍵流程：接收 batch 執行資訊 → 擷取 tenant/hotelId/displayName/summary/stoppedReason/artifactPath → 計算 ok/duration → 回傳 JSON payload。

const { sanitizeAdminRateInventorySnapshot } = require("./sanitizeAdminRateInventorySnapshot");

function summarizeAdminRateInventoryDryRunBatch({ mode = "ALL", startedAt, finishedAt, results = [] } = {}) {
  const startMs = startedAt instanceof Date ? startedAt.getTime() : new Date(startedAt).getTime();
  const finishMs = finishedAt instanceof Date ? finishedAt.getTime() : new Date(finishedAt).getTime();
  const safeResults = results.map((result) => ({
    tenant: String(result.tenant || ""),
    hotelId: String(result.hotelId || ""),
    displayName: String(result.displayName || ""),
    ok: Boolean(result.ok),
    stoppedReason: String(result.stoppedReason || ""),
    summary: result.summary || {},
    artifactPath: String(result.artifactPath || ""),
  }));

  return sanitizeAdminRateInventorySnapshot({
    ok: safeResults.every((result) => result.ok),
    mode,
    tenantCount: safeResults.length,
    startedAt: new Date(startMs).toISOString(),
    finishedAt: new Date(finishMs).toISOString(),
    durationMs: Math.max(0, finishMs - startMs),
    results: safeResults,
  });
}

module.exports = {
  summarizeAdminRateInventoryDryRunBatch,
};
