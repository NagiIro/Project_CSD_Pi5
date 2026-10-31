# 問答挑戰 (Quiz Game)

限時 3 分鐘嘅 A/B/C 鍵盤問答遊戲，為 Raspberry Pi 5 kiosk 模式而設。

## 玩法

- 遊戲會由問題池（預設 20 條）**隨機抽 10 條**
- 用鍵盤 **A / B / C** 作答（滑鼠點擊亦得，方便測試）
- **答錯任何一題，即由第 1 題重新開始**（選項會重新洗牌）
- 3 分鐘限時內答啱晒 10 條 = **任務成功**
- 成功後會觸發一個 HTTP request（URL 喺管理介面設定），15 秒後自動返回開始畫面
- 時間到 = 任務失敗，按任意 A/B/C 返回開始畫面

## 本機 / Docker 運行

```bash
docker compose up --build
```

- 遊戲：http://localhost:3000
- 問題管理：http://localhost:3000/admin.html

唔用 Docker 都得（需要 Node.js 18+）：

```bash
npm install
npm start
```

## 管理問題同答案

開 http://localhost:3000/admin.html ：

- 新增 / 修改 / 刪除問題
- 每條問題 3 個選項，點選圓圈設定正確答案（綠色為正確）
- 改完撳「儲存全部」
- 問題存放喺 `data/questions.json`，亦可以直接手改呢個 file

## 設定成功觸發嘅 HTTP Request

喺管理介面嘅「成功觸發設定」入面貼上你條 link，撳「儲存」，可以用「測試觸發」驗證。
觸發係由**伺服器端**發出（HTTP GET），避免 CORS 問題。設定存放喺 `data/config.json`。

## 部署去 Raspberry Pi 5

1. 將成個 folder copy 去 Pi 5（或者用 git clone）
2. 喺 Pi 5 行：
   ```bash
   docker compose up --build -d
   ```
   （`node:20-alpine` 支援 ARM64，Pi 5 直接 build 到）
3. 開機自動全螢幕顯示（kiosk 模式），喺 Pi 嘅 `~/.config/autostart/kiosk.desktop` 加：
   ```ini
   [Desktop Entry]
   Type=Application
   Name=Quiz Kiosk
   Exec=chromium-browser --kiosk --incognito http://localhost:3000
   ```

## 檔案結構

```
├── server.js            # Express 後端 + API
├── data/
│   ├── questions.json   # 問題庫（admin 介面會改呢個）
│   └── config.json      # Webhook URL 設定
├── public/
│   ├── index.html       # 遊戲畫面
│   ├── admin.html       # 問題管理介面
│   ├── css/
│   └── js/
├── Dockerfile
└── docker-compose.yml
```
