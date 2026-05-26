# XYZSTORE Merged Bot

Gabungan **BotPPOB** + **BotVPN** dalam satu process Telegraf.

| Aspek | Konfigurasi |
|---|---|
| Token Telegram | **1 token** (gabungan) |
| Process | **1 process Node.js** |
| Express server | **1 server** di port `PORT` (default 6969) |
| Database | **2 file pisah** — `ppob/ppob.db` & `vpn/sellvpn.db` |
| Saldo | **Pisah per layanan** (saldo PPOB & saldo VPN tidak terkait) |
| QRIS | PPOB pakai AutoGoPay, VPN pakai Orderkuota EMV |

## Struktur Folder

```
BotMerged/
├── index.js                 # Master entry: init bot+app, picker /start /menu
├── package.json             # Dependencies gabungan
├── ecosystem.config.js      # PM2 config (1 process)
├── .env.example             # Template config PPOB + master
├── ppob/                    # Modul PPOB (eks BotPPOB)
│   ├── bot.js               # export setupPpob({bot, app})
│   ├── handlers/
│   ├── modules/
│   ├── server/webhook.js    # mount route ke `app` master
│   └── ppob.db              # (jangan di-commit)
└── vpn/                     # Modul VPN (eks BotVPN)
    ├── app.js               # export setupVpn({bot, app})
    ├── modules/
    ├── .vars.json.example   # Template config VPN (format lama)
    └── sellvpn.db           # (jangan di-commit)
```

## Setup

```bash
cd BotMerged
npm install

# 1) Konfigurasi PPOB + master
cp .env.example .env
nano .env

# 2) Konfigurasi VPN (format lama, tidak diubah)
cp vpn/.vars.json.example vpn/.vars.json
nano vpn/.vars.json

# 3) Pindahkan DB lama (kalau migrasi dari bot terpisah)
cp /path/lama/BotPPOB/ppob.db ppob/ppob.db
cp /path/lama/BotVPN/sellvpn.db vpn/sellvpn.db
cp /path/lama/BotVPN/ressel.db vpn/ressel.db   # opsional
cp /path/lama/BotVPN/trial.db vpn/trial.db     # opsional

# 4) Jalankan
node index.js          # quick test
# atau dengan PM2
pm2 start ecosystem.config.js
pm2 logs xyzstore-bot
```

## Alur Menu

User ketik `/start` atau `/menu` → muncul **picker** dengan 2 tombol:

- 🛒 **Layanan PPOB** → callback `go_ppob` → menu PPOB existing
- 🌐 **Layanan VPN** → callback `send_main_menu` → menu VPN existing

Shortcut command langsung:
- `/ppob` — masuk menu PPOB
- `/vpn` — masuk menu VPN
- `/main` — kembali ke picker

Command admin (mis. `/addserver`, `/addsaldo`, `/sync`, `/broadcast`, dll) tetap berjalan seperti pada bot terpisah.

## Catatan Penting

1. **Token Telegram tetap 1.** `BOT_TOKEN` di `.env` adalah sumber utama. `vpn/.vars.json` masih punya field `BOT_TOKEN` (untuk backward compatibility) tapi nilainya **tidak dipakai** oleh master.
2. **Express port tunggal.** Webhook Digiflazz (`/digiflazz/webhook`) dan AutoGoPay (`/webhook/gopay`) sekarang nempel di `PORT` utama, bukan port terpisah `8787` lagi. Update setting webhook URL di dashboard Digiflazz / AutoGoPay sesuai.
3. **Text handler cascade.** Modul VPN sudah dipatch supaya `bot.on('text')` panggil `next()` ketika tidak ada state aktif → handler text PPOB tetap dapat dipanggil.
4. **Tidak ada migrasi data.** DB tetap pisah, jadi tidak ada konversi data atau merge tabel. Aman dijalankan side-by-side dengan bot lama (asalkan port & token berbeda).
5. **Saldo terpisah.** User yang topup di PPOB tidak otomatis dapat saldo di VPN, dan sebaliknya. Sesuai design awal merge ini.

## Troubleshooting

| Masalah | Solusi |
|---|---|
| `BOT_TOKEN belum di-set` | Isi `BOT_TOKEN` di `.env` |
| `ENOENT: no such file or directory ... .vars.json` | Buat `vpn/.vars.json` (lihat `.vars.json.example`) |
| Webhook Digiflazz tidak masuk | Update URL ke `https://domain.tld/digiflazz/webhook` (port utama, bukan 8787) |
| QRIS Orkut tidak detect | Cek `MERCHANT_ID` & `API_KEY` di `vpn/.vars.json` |
| Bot tidak respon `/start` | Pastikan tidak ada bot lama yang masih running pakai token sama (Telegram hanya izinkan 1 polling per token) |

## Reverting

Kalau ingin balik ke 2 bot terpisah, repo `BotPPOB` & `BotVPN` asli tetap utuh & tidak diubah. Tinggal stop merged bot, jalankan lagi keduanya.
