# 醫院工作群組優化助手 (LINE Bot for Hospital Workgroup)

本專案旨在解決臨床護理站與病房行政群組之痛點，整合 LINE Messaging API, LIFF (LINE Front-end Framework) 與 Google Gemini 多模態 OCR 辨識，實現：
1. **注意事項筆記共同編輯**：拉起 LIFF 網頁共同修改交班注意事項，避免洗版。
2. **報告排程與 @ 精準提醒**：於排程提醒中精準標記（@）同仁手機。
3. **分配表跨群組自動分流轉發**：上傳個案大表照片，Gemini 自動辨識人名與科別，隔日清晨 07:30 自動推播至各醫師個人/科別群組。
   - **骨科模式**：多對一自動比對與去重發送。
   - **泌尿科（URO）模式**：一對多防呆，Bot 送出 Flex Message 卡片提示，點開 LIFF 勾選當日負責醫師，確認後寫入排程。

---

## 專案結構
```
hospital-workgroup-bot/
├── public/                 # LIFF 前端靜態網頁
│   ├── css/
│   │   └── style.css       # 臨床風格磨砂玻璃 (Glassmorphism) 暗色主題
│   ├── images/             # 上傳的 Case 大表圖片暫存處 (供 LINE Push Image 使用)
│   ├── notes.html          # 注意事項編輯器 LIFF 頁面
│   └── dispatch.html       # URO 一對多醫師勾選 LIFF 頁面
├── src/                    # 後端 Node.js 核心程式碼
│   ├── db.js               # 雙資料庫配接器 (支援 Local JSON 檔與 Cloud Firestore)
│   ├── gemini.js           # Google GenAI SDK (Gemini-2.5-flash OCR 辨識)
│   ├── line.js             # LINE Webhook 監聽、簽章校驗與 Flex Message 產生器
│   ├── scheduler.js        # node-cron 每日 07:30 定時轉發與報告 @ 提醒任務
│   └── index.js            # 伺服器進入點與 Express API 路由
├── .env                    # 環境變數設定檔
├── .env.example            # 環境變數範本檔
├── db.json                 # 本地開發測試用 JSON 資料庫 (自動建立並種入 Mock Data)
└── package.json            # 專案依賴與腳本
```

---

## 安裝與本地啟動

### 1. 安裝套件
確保您已安裝 Node.js (v18+ 推薦)。
在專案根目錄下執行：
```bash
npm install
```

### 2. 設定環境變數
將 `.env.example` 複製一份並命名為 `.env`，並填入您的 Key：
```env
# 伺服器埠號
PORT=3000
# 您的 Ngrok 公網 HTTPS URL (LINE 圖片推送需要公開 HTTPS 連結)
BASE_URL=https://your-subdomain.ngrok-free.app

# LINE Channel 金鑰 (請至 LINE Developers 取得)
LINE_CHANNEL_ACCESS_TOKEN=your_channel_access_token
LINE_CHANNEL_SECRET=your_channel_secret

# LINE LIFF ID (請建立兩個 LIFF App)
LIFF_NOTES_ID=your_liff_notes_app_id
LIFF_DISPATCH_ID=your_liff_dispatch_app_id

# Google Gemini API KEY
GEMINI_API_KEY=your_gemini_api_key
```

> [!TIP]
> **本地開發免設定 Firebase/Gemini 運行法：**
> 1. 本專案預設採用 `DB_TYPE=local`。啟動時會自動建立 `db.json` 並塞入預設的醫師對照表及人員清單。
> 2. 若 `GEMINI_API_KEY` 留空或為 `placeholder`，系統會自動切換為 **MOCK OCR 辨識模式**，上傳圖片後將固定回傳偵測到 `陳鍾沛` 醫師與 `URO` 科別，方便您在未配置 API Key 時快速調試完整流程。

### 3. 本地運行
啟動 Express 伺服器：
```bash
npm run dev
```

---

## 臨床實地調試 (E2E Test) 指引

### 1. 啟動 Ngrok 隧道
LINE 伺服器需要與您的本地後端進行通訊，請啟動 Ngrok 映射 3000 埠：
```bash
ngrok http 3000
```
將 Ngrok 產生的 `https://xxxx.ngrok-free.app` 複製：
- 填入 `.env` 的 `BASE_URL`。
- 填入 LINE Developers Console 的 **Webhook URL** 欄位（後綴加上 `/webhook`），例如：`https://xxxx.ngrok-free.app/webhook`。
- 將 LIFF Apps 的 Endpoint URL 分別設定為：
  - Notes LIFF: `https://xxxx.ngrok-free.app/liff/notes`
  - Dispatch LIFF: `https://xxxx.ngrok-free.app/liff/dispatch`

### 2. 人員與科室對照模擬 (db.json)
本地測試資料庫 `db.json` 會內建以下測試資料：
- **陳鍾沛** ➔ 綁定至 `大樹骨群` (`G_ortho_group`, `DIRECT` 姓名直對模式)。
- **URO (泌尿科)** ➔ 綁定 `王彥傑醫師群` (`G_uro_wang_yj`) 與 `王世峰醫師群` (`G_uro_wang_sf`) (`FLEXIBLE` 模糊科別一對多模式)。

### 3. 測試流程
1. **加入群組**：邀請 Bot 加入測試 LINE 群組，Bot 會自動發送**主選單 Flex Message**。
2. **筆記編輯**：點擊「📝 共同編輯注意事項」會拉起 LIFF 網頁，修改儲存後可關閉網頁。
3. **上傳分配表**：在群組中上傳一張圖片（Case 分配表）。
   - 系統自動解析（若為 Mock 模式會模擬辨識出「陳鍾沛」與「URO」）。
   - 骨科部分：自動將大樹骨群加入明早轉發清單。
   - 泌尿科部分：Bot 會在群組回覆一個 **互動卡片「⚠️ 偵測到今日有 URO 個案」**。
4. **手動勾選 URO 負責人**：
   - 點擊卡片中的「設定今日 URO 負責醫師」按鈕拉起 LIFF。
   - 網頁上會展示該科別所有對應的群組（王彥傑群、王世峰群），勾選今日有 Case 的醫師（例如只勾選王彥傑群），點擊儲存。
5. **手動觸發排程發送 (免等到 07:30)**：
   - 為了方便開發者，後端設計了測試端點。在瀏覽器開啟：`http://localhost:3000/api/test-cron`
   - 系統會立刻執行發送任務：大樹骨群與您剛才勾選的王彥傑群，都將收到當天您上傳的分配表圖片！同時，陳鍾沛醫師也會在群組內收到帶有精準 **@Mentions 高亮**的晨會報告提醒。
