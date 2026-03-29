"use strict";

/**
 * Odin → Google Sheet Sync Web App（完整版｜日期格式統一 yyyy/MM/dd）
 * ---------------------------------------------------
 * ✅ 驗證：payload.token（對應 Script Properties 的 ODIN_SHEET_TOKEN）
 * ✅ 建分頁：YYYY(民宿名稱ID)房況（以「入住日期」年份為準）
 * ✅ 表頭：第 2 行
 * ✅ 資料：第 3 行起，依「訂單編號」upsert
 * ✅ Upsert 效能：只有「真的有變更」才更新（減少寫入量）
 * ✅ 取消單清理：payload.cancelledOrderNos 會在 Sheet 中刪除對應訂單列
 * ✅ 同步後自動排序：入住日期 ASC → 訂單編號 ASC
 * ✅ 電話欄位：強制純文字（避免前導 0 消失）
 * ✅ 日期欄位：統一寫入為 Date 型別 + 顯示格式鎖定 yyyy/MM/dd（避免同欄混用 - 與 /）
 * ✅ 每次同步：更新分頁 A1/B1 為「最後更新時間（台北時區）」
 *
 * ✅ 本次修正重點（取消單刪不掉的根因修復）：
 * - 只要有 cancelledOrderNos，就「掃現有所有年度分頁」一起做刪除
 *   （避免：本次 rows 只含 2026，但取消的是 2025 分頁 → 永遠刪不到）
 * - 刪除回報補上 cancelIncoming（本次收到幾筆取消單 key），方便診斷：
 *   - cancelIncoming > 0 且 deleted = 0 → 多半是 key 對不到（欄位/空白/型態）
 *
 * Script Properties：
 * - ODIN_SHEET_TOKEN         (必填，你自訂)
 * - ODIN_SPREADSHEET_ID      (可選；不填就用 payload.spreadsheetId)
 */

function doPost(e) {
  try {
    const reqId = Utilities.getUuid();

    const token = _getToken_(e);
    const expected = String(PropertiesService.getScriptProperties().getProperty("ODIN_SHEET_TOKEN") || "").trim();
    if (!expected) return _json_(401, { ok: false, reqId: reqId, error: "ODIN_SHEET_TOKEN not set in Script Properties" });
    if (!token || token !== expected) return _json_(403, { ok: false, reqId: reqId, error: "Unauthorized" });

    const bodyText = (e && e.postData && e.postData.contents) ? e.postData.contents : "";
    if (!bodyText) return _json_(400, { ok: false, reqId: reqId, error: "Empty body" });

    const payload = JSON.parse(bodyText);
    const items = Array.isArray(payload.items) ? payload.items : [payload];

    const spreadsheetId = String(
      payload.spreadsheetId ||
      PropertiesService.getScriptProperties().getProperty("ODIN_SPREADSHEET_ID") ||
      ""
    ).trim();

    if (!spreadsheetId) {
      return _json_(400, {
        ok: false,
        reqId: reqId,
        error: "Missing spreadsheetId (payload.spreadsheetId or Script Properties ODIN_SPREADSHEET_ID)"
      });
    }

    const ss = SpreadsheetApp.openById(spreadsheetId);

    const results = [];
    for (const it of items) {
      results.push(_syncOne_(ss, it));
    }

    return _json_(200, { ok: true, reqId: reqId, results: results });
  } catch (err) {
    return _json_(500, { ok: false, error: String(err && err.stack ? err.stack : err) });
  }
}

function _syncOne_(ss, item) {
  const hotelId = String(item && item.hotelId != null ? item.hotelId : "").trim();
  const hotelName = String(item && item.hotelName != null ? item.hotelName : "").trim();
  const columns = _normalizeColumns_(Array.isArray(item && item.columns) ? item.columns : []);
  const rows = Array.isArray(item && item.rows) ? item.rows : [];
  const cancelledOrderNos = Array.isArray(item && item.cancelledOrderNos) ? item.cancelledOrderNos : [];
  const replaceAllRows = !!(item && item.replaceAllRows);

  if (!hotelId) return { ok: false, hotelId: hotelId, error: "Missing hotelId" };
  if (!columns.length) return { ok: false, hotelId: hotelId, error: "Missing columns" };

  const groups = _groupByYear_(rows);
  const hasCancel = cancelledOrderNos && cancelledOrderNos.length > 0;

  // ✅ 年份集合：rows 年份 + 已存在的分頁年份（確保取消單能跨年度刪除）
  const yearSet = {};
  for (const y of Object.keys(groups)) yearSet[y] = true;

  if (hasCancel || replaceAllRows) {
    const scanYears = _discoverPossibleYears_(ss, hotelName, hotelId);
    for (const y of scanYears) yearSet[y] = true;
  }

  const yearsToProcess = Object.keys(yearSet).sort();

  const summary = {
    ok: true,
    hotelId: hotelId,
    hotelName: hotelName,
    years: yearsToProcess,
    wrote: []
  };

  // ✅ 若某年份只有取消單刪除、沒有 rows，要保證 groups[year] 有陣列
  for (const y of yearsToProcess) {
    if (!groups[y]) groups[y] = [];
  }

  for (const year of yearsToProcess) {
    const sheetName = _buildSheetName_(year, hotelName, hotelId);
    const sh = _getOrCreateSheet_(ss, sheetName);

    const layout = _ensureHeaderRow_(sh, columns);
    const dataStartRow = layout && layout.dataStartRow ? layout.dataStartRow : 2;

    const clearInfo = replaceAllRows ? _clearDataRows_(sh, dataStartRow) : { ok: true, cleared: 0 };
    const delInfo = replaceAllRows
      ? { ok: true, deleted: 0, cancelIncoming: hasCancel ? cancelledOrderNos.length : 0, skipped: true, reason: "replace_all" }
     : (hasCancel ? _deleteCancelled_(sh, columns, cancelledOrderNos, dataStartRow) : { ok: true, deleted: 0, cancelIncoming: 0 });
    const wrote = _upsertRows_(sh, columns, groups[year], dataStartRow);
    const sortInfo = _sortSheet_(sh, columns, dataStartRow);
    const updatedAt = _setUpdatedTimestamp_(sh);

    summary.wrote.push({
      year: year,
      sheetName: sheetName,
      cleared: clearInfo && clearInfo.ok ? clearInfo.cleared : 0,
      deleted: delInfo && delInfo.ok ? delInfo.deleted : 0,
      cancelIncoming: delInfo && delInfo.ok ? delInfo.cancelIncoming : 0,
      deleteError: delInfo && delInfo.ok ? "" : (delInfo && delInfo.error ? delInfo.error : ""),
      updated: wrote.updated,
      appended: wrote.appended,
      skippedSame: wrote.skippedSame,
      totalIncoming: wrote.totalIncoming,
      sort: sortInfo,
      updatedAt: updatedAt
    });
  }

  return summary;
}

function _clearDataRows_(sh, dataStartRow) {
  try {
    const startRow = Number(dataStartRow || 2);
    const lastRow = sh.getLastRow();
    if (lastRow < startRow) return { ok: true, cleared: 0 };

    const count = lastRow - startRow + 1;
    sh.deleteRows(startRow, count);
    return { ok: true, cleared: count };
  } catch (err) {
    return { ok: false, cleared: 0, error: String(err && err.message ? err.message : err) };
  }
}

function _normalizeColumns_(columns) {
  const seen = {};
  const out = [];
  for (const c of columns) {
    const k = String(c == null ? "" : c).trim();
    if (!k || seen[k]) continue;
    seen[k] = true;
    out.push(k);
  }
  return out;
}

function _groupByYear_(rows) {
  const out = {};
  const nowYear = new Date().getFullYear();

  for (const r of rows) {
    const checkin = String(r && r["入住日期"] != null ? r["入住日期"] : "").trim();
    const y = _yearFromDate_(checkin) || String(nowYear);
    if (!out[y]) out[y] = [];
    out[y].push(r);
  }
  return out;
}

function _yearFromDate_(s) {
  const m = String(s || "").match(/^(\d{4})[\/-]\d{2}[\/-]\d{2}/);
  return m ? m[1] : "";
}

function _buildSheetName_(year, hotelName, hotelId) {
  const name = hotelName ? hotelName : "Hotel";
  return year + "(" + name + hotelId + ")房況";
}

function _getOrCreateSheet_(ss, name) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  return sh;
}

function _ensureHeaderRow_(sh, columns) {
  const headerRow = 2;
  const range = sh.getRange(headerRow, 1, 1, columns.length);
  const current = range.getValues()[0] || [];

  const empty =
    current.length === columns.length &&
    current.every(function(v) { return String(v == null ? "" : v).trim() === ""; });
  const same =
    current.length === columns.length &&
    current.every(function(v, i) { return String(v || "") === String(columns[i] || ""); });

  let hasHeader = false;
  if (same) {
    hasHeader = true;
  } else if (empty) {
    range.setValues([columns]);
    hasHeader = true;
  }

  try { sh.setFrozenRows(2); } catch (_) {}

  // ✅ 電話：強制純文字
  _ensurePlainTextColumns_(sh, columns, ["電話"]);

  // ✅ 日期欄：顯示格式統一 yyyy/MM/dd（避免同欄混用 - 與 /）
  _ensureDateFormatColumns_(sh, columns, ["訂單日期", "入住日期", "退房日期"]);

  return { hasHeader: hasHeader, dataStartRow: hasHeader ? 3 : 2 };
}

function _ensurePlainTextColumns_(sh, columns, colNames) {
  try {
    const names = Array.isArray(colNames) ? colNames : [];
    if (!names.length) return;

    const maxRows = sh.getMaxRows();
    for (const n of names) {
      const idx = columns.indexOf(String(n || "").trim());
      if (idx === -1) continue;

      const col = idx + 1;
      sh.getRange(1, col, maxRows, 1).setNumberFormat("@");
    }
  } catch (_) {}
}

function _ensureDateFormatColumns_(sh, columns, colNames) {
  try {
    const names = Array.isArray(colNames) ? colNames : [];
    if (!names.length) return;

    const maxRows = sh.getMaxRows();
    for (const n of names) {
      const idx = columns.indexOf(String(n || "").trim());
      if (idx === -1) continue;

      const col = idx + 1;
      sh.getRange(1, col, maxRows, 1).setNumberFormat("yyyy/MM/dd");
    }
  } catch (_) {}
}

function _setUpdatedTimestamp_(sh) {
  try {
    const now = new Date();
    const display = Utilities.formatDate(now, "Asia/Taipei", "yyyy/MM/dd HH:mm:ss");
    sh.getRange("A1").setValue("最後更新");
    sh.getRange("B1").setValue(display).setNumberFormat("@");
    return display;
  } catch (_) {
    return "";
  }
}

function _deleteCancelled_(sh, columns, cancelledOrderNos, dataStartRow) {
  try {
    const startRow = Number(dataStartRow || 2);
    const keyName = "訂單編號";
    const keyColIndex = columns.indexOf(keyName);
    if (keyColIndex === -1) return { ok: false, error: "columns missing 訂單編號" };

    const lastRow = sh.getLastRow();
    const existingRowCount = Math.max(0, lastRow - startRow + 1);
    if (existingRowCount <= 0) {
      const cancelSetEmpty = _buildCancelSet_(cancelledOrderNos);
      return { ok: true, deleted: 0, cancelIncoming: Object.keys(cancelSetEmpty).length };
    }

    const range = sh.getRange(startRow, 1, existingRowCount, columns.length);
    const values = range.getValues();

    const cancelSet = _buildCancelSet_(cancelledOrderNos);

    const rowsToDelete = [];
    for (let i = 0; i < values.length; i++) {
      const rowVals = values[i];
      const key = String(rowVals[keyColIndex] || "").trim();
      if (key && cancelSet[key]) rowsToDelete.push(startRow + i);
    }

    if (!rowsToDelete.length) return { ok: true, deleted: 0, cancelIncoming: Object.keys(cancelSet).length };

    rowsToDelete.sort(function(a, b) { return b - a; });
    for (const r of rowsToDelete) sh.deleteRow(r);

    return { ok: true, deleted: rowsToDelete.length, cancelIncoming: Object.keys(cancelSet).length };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

function _buildCancelSet_(cancelledOrderNos) {
  const cancelSet = {};
  for (const k of Array.isArray(cancelledOrderNos) ? cancelledOrderNos : []) {
    const kk = String(k || "").trim();
    if (kk) cancelSet[kk] = true;
  }
  return cancelSet;
}

function _upsertRows_(sh, columns, rows, dataStartRow) {
  const startRow = Number(dataStartRow || 2);

  const keyName = "訂單編號";
  const keyColIndex = columns.indexOf(keyName);
  if (keyColIndex === -1) return { ok: false, updated: 0, appended: 0, skippedSame: 0, totalIncoming: rows.length };

  const lastRow = sh.getLastRow();
  const existingRowCount = Math.max(0, lastRow - startRow + 1);

  const existingMap = {};
  if (existingRowCount > 0) {
    const range = sh.getRange(startRow, 1, existingRowCount, columns.length);
    const values = range.getValues();

    for (let i = 0; i < values.length; i++) {
      const rowVals = values[i];
      const key = String(rowVals[keyColIndex] || "").trim();
      if (key) existingMap[key] = { row: startRow + i, values: rowVals };
    }
  }

  let updated = 0;
  let appended = 0;
  let skippedSame = 0;

  const updates = [];
  const appends = [];

  for (const obj of rows) {
    const key = String(obj && obj[keyName] != null ? obj[keyName] : "").trim();
    if (!key) continue;

    const rowVals = _alignRowToColumns_(obj, columns);

    const hit = existingMap[key];
    if (hit && hit.row) {
      const oldVals = hit.values || [];
      const same = _rowEquals_(oldVals, rowVals);
      if (same) {
        skippedSame++;
        continue;
      }
      updates.push({ row: hit.row, values: rowVals });
    } else {
      appends.push(rowVals);
    }
  }

  if (updates.length) {
    updated += _writeBatchedRowUpdates_(sh, columns.length, updates);
  }

  if (appends.length) {
    sh.getRange(sh.getLastRow() + 1, 1, appends.length, columns.length).setValues(appends);
    appended += appends.length;
  }

  return { ok: true, updated: updated, appended: appended, skippedSame: skippedSame, totalIncoming: rows.length };
}

function _alignRowToColumns_(obj, columns) {
  return columns.map(function(c) { return _cell_(obj ? obj[c] : "", c); });
}

function _writeBatchedRowUpdates_(sh, width, updates) {
  updates.sort(function(a, b) { return a.row - b.row; });

  let wrote = 0;
  let start = 0;
  while (start < updates.length) {
    let end = start;
    while (end + 1 < updates.length && updates[end + 1].row === updates[end].row + 1) end++;

    const firstRow = updates[start].row;
    const chunkVals = [];
    for (let i = start; i <= end; i++) chunkVals.push(updates[i].values);

    sh.getRange(firstRow, 1, chunkVals.length, width).setValues(chunkVals);
    wrote += chunkVals.length;
    start = end + 1;
  }

  return wrote;
}

function _rowEquals_(a, b) {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (String(a[i] == null ? "" : a[i]) !== String(b[i] == null ? "" : b[i])) return false;
  }
  return true;
}

function _sortSheet_(sh, columns, dataStartRow) {
  try {
    const startRow = Number(dataStartRow || 2);
    const lastRow = sh.getLastRow();
    if (lastRow < startRow) return { ok: true, skipped: true, reason: "no data rows" };

    const checkinCol = columns.indexOf("入住日期") + 1;
    const orderNoCol = columns.indexOf("訂單編號") + 1;

    if (checkinCol <= 0) return { ok: true, skipped: true, reason: "missing 入住日期 column" };
    if (orderNoCol <= 0) return { ok: true, skipped: true, reason: "missing 訂單編號 column" };

    const height = lastRow - startRow + 1;
    if (height <= 1) return { ok: true, skipped: true, reason: "not enough rows" };

    _normalizeDateCellsInSheet_(sh, columns, startRow, height);

    sh.getRange(startRow, 1, height, columns.length).sort([
      { column: checkinCol, ascending: true },
      { column: orderNoCol, ascending: true }
    ]);

    return { ok: true, sorted: true, by: ["入住日期", "訂單編號"] };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

function _normalizeDateCellsInSheet_(sh, columns, dataStartRow, height) {
  const dateCols = ["訂單日期", "入住日期", "退房日期"];

  for (const n of dateCols) {
    const col = columns.indexOf(n) + 1;
    if (col <= 0) continue;

    const rg = sh.getRange(dataStartRow, col, height, 1);
    const vals = rg.getValues();

    let changed = false;
    for (let i = 0; i < vals.length; i++) {
      const v = vals[i][0];
      const parsed = _parseDateLike_(v);
      if (parsed && !(v instanceof Date && !isNaN(v))) {
        vals[i][0] = parsed;
        changed = true;
      }
    }

    if (changed) rg.setValues(vals);
    rg.setNumberFormat("yyyy/MM/dd");
  }
}

function _cell_(v, colName) {
  if (v == null) return "";

  const name = String(colName || "").trim();

  // ✅ 電話：純文字（避免前導 0 消失）
  if (name === "電話") {
    const s = String(v).trim();
    if (!s) return "";
    if (/^\d+$/.test(s)) return "'" + s;
    return s;
  }

  // ✅ 日期欄：統一轉 Date 物件，讓型別一致
  if (name === "訂單日期" || name === "入住日期" || name === "退房日期") {
    const d = _parseDateLike_(v);
    return d || String(v).trim();
  }

    return v;
}

function _parseDateLike_(v) {
  if (v instanceof Date && !isNaN(v)) return v;

  const s = String(v == null ? "" : v).trim();
  if (!s) return null;

  const m = s.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})(?:\D.*)?$/);
  if (!m) return null;

  const y = Number(m[1]);
  const mm = Number(m[2]);
  const dd = Number(m[3]);
  if (!y || !mm || !dd) return null;

  return new Date(y, mm - 1, dd);
}

function _discoverPossibleYears_(ss, hotelName, hotelId) {
  const out = {};
  const name = hotelName ? hotelName : "Hotel";
  const pattern = new RegExp("^([0-9]{4})\\(" + _escapeRegExp_(name) + _escapeRegExp_(String(hotelId)) + "\\)房況$");

  const sheets = ss.getSheets();
  for (const sh of sheets) {
    const n = sh.getName();
    const m = n.match(pattern);
    if (m && m[1]) out[m[1]] = true;
  }

  const years = Object.keys(out);
  if (!years.length) years.push(String(new Date().getFullYear()));
  years.sort();
  return years;
}

function _escapeRegExp_(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function _getToken_(e) {
  const params = (e && e.parameter) ? e.parameter : {};
  const tokenFromQuery = params.token ? String(params.token).trim() : "";
  if (tokenFromQuery) return tokenFromQuery;

  try {
    const bodyText = (e && e.postData && e.postData.contents) ? e.postData.contents : "";
    if (!bodyText) return "";
    const payload = JSON.parse(bodyText);
    return payload && payload.token != null ? String(payload.token).trim() : "";
  } catch (_) {
    return "";
  }
}

function _json_(code, obj) {
  const out = ContentService.createTextOutput(JSON.stringify(obj));
  out.setMimeType(ContentService.MimeType.JSON);
  return out;
}
