"use strict";

/**
 * RevenueSyncOnly.gs（電話映射版）
 * ------------------------------------------------------------
 * 🎯 單一目的：把「房況年度分頁」同步到「年度營收分頁」
 *
 * ✅ 新增：營收表不存在該訂單 → 寫入 A~I + K（K 寫電話），J 保留給公式
 * ✅ 更新：欄位有差異才更新（J 不比對、不覆寫；K 會同步電話）
 * ✅ 清除：房況不存在的訂單 → 清 A~K（保護 L 欄既有重要資訊）
 * ✅ 封住公式長尾：所有資料範圍都用「訂單編號欄(B)」找最後有效列
 *
 * ------------------------------------------------------------
 * Script Properties（建議設定）：
 * - SOURCE_SHEET_ID              (可選，不填=腳本所在試算表；A表)
 * - TARGET_REVENUE_SHEET_ID      (可選，不填=寫回 A 表；填了=外部 B 表)
 * - REVENUE_SHEET_PREFIX         (可選，預設「營收」)
 * - REVENUE_DATA_START_ROW       (可選，預設 9)
 *
 * 欄位映射（本版）：
 * - SOURCE：L 欄(電話) → TARGET：K 欄
 * - TARGET：L 欄起的既有資訊一律不碰、不清空
 */

const REV_SYNC_CONFIG = {
  BRAND_NAME: "(良辰吉日5720)",

  ROOM_SHEET_SUFFIX_ENABLED: true,
  ROOM_SHEET_SUFFIX_TEXT: "房況",

  REVENUE_SHEET_PREFIX: "營收",
  REVENUE_DATA_START_ROW: 9,

  // ✅ 同步年度範圍：今年 + 明年
  SYNC_YEAR_OFFSET_MIN: 0,
  SYNC_YEAR_OFFSET_MAX: 1,

  // ✅ 固定欄位位置（避免魔法數散落）
  ROOM_COLS: {
    ORDER_ID: 2,   // B
    UUID: 11,      // K（不用）
    PHONE: 12      // L（要用）
  },

  REV_COLS: {
    PHONE_TARGET: 11 // K：要寫電話到這裡
  }
};

const __SP = PropertiesService.getScriptProperties();
const REV_RUNTIME = {
  SOURCE_SHEET_ID: __SP.getProperty("SOURCE_SHEET_ID") || "",
  TARGET_REVENUE_SHEET_ID: __SP.getProperty("TARGET_REVENUE_SHEET_ID") || "",
  REVENUE_SHEET_PREFIX: __SP.getProperty("REVENUE_SHEET_PREFIX") || REV_SYNC_CONFIG.REVENUE_SHEET_PREFIX,
  REVENUE_DATA_START_ROW: Number(__SP.getProperty("REVENUE_DATA_START_ROW")) || REV_SYNC_CONFIG.REVENUE_DATA_START_ROW
};

function _escapeRegExp_(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function _roomSheetSuffix_() {
  return REV_SYNC_CONFIG.ROOM_SHEET_SUFFIX_ENABLED ? String(REV_SYNC_CONFIG.ROOM_SHEET_SUFFIX_TEXT || "") : "";
}

function _roomSheetNameRegex_() {
  const brand = _escapeRegExp_(REV_SYNC_CONFIG.BRAND_NAME || "");
  const suffix = _escapeRegExp_(_roomSheetSuffix_());
  return new RegExp("^\\d{4}" + brand + suffix + "$");
}

function _stripTime_(d) {
  if (!(d instanceof Date) || isNaN(d)) return d;
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0));
}

function _normForCompare_(v) {
  if (v === null || v === undefined) return "";

  if (v instanceof Date && !isNaN(v)) {
    const d = _stripTime_(v);
    return Utilities.formatDate(d, "Asia/Taipei", "yyyy-MM-dd");
  }

  const s = String(v).trim();
  if (!s) return "";

  const numeric = s.replace(/,/g, "");
  if (/^-?\d+(\.\d+)?$/.test(numeric)) return String(Number(numeric));

  return s;
}

function _getSourceSS_() {
  const id = String(REV_RUNTIME.SOURCE_SHEET_ID || "").trim();
  if (id) return SpreadsheetApp.openById(id);
  return SpreadsheetApp.getActiveSpreadsheet();
}

function _getTargetSS_() {
  const id = String(REV_RUNTIME.TARGET_REVENUE_SHEET_ID || "").trim();
  if (id) return SpreadsheetApp.openById(id);
  return _getSourceSS_();
}

function _findRoomDataStartRow_(sheet) {
  const last = sheet.getLastRow();
  const scanMax = Math.min(20, Math.max(last, 1));
  for (let r = 1; r <= scanMax; r++) {
    const row = sheet.getRange(r, 1, 1, 12).getValues()[0].map(v => String(v || ""));
    const joined = row.join("|");
    // ✅ 只要找到訂單編號與入住日期即可（UUID/電話欄位存在與否不影響資料起始列）
    if (joined.includes("訂單編號") && joined.includes("入住日期")) return r + 1;
  }
  return 3;
}

function _getRevenueStartRow_(sheet) {
  const fixed = Number(REV_RUNTIME.REVENUE_DATA_START_ROW);
  if (fixed && fixed >= 2) return fixed;

  const last = sheet.getLastRow();
  const scanMax = Math.min(20, Math.max(last, 1));
  for (let r = 1; r <= scanMax; r++) {
    const row = sheet.getRange(r, 1, 1, 12).getValues()[0].map(v => String(v || ""));
    const joined = row.join("|");
    if (joined.includes("訂單編號")) return r + 1;
  }
  return 9;
}

function _ensureRevenueStartRowPadding_(sheet) {
  const startRow = _getRevenueStartRow_(sheet);
  const needLastRow = startRow - 1;
  const lastRow = sheet.getLastRow();
  if (lastRow < needLastRow) {
    sheet.insertRowsAfter(1, needLastRow - 1);
  }
}

/**
 * ✅ 以「訂單編號欄(B)」判定最後一筆有效資料列（避免被公式長尾撐大）
 */
function _getLastDataRowByOrderId_(sheet, startRow) {
  const sr = Number(startRow || 1);
  if (!sheet || sr < 1) return sr - 1;

  const CHUNK = 500;
  const BLANK_STOP = 200;

  const maxRows = sheet.getMaxRows();

  let cursor = sr;
  let lastFoundRow = sr - 1;
  let blankRun = 0;

  while (cursor <= maxRows) {
    const size = Math.min(CHUNK, maxRows - cursor + 1);
    const colB = sheet.getRange(cursor, 2, size, 1).getValues();

    for (let i = 0; i < colB.length; i++) {
      const v = String(colB[i][0] || "").trim();

      if (v) {
        lastFoundRow = cursor + i;
        blankRun = 0;
        continue;
      }

      if (lastFoundRow >= sr) {
        blankRun++;
        if (blankRun >= BLANK_STOP) return lastFoundRow;
      }
    }

    cursor += size;
  }

  return lastFoundRow;
}

function _findFirstEmptyOrderRow_(sheet, startRow) {
  const lastDataRow = _getLastDataRowByOrderId_(sheet, startRow);
  if (lastDataRow < startRow) return startRow;

  const values = sheet.getRange(startRow, 2, lastDataRow - startRow + 1, 1).getValues();
  for (let i = 0; i < values.length; i++) {
    const v = String(values[i][0] || "").trim();
    if (!v) return startRow + i;
  }
  return lastDataRow + 1;
}

/**
 * ✅ 核心同步：房況 → 年度營收（SOURCE L 電話 → TARGET K）
 */
function syncRoomToRevenueOnly() {
  const sourceSS = _getSourceSS_();
  const targetSS = _getTargetSS_();

  const targetId = String(REV_RUNTIME.TARGET_REVENUE_SHEET_ID || "").trim();
  Logger.log("🧭 REV TARGET MODE=" + (targetId ? "外部B試算表" : "寫回A試算表"));
  Logger.log("🧭 SOURCE SS=" + sourceSS.getId());
  Logger.log("🧭 TARGET SS=" + targetSS.getId());

  // ✅ 表頭可以維持你的既有格式；我們只保證不碰 TARGET 的 L 欄起資料
  const headers = ["訂單日期", "訂單編號", "入住日期", "退房日期", "姓名", "房型", "專案名稱", "訂單款項", "已收金額", "剩餘尾款", "電話"];

  const now = new Date();
  const currentYear = now.getFullYear();
  const yMin = currentYear + Number(REV_SYNC_CONFIG.SYNC_YEAR_OFFSET_MIN || 0);
  const yMax = currentYear + Number(REV_SYNC_CONFIG.SYNC_YEAR_OFFSET_MAX || 0);

  const roomSheetNames = sourceSS.getSheets()
    .map(s => s.getName())
    .filter(name => {
      if (!_roomSheetNameRegex_().test(name)) return false;
      const y = Number(String(name).slice(0, 4)) || 0;
      return y >= yMin && y <= yMax;
    });

  let added = 0;
  let updated = 0;
  let cleared = 0;

  const addedIds = [];
  const updatedIds = [];
  const clearedIds = [];

  for (let si = 0; si < roomSheetNames.length; si++) {
    const sheetName = roomSheetNames[si];
    const year = String(sheetName).slice(0, 4);

    const roomSheet = sourceSS.getSheetByName(sheetName);
    if (!roomSheet) continue;

    const startRowRoom = _findRoomDataStartRow_(roomSheet);
    const roomLastDataRow = _getLastDataRowByOrderId_(roomSheet, startRowRoom);
    if (roomLastDataRow < startRowRoom) {
      Logger.log("⏭️ 略過 " + sheetName + "（無資料）");
      continue;
    }

    // ✅ 讀 A~L（12欄），拿到 L 的電話
    const roomData = roomSheet.getRange(startRowRoom, 1, roomLastDataRow - startRowRoom + 1, 12).getValues();

    const revenueSheetName = year + String(REV_RUNTIME.REVENUE_SHEET_PREFIX || "營收");
    let revSheet = targetSS.getSheetByName(revenueSheetName);

    if (!revSheet) {
      revSheet = targetSS.insertSheet(revenueSheetName);
      revSheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      _ensureRevenueStartRowPadding_(revSheet);
      Logger.log("🆕 建立營收分頁：" + revenueSheetName);
    }

    const startRowRev = _getRevenueStartRow_(revSheet);
    const revLastDataRow = _getLastDataRowByOrderId_(revSheet, startRowRev);

    // ✅ 建索引：只讀 B 欄（訂單編號）
    const revIndexMap = new Map();
    if (revLastDataRow >= startRowRev) {
      const oids = revSheet.getRange(startRowRev, 2, revLastDataRow - startRowRev + 1, 1).getValues();
      for (let i = 0; i < oids.length; i++) {
        const oid = String(oids[i][0] || "").trim();
        if (!oid) continue;
        if (!revIndexMap.has(oid)) revIndexMap.set(oid, startRowRev + i);
      }
    }

    // ✅ 來源端訂單集合（用於清除）
    const roomOrderIds = new Set(roomData.map(r => r[REV_SYNC_CONFIG.ROOM_COLS.ORDER_ID - 1]).filter(Boolean));

    // ✅ 新增 / 更新
    for (let i = 0; i < roomData.length; i++) {
      const src = roomData[i];
      const orderId = src[REV_SYNC_CONFIG.ROOM_COLS.ORDER_ID - 1];
      if (!orderId) continue;

      // ✅ SOURCE 的 L 欄電話（第12欄）
      const phone = src[REV_SYNC_CONFIG.ROOM_COLS.PHONE - 1];

      // ✅ 只同步 A~I（9欄）＋ K(電話)
      // J(第10欄) 留給公式：H - N(I)
      const formattedAtoI = [
        _stripTime_(src[0]),     // A 訂單日期
        orderId,                 // B 訂單編號
        _stripTime_(src[2]),     // C 入住日期
        _stripTime_(src[3]),     // D 退房日期
        src[4],                  // E 姓名
        src[5],                  // F 房型
        src[6],                  // G 專案名稱
        src[7],                  // H 訂單款項
        src[8]                   // I 已收金額
      ];

      const index = revIndexMap.get(orderId);

      // --- 新增 ---
      if (!index) {
        const insertRow = _findFirstEmptyOrderRow_(revSheet, startRowRev);

        // 寫 A~I
        revSheet.getRange(insertRow, 1, 1, 9).setValues([formattedAtoI]);

        // ✅ 寫 K=電話：強制純文字，保留前導 0
        const phoneText = (phone === null || phone === undefined) ? "" : String(phone).trim();
        const phoneCell = revSheet.getRange(insertRow, REV_SYNC_CONFIG.REV_COLS.PHONE_TARGET, 1, 1);
        phoneCell.setNumberFormat("@");           // ← 純文字格式
        phoneCell.setValues([[phoneText]]);       // ← 用字串寫入

        // J 欄保險絲：H - N(I)
        if (!revSheet.getRange(insertRow, 10).getFormula()) {
          revSheet.getRange(insertRow, 10).setFormulaR1C1('=IF(LEN(RC[-2])=0,"",RC[-2]-N(RC[-1]))');
        }

        [1, 3, 4].forEach(col => revSheet.getRange(insertRow, col).setNumberFormat("yyyy/MM/dd"));

        revIndexMap.set(orderId, insertRow);

        added++;
        addedIds.push(year + ":" + orderId);
        continue;
      }

      // --- 更新（只有不同才寫）---
      // ✅ 讀 A~K（11欄）就夠了：我們不碰 L
      const existing = revSheet.getRange(index, 1, 1, 11).getValues()[0];

      let differs = false;

      // 比對 A~I（0~8）
      for (let k = 0; k <= 8; k++) {
        if (_normForCompare_(formattedAtoI[k]) !== _normForCompare_(existing[k])) {
          differs = true;
          break;
        }
      }

      // 比對 K（電話） existing[10]
      if (!differs) {
        if (_normForCompare_(phone) !== _normForCompare_(existing[10])) {
          differs = true;
        }
      }

      if (differs) {
        // 寫 A~I
        revSheet.getRange(index, 1, 1, 9).setValues([formattedAtoI]);

        // ✅ 寫 K=電話：強制純文字，保留前導 0
        const phoneText = (phone === null || phone === undefined) ? "" : String(phone).trim();
        const phoneCell = revSheet.getRange(index, REV_SYNC_CONFIG.REV_COLS.PHONE_TARGET, 1, 1);
        phoneCell.setNumberFormat("@");
        phoneCell.setValues([[phoneText]]);

        // J 欄保險絲
        if (!revSheet.getRange(index, 10).getFormula()) {
          revSheet.getRange(index, 10).setFormulaR1C1('=IF(LEN(RC[-2])=0,"",RC[-2]-N(RC[-1]))');
        }

        [1, 3, 4].forEach(col => revSheet.getRange(index, col).setNumberFormat("yyyy/MM/dd"));

        updated++;
        updatedIds.push(year + ":" + orderId);
      }
    }

    // ✅ 清除：營收存在，但房況沒有 → 維持原本清 A~N
    const clearWidth = 14; // A~N
    for (const entry of revIndexMap.entries()) {
      const oid = entry[0];
      const idx = entry[1];
      if (!roomOrderIds.has(oid)) {
        revSheet.getRange(idx, 1, 1, clearWidth).clearContent(); // A~N
        cleared++;
        clearedIds.push(year + ":" + oid);
      }
    }
  }

  Logger.log("✅ 同步完成：新增 " + added + "，更新 " + updated + "，清除 " + cleared);

  return {
    added: added,
    updated: updated,
    cleared: cleared,
    addedIds: addedIds,
    updatedIds: updatedIds,
    clearedIds: clearedIds
  };
}

function MENU_SyncRevenueOnly() {
  const summary = syncRoomToRevenueOnly();
  const msg = [
    "年度營收同步完成",
    "新增：" + summary.added,
    "更新：" + summary.updated,
    "清除：" + summary.cleared
  ].join("\n");

  try {
    SpreadsheetApp.getUi().alert("同步完成", msg, SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (e) {
    SpreadsheetApp.getActiveSpreadsheet().toast(msg, "同步完成", 8);
  }
}
