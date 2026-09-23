# 醫院工作群組優化助手 (LINE Bot for Hospital Workgroup)

本專案旨在解決臨床護理站與病房行政群組之痛點，整合 LINE Messaging API、LIFF (LINE Front-end Framework) 與多模態 OCR 辨識，實現：

1. **注意事項筆記共同編輯**：拉起 LIFF 網頁共同修改交班注意事項，避免洗版。
2. **報告排程與 @ 精準提醒**：於排程提醒中精準標記（@）同仁手機。
3. **分配表跨群組自動分流轉發**：上傳個案大表照片，自動辨識人名與科別，隔日清晨 07:30 自動推播至各醫師個人/科別群組。
   - **骨科模式**：多對一自動比對與去重發送。
   - **泌尿科（URO）模式**：一對多防呆，Bot 送出 Flex Message 卡片提示，點開 LIFF 勾選當日負責醫師，確認後寫入排程。

---

## 架構現況

單一 Node.js 行程，部署在 Oracle Cloud Always Free 的 ARM 機器上：

| 項目 | 選用 |
|---|---|
| 執行環境 | Node.js 20+ / Hono（`@hono/node-server`） |
| 資料庫 | SQLite 單檔（`data/hospital.db`，WAL） |
| 排程 | `node-cron`，每日 07:30 **Asia/Taipei** |
| AI 辨識 | 本機 llama.cpp + Gemma 4 E4B（視覺），Gemini 為自動備援 |
| 對外 | DuckDNS + Caddy（Let's Encrypt） |
| API 驗證 | LINE ID Token（LIFF）／`ADMIN_API_KEY`（管理端點） |

> 先前曾短暫遷往 Cloudflare Workers + Supabase。該版本無法運作（Workers 沒有檔案系統可寫入圖片、`public/` 缺少 assets binding 導致 LIFF 頁面無法服務、`node-cron` 不會啟動），已整批回退為單機架構。詳細的決策脈絡見 `docs/`。

## 專案結構

```
hospital-workgroup-bot/
├── public/                 # LIFF 前端靜態網頁
│   ├── css/style.css       # 「病房表單」設計系統（紙墨格線＋筆跡標記，含深色模式）
│   ├── js/api.js           # 自動為 /api/ 請求附加 LINE ID Token
│   ├── images/             # Case 大表圖片（供隔日 LINE Push Image 使用）
│   ├── notes.html          # 注意事項編輯器
│   ├── dispatch.html       # URO 一對多醫師勾選
│   ├── admin.html          # 群組對照與人員管理
│   └── calendar.html       # 行事曆與晨會輪序
├── src/
│   ├── ai/
│   │   ├── index.js        # 兩階段管線、map-reduce 多圖、雲端 fallback
│   │   ├── local.js        # llama-server（Gemma 4 E4B + mmproj）
│   │   ├── gemini.js       # 雲端備援
│   │   ├── mock.js         # 無模型時的離線替身
│   │   ├── prompts.js      # 分類／抽取／整併各自的短提示詞
│   │   ├── schemas.js      # JSON Schema（會被編成 GBNF 文法）
│   │   └── queue.js        # 全域序列化推論佇列
│   ├── parsers/workbook.js # xlsx／csv 直解（名冊與大表）
│   ├── util/date.js        # 台灣時區日期工具（所有日期都必須經過這裡）
│   ├── util/image.js       # 推論前的影像前處理
│   ├── roster.js           # 封閉名單姓名比對與分流提案
│   ├── db.js               # SQLite 資料層
│   ├── auth.js             # LINE ID Token 驗證
│   ├── line.js             # Webhook、簽章校驗、Flex Message、確認卡片
│   ├── scheduler.js        # 07:30 轉發、@ 提醒、逾時自動採用
│   └── index.js            # 伺服器進入點與 API 路由
├── assets/richmenu/        # Rich Menu 圖片（已產生，可直接上傳）
├── deploy/                 # OCI 部署：Caddyfile、systemd units、手冊
├── scripts/                # 維運腳本：名冊搬遷、模型實測、Rich Menu
└── data/                   # SQLite 資料庫（不進版控）
```

---

## 本地開發

```bash
npm install
cp .env.example .env     # 至少填 LINE 憑證；本地可設 AUTH_DISABLED=true
npm run dev              # http://localhost:3000
```

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

## 辨識流程

1. 群組收到**檔案**（`.xlsx` / `.csv`）→ 直接讀儲存格，不呼叫 AI。
2. 群組收到**照片** → 10 秒連拍視窗 → 影像前處理（保留彩色、長邊 1536）→
   - 單張：先分類（CASE_TABLE / WARD_NOTE / CALENDAR / UNKNOWN），再依類型用專用提示詞抽取
   - 多張：逐張摘要後，用純文字合併成一則公告（避免多圖同時進 context）
3. 輸出經 GBNF 文法約束為合法 JSON，再由程式驗證一次（llama-server 文法編譯失敗時會 fail open）。
4. 姓名以 `doctors` 名冊做封閉集合比對（完全相同／別名／編輯距離 1，三字以上才允許模糊）。
5. 產生確認卡片；`CONFIRM_GRACE_HOURS` 內無人確認則自動採用並在群組說明。
6. 本地推論失敗、逾時，或 CASE_TABLE/CALENDAR 抽出空結果 → 自動改用 Gemini，**並在群組明示照片已上傳 Google**。

## 設計語彙

介面沿用這個工具實際處理的素材：印刷的臨床表單。格線而非陰影、系統明體的表頭、等寬字的代號與時間。**粉紅筆跡專用於「機器判讀或尚未有人確認」的內容**——印刷代表已成立，筆跡代表還需要有人負責。見 `public/css/style.css` 開頭的說明。

## 重要慣例

- **日期一律用 `src/util/date.js`。** 不要再寫 `new Date().toISOString().split('T')[0]`——那是 UTC 日期，會在台灣時間早上 8 點換日，正好落在 07:30 發送與 08:00 晨會之間。
- **轉發排程看的是 `dispatch_date`（預定發送日），不是建立日。** 今天上傳的圖，`dispatch_date` 是明天。
- **新增 `/api/*` 端點預設就會被驗證擋住。** 若要開放，必須明確加進 `src/index.js` 的 `OPEN_API_PATHS`。
- **所有推論都要走 `runExclusive()`。** 2 核機器上並行推論不會比較快，只會一起 OOM。
- **粉紅色（`--pen`）不是裝飾色。** 只能用在「機器產生、尚未經人確認」的內容上，否則這個訊號會失效。
