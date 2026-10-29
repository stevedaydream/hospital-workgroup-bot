# 本機部署手冊：Windows + Tailscale Funnel

Bot 與 Strata 跑在同一台電腦（`steve`）。OCI 因為一直顯示沒有容量可建立，暫緩；`deploy/README.md` 保留給日後搬上雲端時使用。

```
LINE 平台 ──HTTPS──▶ Tailscale Funnel (steve.tailb73635.ts.net:10000)
                         │
                         ▼
                 Bot  127.0.0.1:3000 ─┬─▶ Port Monitor 127.0.0.1:43922（有專案金鑰時，會拉起模型）
                         │             └─▶ Local AI Gateway 127.0.0.1:4000（Port Monitor 沒開時，只用執行中的模型）
                         │                    ├─ local   → Strata  :8080
                         │                    └─ qwen3.6 → Qwen3.6 :8081（Strata 顯存不足時）
                         │                    （都失敗 → Gemini，需有 key）
                         ▼
                 data/hospital.db
```

- Bot 只聽 `127.0.0.1`（`HOST` 可改），對外一律經 Funnel，不暴露在區網。
- 模型依 `LOCAL_AI_MODELS` 的順序嘗試，預設 `local,qwen3.6`。Strata 與 Qwen3.6 共用顯示卡，不會同時執行。
- **Port Monitor 路線**（設了 `PORT_MONITOR_API_KEY`）：模型沒載入時，Port Monitor 依專案優先順序排隊，必要時關閉閒置的模型再啟動它。Strata 放不下時 Port Monitor 立即回失敗，bot 接著要 Qwen3.6，由 Port Monitor 拉起。冷啟動 Strata 約 3 分鐘，逾時預設 600 秒。
- **Gateway 路線**：Port Monitor 沒開（連不上）、沒設金鑰，或所有模型都失敗時使用。gateway 的模型不會自動啟動，只會用已經在跑的那一個；停機的模型約 2 秒就回 `provider_unavailable`。
- 本機模型呼叫都不經過 Tailscale。

## 1. `.env`

已由 `.env.example` 建立，本機專屬的值：

| 變數 | 值 |
|---|---|
| `BASE_URL` | `https://steve.tailb73635.ts.net:10000` |
| `LOCAL_AI_BASE_URL` | `http://127.0.0.1:4000`（Local AI Gateway） |
| `LOCAL_AI_MODELS` | `local,qwen3.6`（兩條路線共用；Port Monitor 的模型 id／別名須與此相同） |
| `PORT_MONITOR_API_KEY` | Port Monitor 桌面 →「取得連線設定」，為本 bot 建立專案金鑰並設定優先順序；留空就不經 Port Monitor |
| `ADMIN_API_KEY` | 已隨機產生 |
| `GEMINI_API_KEY` | 留 `placeholder` = **不備援**：本機模型都失敗時群組會收到錯誤訊息，不會產生假資料。要備援就填真的 key。 |

還要自己填：`LINE_CHANNEL_ACCESS_TOKEN`、`LINE_CHANNEL_SECRET`、`LINE_LOGIN_CHANNEL_ID`、四個 `LIFF_*_ID`（來源見 `deploy/README.md` 第 7 節）。

## 2. Tailscale Funnel（對公網開放）

LINE 的伺服器不在 tailnet 裡，webhook 與 07:30 推播的圖片網址必須能從公網存取，所以要用 **Funnel**（不是 serve）。Funnel 只允許 443、8443、10000 三個埠；443 與 8443 已被其他 tailnet-only 服務占用，因此用 10000。

```powershell
tailscale funnel --bg --https=10000 http://127.0.0.1:3000
tailscale funnel status
# 關閉：tailscale funnel --https=10000 off
```

第一次開 Funnel 時，Tailscale 可能要求到管理後台的 Access controls 允許此節點使用 funnel（`nodeAttrs` 的 `funnel` 屬性），依指令輸出的連結操作即可。

開放後整個 bot 都在公網上，安全性靠：LINE webhook 簽章驗證、LIFF ID Token + `users` 白名單、管理端點的 `ADMIN_API_KEY`。**不要在這台設 `AUTH_DISABLED=true`。**

## 3. LINE Developers Console

把 `deploy/README.md` 第 9 節的網址前綴換成 `https://steve.tailb73635.ts.net:10000`：

- Webhook URL：`https://steve.tailb73635.ts.net:10000/webhook` →「Verify」應回 Success
- LIFF Endpoint：`.../liff/notes`、`.../liff/dispatch`、`.../liff/admin`、`.../liff/calendar`

## 4. 啟動與開機自動執行

手動：

```powershell
cd H:\project\hospital-workgroup-bot
npm start
```

登入時自動啟動（工作排程器，不需系統管理員權限）：

```powershell
schtasks /Create /SC ONLOGON /TN "HospitalBot" /TR "cmd /c cd /d H:\project\hospital-workgroup-bot && npm start >> data\bot.log 2>&1"
```

Local AI Gateway 已有登入自動啟動的排程（「Local AI Gateway」）。有 Port Monitor 時它會自動拉起模型；沒有 Port Monitor 時，Strata 或 Qwen3.6 至少要手動開一個，否則所有辨識都會失敗或走 Gemini。

## 5. 這台電腦的限制

- **睡眠 = 服務中斷**：電源選項把「睡眠」設為「永不」；筆電則要接電、闔蓋不睡眠。
- **07:30 推播**靠 `node-cron`，電腦當下必須開著、bot 必須在跑；錯過不會補發。
- **備份**：`data/hospital.db` 開了 WAL，用 `sqlite3 data\hospital.db ".backup 'backup.db'"`，不要直接複製檔案。

## 驗收清單

- [ ] `curl http://127.0.0.1:3000/api/config` 回傳四個 LIFF ID
- [ ] `curl https://steve.tailb73635.ts.net:10000/api/notes` 從**手機行動網路**（不在 tailnet）回 **401**
- [ ] LINE Console Webhook「Verify」成功
- [ ] 群組上傳一張 case 大表，啟動訊息顯示「本機 AI」，log 出現 `LOCAL local RAW RESPONSE`（或 `qwen3.6`），`data/hospital.db` 出現 `dispatch_date` 為明天的列
