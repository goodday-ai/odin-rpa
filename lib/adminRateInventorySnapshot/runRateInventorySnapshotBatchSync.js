// 功能：執行 Rate Inventory Snapshot Sync 的 tenant=ALL 多品牌 sequential 批次流程。
// 責任：依 config/rateInventoryTenants.json 篩選 eligible tenants，逐一呼叫單品牌 sync，品牌間延遲，並產出 batch summary artifact。
// 關聯模組：loadRateInventorySnapshotConfig 提供 ALL batch config；runRateInventorySnapshotSync 負責每個 tenant 的抓取、驗證與 publish candidate；summarizeRateInventorySnapshotBatch 負責摘要輸出。
// 關鍵流程：load ALL config → 無 eligible controlled stop → for...of sequential sync → controlled stop 視設定續跑 → fatal stop 才中止 → 寫 batch summary。

const { loadRateInventorySnapshotConfig } = require("./loadRateInventorySnapshotConfig");
const { CONTROLLED_STOP_REASONS, outputExitCode, runRateInventorySnapshotSync } = require("./runRateInventorySnapshotSync");
const { summarizeRateInventorySnapshotBatch, writeRateInventorySnapshotBatchSummary } = require("./summarizeRateInventorySnapshotBatch");

const FATAL_STOP_REASONS = new Set(["missing_credentials", "login_failed", "auth_capture_failed", "browser_launch_error"]);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isFatalStop(reason) {
  return FATAL_STOP_REASONS.has(reason);
}

function batchExitCode(summary) {
  if (!summary.ok) return outputExitCode(summary.stoppedReason) || 1;
  return 0;
}

async function runRateInventorySnapshotBatchSync({ chromium, env = process.env, runner = runRateInventorySnapshotSync, sleep = delay } = {}) {
  const startedAt = Date.now();
  const config = loadRateInventorySnapshotConfig(env);
  if (config.mode !== "ALL") {
    throw new Error("runRateInventorySnapshotBatchSync requires RATE_INVENTORY_TENANT=ALL");
  }

  if (config.tenants.length === 0) {
    const finishedAt = Date.now();
    const summary = summarizeRateInventorySnapshotBatch({ config, startedAt, finishedAt, results: [], ok: true, stoppedReason: "no_enabled_tenants" });
    const outputPath = await writeRateInventorySnapshotBatchSummary(config, summary);
    return { ok: true, stoppedReason: "no_enabled_tenants", exitCode: 0, outputPath, summary };
  }

  const results = [];
  let batchOk = true;
  let batchStoppedReason = "";

  for (let index = 0; index < config.tenants.length; index += 1) {
    const tenantConfig = config.tenants[index];
    // 中文註解：for...of/await 明確保證 sequential 執行；不可改成 Promise.all，避免多品牌同時登入/打 calendars API。
    const result = await runner({ chromium, env: { ...env, RATE_INVENTORY_TENANT: tenantConfig.tenant }, config: tenantConfig });
    results.push({ tenantConfig, result });

    const reason = result && result.stoppedReason;
    if (isFatalStop(reason)) {
      batchOk = false;
      batchStoppedReason = reason;
      break;
    }
    // 中文註解：除明確 fatal 外，單一 tenant 的失敗只記錄於 results，不中止整批，避免後續品牌失去產生 artifact/publish candidate 的機會。
    if (reason && CONTROLLED_STOP_REASONS.has(reason) && !config.continueOnControlledStop) {
      batchStoppedReason = reason;
      break;
    }
    if (index < config.tenants.length - 1 && config.batchDelayMs > 0) {
      await sleep(config.batchDelayMs);
    }
  }

  const finishedAt = Date.now();
  const summary = summarizeRateInventorySnapshotBatch({ config, startedAt, finishedAt, results, ok: batchOk, stoppedReason: batchStoppedReason });
  const outputPath = await writeRateInventorySnapshotBatchSummary(config, summary);
  return { ok: batchOk, stoppedReason: batchStoppedReason, exitCode: batchExitCode(summary), outputPath, summary };
}

module.exports = {
  FATAL_STOP_REASONS,
  delay,
  isFatalStop,
  runRateInventorySnapshotBatchSync,
};
