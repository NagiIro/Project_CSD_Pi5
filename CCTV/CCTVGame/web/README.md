# 閉路電視•案件重組（CCTV Case Reconstruction）

觸摸屏拖放解謎遊戲 + 第二屏幕影片聯動。

- **主觸屏**（`index.html`）：開始畫面 → 按「開始重組案件」→ 限時 7 分鐘，把左側 8 個「日期、時間」方塊（TimePlace，紫色）和 8 個「閉路電視編號」方塊（Num，青框）拖放到右側 8 個放置區的對應格。方塊可自由停放在任何同類格（錯的不會即時彈回，可互相調換），放完按右上「✔ 確認答案」才檢驗：全對 → 成功；有錯 → 錯的退回左面板並提示，對的保留。
- **全螢幕**：按「開始重組案件」會自動進入全螢幕；HUD 右上「全螢幕／退出全螢幕」按鈕可手動切換，開始畫面也有「全螢幕模式」連結。
- **自適應解像度**：所有尺寸以 rem 為單位、根字級隨視窗短邊（vmin）縮放，1366×768 / 1600×900 / 1920×1080 均自動適配；直向（portrait）時改為上下排列可滾動的備用版面。
- **第二屏幕**（`screen2.html`）：預設循環播放**影片 A**；遊戲成功後切換並**固定循環播放影片 B**；遊戲重置或關閉 → 自動切回影片 A（關閉偵測靠心跳，遊戲頁消失約 5 秒內切回）。
- 成功同時發送一條 **API request**（網址、方法、headers、body 都在 `config.json` 自訂，預設 `enabled: false`）。

## 電腦上測試運行

需要用本機伺服器開啟（`fetch config.json` 不支援 file://）：

```bash
cd CCTVGame/web
python -m http.server 8641
```

1. 開 `http://127.0.0.1:8641/screen2.html`（模擬第二屏幕，可放另一個視窗/顯示器）
2. 開 `http://127.0.0.1:8641/index.html`（主觸屏），按「開始重組案件」

兩頁面經 BroadcastChannel + localStorage 通訊，同一瀏覽器的不同分頁/視窗即可聯動。

## 遊戲內設定頁（帶密碼鎖）

開始畫面按「⚙ 設定」→ 輸入 **4 位數字密碼（預設 `0000`）**→ 開啟設定頁。可改：限時秒數、密碼、影片 A/B 來源、API request（開關/URL/方法/Headers/Body）、題目 zones JSON。

- 設定儲存在瀏覽器/WebView 的 **localStorage**（`cctv.config.override`），以 `config.json` 為底做覆寫：改過的欄位用新值，沒改的跟回 config.json。重新整理、重開 App 都會保留。
- 在 Android 上這樣**不用找檔案**就能改設定；想直接改 JSON 檔也可以，兩者會合併。
- 「恢復預設」會清掉覆寫，全部回到 config.json。
- 儲存後會即時通知第二屏幕重讀設定（例如換了影片來源）。
- 密碼也可在 config.json 的 `settingsPin` 改預設值；在設定頁改過後以設定頁為準。

## 設定檔 `config.json`

| 欄位 | 說明 |
|---|---|
| `gameTitle` / `startButtonText` | 標題與開始按鈕文字 |
| `timerSeconds` | 限時秒數（預設 420 = 7 分鐘） |
| `settingsPin` | 設定頁的 4 位數字密碼（預設 `0000`） |
| `videoA` / `videoB` | 第二屏幕影片。支援 `.gif/.jpg/.png/.webp`（用 `<img>` 循環）或 `.mp4/.webm`（用 `<video muted loop autoplay>`）。可填相對路徑或完整 URL |
| `api.enabled` | 是否真正發送 API request |
| `api.url` / `api.method` / `api.headers` / `api.body` | 成功時發送的請求設定 |
| `zones[]` | 8 個放置區的資料：`image`（示範圖）、`date`+`time`（TimePlace 方塊文字）、`camera`（Num 方塊文字）。方塊與放置區的對應關係由 `id` 決定，改文字即可換題目 |

測試用示範圖 `media/cctv_show01.jpg` ~ `cctv_show08.jpg` 由 `tools/gen_cctv_images.py` 產生；換正式圖時直接覆蓋 `media/` 內同名檔案即可。

## 檔案結構

```
CCTVGame/web/
├── index.html        主觸屏（開始畫面 + 遊戲）
├── screen2.html      第二屏幕播放器
├── config.json       ★ 用戶自設定檔
├── css/style.css     UI 風格
├── js/shared.js      雙屏通訊（BroadcastChannel + localStorage + 心跳）
├── js/game.js        遊戲邏輯
├── js/screen2.js     第二屏幕邏輯
└── media/            影片 A/B + 8 張示範圖
```

## 副屏方案二：PI5 播放端（推薦，不依賴 Android 雙屏）

平板只跑遊戲，第二屏幕交給 Raspberry Pi 5（HDMI 接副屏）：平板透過 HTTP 指令控制切換。
PI5 端程式在 [../../pi5-player/](../../pi5-player/)（有獨立 README）。

遊戲設定頁 →「副屏控制方式」：

| 值 | 行為 |
|---|---|
| `local` | 本機第二屏（APK Presentation / 瀏覽器視窗）——預設 |
| `pi5` | 只發 HTTP 給 PI5 |
| `both` | 兩者同時（除錯/過渡用） |

成功 → `POST {pi5BaseUrl}/api/play?video=B`；重置/關閉 → `...?video=A`（關閉用 sendBeacon）；
遊戲運行期間每秒 `POST /api/heartbeat`，PI5 心跳逾時自動回 A。

## 搬到 Android（APK 雙屏異顯）

`CCTVGame/` 本身就是完整 Android 專案（Gradle 7.6.4 + AGP 7.4.2，免 AndroidX、免第三方依賴）：

- **主屏**：`MainActivity` 全屏 WebView 載入 `assets/www/index.html`
- **副屏**：偵測到 HDMI/DisplayLink 副屏時，用 `Presentation` 在副屏放第二個 WebView 載入 `screen2.html`；副屏拔出時自動關閉
- **雙屏通訊**：`CctvNative` JS bridge（兩個 WebView 不共享 BroadcastChannel）+ localStorage 共享（心跳、A/B 狀態、設定覆寫）
- **設定**：直接用遊戲內「⚙ 設定」頁（PIN 鎖），存 localStorage，不用改檔案

### Build APK

```bash
cd CCTVGame
set JAVA_HOME=D:\Github\CCTV\tools\jdk17   # JDK 17
D:\Github\CCTV\tools\gradle\bin\gradle.bat --no-daemon assembleDebug
```

產物：`app\build\outputs\apk\debug\app-debug.apk`，用 adb 或隨身碟 sideload 到平板即可。每次 build 會自動把 `web/` 最新檔案同步進 `assets/www/`（`web/` 是唯一編輯來源）。

### 平板上使用

1. 接上副屏（HDMI）→ 開 App → 主屏顯示遊戲，副屏自動播放影片 A
2. 主屏解謎成功 → 副屏切影片 B 並發 API request；重置/關 App → 副屏回影片 A
3. 改設定：開始畫面「⚙ 設定」（密碼預設 0000）
4. 預設鎖橫屏（`AndroidManifest.xml` 的 `screenOrientation="landscape"`），要直向可自行移除

## 搬到 Android 電視 / 平板（原理說明）

網頁部分**不用改**，用一個薄原生殼包住即可：

1. **主屏**：`WebView` 全屏載入 `index.html`（assets 或本機伺服器）。
2. **第二屏**：Android 13 支援副螢幕（HDMI / DisplayLink）。用 [`Presentation`](https://developer.android.com/reference/android/app/Presentation) API 在第二塊 `Display` 上放另一個 `WebView` 載入 `screen2.html`。
3. **雙屏通訊**：兩個 WebView 不共享 BroadcastChannel，原生殼加一個 `@JavascriptInterface`（例如 `AndroidBus.send(json)` / 回調 `onBusMessage(json)`），在 `js/shared.js` 的 `CctvBus.send/onMessage` 裡橋接即可（`shared.js` 已把通訊收口在這一個物件上，就是為此預留的）。
4. 打包：Android Studio 或 `tools/gradle` 建 WebView 專案，`web/` 整個放進 `app/src/main/assets/`。
5. 副螢幕偵測：`DisplayManager.getDisplays(DisplayManager.DISPLAY_CATEGORY_PRESENTATION)`，有副屏才建立 Presentation，否則退回單屏（遊戲本身不依賴第二屏也能玩）。

## 除錯掛勾

主遊戲頁 console 有 `window.__cctv`：`getState()` / `getPlaced()` / `solveAll()`（一鍵放對全部，自動化測試用）/ `reset()`。正式版如想移除，刪掉 `game.js` 末尾的「測試/除錯掛勾」段落即可。
