# PI5 播放端（pi5-player）

CCTV 遊戲的第二屏幕播放服務：跑在 Raspberry Pi 5 上，PI5 的 HDMI 接第二屏幕。
平板（遊戲）透過 HTTP 指令控制切換影片 —— 不依賴 Android 的雙屏能力。

## 行為

- 預設循環播放**影片 A**
- 收到 `/api/play?video=B` → 切換並固定循環播放**影片 B**
- 收到 `/api/play?video=A` → 切回 A
- 遊戲每 1 秒發心跳（`POST /api/heartbeat`）；心跳斷超過 `heartbeatTimeoutMs`（預設 6 秒，遊戲關閉/平板斷線）→ 自動切回 A

## 在 PI5 上跑（Docker，與 QNA 同模式）

```bash
cd pi5-player
docker compose up --build -d
```

零依賴，不用 Docker 也行（Node 18+）：`node server.js`

## 播放頁（kiosk）

Chromium 全屏開 `http://localhost:3100/`。開機自動（`~/.config/autostart/kiosk.desktop`）：

```ini
[Desktop Entry]
Type=Application
Name=CCTV Screen2
Exec=chromium-browser --kiosk --incognito http://localhost:3100/
```

## API

| 端點 | 說明 |
|---|---|
| `GET /` | 播放頁 |
| `GET /api/state` | 目前狀態 + 心跳年齡 |
| `GET 或 POST /api/play?video=A\|B` | 切換影片 |
| `POST /api/heartbeat` | 遊戲心跳 |
| `GET /api/config` | 播放頁讀影片 URL |
| `GET /api/health` | 健康檢查 |
| `GET /api/reload-config` | 改完 config.json 不用重啟 |

## 換正式影片

放進 `media/`，改 `config.json` 的 `videoA`/`videoB`（相對路徑或完整 URL 皆可），然後 `curl http://localhost:3100/api/reload-config`。建議 H.264 mp4。

## 遊戲端設定

平板遊戲 → 開始畫面「⚙ 設定」（PIN 0000）→ 副屏控制方式選「PI5 播放端（HTTP）」（或「兩者同時」除錯用）→ PI5 位址填 `http://<PI5的IP>:3100` → 儲存。
