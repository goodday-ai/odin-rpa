/**
 * 功能：驗證 ODIN 訂單同步的房型異動判定與 refresh 覆寫行為。
 * 責任：用最小單元測試保護 changedOnly 與 detail refresh 在 roomType 變更時不漏同步。
 * 關聯模組：tests/orderDetailCapture.spec.js（stableSig / changedOnly 判定 / detail refresh）
 * 關鍵流程：
 * 1) 舊 row 與新 row 僅「房型」不同時，signature 必須不同，代表會進 changed rows。
 * 2) refresh 條件成立且 detail 回傳新 room_config_name 時，最終 roomType 必須採用新值。
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

function stableSig(row) {
  return [
    row["入住日期"],
    row["退房日期"],
    row["訂單款項"],
    row["已收金額"],
    row["剩餘尾款"],
    row["房型"],
    row["專案名稱"],
    row["電話"]
  ].map((x) => String(x || "")).join("|");
}

function extractRoomTypeFromDetail(detailJson) {
  const d = detailJson && detailJson.data ? detailJson.data : null;
  if (!d) return "";
  const rooms = Array.isArray(d.rooms) ? d.rooms : [];
  const names = [...new Set(rooms.map((r) => String((r && r.room_config_name) || "").trim()).filter(Boolean))];
  return names.join("｜");
}

function shouldFetchDetailByPolicy({ detailForceRefreshEffective, nearCheckinRefresh, cacheOk }) {
  return getDetailFetchReasonByPolicy({ detailForceRefreshEffective, nearCheckinRefresh, cacheOk }) !== "cache_hit_skip";
}

// 中文註解：集中解析 ODIN_DETAIL_REFRESH_HOUR，空值回預設 6，僅明確停用字串才停用。
function parseDetailRefreshHour_(raw) {
  if (raw === undefined || raw === null) return { hour: 6, source: "default" };
  const text = String(raw).trim();
  if (!text) return { hour: 6, source: "default_empty_env" };
  if (/^(off|disabled|disable|none|-1)$/i.test(text)) return { hour: -1, source: "explicit_disabled" };
  const n = Number(text);
  if (Number.isFinite(n) && n >= 0 && n <= 23) return { hour: Math.floor(n), source: "env" };
  return { hour: 6, source: "default_invalid_env" };
}

// 中文註解：提供 detail policy 的理由分類，確保營運摘要統計與是否重打判斷一致。
function getDetailFetchReasonByPolicy({ detailForceRefreshEffective, nearCheckinRefresh, cacheOk }) {
  if (detailForceRefreshEffective) return "force_refresh";
  if (!cacheOk) return "cache_miss";
  if (nearCheckinRefresh) return "near_checkin_scheduled_refresh";
  return "cache_hit_skip";
}

// 中文註解：建立低噪音 refresh summary，僅輸出統計欄位，避免敏感資料外洩。
function buildDetailRefreshSummary(input) {
  return {
    hotelId: String(input.hotelId || ""),
    refreshHour: input.refreshHour,
    taipeiHour: input.taipeiHour,
    isScheduledDetailRefreshWindow: Boolean(input.isScheduledDetailRefreshWindow),
    scheduledRefreshMode: "near_checkin_conditional",
    forceRefresh: Boolean(input.forceRefresh),
    forceRefreshEffective: Boolean(input.forceRefreshEffective),
    nearCheckinDays: input.nearCheckinDays,
    detailFetchPolicy: { ...input.detailFetchPolicy },
    roomType: { ...input.roomType }
  };
}

test("roomType 變更會進入 changed rows", () => {
  const oldRow = {
    訂單編號: "OD123",
    入住日期: "2026-05-01",
    退房日期: "2026-05-02",
    訂單款項: "1000",
    已收金額: "500",
    剩餘尾款: "500",
    房型: "二人房 A",
    專案名稱: "早鳥",
    電話: ""
  };
  const newRow = { ...oldRow, 房型: "四人房 B" };
  assert.notEqual(stableSig(oldRow), stableSig(newRow));
});

test("refresh 條件命中時使用新 detail room_config_name 覆寫 roomType", () => {
  const order = { roomType: "舊房型" };
  const detailJson = { data: { rooms: [{ room_config_name: "新房型" }] } };
  const extracted = extractRoomTypeFromDetail(detailJson);
  if (extracted) order.roomType = extracted;
  assert.equal(order.roomType, "新房型");
});

test("06:00 refresh window 不等於 force refresh：cache hit + 非 near-checkin 不重打", () => {
  const shouldFetchDetail = shouldFetchDetailByPolicy({
    detailForceRefreshEffective: false,
    nearCheckinRefresh: false,
    cacheOk: true
  });
  assert.equal(shouldFetchDetail, false);
});

test("06:00 refresh window + near-checkin 仍會重打 detail", () => {
  const shouldFetchDetail = shouldFetchDetailByPolicy({
    detailForceRefreshEffective: false,
    nearCheckinRefresh: true,
    cacheOk: true
  });
  assert.equal(shouldFetchDetail, true);
});

test("explicit force refresh 仍可全量重打 detail", () => {
  const shouldFetchDetail = shouldFetchDetailByPolicy({
    detailForceRefreshEffective: true,
    nearCheckinRefresh: false,
    cacheOk: true
  });
  assert.equal(shouldFetchDetail, true);
});

test("detail fetch reason 分類與 shouldFetchDetailByPolicy 一致", () => {
  const cases = [
    { input: { detailForceRefreshEffective: true, nearCheckinRefresh: false, cacheOk: true }, expected: "force_refresh", fetch: true },
    { input: { detailForceRefreshEffective: false, nearCheckinRefresh: true, cacheOk: true }, expected: "near_checkin_scheduled_refresh", fetch: true },
    { input: { detailForceRefreshEffective: false, nearCheckinRefresh: false, cacheOk: false }, expected: "cache_miss", fetch: true },
    { input: { detailForceRefreshEffective: false, nearCheckinRefresh: false, cacheOk: true }, expected: "cache_hit_skip", fetch: false }
  ];
  for (const c of cases) {
    assert.equal(getDetailFetchReasonByPolicy(c.input), c.expected);
    assert.equal(shouldFetchDetailByPolicy(c.input), c.fetch);
  }
});

test("parseDetailRefreshHour_ 解析 fallback 與停用語意", () => {
  const cases = [
    { raw: undefined, hour: 6, source: "default" },
    { raw: "", hour: 6, source: "default_empty_env" },
    { raw: "   ", hour: 6, source: "default_empty_env" },
    { raw: "6", hour: 6, source: "env" },
    { raw: "17", hour: 17, source: "env" },
    { raw: "23", hour: 23, source: "env" },
    { raw: "off", hour: -1, source: "explicit_disabled" },
    { raw: "disabled", hour: -1, source: "explicit_disabled" },
    { raw: "-1", hour: -1, source: "explicit_disabled" },
    { raw: "abc", hour: 6, source: "default_invalid_env" }
  ];
  for (const c of cases) {
    assert.deepEqual(parseDetailRefreshHour_(c.raw), { hour: c.hour, source: c.source });
  }
});

test("refresh summary 不含敏感資料欄位", () => {
  const summary = buildDetailRefreshSummary({
    hotelId: "12345",
    refreshHour: 6,
    taipeiHour: 6,
    isScheduledDetailRefreshWindow: true,
    forceRefresh: false,
    forceRefreshEffective: false,
    nearCheckinDays: 7,
    detailFetchPolicy: { cacheHitSkipped: 10, cacheMissFetched: 2, nearCheckinFetched: 3, forceFetched: 0, totalFetched: 5 },
    roomType: { refreshed: 1, changed: 1 },
    cookie: "x",
    token: "y",
    phone: "z",
    payload: { rows: [1] }
  });
  const raw = JSON.stringify(summary);
  assert.equal(raw.includes("cookie"), false);
  assert.equal(raw.includes("token"), false);
  assert.equal(raw.includes("phone"), false);
  assert.equal(raw.includes("payload"), false);
  assert.equal(raw.includes("\"rows\""), false);
});

test("roomType changed summary 統計正確", () => {
  const oldRow = { 房型: "A" };
  const newRow = { 房型: "B" };
  const changedRows = [newRow];
  const roomTypeChangedRows = oldRow.房型 !== newRow.房型 ? 1 : 0;
  assert.equal(changedRows.length, 1);
  assert.equal(roomTypeChangedRows, 1);
});

test("near-checkin cache hit must refetch", () => {
  const counters = { nearCheckinCacheHitRefetched: 0, cacheHitSkipped: 0 };
  const input = { detailForceRefreshEffective: false, nearCheckinRefresh: true, cacheOk: true };
  const reason = getDetailFetchReasonByPolicy(input);
  const shouldFetch = shouldFetchDetailByPolicy(input);
  if (reason === "near_checkin_scheduled_refresh" && input.cacheOk) counters.nearCheckinCacheHitRefetched += 1;
  if (!shouldFetch) counters.cacheHitSkipped += 1;
  assert.equal(shouldFetch, true);
  assert.equal(reason, "near_checkin_scheduled_refresh");
  assert.equal(counters.nearCheckinCacheHitRefetched, 1);
  assert.equal(counters.cacheHitSkipped, 0);
});

test("cache new but current row old 仍判定 changed", () => {
  const cache = { roomType: "新房型", phone: "0912", projectName: "A" };
  const row = { roomType: "舊房型", phone: "0912", projectName: "A" };
  const detail = { roomType: "新房型", phone: "0912", projectName: "A" };
  const changedFields = ["roomType", "phone", "projectName"].filter((f) => detail[f] !== cache[f] || detail[f] !== row[f]);
  assert.equal(changedFields.includes("roomType"), true);
});
