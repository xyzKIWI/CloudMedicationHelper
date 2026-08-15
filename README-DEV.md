# 雲端藥歷整理小幫手－開發者 README

## 專案目標

這是 Manifest V3 內容腳本擴充功能，只在 `https://medcloud2.nhi.gov.tw/imu/*` 執行。它讀取使用者目前已開啟的健保雲端表格，於當前分頁記憶體建立整理面板。

## 目錄

- `extension/manifest.json`：擴充功能清單與版本。
- `extension/content.js`：頁面偵測、資料解析、報告讀取、整理與複製。
- `extension/panel.css`：整理面板樣式。
- `test-fixtures/`：不含真實病人資料的合成測試頁。
- `USER-GUIDE.md`：安裝、操作與故障排除。
- `package.ps1`：建立發布資料夾、ZIP 與 SHA-256。

## 主要流程

1. 以表頭文字而非固定欄位辨識用藥（IMUE0008）、檢驗（IMUE0060）與影像病理（IMUE0130）表格。
2. SPA 表格指紋變更時關閉舊面板，降低跨個案殘留。
3. 影像病理以原頁「報告」控件逐筆觸發，偵測健保頁重複使用的報告 DOM。
4. 報告 DOM 可能在外層視窗仍隱藏時更新，因此以內容簽章與醫令名稱核對。
5. 連續重複報告可能不再改寫 DOM；只在醫令、檢驗類別、來源相同，且消除敏感欄位後的報告內容與前一份完全相同時沿用。
6. 單筆報告最多等待 12 秒，失敗後繼續下一筆。

## 隱私不變條件

任何改動都必須維持：

- `manifest.json` 的 `permissions` 為空陣列。
- 不新增 `fetch`、XHR、WebSocket、遠端日誌或自動上傳。
- 不將病人資料寫入 `localStorage`、`sessionStorage`、`chrome.storage`、IndexedDB 或檔案。
- 合成 fixture、測試輸出、截圖與文件不可含真實姓名、身分證、病歷號、院所、日期或報告內文。
- 影像病理匯出僅限五欄：檢驗日期、醫令名稱、報告結果、檢驗類別、來源。
- 複製結果可含醫療資料，UI 必須保留剪貼簿警示。

## 測試

在 PowerShell 執行：

```powershell
node --check .\extension\content.js
node .\test-fixtures\formatters-smoke.mjs

Set-Location C:\Users\User\Projects\web-reader
node .\src\medcloud-extension-smoke.js
node .\src\medcloud-timeout-smoke.js
```

`medcloud-extension-smoke.js` 覆蓋隱藏 DOM、短報告、連續重複報告、五欄匯出與敏感欄位排除。`medcloud-timeout-smoke.js` 確認首筆無回應約 12 秒後會繼續。

實機測試只可輸出筆數、進度與技術錯誤，不得儲存個案識別資料、日期、院所、醫令名稱、截圖或報告內文。

## 版本與發布

1. 更新 `extension/manifest.json` 的版本。
2. 更新 `README.md` 與 `USER-GUIDE.md` 版本說明。
3. 執行全部合成與 Playwright 測試。
4. 執行：

```powershell
.\package.ps1
```

預設在專案上層產生 `CloudMedicationHelper-<version>` 資料夾、ZIP 與 `.sha256.txt`。ZIP 解壓縮後應直接看到 `extension`、使用說明與開發文件；`manifest.json` 必須位於 `extension` 內。
