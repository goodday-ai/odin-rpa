/**
 * 功能：驗證 ODIN detail compared log 使用的電話遮罩 helper 行為。
 * 責任：確保 maskPhone_ 對空值/非字串安全，且不外洩完整電話，避免 log 階段中斷 workflow。
 * 關聯模組：tests/orderDetailCapture.spec.js（detail compared log）。
 * 關鍵流程：輸入正規化 -> 擷取數字 -> 遮罩輸出 -> 缺欄位容錯。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

function maskPhone_(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  const digits = s.replace(/\D+/g, '');
  if (!digits) return '***';
  if (digits.length <= 4) return '***' + digits.slice(-2);
  return digits.slice(0, 3) + '***' + digits.slice(-3);
}

test('maskPhone_ handles undefined safely', () => {
  assert.doesNotThrow(() => maskPhone_(undefined));
});

test('maskPhone_ handles empty string', () => {
  assert.equal(maskPhone_(''), '');
});

test('maskPhone_ does not expose full mobile number', () => {
  const masked = maskPhone_('0912345678');
  assert.notEqual(masked, '0912345678');
  assert.match(masked, /\*\*\*/);
});

test('detail compared log payload build does not crash when phone is missing', () => {
  const rowBefore = { phone: undefined };
  const detailAfter = { phone: null };
  assert.doesNotThrow(() => {
    const payload = {
      oldPhoneMasked: maskPhone_(rowBefore.phone),
      newPhoneMasked: maskPhone_(detailAfter.phone)
    };
    assert.ok(Object.prototype.hasOwnProperty.call(payload, 'oldPhoneMasked'));
    assert.ok(Object.prototype.hasOwnProperty.call(payload, 'newPhoneMasked'));
  });
});
