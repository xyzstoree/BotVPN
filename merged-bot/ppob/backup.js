// backup.js
// AUTO BACKUP HARIAN — HANYA SEKALI SEHARI TEPAT JAM 02:00 PAGI
const path = require('path');
const fs = require('fs');
const https = require('https');
const DB_PATH = path.join(__dirname, 'ppob.db');
// Ambil dari .env
const BOT_TOKEN = process.env.BOT_TOKEN?.trim();
const CHAT_ID = process.env.ADMIN_IDS?.trim();
// Validasi
if (!BOT_TOKEN || !CHAT_ID) {
  console.error("[BACKUP] ⚠️ BOT_TOKEN atau ADMIN_IDS kosong di .env! Backup Telegram tidak akan jalan.");
}
// Fungsi kirim backup langsung ke Telegram (tanpa simpan lokal)
async function sendBackupToTelegram() {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log("[BACKUP] Skip kirim karena token/chat ID kosong");
    return;
  }
  const now = new Date();
  const dateStr = now.toLocaleDateString('id-ID', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');
  const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, '-');
  const fileName = `backup-\( {dateStr}_ \){timeStr}.db`;
  const caption = `🗄️ *Backup Database Otomatis*\n` +
                  `📅 ${dateStr}\n` +
                  `🕐 ${timeStr}\n` +
                  `📁 ${fileName}\n\n` +
                  `Bot PPOB - XYZSTORE`;
  return new Promise((resolve, reject) => {
    const fileStream = fs.createReadStream(DB_PATH);
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`;
    const boundary = '----' + Date.now();
    let postData = '';
    postData += `--${boundary}\r\n`;
    postData += `Content-Disposition: form-data; name="chat_id"\r\n\r\n${CHAT_ID}\r\n`;
    postData += `--${boundary}\r\n`;
    postData += `Content-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`;
    postData += `--${boundary}\r\n`;
    postData += `Content-Disposition: form-data; name="document"; filename="${fileName}"\r\n`;
    postData += `Content-Type: application/octet-stream\r\n\r\n`;
    const req = https.request(url, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }
    });
    req.write(postData);
    fileStream.pipe(req, { end: false });
    fileStream.on('end', () => {
      req.end(`\r\n--${boundary}--\r\n`);
    });
    req.on('response', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.ok) {
            console.log(`[BACKUP] ✅  Backup otomatis berhasil dikirim: ${fileName}`);
            resolve();
          } else {
            console.error("[BACKUP] Gagal kirim:", json.description);
            reject(new Error(json.description));
          }
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', (err) => {
      console.error("[BACKUP] Error koneksi:", err.message);
      reject(err);
    });
  });
}
// Jadwal: backup hanya sekali sehari tepat jam 02:00 pagi
function scheduleDailyBackup() {
  const now = new Date();
  let nextBackup = new Date(now);
  nextBackup.setHours(0, 0, 0, 0);
  // Kalau sudah lewat jam 2 pagi hari ini, jadwalkan untuk besok
  if (now >= nextBackup) {
    nextBackup.setDate(nextBackup.getDate() + 1);
  }
  const delayMs = nextBackup.getTime() - now.getTime();
  console.log(`[BACKUP] Jadwal backup otomatis berikutnya: ${nextBackup.toLocaleString('id-ID')} (dalam ${Math.round(delayMs / 60000)} menit)`);
  setTimeout(() => {
    sendBackupToTelegram().catch(console.error);
    scheduleDailyBackup(); // jadwal ulang untuk hari berikutnya
  }, delayMs);
}
// Hanya jalankan jadwal — TIDAK backup saat bot start/restart
scheduleDailyBackup();
console.log("[BACKUP] Auto backup HANYA sekali sehari jam 02:00 pagi (tidak backup saat restart)");
