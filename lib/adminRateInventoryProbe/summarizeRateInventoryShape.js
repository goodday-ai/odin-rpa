// 功能：產生後台 rate/inventory 候選 JSON 的安全結構摘要。
// 責任：只統計型別、巢狀 key 數量、深度與日期值數量，不保存 raw body 或任一原始個資值。
// 關聯模組：detectRateInventoryCandidate 用本模組建立 sampleShape；inferRateInventoryApiMode 使用 dateValues 判斷 API 粒度。
// 關鍵流程：有限深度遞迴走訪 → 收集 key 與 YYYY-MM-DD/YYYY-MM 日期形態 → 回傳形狀摘要與日期統計。

function valueType(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function topLevelJsonKeys(json, limit = 30) {
  if (!json || typeof json !== "object" || Array.isArray(json)) return [];
  return Object.keys(json).slice(0, limit).sort();
}

function summarizeRateInventoryShape(json, options = {}) {
  const maxDepthLimit = Number.isInteger(options.maxDepthLimit) ? options.maxDepthLimit : 6;
  const maxKeys = Number.isInteger(options.maxKeys) ? options.maxKeys : 500;
  let nestedKeyCount = 0;
  let maxDepth = 0;
  const dateValues = new Set();
  const monthValues = new Set();
  const seen = new Set();

  function scanScalar(value) {
    if (typeof value !== "string") return;
    const dateMatches = value.match(/\b\d{4}-\d{2}-\d{2}\b/g) || [];
    for (const date of dateMatches) dateValues.add(date);
    const monthMatches = value.match(/\b\d{4}-\d{2}\b/g) || [];
    for (const month of monthMatches) monthValues.add(month);
  }

  function visit(value, depth) {
    maxDepth = Math.max(maxDepth, depth);
    scanScalar(value);
    if (depth >= maxDepthLimit || !value || typeof value !== "object" || nestedKeyCount >= maxKeys) return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 20)) visit(item, depth + 1);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      nestedKeyCount += 1;
      scanScalar(key);
      visit(child, depth + 1);
      if (nestedKeyCount >= maxKeys) break;
    }
  }

  visit(json, 0);
  return {
    type: valueType(json),
    topLevelType: valueType(json),
    nestedKeyCount,
    maxDepth,
    dateValueCount: dateValues.size,
    monthValueCount: monthValues.size,
    dateValues: Array.from(dateValues).sort().slice(0, 80),
    monthValues: Array.from(monthValues).sort().slice(0, 24),
  };
}

module.exports = {
  summarizeRateInventoryShape,
  topLevelJsonKeys,
  valueType,
};
