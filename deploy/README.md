# P1 部署手冊：Oracle Cloud Always Free (ARM)

目標機器：OCI Ampere A1，**2 OCPU / 12GB RAM**，Ubuntu 22.04 或 24.04 (aarch64)。
AI 辨識先走家中電腦的 Strata（經 Tailscale，見第 12 節），連不上時自動備援到 Gemini 雲端。

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
| `STRATA_BASE_URL` | 家中電腦的 Tailscale serve 網址，例如 `https://steve.tailb73635.ts.net:8444`（見第 12 節） |
| `GEMINI_API_KEY` | Google AI Studio（Strata 連不上時的備援） |

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

## 12. Tailscale 連到家中電腦的 Strata

Strata 只聽 `127.0.0.1:8080`，不對外開埠；伺服器加入同一個 tailnet 後經 `tailscale serve` 存取。

**家中電腦（已設定）**

```powershell
tailscale serve --bg --https=8444 http://127.0.0.1:8080   # 只在 tailnet 內可見，不是 funnel
tailscale serve status
# 取消：tailscale serve --https=8444 off
```

Strata 有 DNS rebinding 防護，會擋掉非 localhost 的 Host。`C:\AI\providers\Strata\strata-iq3_xxs.json` 已加入：

```json
"allowed_hosts": ["steve.tailb73635.ts.net", "steve.tailb73635.ts.net:8444"]
```

改完要重啟 Strata 才生效（`Stop-Uncensored.cmd` → `Start-Uncensored.cmd`）。換模型或重裝後若設定檔被覆寫，Tailscale 網址會回 403 `forbidden`，補回這行即可。

**OCI 伺服器**

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --hostname=hospital-bot      # 依提示用同一個帳號登入
curl https://steve.tailb73635.ts.net:8444/health   # 應回 {"status": "ok", ... "service": "strata"}
```

建議到 Tailscale 管理後台把 `hospital-bot` 這台設成 **Disable key expiry**，否則 180 天後金鑰過期，會無聲地一直走 Gemini 備援。

**行為**
- 電腦關機、Strata 沒開、逾時（`STRATA_TIMEOUT_MS`，預設 240 秒）都會自動改走 Gemini，並在群組發一則「照片已改上傳至雲端」的提示。
- 實測單張 case 大表約 20～30 秒。

---

## 驗收清單

- [ ] `curl https://你的子網域.duckdns.org/api/config` 回傳四個 LIFF ID
- [ ] `curl https://你的子網域.duckdns.org/api/notes` 回傳 **401**（沒帶 token 就該被擋）
- [ ] `curl "https://你的子網域.duckdns.org/api/test-cron?key=你的ADMIN_API_KEY"` 回傳 JSON（**注意：這會真的發送訊息**）
- [ ] 手機在 LINE 群組點開「共同編輯注意事項」，LIFF 頁面能正常讀寫
- [ ] 伺服器上 `curl https://steve.tailb73635.ts.net:8444/health` 回傳 `"service": "strata"`
- [ ] `journalctl -u hospital-bot` 沒有 `Unauthorized` 之外的錯誤
- [ ] 群組上傳一張圖片，`public/images/` 出現對應檔案，`data/hospital.db` 出現 `dispatch_date` 為明天的列
