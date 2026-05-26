#!/bin/bash
  cd /root/BotVPN
    timedatectl set-timezone Asia/Jakarta || echo -e "${red}Failed to set timezone to Jakarta${neutral}"
sudo apt remove nodejs -y
sudo apt purge nodejs -y
sudo apt autoremove -y
    if ! dpkg -s nodejs >/dev/null 2>&1; then
        curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - || echo -e "${red}Failed to download Node.js setup${neutral}"
        apt-get install -y nodejs || echo -e "${red}Failed to install Node.js${neutral}"
    else
        echo -e "${green}Node.js is already installed, skipping...${neutral}"
    fi

    if [ ! -f /root/BotVPN/app.js ]; then
        git clone https://github.com/arivpnstores/BotVPN.git /root/BotVPN
    fi
apt install jq -y
apt install npm pm2 -y
npm install -g npm@latest
npm install -g pm2

    if ! npm list --prefix /root/BotVPN express telegraf axios moment sqlite3 >/dev/null 2>&1; then
        npm install --prefix /root/BotVPN sqlite3 express crypto telegraf axios dotenv
    fi

    if [ -n "$(ls -A /root/BotVPN)" ]; then
        chmod +x /root/BotVPN/*
    fi
wget -O .gitattributes "https://raw.githubusercontent.com/arivpnstores/BotVPN/main/.gitattributes"
wget -O README.md "https://raw.githubusercontent.com/arivpnstores/BotVPN/main/README.md"
wget -O app.js "https://raw.githubusercontent.com/arivpnstores/BotVPN/main/app.js"
wget -O cek-port.sh "https://raw.githubusercontent.com/arivpnstores/BotVPN/main/cek-port.sh"
wget -O ecosystem.config.js "https://raw.githubusercontent.com/arivpnstores/BotVPN/main/ecosystem.config.js"
wget -O package.json "https://raw.githubusercontent.com/arivpnstores/BotVPN/main/package.json"
wget -O ss.png "https://raw.githubusercontent.com/arivpnstores/BotVPN/main/ss.png"
wget -O ss2.png "https://raw.githubusercontent.com/arivpnstores/BotVPN/main/ss2.png"
wget -O start "https://raw.githubusercontent.com/arivpnstores/BotVPN/main/start"
wget -O update.sh "https://raw.githubusercontent.com/arivpnstores/BotVPN/main/update.sh"
wget -O /root/BotVPN/modules/reseller.js "https://raw.githubusercontent.com/arivpnstores/BotVPN/main/modules/reseller.js"
wget -O /root/BotVPN/modules/create.js "https://raw.githubusercontent.com/arivpnstores/BotVPN/main/modules/create.js"
wget -O /root/BotVPN/modules/del.js "https://raw.githubusercontent.com/arivpnstores/BotVPN/main/modules/del.js"
wget -O /root/BotVPN/modules/lock.js "https://raw.githubusercontent.com/arivpnstores/BotVPN/main/modules/lock.js"
wget -O /root/BotVPN/modules/unlock.js "https://raw.githubusercontent.com/arivpnstores/BotVPN/main/modules/unlock.js"
wget -O /root/BotVPN/modules/renew.js "https://raw.githubusercontent.com/arivpnstores/BotVPN/main/modules/renew.js"
wget -O /root/BotVPN/modules/trial.js "https://raw.githubusercontent.com/arivpnstores/BotVPN/main/modules/trial.js"

# stop dulu servicenya
systemctl stop sellvpn.service

# nonaktifkan supaya tidak jalan saat boot
systemctl disable sellvpn.service

# hapus file service dari systemd
rm -f /etc/systemd/system/sellvpn.service

# reload systemd biar bersih
systemctl daemon-reload
systemctl reset-failed


pm2 start ecosystem.config.js
pm2 save

cat >/usr/bin/backup_sellvpn <<'EOF'
#!/bin/bash
# File: /usr/bin/backup_sellvpn
# Pastikan chmod +x /usr/bin/backup_sellvpn

VARS_FILE="/root/BotVPN/.vars.json"
DB_FOLDER="/root/BotVPN"

# Cek file .vars.json
if [ ! -f "$VARS_FILE" ]; then
    echo "❌ File $VARS_FILE tidak ditemukan"
    exit 1
fi

# Ambil nilai dari .vars.json
BOT_TOKEN=$(jq -r '.BOT_TOKEN' "$VARS_FILE")
USER_ID=$(jq -r '.USER_ID' "$VARS_FILE")

if [ -z "$BOT_TOKEN" ] || [ -z "$USER_ID" ]; then
    echo "❌ BOT_TOKEN atau USER_ID kosong di $VARS_FILE"
    exit 1
fi

# Daftar file database
DB_FILES=("sellvpn.db" "trial.db" "ressel.db")

for DB_FILE in "${DB_FILES[@]}"; do
    FILE_PATH="$DB_FOLDER/$DB_FILE"
    if [ -f "$FILE_PATH" ]; then
        curl -s -F chat_id="$USER_ID" \
             -F document=@"$FILE_PATH" \
             "https://api.telegram.org/bot$BOT_TOKEN/sendDocument" >/dev/null 2>&1
        echo "✅ $DB_FILE terkirim ke Telegram"
    else
        echo "❌ File $DB_FILE tidak ditemukan"
    fi
done

echo "✅ Semua backup selesai."
EOF

# bikin cron job tiap 1 jam
cat >/etc/cron.d/backup_sellvpn <<'EOF'
SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin
0 0 * * * root /usr/bin/backup_sellvpn
EOF

chmod +x /usr/bin/backup_sellvpn
service cron restart
cd 