# NFC Gate Trigger (Pi 5 + PN532)

Pi 5 經 USB-Serial（ESP-D01 / CH340 / CP2102 等）駁 PN532。
感應到 NFC 卡時，自動向可設定嘅 API URL 發送 request。
附設後台網頁，隨時更改 API link、method 同冷卻時間。

## 功能

- PN532 UART (115200 baud) 自動掃卡，拍卡即觸發 API
- API URL 可經後台網頁隨時更改（儲存喺 `config.json`，改完即時生效）
- 同一張卡設冷卻時間（預設 5 秒），避免一直拍住張卡狂打 API
- 後台有「立即測試觸發」按鈕、狀態顯示、事件紀錄
- 斷線自動重連；systemd 開機自動啟動

## 安裝（喺 Pi 上執行）

```bash
cd ~/nfc-gate
bash install.sh
```

安裝後服務名為 `nfc-gate`：

```bash
sudo systemctl status nfc-gate    # 狀態
journalctl -u nfc-gate -f         # 即時 log
sudo systemctl restart nfc-gate   # 重新啟動
```

## 後台

瀏覽器開 `http://<Pi IP>:3000`

- **觸發 API URL**：拍卡時呼叫嘅 link（預設為 questxr.ai 測試 link）
- **Method**：
  - `POST` — JSON body：`{"uid":"04a1b2c3","source":"pi5-pn532","ts":"..."}`
  - `GET` — 會喺 URL 後面加 `?uid=xxxx`
- **冷卻時間**：同一張卡喺呢段時間內重複感應唔會再觸發
- **立即測試觸發**：唔使拍卡，即時打一次 API 驗證連線

## 檔案結構

```
config.json          # 設定（API URL 等）
src/server.js        # 主程式：NFC 監聽 + 觸發 + 後台
public/index.html    # 後台網頁
install.sh           # 一鍵安裝（Node.js + systemd）
```

## 硬件

- PN532 設為 **UART 模式**（板上的 DIP 開關：CH1=OFF / CH2=ON，視乎板子絲印）
- 經 ESP-D01（USB-Serial）插入 Pi USB，會出現 `/dev/ttyUSB0`
- `serialPort` 預設 `auto`，會自動搵 `/dev/ttyUSB*` / `/dev/ttyACM*`；
  如有需要可喺 `config.json` 寫死路徑
