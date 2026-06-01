// 功能：將通過驗證的 Admin Rate Inventory Snapshot v1 覆蓋到 latest JSON。
// 責任：只處理 rate inventory snapshot 的最小安全 publish path，不重構既有訂單同步、不建立 history。
// 關聯模組：runRateInventorySnapshotSync 成功抓取後呼叫；validateRateInventorySnapshotForPublish 決定是否允許覆蓋 latest。
// 關鍵流程：publish enabled 檢查 → validate → mkdir latest → atomic temp write/rename → 回傳 latest 路徑。

const fs = require("node:fs/promises");
const path = require("node:path");
const { assertRateInventorySnapshotPublishable } = require("./validateRateInventorySnapshot");

function latestSnapshotPath(config) {
  const safeTenant = String(config.tenant || "tenant").replace(/[^a-zA-Z0-9_-]/g, "_") || "tenant";
  return path.join(config.latestDir, `rate_inventory_${safeTenant}.json`);
}

async function publishRateInventorySnapshot(snapshot, config) {
  if (!config.publishEnabled) {
    return { published: false, skippedReason: "publish_disabled", latestPath: latestSnapshotPath(config) };
  }

  // 中文註解：驗證放在任何寫檔前，確保 login/parse/truncated/空資料等失敗情境不會碰 latest。
  assertRateInventorySnapshotPublishable(snapshot, config);

  const latestPath = latestSnapshotPath(config);
  const latestDir = path.dirname(latestPath);
  const tempPath = path.join(latestDir, `.${path.basename(latestPath)}.${process.pid}.${Date.now()}.tmp`);
  await fs.mkdir(latestDir, { recursive: true });
  await fs.writeFile(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, latestPath);
  return { published: true, latestPath, dataBranch: config.dataBranch };
}

module.exports = {
  latestSnapshotPath,
  publishRateInventorySnapshot,
};
