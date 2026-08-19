/* 雲端小幫手 — 出院診斷跨分頁記憶體中繼
 *
 * ShowXml 另開頁與摘要頁無法直接共享 content script closure，因此由 MV3
 * service worker 暫存單筆等待中的 request。資料不落地、不連外，逾時或
 * 連線中斷立即刪除；只用出院日期與院所代碼配對，不傳送病人識別欄位。
 */
'use strict';

const PORT_NAME = 'nhi-discharge-diagnosis';
const SHOWXML_CONTROL_PORT = 'nhi-showxml-control';
const REQUEST_TTL_MS = 45000;
const pending = new Map();
const showXmlControls = new Set();

function normalizedDate(value) {
  const match = String(value || '').match(/(\d{2,4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  if (!match) return '';
  let year = Number(match[1]);
  if (year < 1911) year += 1911;
  const month = Number(match[2]), day = Number(match[3]);
  if (year < 1911 || month < 1 || month > 12 || day < 1 || day > 31) return '';
  return `${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
}

function facilityCode(value) {
  const matches = String(value || '').match(/\b\d{8,12}\b/g);
  return matches ? matches[matches.length - 1] : '';
}

function removePortRequests(port) {
  for (const [requestId, request] of pending) {
    if (request.port === port) pending.delete(requestId);
  }
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name === SHOWXML_CONTROL_PORT) {
    let senderUrl;
    try { senderUrl = new URL(port.sender && port.sender.url || ''); } catch (error) { return; }
    if (senderUrl.origin !== 'https://medcloud2.nhi.gov.tw' || !/\/ShowXml\/?$/i.test(senderUrl.pathname)) return;
    showXmlControls.add(port);
    port.onDisconnect.addListener(() => showXmlControls.delete(port));
    return;
  }
  if (port.name !== PORT_NAME) return;
  port.onMessage.addListener(message => {
    if (!message || message.type !== 'start' || typeof message.requestId !== 'string') return;
    const sourceTabId = port.sender && port.sender.tab && port.sender.tab.id;
    if (!Number.isInteger(sourceTabId)) return;
    const requestId = message.requestId;
    const expectedDischargeDate = normalizedDate(message.expectedDischargeDate);
    if (!expectedDischargeDate) return;
    pending.set(requestId, {
      port,
      sourceTabId,
      childTabId: null,
      expectedDischargeDate,
      expectedFacilityCode: facilityCode(message.expectedFacilityCode),
      createdAt: Date.now()
    });
    port.postMessage({ type: 'registered', requestId });
    // 已開啟的具名 ShowXml popup 可能只被聚焦、不重新導頁；要求它重新送出
    // 目前欄位，metadata 不符時背景會拒絕，接著原頁 click 再切到正確紀錄。
    for (const control of showXmlControls) {
      try { control.postMessage({ type: 'extract-current' }); } catch (error) { showXmlControls.delete(control); }
    }
    setTimeout(() => {
      const request = pending.get(requestId);
      if (request && request.port === port) pending.delete(requestId);
    }, REQUEST_TTL_MS);
  });
  port.onDisconnect.addListener(() => removePortRequests(port));
});

chrome.tabs.onCreated.addListener(tab => {
  if (!Number.isInteger(tab.id) || !Number.isInteger(tab.openerTabId)) return;
  const now = Date.now();
  const candidates = [...pending.entries()].filter(([, request]) =>
    request.sourceTabId === tab.openerTabId && request.childTabId === null &&
    now - request.createdAt <= REQUEST_TTL_MS
  );
  // 同一來源理論上只會有一筆逐筆等待；若不唯一就不猜，讓該筆安全逾時。
  if (candidates.length === 1) candidates[0][1].childTabId = tab.id;
});

chrome.tabs.onRemoved.addListener(tabId => {
  for (const [requestId, request] of pending) {
    if (request.sourceTabId === tabId || request.childTabId === tabId) pending.delete(requestId);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'showxml-discharge-diagnosis') return;
  let senderUrl;
  try { senderUrl = new URL(sender && sender.url || ''); } catch (error) { return; }
  if (senderUrl.origin !== 'https://medcloud2.nhi.gov.tw' || !/\/ShowXml\/?$/i.test(senderUrl.pathname)) return;

  const payload = message.payload || {};
  const diagnosis = String(payload.diagnosis || '').trim();
  const dischargeDate = normalizedDate(payload.dischargeDate);
  const sourceCode = facilityCode(payload.facilityCode);
  const childTabId = sender && sender.tab && sender.tab.id;
  if (!diagnosis || !dischargeDate) { sendResponse({ accepted: 0 }); return; }

  const now = Date.now();
  for (const [requestId, request] of pending) {
    if (now - request.createdAt > REQUEST_TTL_MS) pending.delete(requestId);
  }
  const metadataMatches = [...pending.entries()].filter(([, request]) =>
    request.expectedDischargeDate === dischargeDate &&
    (!request.expectedFacilityCode || request.expectedFacilityCode === sourceCode)
  );
  const strictMatches = metadataMatches.filter(([, request]) =>
    Number.isInteger(childTabId) && request.childTabId === childTabId
  );
  // 某些健保頁以具名 popup 開啟 ShowXml；Edge 可能不提供 openerTabId，
  // 或先建立中介 popup 而把 request 綁到錯誤 tab。此時只接受唯一的
  // 日期＋院所完全配對；多筆時絕不猜。
  const matches = strictMatches.length === 1
    ? strictMatches
    : metadataMatches.length === 1
      ? metadataMatches
      : [];
  let accepted = 0;
  for (const [requestId, request] of matches) {
    pending.delete(requestId);
    try {
      request.port.postMessage({ type: 'result', requestId, diagnosis });
      accepted += 1;
    } catch (error) { /* 摘要頁已關閉；request 已清除。 */ }
  }
  sendResponse({ accepted });
});
