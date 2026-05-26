const { exec } = require('child_process');
const sqlite3 = require('sqlite3').verbose();

// DB utama
const db = new sqlite3.Database('./sellvpn.db');

async function createzivpn(username, password, exp, iplimit, serverId) {
  // Validasi username: huruf/angka saja, tanpa spasi
  if (/\s/.test(username) || /[^a-zA-Z0-9]/.test(username)) {
    return '❌  Username hanya boleh huruf & angka (tanpa spasi)';
  }

  return new Promise((resolve) => {
    db.get('SELECT * FROM Server WHERE id = ?', [serverId], (err, server) => {
      if (err || !server) {
        console.error('❌  Error fetch server ZIVPN:', err?.message);
        return resolve('❌  Server tidak ditemukan');
      }

      const url = `http://${server.domain}/vps/sshvpn`;

      const cmd = `curl -s -X POST "${url}" \
-H "Authorization: ${server.auth}" \
-H "Content-Type: application/json" \
-d '{"expired":${exp},"limitip":"${iplimit}","password":"${password}","username":"${username}"}'`;

      exec(cmd, (_, stdout) => {
        let res;
        try {
          res = JSON.parse(stdout);
        } catch (e) {
          console.error('❌  Gagal parse JSON ZIVPN:', e.message);
          console.error('🪵 Raw output:', stdout);
          return resolve('❌  Response server tidak valid');
        }

        // ====== CEK SUKSES / GAGAL ======
        const isSuccess =
          res?.meta?.code === 200 ||
          res?.status === 'success' ||
          res?.success === true ||
          (res?.data && res.data.username);

        if (!isSuccess) {
          // Ambil pesan error dari panel
          let errMsg = res?.message || res?.meta?.message || JSON.stringify(res);

          // Mapping khusus untuk username duplikat (contoh pesan panel: "Client xxx exists")
          if (
            typeof errMsg === 'string' &&
            errMsg.toLowerCase().includes('exists')
          ) {
            // Bisa dipersempit pakai 'client' juga kalau perlu:
            // && errMsg.toLowerCase().includes('client')
            errMsg = 'Username Akun Sudah Di Gunakan\nMasukan Username Baru!';
          }

          return resolve(`❌  Gagal membuat akun ZIVPN:\n${errMsg}`);
        }

        const s = res.data || res;

        // ====== UPDATE total_create_akun (mirip modul SSH) ======
        const days = Number(exp) || 0;
        if (days >= 3 && days <= 135) {
          db.run(
            'UPDATE Server SET total_create_akun = total_create_akun + 1 WHERE id = ?',
            [serverId],
            (err2) => {
              if (err2) {
                console.error('⚠️ Gagal update total_create_akun (zivpn):', err2.message);
              } else {
                console.log(`✅ total_create_akun ZIVPN++ untuk serverId ${serverId} (exp=${days})`);
              }
            }
          );
        } else {
          console.log(`⚠️ Exp ZIVPN ${days} hari tidak dicatat ke total_create_akun`);
        }
        // ====== SELESAI UPDATE total_create_akun ======

        // ====== PESAN KE USER (BOX UDP ZIVPN) ======
        const msg = `
┌─────────────────────
│ㅤ   🔹 *UDP ZIVPN Account* 🔹
└─────────────────────
┌─────────────────────
│ *Hostname*     : \`${s.hostname || server.domain}\`
│ *UDP password* : \`${s.username || username}\`
│ *Expired*      : \`${s.exp || (exp + ' Hari')}\`
│ *Limit IP*     : ${iplimit} IP
└─────────────────────
🤖 @xyzstorevpnbot
✨ Selamat menggunakan layanan kami!
`.trim();

        resolve(msg);
      });
    });
  });
}

module.exports = { createzivpn };
