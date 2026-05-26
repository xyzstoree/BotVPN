const { exec } = require('child_process');
const sqlite3 = require('sqlite3').verbose();

// Pakai DB utama sellvpn.db
const db = new sqlite3.Database(require('path').join(__dirname, '..', 'sellvpn.db'));

// 👇 UBAH DI SINI: Sesuaikan urutan parameter agar serverId berada di posisi ke-5
async function trialzivpn(username, password, exp, iplimit, serverId) {
  return new Promise((resolve) => {
    // Sekarang serverId benar-benar berisi angka ID server
    db.get('SELECT * FROM Server WHERE id = ?', [serverId], (err, server) => {
      if (err || !server) {
        console.error('❌ Error fetching server (trial zivpn):', err?.message || 'server null');
        return resolve('❌ Server tidak ditemukan. Silakan coba lagi.');
      }

      const domain = server.domain;
      const param = `/vps/trialsshvpn`;          // endpoint trial
      const web_URL = `http://${domain}${param}`;
      const AUTH_TOKEN = server.auth;

      const TRIAL_MINUTES = 30;                 // durasi trial 30 menit
      const LIMIT_IP = 1;                       // fix 1 IP

      const curlCommand = `curl -s -X POST "${web_URL}" \
-H "Authorization: ${AUTH_TOKEN}" \
-H "Content-Type: application/json" \
-H "Accept: application/json" \
-d '{"timelimit":"${TRIAL_MINUTES}m"}'`;

      exec(curlCommand, (_, stdout) => {
        let d;
        try {
          d = JSON.parse(stdout);
        } catch (e) {
          console.error('❌ Gagal parsing JSON (trial zivpn):', e.message);
          console.error('🪵 Output:', stdout);
          return resolve('❌ Format respon dari server tidak valid (trial ZIVPN).');
        }

        // Cek sukses dari panel
        if (d?.meta?.code !== 200 || !d.data) {
          console.error('❌ Respons error (trial zivpn):', d);
          const errMsg = d?.message || d?.meta?.message || JSON.stringify(d, null, 2);
          return resolve(`❌ Gagal membuat akun trial ZIVPN:\n${errMsg}`);
        }

        const s = d.data || d;

        // TAMPILAN SIMPLE SESUAI PERMINTAAN
        const msg = `
┌─────────────────────
│ㅤ  🔹 *TRIAL ZIVPN Account* 🔹
└─────────────────────
│ *Hostname* : \`${s.hostname || domain}\`
│ *UDP password*: \`${s.username || 'trial'}\`
│ *Durasi* : \`${TRIAL_MINUTES} Menit\`
│ *Limit IP* : ${LIMIT_IP} IP
└─────────────────────`.trim();

        return resolve(msg);
      });
    });
  });
}

module.exports = { trialzivpn };

