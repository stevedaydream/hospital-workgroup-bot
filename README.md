# 醫院工作群組優化助手 (LINE Bot for Hospital Workgroup)

本專案旨在解決臨床護理站與病房行政群組之痛點，整合 LINE Messaging API、LIFF (LINE Front-end Framework) 與多模態 OCR 辨識，實現：

1. **注意事項筆記共同編輯**：拉起 LIFF 網頁共同修改交班注意事項，避免洗版。
2. **報告排程與 @ 精準提醒**：於排程提醒中精準標記（@）同仁手機。
3. **分配表跨群組自動分流轉發**：上傳個案大表照片，自動辨識人名與科別，隔日清晨 07:30 自動推播至各醫師個人/科別群組。
   - **骨科模式**：多對一自動比對與去重發送。
   - **泌尿科（URO）模式**：一對多防呆，Bot 送出 Flex Message 卡片提示，點開 LIFF 勾選當日負責醫師，確認後寫入排程。

---

## 架構現況

單一 Node.js 行程。目前跑在家中電腦，與 Strata 同機，經 Vercel 中繼 → Tailscale Funnel 對外（見 `deploy/LOCAL.md`）；Oracle Cloud 版本暫緩（`deploy/README.md`）：

| 項目 | 選用 |
|---|---|
| 執行環境 | Node.js 20+ / Hono（`@hono/node-server`） |
| 資料庫 | SQLite 單檔（`data/hospital.db`，WAL） |
| 排程 | `node-cron`，每日 07:30 **Asia/Taipei** |
| AI 辨識 | 本機模型（Strata，顯存不足時改 Qwen3.6），都失敗才備援到 Google Gemini |
| 對外 | Vercel 中繼 → Tailscale Funnel（本機）／DuckDNS + Caddy（OCI，暫緩） |
| API 驗證 | LINE ID Token（LIFF）／`ADMIN_API_KEY`（管理端點） |

> 先前曾短暫遷往 Cloudflare Workers + Supabase。該版本無法運作（Workers 沒有檔案系統可寫入圖片、`public/` 缺少 assets binding 導致 LIFF 頁面無法服務、`node-cron` 不會啟動），已整批回退為單機架構。詳細的決策脈絡見 `docs/`。

## 專案結構

```
hospital-workgroup-bot/
├── public/                 # LIFF 前端靜態網頁
│   ├── css/style.css       # 臨床風格磨砂玻璃 (Glassmorphism) 暗色主題
│   ├── js/api.js           # 自動為 /api/ 請求附加 LINE ID Token
│   ├── images/             # Case 大表圖片（供隔日 LINE Push Image 使用）
│   ├── notes.html          # 注意事項編輯器
│   ├── dispatch.html       # URO 一對多醫師勾選
│   ├── admin.html          # 群組對照與人員管理
│   ├── calendar.html       # 行事曆與晨會輪序
│   └── travel.html         # NP/醫師休假與出國登記（全科共用）
├── src/
│   ├── util/date.js        # 台灣時區日期工具（所有日期都必須經過這裡）
│   ├── db.js               # SQLite 資料層
│   ├── auth.js             # LINE ID Token 驗證
│   ├── ai.js               # 影像辨識入口：先走本機模型，全部失敗才 fallback 到 Gemini
│   ├── local-ai.js         # 本機模型（Port Monitor 拉起，或經 Local AI Gateway：Strata → Qwen3.6）
│   ├── gemini.js           # Gemini provider
│   ├── prompts.js          # 各 provider 共用的 prompt 與結果正規化
│   ├── line.js             # Webhook、簽章校驗、Flex Message
│   ├── scheduler.js        # 07:30 轉發與 @ 提醒
│   └── index.js            # 伺服器進入點與 API 路由
├── deploy/                 # OCI 部署：Caddyfile、systemd unit、手冊
├── scripts/                # 一次性維運腳本
└── data/                   # SQLite 資料庫（不進版控）
```

---

## 本地開發

```bash
npm install
cp .env.example .env     # 至少填 LINE 憑證；本地可設 AUTH_DISABLED=true
npm run dev              # http://localhost:3000
```

- `LOCAL_AI_BASE_URL` 留空時不走本機 AI；本機設定為 Local AI Gateway `http://127.0.0.1:4000`。
- `GEMINI_API_KEY` 留空或填 `placeholder` 時，辨識會走 **MOCK 模式**，不需 API Key 即可調試完整流程。
- `AUTH_DISABLED=true` 會關閉所有 `/api/*` 的驗證，**僅限本機**。伺服器上設這個等於把病房公告與群組 ID 公開。
- 資料庫會在首次啟動時於 `data/hospital.db` 自動建立，預設是空的（不再塞入含病人姓名的假資料）。

### 對外測試（LINE webhook 需要公開 HTTPS）

```bash
ngrok http 3000
```

把產生的網址填入 `.env` 的 `BASE_URL`、LINE Console 的 Webhook URL（後綴 `/webhook`）與四個 LIFF Endpoint。

### 手動觸發排程

```bash
curl "http://localhost:3000/api/test-cron?key=$ADMIN_API_KEY"
```

⚠️ 這會真的對所有已確認的群組推送圖片與提醒。

---

## 正式部署

見 **[`deploy/README.md`](deploy/README.md)** ——包含 OCI 執行個體、**兩層防火牆設定**（Security List 與 VM 內部 iptables，只做一層不會通）、DuckDNS、Caddy、systemd、LINE Console 設定、Supabase 資料搬遷與備份。

---

## 重要慣例

- **日期一律用 `src/util/date.js`。** 不要再寫 `new Date().toISOString().split('T')[0]`——那是 UTC 日期，會在台灣時間早上 8 點換日，正好落在 07:30 發送與 08:00 晨會之間。
- **轉發排程看的是 `dispatch_date`（預定發送日），不是建立日。** 今天上傳的圖，`dispatch_date` 是明天。
- **新增 `/api/*` 端點預設就會被驗證擋住。** 若要開放，必須明確加進 `src/index.js` 的 `OPEN_API_PATHS`。

## NP/醫師休假與出國登記

- LINE 輸入「休假」「休假登記」「誰休假」或原有的「出國」「長假」，可查詢今日與即將開始的登記並開啟表單。
- 休假支援單日、多日及全天／上午／下午；多日登記的時段套用至每日，不同時段請分筆登記。NP／醫師姓名與起訖日期必填，代理人、備註選填。
- 行事曆從同一份登記顯示未來 90 天的每日註記；其他日期若已有行程，也會顯示對應註記。依登記姓名、日期與時段提示報告衝突，未填報告時間時會保守提示；提示不會自動調整輪序。
- 首次以新版啟動時，SQLite 自動增加 `leave_period` 欄位，既有「長假」保留原資料並轉為全天休假。休假註記不會寫入報告排程或觸發報告提醒。
- 執行 `npm test` 驗證日期、半天衝突比對與舊資料轉換。

### 群組休假公告自動登記

管理頁可對指定群組開啟「群組休假訊息自動登記」（預設關閉，且需同時開啟「休假／出國」）。僅處理啟用群組之後送出的完整文字公告，不掃描歷史聊天。例：「王小明11/4-11/8請假老何代看」「NP林小美 2026年11月4日 下午休假，何醫師代理」。

日期含起訖當天，未填時段視為全天，多日登記的時段套用每日；未填年份按訊息發送當天的台灣年份判斷，11／12 月到 1／2 月的日期範圍會跨年。未寫年份且開始日期已過 30 天以上時不猜年份，回覆請補西元年。代理人別名照原文保存，不自行對應通訊錄人員。限開頭明確姓名的單人公告，不推測「我」「主任」等稱呼。

成功會回覆姓名、完整起訖日期、時段、代理人與修改連結，並同步到既有登記頁／行事曆。同一則訊息持久去重；相同登記不重複建立，重疊休假不覆寫。疑問、取消、更正、引述或無法完整辨識的文字不會自動建立或修改資料，可改用登記頁操作。不保存一般聊天或原始訊息全文。

## MedBase 主治醫師基礎名單

管理頁「從醫師名單建立群組對照」可直接載入 MedBase 通訊錄中職稱包含「主治」或為「VS」的人員。只取得姓名、科別、職稱，不取得通訊錄帳密、電話或備註。載入後仍需勾選醫師、指定 LINE 群組並確認匯入；既有對照預設略過，同名不同科會提示確認，避免直接自動綁錯群組。照片辨識保留作為補充入口。

此功能沿用 `MEDBASE_API_URL` 與 `MEDBASE_API_KEY`，需先部署支援 `attendingRoster` 的 MedBase 手機 API，再重啟 bot。未更新或連線失敗時會顯示原因，既有對照與轉發仍照原設定運作。

## LINE 自費查詢與複製

- 在 Bot 私訊輸入「自費 人工關節」或「自費項目：院內碼」，直接回傳 Flex 結果卡片。支援名稱、英文名、院內碼、科別等欄位的多關鍵字搜尋；每頁 5 筆，可按下一頁繼續。
- 每張卡片提供「複製院內碼」「複製名稱＋院內碼」「複製完整資訊」及「MedBase 詳情」。院內碼保留前導零，價格未登錄時明示。複製按鈕需 iOS／Android LINE 14.0 以上，桌機或舊版可使用 MedBase 詳情頁。
- 首次使用須在 MedBase「設定 → LINE 通知」綁定 LINE。每次搜尋／分頁依綁定帳號查目前 MedBase 自費權限；群組中只提示改至私訊，不自動推送或公開結果。通訊錄中已有 MedBase 帳號的人員即使不在排班名單也可綁定。
- 輸入「MedBase 查詢」（或「MedBase」），提供自費品項、通訊錄、處方套組、班表、規則備忘錄的網頁入口。主選單和快速選單也有入口；網頁沿用原登入與權限。
- 後台「MedBase 功能查詢」可逐群組開關。網頁入口只需 `MEDBASE_API_URL`；直接查詢另外需要 `MEDBASE_API_KEY`，MedBase `/api/bot` 的 `items` 操作，以及 GAS 的 `botItems` 唯讀入口（強制服務金鑰、由 GAS 判斷權限）。不傳回備註、廠商或通訊錄私密欄位。
- 部署順序：更新 GAS 既有 Web App 部署 → 部署 MedBase 手機 API → 重啟 bot。用 `npm test` 驗證 Bot，MedBase 用 `npx vitest run mobile/api/_tests/bot.test.ts mobile/api/_tests/bot-items.test.ts` 驗證 API 與 GAS 的實際程式。
