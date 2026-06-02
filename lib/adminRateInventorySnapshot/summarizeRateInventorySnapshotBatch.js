// 功能：整理 Rate Inventory Snapshot tenant=ALL 批次同步結果為安全摘要 artifact。
// 責任：只輸出每個 tenant 的狀態、summary、artifact/candidate 路徑與 stoppedReason，不輸出 raw response、headers、token 或 cookie。
// 關聯模組：runRateInventorySnapshotBatchSync 逐品牌同步後呼叫；workflow artifact upload 會上傳本摘要供人工稽核。
// 關鍵流程：單品牌 runner result → 精簡 tenant result → batch ok/duration 統計 → sanitize 後寫入 out/rate_inventory_snapshot_sync_batch_<timestamp>.json。

const fs = require("node:fs/promises");
const path = require("node:path");
const { sanitizeAdminRateInventorySnapshot } = require("../adminRateInventoryFetcher/sanitizeAdminRateInventorySnapshot");

function safeBatchTimestamp(isoText) {
  return String(isoText || new Date().toISOString()).replace(/[^0-9A-Za-z-]/g, "_");
}

function summarizeTenantResult(tenantConfig, result) {
  // 中文註解：batch summary 只記錄 publish 判斷需要的人類可讀欄位，避免把單品牌 artifact 的其他診斷細節擴散到批次摘要。
  return {
    tenant: tenantConfig.tenant,
    hotelId: tenantConfig.hotelId,
    displayName: tenantConfig.displayName,
    ok: Boolean(result && result.ok),
    published: Boolean(result && result.published),
    publishSkippedReason: (result && result.stoppedReason === "publish_disabled" ? "publish_disabled" : result && result.publishSkippedReason) || undefined,
    stoppedReason: (result && result.ok ? "" : result && result.stoppedReason) || undefined,
    summary: (result && result.summary) || {},
    artifactPath: (result && result.outputPath) || "",
    latestPath: (result && result.latestPath) || undefined,
    candidatePath: (result && result.candidatePath) || undefined,
  };
}

function summarizeRateInventorySnapshotBatch({ config, startedAt, finishedAt, results, ok = true, stoppedReason = "" }) {
  const startedDate = new Date(startedAt);
  const finishedDate = new Date(finishedAt);
  return sanitizeAdminRateInventorySnapshot({
    ok,
    mode: "ALL",
    publishEnabled: Boolean(config.publishEnabled),
    tenantCount: results.length,
    startedAt: startedDate.toISOString(),
    finishedAt: finishedDate.toISOString(),
    durationMs: Math.max(0, finishedDate.getTime() - startedDate.getTime()),
    stoppedReason: stoppedReason || undefined,
    results: results.map(({ tenantConfig, result }) => summarizeTenantResult(tenantConfig, result)),
  });
}

async function writeRateInventorySnapshotBatchSummary(config, summary) {
  const outputPath = path.join(config.outDir || "out", `rate_inventory_snapshot_sync_batch_${safeBatchTimestamp(summary.startedAt)}.json`);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(sanitizeAdminRateInventorySnapshot(summary), null, 2)}\n`, "utf8");
  return outputPath;
}

module.exports = {
  summarizeRateInventorySnapshotBatch,
  summarizeTenantResult,
  writeRateInventorySnapshotBatchSummary,
};
