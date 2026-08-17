import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contentPath = path.join(projectDir, 'extension', 'content.js');
const source = fs.readFileSync(contentPath, 'utf8');
const marker = '})();';
const markerAt = source.lastIndexOf(marker);
assert.notEqual(markerAt, -1, '找不到 content script 結尾');

const instrumented = source.slice(0, markerAt) + `
  globalThis.__formatterTests = {
    medToPasteFormat, labToSimpleList, shortDrug, calendarMonthsAgo, recentRows,
    dedupeAllergyRows, aggregateToPlain
  };
` + source.slice(markerAt);

const document = {
  body: { appendChild() {} },
  getElementById() { return null; },
  querySelectorAll() { return []; },
  createElement() { return {}; },
  addEventListener() {}
};
const sandbox = {
  console,
  document,
  location: { pathname: '/imu/IMUE0008' },
  navigator: {},
  window: { isSecureContext: false },
  setInterval() { return 0; },
  setTimeout() { return 0; },
  MutationObserver: class { observe() {} }
};
vm.runInNewContext(instrumented, sandbox, { filename: contentPath });
const {
  medToPasteFormat, labToSimpleList, shortDrug, calendarMonthsAgo, recentRows,
  dedupeAllergyRows
} = sandbox.__formatterTests;

const roc = raw => {
  const [year, month, day] = raw.split('/').map(Number);
  return new Date(year + 1911, month - 1, day);
};
const dx = { code: 'I10', name: '原發性高血壓' };
const medRow = (dateRaw, src, srcType, atc7, drug, ingr = '', sig = 'QD', days = 28) => ({
  dateRaw, date: roc(dateRaw), src, srcType, srcKey: `${src}|${srcType}`, dx,
  atc7, ingr, drug, sig, days
});

assert.equal(shortDrug('NORVASC TABLETS 5MG'), 'Norvasc 5mg');
assert.equal(shortDrug('CADUET TABLETS 5MG/20MG'), 'Caduet 5mg/20mg');

const medText = medToPasteFormat({ rows: [
  medRow('115/08/10', '甲診所', '門診', 'A001', 'NORVASC TABLETS 5MG', 'Amlodipine'),
  medRow('115/08/10', '甲診所', '門診', 'A002', 'COZAAR TABLETS 50MG', 'Losartan'),
  medRow('115/07/01', '甲診所', '門診', 'A001', 'NORVASC TABLETS 5MG', 'Amlodipine'),
  medRow('115/08/09', '丁藥局', '藥局', 'A003', 'ASPIRIN TABLETS 100MG', 'Aspirin')
] });
assert.equal(medText, [
  '115/08/10 甲診所（I10 原發性高血壓）：Amlodipine QD×28d、Losartan QD×28d',
  '115/08/09 丁藥局（I10 原發性高血壓）：Aspirin QD×28d'
].join('\n'));
assert.ok(!medText.includes('Norvasc') && !medText.includes('Cozaar'), '精簡藥歷不應輸出商品名');
assert.ok(!medText.includes('【醫療院所') && !medText.includes('【藥局'), '精簡藥歷不應依醫院／藥局分段');
assert.ok(!medText.includes('115/07/01'), '重複用藥應只保留最新日期');

const missingIngredientText = medToPasteFormat({ rows: [
  medRow('115/08/08', '甲診所', '門診', 'A004', 'UNKNOWN BRAND TABLETS 10MG')
] });
assert.ok(missingIngredientText.includes('未對應成分'), '成分名稱缺漏時應明確標示');
assert.ok(!missingIngredientText.includes('Unknown Brand'), '成分名稱缺漏時不應退回商品名');

const labRow = (item, result, ref, extra = {}) => ({
  dateRaw: '115/08/03', date: roc('115/08/03'), src: '乙診所', item,
  result, resultRaw: result, ref, unit: extra.unit || '', note: extra.note || ''
});
const labText = labToSimpleList({ rows: [
  labRow('Glucose AC', '126', '[70][99]'),
  labRow('Hemoglobin', '12.1', '[13.5][17.5]'),
  labRow('Urine Protein', '4+', '[Negative][]'),
  labRow('Urine Glucose', 'Negative', '[Negative][]'),
  labRow('Potassium', '4.1', '[3.5][5.1]', { unit: 'mEq/L' }),
  labRow('Potassium', '4.3', '[3.5][5.1]', { unit: 'mEq/L' })
] });
assert.equal(labText, [
  '115/08/03 乙診所',
  '- Glucose AC 126↑',
  '- Hemoglobin 12.1↓',
  '- Urine Protein 4+',
  '- Urine Glucose (-)',
  '- Potassium 4.1 / 4.3'
].join('\n'));

const localDateKey = date => `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
assert.equal(localDateKey(calendarMonthsAgo(new Date(2025, 4, 31), 3)), '2025-2-28');
assert.equal(localDateKey(calendarMonthsAgo(new Date(2024, 4, 31), 3)), '2024-2-29');
const windowed = recentRows([
  { date: new Date(2026, 4, 16), value: 'start' },
  { date: new Date(2026, 4, 15), value: 'old' },
  { date: new Date(2026, 7, 16), value: 'today' },
  { date: new Date(2026, 7, 17), value: 'future' },
  { date: null, value: 'invalid' }
], 3, new Date(2026, 7, 16));
assert.equal(Array.from(windowed.rows, row => row.value).join(','), 'start,today');
assert.equal(windowed.invalidDate.length, 1);
assert.equal(windowed.future.length, 1);
assert.equal(windowed.outsideRange.length, 1);

const allergy = dedupeAllergyRows([
  { code: 'ALG001', drug: 'TEST ALLERGEN', reaction: 'Rash', dateRaw: '115/01/01', date: roc('115/01/01'), src: '甲', note: '' },
  { code: '', drug: 'Test Allergen', reaction: 'Itching', dateRaw: '115/02/01', date: roc('115/02/01'), src: '乙', note: 'note' },
  { code: '-', drug: 'SECOND ALLERGEN', reaction: 'Rash', dateRaw: '115/03/01', date: roc('115/03/01'), src: '甲', note: '' },
  { code: 'N/A', drug: 'THIRD ALLERGEN', reaction: 'Rash', dateRaw: '115/04/01', date: roc('115/04/01'), src: '甲', note: '' }
]);
assert.equal(allergy.length, 3, '缺碼占位不得把不同藥物合併');
assert.equal(allergy.find(row => row.code === 'ALG001').reactions.join(','), 'Rash,Itching');

console.log(JSON.stringify({
  syntax: 'pass', medicationFormatter: 'pass', labFormatter: 'pass',
  calendarMonths: 'pass', allergyDeduplication: 'pass'
}, null, 2));
