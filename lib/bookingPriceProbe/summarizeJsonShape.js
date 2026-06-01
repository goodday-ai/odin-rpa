// 功能：產生 JSON 結構摘要，只描述 key、型別、深度與數量，不保留原始 scalar value。
// 責任：讓候選 API 可被觀測，同時避免輸出完整 response body 或個資內容。
// 關聯模組：detectPriceApiCandidate 與 runBookingPriceProbe 會把 sampleShape 放入 sanitized output。
// 關鍵流程：遞迴走訪 JSON → 計算 nestedKeyCount/maxDepth → 取樣 topLevelJsonKeys 與型別路徑。

function valueType(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function topLevelJsonKeys(json, limit = 30) {
  if (!json || typeof json !== "object" || Array.isArray(json)) return [];
  return Object.keys(json).slice(0, limit).sort();
}

function summarizeJsonShape(json, options = {}) {
  const maxDepthLimit = Number.isInteger(options.maxDepthLimit) ? options.maxDepthLimit : 6;
  const maxTypePaths = Number.isInteger(options.maxTypePaths) ? options.maxTypePaths : 40;
  let nestedKeyCount = 0;
  let maxDepth = 0;
  const typePaths = [];

  function visit(value, path, depth) {
    maxDepth = Math.max(maxDepth, depth);
    const type = valueType(value);
    if (typePaths.length < maxTypePaths) {
      typePaths.push({ path, type });
    }
    if (depth >= maxDepthLimit || !value || typeof value !== "object") return;

    if (Array.isArray(value)) {
      if (value.length > 0) visit(value[0], `${path}[]`, depth + 1);
      return;
    }

    for (const key of Object.keys(value)) {
      nestedKeyCount += 1;
      visit(value[key], `${path}.${key}`, depth + 1);
    }
  }

  visit(json, "$", 0);
  return {
    type: valueType(json),
    topLevelType: valueType(json),
    topLevelJsonKeys: topLevelJsonKeys(json),
    nestedKeyCount,
    maxDepth,
    typePaths,
  };
}

module.exports = {
  summarizeJsonShape,
  topLevelJsonKeys,
  valueType,
};
