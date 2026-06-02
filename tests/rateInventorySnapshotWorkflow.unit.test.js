// 功能：Rate Inventory Snapshot Sync workflow 的靜態驗證測試。
// 責任：確認 manual-only workflow 支援單品牌與 tenant=ALL sequential sync，未混用訂單同步、Google Sheet/GAS 或 schedule，且 publish step 可一次處理多個 tenant candidate。
// 關聯模組：.github/workflows/rate-inventory-snapshot-sync.yml 與 package.json 的 test:rate-inventory-snapshot-workflow script。
// 關鍵流程：讀取 workflow YAML 文字 → 檢查 workflow_dispatch/input/env allowlist/batch env → 禁止 schedule/ODIN_SHEET/舊訂單 publish 設定。

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const workflowPath = path.join(__dirname, "..", ".github", "workflows", "rate-inventory-snapshot-sync.yml");
const odinSyncPath = path.join(__dirname, "..", ".github", "workflows", "odin-sync.yml");
const workflow = fs.readFileSync(workflowPath, "utf8");

function workflowDispatchBlock() {
  const match = workflow.match(/on:\n([\s\S]*?)\n\npermissions:/);
  return match ? match[1] : "";
}

test("rate inventory snapshot sync workflow is manual-only", () => {
  const onBlock = workflowDispatchBlock();
  assert.match(onBlock, /workflow_dispatch:/);
  assert.doesNotMatch(onBlock, /(^|\n)\s*schedule:/);
  assert.doesNotMatch(workflow, /cron:/);
});

test("rate inventory snapshot sync workflow declares required dispatch inputs", () => {
  for (const input of ["tenant", "publish_enabled", "days", "timeout_ms", "max_tenants_per_run", "today"]) {
    assert.match(workflow, new RegExp(`\\n\\s{6}${input}:`));
  }
  assert.match(workflow, /tenant:[\s\S]*?description: "Tenant key or ALL"/);
  assert.match(workflow, /publish_enabled:[\s\S]*?type: boolean[\s\S]*?default: false/);
  assert.match(workflow, /days:[\s\S]*?default: "120"/);
  assert.match(workflow, /max_tenants_per_run:[\s\S]*?default: "1"/);
});

test("rate inventory snapshot sync workflow uses Odin credentials and no Sheet secrets", () => {
  assert.match(workflow, /ODIN_EMAIL:\s*\$\{\{ secrets\.ODIN_EMAIL \}\}/);
  assert.match(workflow, /ODIN_PASSWORD:\s*\$\{\{ secrets\.ODIN_PASSWORD \}\}/);
  assert.doesNotMatch(workflow, /ODIN_SHEET_/);
});

test("rate inventory snapshot sync workflow enforces 120-day cap and ALL tenant allowlist", () => {
  assert.match(workflow, /RATE_INVENTORY_DAYS:\s*\$\{\{ inputs\.days \}\}/);
  assert.match(workflow, /RATE_INVENTORY_MAX_DAYS:\s*"120"/);
  assert.match(workflow, /RATE_INVENTORY_MAX_ITEMS:\s*"8000"/);
  assert.match(workflow, /RATE_INVENTORY_TENANT_ALLOWLIST:\s*"goodday,mozhouse,houseapt,houseresidence,lunarhaven,nightph,sunmoon,triplesuite"/);
  assert.match(workflow, /RATE_INVENTORY_MAX_TENANTS_PER_RUN:\s*\$\{\{ inputs\.max_tenants_per_run \}\}/);
  assert.match(workflow, /RATE_INVENTORY_BATCH_DELAY_MS:\s*"1500"/);
  assert.match(workflow, /RATE_INVENTORY_CONTINUE_ON_CONTROLLED_STOP:\s*"true"/);
  assert.doesNotMatch(workflow, /ODIN_DATA_BRANCH/);
});

test("rate inventory snapshot sync workflow has safe artifact retention and sanitizer audit", () => {
  assert.match(workflow, /retention-days:\s*3/);
  assert.match(workflow, /auditSanitizedAdminRateInventoryOutDir/);
  assert.match(workflow, /out\/rate_inventory_snapshot_sync_\*\.json/);
  assert.match(workflow, /out\/rate_inventory_snapshot_sync_batch_\*\.json/);
  assert.doesNotMatch(workflow, /out\/\*\.json/);
  for (const forbidden of ["raw", "headers", "trace", "screenshot", "storageState", "cookie", "cookies"]) {
    assert.match(workflow, new RegExp(`!out/\\*${forbidden}\\*`));
  }
});

test("rate inventory snapshot sync workflow publish step supports rate_inventory_*.json", () => {
  assert.match(workflow, /\/tmp\/rate-inventory-publish\/rate_inventory_\*\.json/);
  assert.match(workflow, /cp \/tmp\/rate-inventory-publish\/rate_inventory_\*\.json/);
  assert.match(workflow, /git -C \.rate_inventory_data_branch add "\$\{RATE_INVENTORY_LATEST_DIR\}\/rate_inventory_\*\.json"/);
  assert.match(workflow, /commit -m "Update rate inventory snapshots"/);
});


test("rate inventory snapshot sync workflow publish validation accepts snapshot root without published flag", () => {
  assert.match(workflow, /assertRateInventorySnapshotPublishCandidate/);
  assert.match(workflow, /Invalid publish candidate: \${file}:/);
  assert.doesNotMatch(workflow, /snapshot\.published\s*!==\s*true/);
  assert.doesNotMatch(workflow, /published\s*===\s*true/);
});

test("rate inventory snapshot sync change does not modify odin sync workflow", () => {
  // 中文註解：測試只確認既有訂單同步 workflow 存在且本新 workflow 未引用它，避免誤把舊訂單 publish 設定搬進快照驗證流程。
  assert.equal(fs.existsSync(odinSyncPath), true);
  assert.doesNotMatch(workflow, /odin-sync\.yml/);
});
