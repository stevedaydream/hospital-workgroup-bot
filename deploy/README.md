# P1 部署手冊：Oracle Cloud Always Free (ARM)

目標機器：OCI Ampere A1，**2 OCPU / 12GB RAM**，Ubuntu 22.04 或 24.04 (aarch64)。
本階段 AI 仍使用 Gemini 雲端；本地 Gemma 4 E4B 屬於 P2。

---

## 1. 建立執行個體

Console → Compute → Instances → Create：

- Shape：**Ampere A1 (VM.Standard.A1.Flex)**，2 OCPU / 12GB
- Image：Canonical Ubuntu 24.04 (aarch64)
- 記得下載 SSH 私鑰

**Always Free 閒置回收**：連續 7 天 CPU、網路、**記憶體**三項 95th percentile 皆低於 20% 才會被回收。P2 讓模型常駐後記憶體會穩定在 40% 以上，不會觸發；但在 P1 階段（模型還沒進來）這台機器是閒置的，**請留意 Oracle 的回收通知信**。

## 2. 開通連接埠（兩層都要做，這是最常卡住的地方）

**第一層 — Console 的 Security List**
VCN → Security Lists → Default Security List → Add Ingress Rules：
Source `0.0.0.0/0`、TCP、Destination Port `80` 與 `443`。

**第二層 — VM 內部的 iptables**
OCI 的 Ubuntu image 自帶一份預設 iptables，只改上面那層**不會通**：

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
sudo iptables -L INPUT -n --line-numbers | head -12   # 確認兩條規則在 REJECT 之前
```

規則順序很重要：必須插在那條 `REJECT all` 之前，否則等於沒設。

## 3. DuckDNS 網域

到 https://www.duckdns.org 用 GitHub/Google 登入，建立一個 subdomain，記下 token。

```bash
mkdir -p ~/duckdns
cat > ~/duckdns/duck.sh <<'EOF'
echo url="https://www.duckdns.org/update?domains=你的子網域&token=你的TOKEN&ip=" | curl -k -o ~/duckdns/duck.log -K -
EOF
chmod 700 ~/duckdns/duck.sh && ~/duckdns/duck.sh && cat ~/duckdns/duck.log   # 應顯示 OK

# 每 5 分鐘回報一次 IP（OCI 的公網 IP 理論上固定，但保險）
(crontab -l 2>/dev/null; echo "*/5 * * * * ~/duckdns/duck.sh >/dev/null 2>&1") | crontab -
```

## 4. 安裝 Node.js 22 與建置工具

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs build-essential python3 sqlite3
node -v
```

`build-essential` 與 `python3` 是給 `better-sqlite3` 的：ARM64 若沒有預編譯檔就會當場編譯。

## 5. 部署程式

```bash
sudo mkdir -p /opt/hospital-workgroup-bot
sudo chown ubuntu:ubuntu /opt/hospital-workgroup-bot
git clone <你的 repo> /opt/hospital-workgroup-bot
cd /opt/hospital-workgroup-bot
npm install --omit=dev

cp .env.example .env
nano .env        # 填入下面第 7 節的所有值
```

## 6. Caddy（HTTPS）

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy

sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile      # 把 your-subdomain.duckdns.org 換成你的
sudo systemctl reload caddy
```

## 7. 環境變數（`.env`）

| 變數 | 從哪裡取得 |
|---|---|
| `BASE_URL` | `https://你的子網域.duckdns.org`（**結尾不要加斜線**） |
| `LINE_CHANNEL_ACCESS_TOKEN` / `LINE_CHANNEL_SECRET` | LINE Developers → Messaging API channel |
| `LINE_LOGIN_CHANNEL_ID` | LINE Developers → **LINE Login** channel 的 Channel ID（LIFF App 掛在這個 channel 底下）。沒填的話所有 `/api/*` 一律拒絕。 |
| `LIFF_*_ID` | 四個 LIFF App 的 ID |
| `ADMIN_API_KEY` | 自己產生：`openssl rand -hex 24` |
| `GEMINI_API_KEY` | Google AI Studio |

## 8. 啟動服務

```bash
sudo cp deploy/hospital-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hospital-bot
sudo systemctl status hospital-bot
journalctl -u hospital-bot -f
```

看到 `[Cron] Scheduler armed: every day at 07:30 Asia/Taipei.` 就代表排程已就位。

## 9. LINE Developers Console 設定

- Messaging API → Webhook URL：`https://你的子網域.duckdns.org/webhook` →「Verify」應回 Success
- Messaging API → Use webhook：**開啟**；Auto-reply messages：**關閉**
- 四個 LIFF App 的 Endpoint URL：
  - `https://你的子網域.duckdns.org/liff/notes`
  - `https://你的子網域.duckdns.org/liff/dispatch`
  - `https://你的子網域.duckdns.org/liff/admin`
  - `https://你的子網域.duckdns.org/liff/calendar`
- LIFF Scopes 需包含 `openid`（ID token 驗證需要）與 `profile`

## 10. 從 Supabase 搬資料（可選，只做一次）

```bash
cd /opt/hospital-workgroup-bot
SUPABASE_URL=https://xxx.supabase.co SUPABASE_ANON_KEY=xxx npm run migrate:supabase
```

會清空並重建 SQLite 的六張表，可重複執行。舊的 `daily_dispatch_cache.created_at` 會依「上傳當天、隔天早上發送」的規則換算成 `dispatch_date`。

## 11. 備份

SQLite 開了 WAL，直接 `cp` 可能拿到不一致的快照，要用 `.backup`：

```bash
mkdir -p ~/backups
(crontab -l 2>/dev/null; echo "0 3 * * * sqlite3 /opt/hospital-workgroup-bot/data/hospital.db \".backup '\$HOME/backups/hospital-\$(date +\\%F).db'\" && find \$HOME/backups -name 'hospital-*.db' -mtime +30 -delete") | crontab -
```

`public/images/` 裡的圖片沒有備份——它們只在隔天早上推播時用得到，過期即無價值。

---

## 驗收清單

- [ ] `curl https://你的子網域.duckdns.org/api/config` 回傳四個 LIFF ID
- [ ] `curl https://你的子網域.duckdns.org/api/notes` 回傳 **401**（沒帶 token 就該被擋）
- [ ] `curl "https://你的子網域.duckdns.org/api/test-cron?key=你的ADMIN_API_KEY"` 回傳 JSON（**注意：這會真的發送訊息**）
- [ ] 手機在 LINE 群組點開「共同編輯注意事項」，LIFF 頁面能正常讀寫
- [ ] `journalctl -u hospital-bot` 沒有 `Unauthorized` 之外的錯誤
- [ ] 群組上傳一張圖片，`public/images/` 出現對應檔案，`data/hospital.db` 出現 `dispatch_date` 為明天的列

---

# P2 附錄：在同一台機器上跑 Gemma 4 E4B

## 1. 編譯 llama.cpp（ARM，純 CPU）

```bash
sudo apt install -y git cmake build-essential libcurl4-openssl-dev
sudo git clone https://github.com/ggml-org/llama.cpp /opt/llama.cpp
cd /opt/llama.cpp
sudo cmake -B build -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=ON
sudo cmake --build build --config Release -j2
```

2 核編譯大約 15～30 分鐘。`-j2` 別往上加，記憶體會不夠。

## 2. 下載模型（**兩個檔案都要**）

Gemma 4 在 llama.cpp 底下看圖需要額外的多模態投影檔（mmproj）；只下載主模型的話它是純文字的，每一張圖都會失敗。

```bash
sudo mkdir -p /opt/models && sudo chown ubuntu:ubuntu /opt/models
cd /opt/models
# 主模型（Q4_K_M，約 5GB）
huggingface-cli download <repo>/gemma-4-E4B-GGUF gemma-4-E4B-Q4_K_M.gguf --local-dir .
# 多模態投影檔（約 1GB）
huggingface-cli download <repo>/gemma-4-E4B-GGUF mmproj-gemma-4-E4B-f16.gguf --local-dir .
```

## 3. 啟動推論服務

```bash
sudo cp deploy/llama-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now llama-server
curl http://127.0.0.1:8080/health     # 應回 {"status":"ok"}
```

載入約需 1～2 分鐘。載入後常駐佔用 6GB 左右 RAM——這同時也是這台機器不會被 Oracle 判定為閒置的原因。

## 4. 實測（**這一步不能跳過**）

單張到底要跑幾分鐘目前只是估算值，而它決定了超時門檻、群組回覆文案、以及圖片解析度上限。

```bash
cd /opt/hospital-workgroup-bot
# 先標註分類答案（20 張，約 5 分鐘）
cat > scripts/labels.json <<'JSON'
{
  "615844065263222972.jpg": "CASE_TABLE",
  "615850548231143544.jpg": "WARD_NOTE",
  "615984761815171379.jpg": "CALENDAR"
}
JSON
npm run benchmark -- --full
```

輸出會給你：分類正確率、單張耗時中位數與最慢值，以及一個建議的 `LOCAL_INFERENCE_TIMEOUT_MS`（最慢值 × 1.5）。把那個值寫回 `.env`。

如果最慢值超過 10 分鐘，代表 2 核撐不住 E4B，此時的選項是升級 PAYG 拿 4 核、或把 `AI_PROVIDER` 改回 `gemini`——**不要改用 E2B**，小一號的模型在這種密集表格上只會更差。

## 5. 切換與回退

```bash
# 只用本地（失敗就明確報錯，不會送雲端）
AI_PROVIDER=local
# 本地優先、失敗自動轉雲端（預設，群組會收到明確告知）
AI_PROVIDER=auto
# 完全退回雲端
AI_PROVIDER=gemini
```

改完 `.env` 後 `sudo systemctl restart hospital-bot` 即可，不需要重啟 llama-server。

---

# P3 附錄：名冊、檔案直解與確認卡片

## 1. 匯入醫師名冊（做完 P1 後的第一件事）

在 LINE 群組開啟「管理設定」→「醫師名冊」分頁，上傳 `.xlsx` 或 `.csv`。格式二選一：

| 姓名 | 科別 |
|---|---|
| 陳鍾沛 | ORTHO |
| 鄧明紘 | URO |

或直接沿用大表底部那種排版（科別代號當欄標題，名字列在底下）。

匯入會先顯示「新增 N／異動 N／移除 N」的差異，確認後才寫入，並自動保留上一版；「歷史版本」可一鍵還原。

**名冊沒匯入的話**：照片辨識仍可運作，但姓名不會做封閉名單校正，檔案直解也無法判斷今日人員。

## 2. 檔案直解

群組裡直接傳 `.xlsx` / `.csv`，Bot 會讀儲存格而不呼叫 AI（一秒完成、零誤判）。`.xls` 與 `.xlsm` 會請對方另存新檔——LINE 常擋含巨集的檔案。

⚠️ 07:30 推播的是「圖片」，所以檔案直解仍需要群組裡先有一張大表照片可轉發；Bot 會自動使用該群組最近上傳的那張。

## 3. 確認卡片

辨識完成後 Bot 會發出確認卡片，列出讀到的人員（含被自動修正的名字、無法對應名冊的名字）與將轉發的群組：

- **✅ 確認排入** → 立刻寫入明早排程
- **✏️ 修改勾選** → 開啟 LIFF 逐一調整群組
- **❌ 全部取消** → 取消這份分配表

`CONFIRM_GRACE_HOURS`（預設 2 小時）內無人處理，系統會自動採用比對通過的結果並在群組留言說明。自動採用的檢查每 10 分鐘執行一次。

---

# P4 附錄：Rich Menu

主選單圖片已內建於 `assets/richmenu/richmenu.png`（2500×1686），六格分兩列：上列是每天都會用到的（交班公告／今日分流／晨會行事曆），下列是偶爾才用的（怎麼上傳／取消轉發／管理設定）。粉紅筆跡標示的兩格代表「今天需要人做決定」。

```bash
# 只有要改文字或版面時才需要重畫（需要有中文字型的電腦，伺服器不用）
npm run richmenu:build

# 上傳並設為所有聊天室的預設選單（在伺服器上跑即可）
npm run richmenu:deploy

npm run richmenu:deploy -- --list     # 列出現有選單
npm run richmenu:deploy -- --clean    # 全部刪除
```

部署腳本會先建立新選單、上傳圖片、設為預設，最後才刪除舊的——中途失敗不會讓群組變成沒有選單。執行前 `.env` 的四個 `LIFF_*_ID` 必須都已填寫，否則選單會連到壞掉的網址。
