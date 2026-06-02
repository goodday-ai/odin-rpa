// 功能：依 rateInventoryTenants config 逐一執行 Admin Rate Inventory Fetcher ALL 多品牌 dry-run。
// 責任：只做 sequential dry-run artifact 與 batch summary，不 publish latest、不推 odin-data、不寫 Google Sheet、不接 schedule。
// 關聯模組：loadAdminRateFetcherConfig/listAdminRateFetcherTenantConfigs 解析 tenant；runAdminRateInventoryFetcherDryRun 執行單品牌；summarizeAdminRateInventoryDryRunBatch 寫批次摘要。
// 關鍵流程：讀取 ALL 設定 → 依 config 順序篩選 enabled/disabled → 套用 maxTenantsPerRun → 逐一呼叫單品牌 dry-run → controlled stop 可續跑 → 寫出 batch summary artifact。

const fs = require("node:fs/promises");
const path = require("node:path");
const { CONTROLLED_STOP_REASONS, ERROR_REASONS, runAdminRateInventoryFetcherDryRun } = require("./runAdminRateInventoryFetcherDryRun");
const { listAdminRateFetcherTenantConfigs, loadAdminRateFetcherConfig } = require("./loadAdminRateFetcherConfig");
const { summarizeAdminRateInventoryDryRunBatch } = require("./summarizeAdminRateInventoryDryRunBatch");
const { sanitizeAdminRateInventorySnapshot } = require("./sanitizeAdminRateInventorySnapshot");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeBatchOutputPath(outDir = "out", date = new Date()) {
  const stamp = date.toISOString().replace(/[:.]/g, "-");
  return path.join(outDir || "out", `admin_rate_inventory_fetcher_dryrun_batch_${stamp}.json`);
}

function resultFromDryRun(tenantConfig, dryRunResult = {}) {
  const output = dryRunResult.output || {};
  const stoppedReason = dryRunResult.stoppedReason === "completed" ? "" : (dryRunResult.stoppedReason || output.stoppedReason || "");
  return {
    tenant: tenantConfig.tenant,
    hotelId: tenantConfig.hotelId,
    displayName: tenantConfig.displayName,
    ok: Boolean(output.ok || dryRunResult.stoppedReason === "completed"),
    stoppedReason,
    summary: output.summary || {},
    uniquePlanCount: Array.isArray(output.uniquePlans) ? output.uniquePlans.length : 0,
    uniquePlanItemCount: Array.isArray(output.uniquePlanItems) ? output.uniquePlanItems.length : 0,
    artifactPath: dryRunResult.outputPath || "",
  };
}

async function writeBatchSummary(outDir, summary) {
  const outputPath = safeBatchOutputPath(outDir);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(sanitizeAdminRateInventorySnapshot(summary), null, 2)}\n`, "utf8");
  return outputPath;
}

function buildTenantEnv(baseEnv, tenantConfig) {
  return {
    ...baseEnv,
    ADMIN_RATE_FETCHER_TENANT: tenantConfig.tenantKey,
    ADMIN_RATE_FETCHER_HOTEL_ID: tenantConfig.hotelId,
    ADMIN_RATE_FETCHER_DISPLAY_NAME: tenantConfig.displayName,
    ADMIN_RATE_FETCHER_CURRENCY: tenantConfig.currency,
  };
}

async function runAdminRateInventoryBatchDryRun({ chromium, env = process.env, dryRunRunner = runAdminRateInventoryFetcherDryRun } = {}) {
  const startedAt = new Date();
  const batchConfig = loadAdminRateFetcherConfig(env);
  if (batchConfig.tenantMode !== "ALL") {
    const summary = summarizeAdminRateInventoryDryRunBatch({ mode: "single", startedAt, finishedAt: new Date(), results: [{ tenant: batchConfig.tenant, ok: false, stoppedReason: "invalid_config" }] });
    const outputPath = await writeBatchSummary(batchConfig.outDir, summary);
    return { exitCode: 1, stoppedReason: "invalid_config", outputPath, output: summary };
  }

  let tenantConfigs;
  try {
    tenantConfigs = listAdminRateFetcherTenantConfigs(env)
      .filter((tenantConfig) => batchConfig.includeDisabled || tenantConfig.enabled)
      .slice(0, batchConfig.maxTenantsPerRun);
  } catch (error) {
    const summary = summarizeAdminRateInventoryDryRunBatch({ mode: "ALL", startedAt, finishedAt: new Date(), results: [{ ok: false, stoppedReason: "invalid_config", summary: { reason: String(error.message || error) } }] });
    const outputPath = await writeBatchSummary(batchConfig.outDir, summary);
    return { exitCode: 1, stoppedReason: "invalid_config", outputPath, output: summary };
  }

  const results = [];
  let fatalReason = "";
  for (const tenantConfig of tenantConfigs) {
    // 中文註解：ALL 模式必須逐一 await，不能 Promise.all，避免多品牌同時打後台造成風險。
    const dryRunResult = await dryRunRunner({ chromium, env: buildTenantEnv(env, tenantConfig) });
    const row = resultFromDryRun(tenantConfig, dryRunResult);
    results.push(row);

    const reason = row.stoppedReason;
    if (reason && ERROR_REASONS.has(reason) && !CONTROLLED_STOP_REASONS.has(reason)) {
      fatalReason = reason;
      break;
    }
    if (reason && CONTROLLED_STOP_REASONS.has(reason) && !batchConfig.continueOnControlledStop) {
      fatalReason = reason;
      break;
    }
    if (batchConfig.batchDelayMs > 0 && results.length < tenantConfigs.length) await sleep(batchConfig.batchDelayMs);
  }

  const finishedAt = new Date();
  const summary = summarizeAdminRateInventoryDryRunBatch({ mode: "ALL", startedAt, finishedAt, results });
  if (fatalReason) summary.ok = false;
  const outputPath = await writeBatchSummary(batchConfig.outDir, summary);
  const hasError = Boolean(fatalReason) || results.some((result) => result.stoppedReason && ERROR_REASONS.has(result.stoppedReason));
  return { exitCode: hasError ? 1 : 0, stoppedReason: fatalReason || (summary.ok ? "completed" : "controlled_stop"), outputPath, output: summary };
}

module.exports = {
  buildTenantEnv,
  resultFromDryRun,
  runAdminRateInventoryBatchDryRun,
  safeBatchOutputPath,
};
