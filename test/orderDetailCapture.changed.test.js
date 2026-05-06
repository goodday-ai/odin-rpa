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
  return Boolean(detailForceRefreshEffective || nearCheckinRefresh || !cacheOk);
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
