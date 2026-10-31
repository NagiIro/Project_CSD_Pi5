#!/bin/bash
# NFC Gate Trigger - Pi 5 一鍵安裝
set -e
cd "$(dirname "$0")"

# 無論直接跑定經 sudo 跑，都以真正用戶為準
RUNUSER=${SUDO_USER:-$USER}
[ "$RUNUSER" = "root" ] && RUNUSER=$(logname 2>/dev/null || echo root)

echo "==> 檢查 Node.js..."
NEED_NODE=1
if command -v node >/dev/null 2>&1; then
  MAJOR=$(node -v | sed 's/v\([0-9]*\).*/\1/')
  [ "$MAJOR" -ge 18 ] && NEED_NODE=0
fi
if [ "$NEED_NODE" = "1" ]; then
  echo "==> 安裝 Node.js 20 (NodeSource)..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node -v

echo "==> 將 $RUNUSER 加入 dialout 群組（存取 USB-Serial）..."
sudo usermod -aG dialout "$RUNUSER" || true

echo "==> 安裝 npm 套件..."
if [ "$(id -u)" -eq 0 ] && [ "$RUNUSER" != "root" ]; then
  sudo -u "$RUNUSER" npm install --omit=dev
else
  npm install --omit=dev
fi

echo "==> 設定 systemd 服務 (nfc-gate)..."
sudo tee /etc/systemd/system/nfc-gate.service > /dev/null <<EOF
[Unit]
Description=NFC Gate Trigger (PN532 -> API)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUNUSER
WorkingDirectory=$(pwd)
ExecStart=$(command -v node) src/server.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable nfc-gate
sudo systemctl restart nfc-gate

IP=$(hostname -I | awk '{print $1}')
echo ""
echo "==============================================="
echo " 安裝完成！服務已啟動並設定開機自動執行。"
echo " 後台網址:  http://$IP:3000"
echo " 睇 log:    journalctl -u nfc-gate -f"
echo "==============================================="
