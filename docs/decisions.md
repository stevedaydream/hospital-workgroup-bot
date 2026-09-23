# 架構決策紀錄（2026-09）

本檔記錄「改用本機小模型」這輪重構的決策與理由，避免日後重新推導。

## 背景

前一版遷移到 Cloudflare Workers + Supabase，但該版本無法實際運作：

- `line.js` 用 `fs.writeFile` 把圖片寫到 `public/images/`，Workers 沒有檔案系統
- `wrangler.toml` 沒有 `[assets]` binding，四個 LIFF 頁面在 Workers 上無法被服務
- `node-cron` 不會在 Workers 啟動；`initializeScheduler()` 又被 `NODE_ENV !== 'production'` 擋住
- Hono 的 `c.executionCtx` 在 Node 環境會直接拋錯

## 決策

| # | 主題 | 結論 | 關鍵理由 |
|---|---|---|---|
| 1 | 部署形態 | OCI Always Free ARM 單機 | 可用性比推論位置重要；順帶修掉 Workers 的結構性問題 |
| 4 | 帳號 | 維持 Always Free（2 OCPU / 12GB） | 未升級 PAYG，須留意閒置回收 |
| 5 | 模型 | Gemma 4 E4B（Q4_K_M）常駐 | 辨識錯誤會導致發錯群組，錯誤成本不對稱，不用準確度換速度 |
| 6 | 辨識管線 | 兩階段（分類 → 專用抽取）+ GBNF 文法 | 本地推論可在採樣層禁止非法 token，JSON 解析失敗歸零 |
| 7 | 多圖 | Map-Reduce（逐張視覺 → 純文字整併） | 語意去重不需要模型同時看多張圖；RAM 峰值變常數 |
| 8·9 | 雲端備援 | 自動 fallback 到 Gemini，並在群組**明示**照片已上傳 | 保留自動化，但讓資料外流可稽核 |
| 10 | 分配表入口 | 支援 xlsx/csv/pdf 直解，照片 OCR 降為備援 | 大表本來就是結構化資料，不該從像素猜回來 |
| 11 | 守門 | 封閉名單模糊比對 + 確認卡片（2 小時無人確認則自動採用） | 小模型最危險的失效是「很有把握地讀錯一個字」，fallback 擋不住 |
| 12 | 資料庫 | SQLite 單檔 | 資料量僅數百列；同時消除 Supabase 專案暫停的風險 |
| 13 | API 驗證 | LINE ID Token + `users` 白名單；管理端點用 `ADMIN_API_KEY` | 資料庫含病人床號姓名，公網 IP 上無驗證不可接受 |
| 14 | 日期 | 新增 `dispatch_date` + `util/date.js` | 舊版靠 UTC 與 UTC+8 的差值巧合運作，修時區反而會弄壞功能 |
| 15 | 對外 | DuckDNS + Caddy（現階段免費方案） | 無可用網域；已知代價是日後換網址要搬 6 個設定 |
| 16·17 | 資料結構 | 抽取改 `assignments:[{doctor, department}]`；新增 `doctors` 主檔 | 大表下半部是科別總名冊，平行陣列會把沒 case 的人也抽進來，造成系統性誤發 |
| 18 | 驗收 | 輕量：20 張標分類 + 量測耗時 | 準確度風險已被架構吸收，真正未知的是速度與分類穩定度 |
| 19 | 交付 | P1 搬遷修復 → P2 換 AI 引擎 → P3 產品功能 | 每階段結束都可上線；本地模型變成可隨時放棄的升級 |

## 已知風險

- **E4B 在 2 顆 ARM 核心上的實際速度未經實測**，估計單圖 2～4 分鐘。若實測遠慢於此，P2 的結論會是維持 Gemini。
- **閒置回收**靠 P2 之後模型常駐記憶體（>20%）規避；P1 階段機器閒置，有被回收的可能。
- **DuckDNS 是第三方免費服務**，停止服務即需緊急搬遷。
- `.xlsm` 可能被 LINE 擋，檔案直解需請同仁另存 `.xlsx` / `.csv`。

## 階段狀態

- **P1 已完成**：單機化、SQLite、時區與 `dispatch_date`、API 驗證、部署檔。
- **P2 已完成**：provider 抽象（local / gemini / mock）、兩階段管線 + GBNF、map-reduce 多圖、序列化佇列、影像前處理、自動 fallback 與群組明示、`scripts/benchmark.mjs`。
- **P3 已完成**：`doctors` 主檔與匯入預覽／還原、xlsx/csv 直解、封閉名單比對、確認卡片與逾時自動採用。
- **P4 已完成**：病房表單設計系統（4 個 LIFF 頁面 + Flex 卡片）、Rich Menu 圖片與部署腳本。

**尚未驗證的部分**：所有程式碼都只在本機以 mock 引擎與模擬資料測過。真實模型的速度與準確度、以及 LINE 端的實際行為（webhook、postback、rich menu、LIFF 登入），都要等 OCI 機器開起來才能確認。
