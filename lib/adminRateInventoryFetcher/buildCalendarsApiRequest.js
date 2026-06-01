// 功能：建立 Owlting 後台 calendars range API 的安全請求描述。
// 責任：驗證單一 hotelId 與日期區間，產生實際 fetch URL 與不含 query value 的 safe request 摘要。
// 關聯模組：runAdminRateInventoryFetcherDryRun 會呼叫本模組；unit test 驗證 URL contract 與防呆規則。
// 關鍵流程：驗證 origin/hotelId/date/range → 組 calendars path → 填入 during_start_date/during_end_date/lang → 回傳 url 與 safe 欄位。

const ALLOWED_ORIGIN = "https://www.owlting.com";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 92;

function parseDateOnly(value, fieldName) {
  const text = String(value || "").trim();
  if (!DATE_RE.test(text)) throw new Error(`${fieldName} must be YYYY-MM-DD`);
  const date = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    throw new Error(`${fieldName} must be a valid YYYY-MM-DD date`);
  }
  return { text, date };
}

function daysBetween(startDate, endDate) {
  return Math.round((endDate.getTime() - startDate.getTime()) / 86400000);
}

function buildCalendarsApiRequest({ origin, hotelId, start, end, lang = "zh_TW" } = {}) {
  const normalizedOrigin = String(origin || "").trim().replace(/\/+$/, "");
  if (normalizedOrigin !== ALLOWED_ORIGIN) throw new Error("origin must be https://www.owlting.com");

  const normalizedHotelId = String(hotelId || "").trim();
  // 中文註解：hotelId 僅允許數字字串，避免自由文字被帶入 path 或 artifact 檔名。
  if (!/^\d+$/.test(normalizedHotelId)) throw new Error("hotelId must be numeric");

  const parsedStart = parseDateOnly(start, "start");
  const parsedEnd = parseDateOnly(end, "end");
  const rangeDays = daysBetween(parsedStart.date, parsedEnd.date);
  if (rangeDays <= 0) throw new Error("start must be before end");
  if (rangeDays > MAX_RANGE_DAYS) throw new Error(`range must be <= ${MAX_RANGE_DAYS} days`);

  const path = `/booking/v2/admin/hotels/${normalizedHotelId}/calendars`;
  const url = new URL(path, normalizedOrigin);
  url.searchParams.set("during_start_date", parsedStart.text);
  url.searchParams.set("during_end_date", parsedEnd.text);
  url.searchParams.set("lang", String(lang || "zh_TW").trim() || "zh_TW");

  return {
    url: url.toString(),
    safe: {
      origin: normalizedOrigin,
      path,
      queryKeys: ["during_start_date", "during_end_date", "lang"],
    },
  };
}

module.exports = {
  ALLOWED_ORIGIN,
  MAX_RANGE_DAYS,
  buildCalendarsApiRequest,
};
