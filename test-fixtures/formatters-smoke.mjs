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
  globalThis.__formatterTests = { medToPasteFormat, labToSimpleList, shortDrug };
` + source.slice(markerAt);

const document = {
  body: { appendChild() {} },
  getElementById() { return null; },
  querySelectorAll() { return []; },
  createElement() { return {}; }
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
const { medToPasteFormat, labToSimpleList, shortDrug } = sandbox.__formatterTests;

const roc = raw => {
  const [year, month, day] = raw.split('/').map(Number);
  return new Date(year + 1911, month - 1, day);
};
const dx = { code: 'I10', name: '原發性高血壓' };
const medRow = (dateRaw, src, srcType, atc7, drug, sig = 'QD', days = 28) => ({
  dateRaw, date: roc(dateRaw), src, srcType, srcKey: `${src}|${srcType}`, dx,
  atc7, ingr: '', drug, sig, days
});

assert.equal(shortDrug('NORVASC TABLETS 5MG'), 'Norvasc 5mg');
assert.equal(shortDrug('CADUET TABLETS 5MG/20MG'), 'Caduet 5mg/20mg');

const medText = medToPasteFormat({ rows: [
  medRow('115/08/10', '甲診所', '門診', 'A001', 'NORVASC TABLETS 5MG'),
  medRow('115/08/10', '甲診所', '門診', 'A002', 'COZAAR TABLETS 50MG'),
  medRow('115/07/01', '甲診所', '門診', 'A001', 'NORVASC TABLETS 5MG'),
  medRow('115/08/09', '丁藥局', '藥局', 'A003', 'ASPIRIN TABLETS 100MG')
] });
assert.equal(medText, [
  '115/08/10 甲診所（I10 原發性高血壓）：Norvasc 5mg QD×28d、Cozaar 50mg QD×28d',
  '115/08/09 丁藥局（I10 原發性高血壓）：Aspirin 100mg QD×28d'
].join('\n'));
assert.ok(!medText.includes('【醫療院所') && !medText.includes('【藥局'), '精簡藥歷不應依醫院／藥局分段');
assert.ok(!medText.includes('115/07/01'), '重複用藥應只保留最新日期');

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

console.log(JSON.stringify({ syntax: 'pass', medicationFormatter: 'pass', labFormatter: 'pass' }, null, 2));
