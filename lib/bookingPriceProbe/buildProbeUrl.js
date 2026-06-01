// 功能：依照單一入住區間與人數參數組裝官網訂房測試 URL。
// 責任：集中治理日期、住客數、語系與允許的 query keys，確保不展開多日期掃描。
// 關聯模組：loadProbeConfig 提供 config，runBookingPriceProbe 使用輸出 URL 開啟 Playwright 頁面。
// 關鍵流程：驗證 bookingUrl/http(s) → 驗證 start/end → 驗證整數人數 → 僅寫入 start/end/lang/adult/child/infant。

const ALLOWED_QUERY_KEYS = ["start", "end", "lang", "adult", "child", "infant"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDateOnly(value) {
  if (!DATE_RE.test(String(value || ""))) return false;
  const [year, month, day] = String(value).split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function parseInteger(name, value, min) {
  const raw = String(value ?? "").trim();
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`invalid_config:${name}_must_be_integer`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < min) {
    throw new Error(`invalid_config:${name}_must_be_at_least_${min}`);
  }
  return parsed;
}

function assertDateRange(start, end) {
  if (!isValidDateOnly(start) || !isValidDateOnly(end)) {
    throw new Error("invalid_config:date_must_be_yyyy_mm_dd");
  }
  if (String(start) >= String(end)) {
    throw new Error("invalid_config:start_must_be_before_end");
  }
}

function buildProbeUrl(config) {
  const parsed = new URL(String(config.bookingUrl || ""));
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("invalid_config:booking_url_must_be_http_or_https");
  }

  assertDateRange(config.start, config.end);
  const adult = parseInteger("adult", config.adult, 1);
  const child = parseInteger("child", config.child, 0);
  const infant = parseInteger("infant", config.infant, 0);
  const lang = String(config.lang || "zh_TW");

  // 重要：這裡刻意清空既有 query，避免沿用來源 URL 中未知參數或完整 query value。
  parsed.search = "";
  const values = {
    start: String(config.start),
    end: String(config.end),
    lang,
    adult: String(adult),
    child: String(child),
    infant: String(infant),
  };
  for (const key of ALLOWED_QUERY_KEYS) {
    parsed.searchParams.set(key, values[key]);
  }
  return parsed.toString();
}

module.exports = {
  ALLOWED_QUERY_KEYS,
  buildProbeUrl,
  isValidDateOnly,
  parseInteger,
  assertDateRange,
};
