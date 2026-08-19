import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionDir = path.join(projectDir, 'extension');
const require = createRequire(path.join(projectDir, '..', 'web-reader', 'package.json'));
const { chromium } = require('playwright');

class Hook {
  listeners = [];
  addListener(listener) { this.listeners.push(listener); }
  emit(...args) { return this.listeners.map(listener => listener(...args)); }
}

function createPort(tabId, name = 'nhi-discharge-diagnosis', url = '') {
  const messages = [];
  return {
    name, sender: { tab: { id: tabId }, url }, messages,
    onMessage: new Hook(), onDisconnect: new Hook(),
    postMessage(message) { messages.push(message); }
  };
}

const runtime = { onConnect: new Hook(), onMessage: new Hook() };
const tabs = { onCreated: new Hook(), onRemoved: new Hook() };
const backgroundSource = fs.readFileSync(path.join(extensionDir, 'background.js'), 'utf8');
const backgroundSetTimeout = (callback, delay) => {
  const timer = setTimeout(callback, delay);
  timer.unref();
  return timer;
};
vm.runInNewContext(backgroundSource, {
  chrome: { runtime, tabs }, URL, Date, setTimeout: backgroundSetTimeout, clearTimeout
}, { filename: 'background.js' });
const plain = value => JSON.parse(JSON.stringify(value));

const existingShowXml = createPort(
  31, 'nhi-showxml-control', 'https://medcloud2.nhi.gov.tw/imu/IMUE1000/ShowXml'
);
runtime.onConnect.emit(existingShowXml);

const parent = createPort(41);
runtime.onConnect.emit(parent);
parent.onMessage.emit({
  type: 'start', requestId: 'request-matched',
  expectedDischargeDate: '115/06/03', expectedFacilityCode: '0000000001'
});
assert.deepEqual(plain(parent.messages), [{ type: 'registered', requestId: 'request-matched' }]);
assert.deepEqual(plain(existingShowXml.messages), [{ type: 'extract-current' }]);
tabs.onCreated.emit({ id: 42, openerTabId: 41 });
let response;
runtime.onMessage.emit({
  type: 'showxml-discharge-diagnosis',
  payload: {
    diagnosis: 'SYNTHETIC_BROKER_DIAGNOSIS', dischargeDate: '2026-06-03', facilityCode: '0000000001'
  }
}, { url: 'https://medcloud2.nhi.gov.tw/imu/IMUE1000/ShowXml', tab: { id: 42 } }, value => { response = value; });
assert.deepEqual(plain(response), { accepted: 1 });
assert.deepEqual(plain(parent.messages.at(-1)), {
  type: 'result', requestId: 'request-matched', diagnosis: 'SYNTHETIC_BROKER_DIAGNOSIS'
});

const staleChildParent = createPort(51);
runtime.onConnect.emit(staleChildParent);
staleChildParent.onMessage.emit({
  type: 'start', requestId: 'request-stale-child',
  expectedDischargeDate: '115/07/03', expectedFacilityCode: '0000000002'
});
tabs.onCreated.emit({ id: 52, openerTabId: 51 });
response = undefined;
runtime.onMessage.emit({
  type: 'showxml-discharge-diagnosis',
  payload: {
    diagnosis: 'SYNTHETIC_STALE_CHILD_DIAGNOSIS', dischargeDate: '2026-07-03', facilityCode: '0000000002'
  }
}, { url: 'https://medcloud2.nhi.gov.tw/imu/IMUE1000/ShowXml', tab: { id: 999 } }, value => { response = value; });
assert.deepEqual(plain(response), { accepted: 1 });
assert.deepEqual(plain(staleChildParent.messages.at(-1)), {
  type: 'result', requestId: 'request-stale-child', diagnosis: 'SYNTHETIC_STALE_CHILD_DIAGNOSIS'
});
tabs.onRemoved.emit(52);

const noOpenerParent = createPort(61);
runtime.onConnect.emit(noOpenerParent);
noOpenerParent.onMessage.emit({
  type: 'start', requestId: 'request-no-opener',
  expectedDischargeDate: '115/08/03', expectedFacilityCode: '0000000003'
});
response = undefined;
runtime.onMessage.emit({
  type: 'showxml-discharge-diagnosis',
  payload: {
    diagnosis: 'SYNTHETIC_NO_OPENER_DIAGNOSIS', dischargeDate: '2026-08-03', facilityCode: '0000000003'
  }
}, { url: 'https://medcloud2.nhi.gov.tw/imu/IMUE1000/ShowXml', tab: { id: 62 } }, value => { response = value; });
assert.deepEqual(plain(response), { accepted: 1 });
assert.deepEqual(plain(noOpenerParent.messages.at(-1)), {
  type: 'result', requestId: 'request-no-opener', diagnosis: 'SYNTHETIC_NO_OPENER_DIAGNOSIS'
});

const metadataMismatchParent = createPort(71);
runtime.onConnect.emit(metadataMismatchParent);
metadataMismatchParent.onMessage.emit({
  type: 'start', requestId: 'request-metadata-mismatch',
  expectedDischargeDate: '115/09/03', expectedFacilityCode: '0000000004'
});
response = undefined;
runtime.onMessage.emit({
  type: 'showxml-discharge-diagnosis',
  payload: {
    diagnosis: 'MUST_NOT_ROUTE', dischargeDate: '2026-09-03', facilityCode: '0000000099'
  }
}, { url: 'https://medcloud2.nhi.gov.tw/imu/IMUE1000/ShowXml', tab: { id: 72 } }, value => { response = value; });
assert.deepEqual(plain(response), { accepted: 0 });
assert.equal(metadataMismatchParent.messages.some(message => message.type === 'result'), false);
metadataMismatchParent.onDisconnect.emit();

const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
try {
  const context = await browser.newContext();
  const showXmlHtml = fs.readFileSync(path.join(projectDir, 'test-fixtures', 'synthetic_showxml.html'), 'utf8');
  await context.route('https://medcloud2.nhi.gov.tw/imu/IMUE1000/ShowXml', route => route.fulfill({
    status: 200, contentType: 'text/html; charset=utf-8', body: showXmlHtml
  }));
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.__relayMessage = null;
    window.__relayCount = 0;
    Object.defineProperty(window, 'chrome', { configurable: true, value: {
      runtime: {
        lastError: null,
        sendMessage(message, callback) {
          window.__relayMessage = message;
          window.__relayCount += 1;
          callback({ accepted: window.__relayCount >= 2 ? 1 : 0 });
        }
      }
    } });
  });
  await page.goto('https://medcloud2.nhi.gov.tw/imu/IMUE1000/ShowXml');
  await page.evaluate(() => {
    const normalize = value => String(value || '').replace(/[\s：:]/g, '');
    const labelCell = [...document.querySelectorAll('th,td')]
      .find(cell => normalize(cell.textContent) === '出院診斷');
    const valueCell = labelCell?.nextElementSibling;
    const delayedValue = valueCell?.innerHTML || '';
    if (valueCell) {
      valueCell.textContent = '';
      setTimeout(() => { valueCell.innerHTML = delayedValue; }, 600);
    }
  });
  await page.addScriptTag({ path: path.join(extensionDir, 'content.js') });
  await page.waitForFunction(() => window.__relayCount >= 2);
  const message = await page.evaluate(() => window.__relayMessage);
  assert.deepEqual(message, {
    type: 'showxml-discharge-diagnosis',
    payload: {
      diagnosis: 'SYNTHETIC_SHOWXML_DIAGNOSIS_PRIMARY\nSYNTHETIC_SHOWXML_DIAGNOSIS_SECONDARY',
      dischargeDate: '2026-06-03', facilityCode: '0000000001'
    }
  });
  assert.equal(await page.locator('#nhi-helper-btn').count(), 0, 'ShowXml 不應注入整理按鈕');
  assert.equal(await page.evaluate(() => window.__relayCount), 2, '背景拒絕第一次時應自動重送');
  const serialized = JSON.stringify(message);
  for (const excluded of [
    'EXCLUDED_SHOWXML_PATIENT', 'EXCLUDED_SHOWXML_SEX', 'EXCLUDED_SHOWXML_CHART',
    'EXCLUDED_SHOWXML_ADMISSION_DIAGNOSIS', 'EXCLUDED_SHOWXML_COMPLAINT',
    'EXCLUDED_SHOWXML_LAB', 'EXCLUDED_SHOWXML_SIGNER'
  ]) assert.equal(serialized.includes(excluded), false, `不得傳送 ${excluded}`);
} finally {
  await browser.close();
}

console.log(JSON.stringify({
  showXmlInlineAndAdjacentFields: 'pass', inMemoryBrokerRouting: 'pass',
  missingOpenerFallback: 'pass', stalePopupBindingFallback: 'pass',
  existingPopupRefresh: 'pass', delayedFirstLoadRetry: 'pass', metadataMismatchRejected: 'pass'
}, null, 2));
