// 功能：Rate Inventory Snapshot Sync workflow 的靜態驗證測試。
// 責任：確認 manual-only workflow 未混用訂單同步、Google Sheet/GAS 或 schedule，且只允許 goodday 以 repo secrets 做 live sync。
// 關聯模組：.github/workflows/rate-inventory-snapshot-sync.yml 與 package.json 的 test:rate-inventory-snapshot-workflow script。
// 關鍵流程：讀取 workflow YAML 文字 → 檢查 workflow_dispatch/input/env allowlist → 禁止 schedule/ODIN_SHEET/舊訂單 publish 設定。

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
  for (const input of ["tenant", "publish_enabled", "days", "timeout_ms", "today"]) {
    assert.match(workflow, new RegExp(`\\n\\s{6}${input}:`));
  }
  assert.match(workflow, /publish_enabled:[\s\S]*?type: boolean[\s\S]*?default: false/);
  assert.match(workflow, /days:[\s\S]*?default: "120"/);
});

test("rate inventory snapshot sync workflow uses Odin credentials and no Sheet secrets", () => {
  assert.match(workflow, /ODIN_EMAIL:\s*\$\{\{ secrets\.ODIN_EMAIL \}\}/);
  assert.match(workflow, /ODIN_PASSWORD:\s*\$\{\{ secrets\.ODIN_PASSWORD \}\}/);
  assert.doesNotMatch(workflow, /ODIN_SHEET_WEBAPP_URL/);
  assert.doesNotMatch(workflow, /ODIN_SHEET_TOKEN/);
});

test("rate inventory snapshot sync workflow enforces 120-day cap and goodday-only tenant allowlist", () => {
  assert.match(workflow, /RATE_INVENTORY_DAYS:\s*\$\{\{ inputs\.days \}\}/);
  assert.match(workflow, /RATE_INVENTORY_MAX_DAYS:\s*"120"/);
  assert.match(workflow, /RATE_INVENTORY_MAX_ITEMS:\s*"8000"/);
  assert.match(workflow, /RATE_INVENTORY_TENANT_ALLOWLIST:\s*"goodday"/);
  assert.match(workflow, /RATE_INVENTORY_MAX_TENANTS_PER_RUN:\s*"1"/);
  assert.doesNotMatch(workflow, /ODIN_DATA_BRANCH/);
});

test("rate inventory snapshot sync workflow has safe artifact retention and sanitizer audit", () => {
  assert.match(workflow, /retention-days:\s*3/);
  assert.match(workflow, /auditSanitizedAdminRateInventoryOutDir/);
  assert.doesNotMatch(workflow, /out\/\*\.json/);
  for (const forbidden of ["raw", "headers", "trace", "screenshot", "storageState", "cookie", "cookies"]) {
    assert.match(workflow, new RegExp(`!out/\\*${forbidden}\\*`));
  }
});

test("rate inventory snapshot sync change does not modify odin sync workflow", () => {
  // 中文註解：測試只確認既有訂單同步 workflow 存在且本新 workflow 未引用它，避免誤把舊訂單 publish 設定搬進快照驗證流程。
  assert.equal(fs.existsSync(odinSyncPath), true);
  assert.doesNotMatch(workflow, /odin-sync\.yml/);
});
