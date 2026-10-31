#!/bin/bash
# 醫院尋證•急救行動 — PI5 啟動腳本
# 以 Kiosk 全螢幕模式開啟遊戲
# --disable-background-networking 等旗標關閉 Google 背景聯網，
# 消除指令板上的 GCM「Registration response error: Deprecated_endpoint」日誌
chromium --kiosk \
  --autoplay-policy=no-user-gesture-required \
  --noerrdialogs --disable-infobars --disable-session-crashed-bubble \
  --disable-background-networking --disable-component-update --disable-sync \
  --check-for-update-interval=31536000 \
  file:///home/efbr02/Downloads/index.html
