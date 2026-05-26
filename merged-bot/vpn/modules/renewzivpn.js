const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Pastikan path database benar
const dbPath = path.resolve(__dirname, '../sellvpn.db');
const db = new sqlite3.Database(dbPath);

async function renewzivpn(username, password, exp, limitip, serverId) {
  console.log(`[ZIVPN] Renewing (via SSH API): ${username}, Exp: ${exp}, Server: ${serverId}`);

  // 1. Validasi Username
  if (!/^[a-z0-9-]+$/.test(username)) {
    return { ok: false, msg: '❌ Username tidak valid. Gunakan huruf kecil, angka, dan strip (-).' };
  }

  return new Promise((resolve) => {
    db.get('SELECT * FROM Server WHERE id = ?', [serverId], async (err, server) => {
      if (err || !server) {
        return resolve({ ok: false, msg: '❌ Server tidak ditemukan.' });
      }

      const domain = server.domain;
      const auth = server.auth;
      const days = exp;

      // ✅ KUNCI UTAMA: Gunakan Endpoint yang SAMA PERSIS dengan Renew SSH
      // Karena 1 Akun = 2 Protokol (SSH & ZIVPN), jadi renew satu = renew semua.
      const apiUrl = `http://${domain}/vps/renewsshvpn/${username}/${days}`;

      try {
        // Gunakan PATCH sesuai API SSH Anda
        const response = await axios.patch(apiUrl, {
          kuota: 0 
        }, {
          headers: {
            'Authorization': auth,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          timeout: 10000 
        });

        const d = response.data;
        console.log("[ZIVPN] Response:", JSON.stringify(d, null, 2));

        // Cek format sukses ala SSH (meta.code 200)
        if (d?.meta?.code !== 200 || !d.data) {
          const errMsg = d?.message || d?.meta?.message || 'Gagal Renew (Unknown Error)';
          return resolve({ ok: false, msg: `❌ Gagal Renew: ${errMsg}` });
        }

        const s = d.data;

        // Format Pesan (Kita ubah judulnya jadi ZIVPN biar user senang)
        const msg = `✅ *RENEW ZIVPN BERHASIL*\n\n` +
                    `🔄 *Status Perpanjangan*\n` +
                    `────────────────────────────\n` +
                    `👤 *Username* : \`${s.username}\`\n` +
                    `📆 *Tambah Durasi* : ${days} Hari\n` +
                    `🕒 *Mulai* : \`${s.from || '-'}\`\n` +
                    `🕒 *Berakhir* : \`${s.to || '-'}\`\n` +
                    `────────────────────────────\n\n` +
                    `✨ Akun SSH & ZIVPN Anda telah diperpanjang!`;

        // Return Object (Penting: kirim 'to' agar DB bot terupdate)
        return resolve({ 
            ok: true, 
            msg: msg,
            to: s.to 
        });

      } catch (error) {
        console.error('[ZIVPN] Axios Error:', error.message);
        
        if (error.response && error.response.data) {
             const errData = error.response.data;
             const errMsg = errData.message || errData.meta?.message || error.message;
             return resolve({ ok: false, msg: `❌ Gagal Renew: ${errMsg}` });
        }
        
        return resolve({ ok: false, msg: '❌ Gagal menghubungi server panel.' });
      }
    });
  });
}

module.exports = { renewzivpn };

