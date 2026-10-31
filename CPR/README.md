# 醫院尋證•急救行動（CPR 節拍遊戲）

運行於 Raspberry Pi 5 的 CPR 模擬遊戲。參加者跟隨屏幕節拍按壓空白鍵進行急救，5 次全部按壓正確即搶救成功，系統會傳送 API request 並循環播放影片。

## 遊戲規則

- 開始畫面按「開始急救」後會先顯示**玩法說明**，按空白鍵確認才正式開始
- CPR 時長可在設定中調整（**5–120 秒**，預設 12 秒）
- 指示從約 1.5–2 秒開始，之後**每隔 1–2 秒**出現一次（紅色標記從右向左移動），按壓次數由時長決定
- 標記到達**白色判定線**時按下**空白鍵**（容許誤差 **±0.5 秒**）
- **全部指示正確** → 搶救成功：傳送 API request，並循環播放 `Loop.mp4`
- **任何一次按錯時機或漏按** → 搶救失敗，數秒後自動返回開始畫面
- 任何時候按 **Ctrl + R** → 立即返回開始畫面

## 開機自動啟動（PI5）

已在 PI5 設定 labwc 開機自啟（`~/.config/labwc/autostart`），開機進入桌面後會自動以 Kiosk 模式開啟遊戲。

- **停用**：刪除 `~/.config/labwc/autostart` 中的 `/home/efbr02/start-game.sh &` 一行
- **手動啟動**：`/home/efbr02/start-game.sh`

## 畫面風格

紅＋白字色、黑底，模擬心電圖監察儀（含掃描線、跳動波形、成功時 QRS 波峰、失敗時直線）。

## 檔案

| 檔案 | 說明 |
|---|---|
| `index.html` | 遊戲主頁面 |
| `style.css` | 心電圖風格樣式 |
| `game.js` | 遊戲邏輯（節拍排程、判定、API、影片播放） |
| `start-game.sh` | PI5 Kiosk 模式啟動腳本 |

## PI5 部署（已部署至 efbr02）

遊戲檔案已複製到 PI5 的 **`/home/efbr02/Downloads/`**，與 `Loop.mp4` 放在同一資料夾。

啟動方式（PI5 桌面環境）：

```bash
/home/efbr02/start-game.sh
```

或直接：

```bash
chromium --kiosk --autoplay-policy=no-user-gesture-required \
  file:///home/efbr02/Downloads/index.html
```

SSH 連線：用戶 `efbr02`、主機 `efbr02`、密碼 `0000`。

## 設定（開始畫面 → 設定）

- 進入設定需輸入密碼，**預設 `0000`**（可在設定內修改，4–8 位數字）
- **API Request 網址**：可填寫觸發網址（例如 `http://192.168.x.x:port/trigger`）
- **API Request 開關**：可開啟／關閉傳送
- 搶救成功瞬間以 `GET` 方式傳送（`no-cors`，失敗不影響遊戲）
- 設定儲存於瀏覽器 localStorage，重開後保留

## 本機測試

在遊戲資料夾執行 `python -m http.server 8765`，瀏覽器開啟
[http://127.0.0.1:8765/](http://127.0.0.1:8765/) 即可測試（本機沒有 `Loop.mp4` 時，成功畫面會顯示提示訊息，屬正常）。
