#!/bin/bash
# 雙影片播放器開機自啟包裝腳本
# 確保 DISPLAY 設定正確（XWayland 啟動需要時間，最多等 30 秒）
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export WAYLAND_DISPLAY="wayland-0"

for i in $(seq 1 30); do
    if pgrep -x Xwayland >/dev/null; then
        break
    fi
    sleep 1
done
export DISPLAY=:0

cd /home/efbr03/visit_player
exec python3 vlc_player.py >> /home/efbr03/visit_player/player.log 2>&1
