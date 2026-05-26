const axios = require('axios');
const { exec } = require('child_process');
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./sellvpn.db');

async function lockssh(username, password, exp, iplimit, serverId) {
  console.log(`Lock SSH account for ${username} with expiry ${exp} days, IP limit ${iplimit}, and password ${password}`);

  // Validasi username
if (!/^[a-z0-9-]+$/.test(username)) {
    return '❌ Username tidak valid. Mohon gunakan hanya huruf dan angka tanpa spasi.';
  }

  return new Promise((resolve) => {
    db.get('SELECT * FROM Server WHERE id = ?', [serverId], (err, server) => {
      if (err || !server) {
        console.error('❌ Error fetching server:', err?.message || 'server null');
        return resolve('❌ Server tidak ditemukan. Silakan coba lagi.');
      }

      const domain = server.domain;
      const param = `/vps/locksshvpn`;
      const web_URL = `http://${domain}${param}`; // Contoh: http://domainmu.com/vps/sshvpn
      const AUTH_TOKEN = server.auth;

      const curlCommand = `curl -s -X PATCH "${web_URL}/${username}" \
-H "Authorization: ${AUTH_TOKEN}" \
-H "accept: application/json"`;

      exec(curlCommand, (_, stdout) => {
        let d;
        try {
          d = JSON.parse(stdout);
        } catch (e) {
          console.error('❌ Gagal parsing JSON:', e.message);
          console.error('🪵 Output:', stdout);
          return resolve('❌ Format respon dari server tidak valid.');
        }

        if (d?.meta?.code !== 200 || !d.data) {
          console.error('❌ Respons error:', d);
          const errMsg = d?.message || d?.meta?.message || JSON.stringify(d, null, 2);
          return resolve(`❌ Respons error:\n${errMsg}`);
        }

        const s = d.data;
        const msg = `✅ *Lock SSH Account Success!*

🔄 *Akun berhasil dikunci*
────────────────────────────
👤 *Username*     : \`${s.username}\`
────────────────────────────

✨ Terima kasih telah memperpanjang layanan kami!
*© Telegram Bots - 2025*`;

        return resolve(msg);
      });
    });
  });
}
async function lockvmess(username, exp, quota, limitip, serverId) {
  console.log(`Lock VMess account for ${username} with expiry ${exp} days, quota ${quota} GB, limit IP ${limitip}`);

  // Validasi username
if (!/^[a-z0-9-]+$/.test(username)) {
    return '❌ Username tidak valid. Mohon gunakan hanya huruf dan angka tanpa spasi.';
  }

  return new Promise((resolve) => {
    db.get('SELECT * FROM Server WHERE id = ?', [serverId], (err, server) => {
      if (err || !server) {
        console.error('❌ Error fetching server:', err?.message || 'server null');
        return resolve('❌ Server tidak ditemukan. Silakan coba lagi.');
      }

      const domain = server.domain;
      const param = `/vps/lockvmess`;
      const web_URL = `http://${domain}${param}`; // contoh: http://domain.com/vps/vmess
      const AUTH_TOKEN = server.auth;

      const curlCommand = `curl -s -X PATCH "${web_URL}/${username}" \
-H "Authorization: ${AUTH_TOKEN}" \
-H "accept: application/json"`;

      exec(curlCommand, (_, stdout) => {
        let d;
        try {
          d = JSON.parse(stdout);
        } catch (e) {
          console.error('❌ Gagal parsing JSON:', e.message);
          console.error('🪵 Output:', stdout);
          return resolve('❌ Format respon dari server tidak valid.');
        }

        if (d?.meta?.code !== 200 || !d.data) {
          console.error('❌ Respons error:', d);
          const errMsg = d?.message || d?.meta?.message || JSON.stringify(d, null, 2);
          return resolve(`❌ Respons error:\n${errMsg}`);
        }

        const s = d.data;
        const msg = `✅ *Lock VMess Account Success!*

🔄 *Akun berhasil dikunci*
────────────────────────────
👤 *Username*    : \`${s.username}\`
────────────────────────────

✨ Terima kasih telah memperpanjang layanan kami!
*© Telegram Bots - 2025*`;

        return resolve(msg);
      });
    });
  });
}
async function lockvless(username, exp, quota, limitip, serverId) {
  console.log(`Lock VLESS account for ${username} with expiry ${exp} days, quota ${quota} GB, limit IP ${limitip}`);

  // Validasi username
if (!/^[a-z0-9-]+$/.test(username)) {
    return '❌ Username tidak valid. Mohon gunakan hanya huruf dan angka tanpa spasi.';
  }

  return new Promise((resolve) => {
    db.get('SELECT * FROM Server WHERE id = ?', [serverId], (err, server) => {
      if (err || !server) {
        console.error('❌ Error fetching server:', err?.message || 'server null');
        return resolve('❌ Server tidak ditemukan. Silakan coba lagi.');
      }

      const domain = server.domain;
      const param = `/vps/lockvless`;
      const web_URL = `http://${domain}${param}`;        // Contoh: http://domain.com/vps/vless
      const AUTH_TOKEN = server.auth;

      const curlCommand = `curl -s -X PATCH "${web_URL}/${username}" \
-H "Authorization: ${AUTH_TOKEN}" \
-H "accept: application/json"`;

      exec(curlCommand, (_, stdout) => {
        let d;
        try {
          d = JSON.parse(stdout);
        } catch (e) {
          console.error('❌ Gagal parsing JSON:', e.message);
          console.error('🪵 Output:', stdout);
          return resolve('❌ Format respon dari server tidak valid.');
        }

        if (d?.meta?.code !== 200 || !d.data) {
          console.error('❌ Respons error:', d);
          const errMsg = d?.message || d?.meta?.message || JSON.stringify(d, null, 2);
          return resolve(`❌ Respons error:\n${errMsg}`);
        }

        const s = d.data;
        const msg = `✅ *Lock VLESS Account Success!*

🔄 *Akun berhasil dikunci*
────────────────────────────
👤 *Username*    : \`${s.username}\`
────────────────────────────

✨ Terima kasih telah memperpanjang layanan kami!
*© Telegram Bots - 2025*`;

        return resolve(msg);
      });
    });
  });
}
async function locktrojan(username, exp, quota, limitip, serverId) {
  console.log(`Lock TROJAN account for ${username} with expiry ${exp} days, quota ${quota} GB, limit IP ${limitip}`);

  // Validasi username
if (!/^[a-z0-9-]+$/.test(username)) {
    return '❌ Username tidak valid. Mohon gunakan hanya huruf dan angka tanpa spasi.';
  }

  return new Promise((resolve) => {
    db.get('SELECT * FROM Server WHERE id = ?', [serverId], (err, server) => {
      if (err || !server) {
        console.error('❌ Error fetching server:', err?.message || 'server null');
        return resolve('❌ Server tidak ditemukan. Silakan coba lagi.');
      }

      const domain = server.domain;
      const param = `/vps/locktrojan`;
      const web_URL = `http://${domain}${param}`;         // Contoh: http://domain.com/vps/trojan
      const AUTH_TOKEN = server.auth;

      const curlCommand = `curl -s -X PATCH "${web_URL}/${username}" \
-H "Authorization: ${AUTH_TOKEN}" \
-H "accept: application/json"`;

      exec(curlCommand, (_, stdout) => {
        let d;
        try {
          d = JSON.parse(stdout);
        } catch (e) {
          console.error('❌ Gagal parsing JSON:', e.message);
          console.error('🪵 Output:', stdout);
          return resolve('❌ Format respon dari server tidak valid.');
        }

        if (d?.meta?.code !== 200 || !d.data) {
          console.error('❌ Respons error:', d);
          const errMsg = d?.message || d?.meta?.message || JSON.stringify(d, null, 2);
          return resolve(`❌ Respons error:\n${errMsg}`);
        }

        const s = d.data;
        const msg = `✅ *Lock TROJAN Account Success!*

🔄 *Akun berhasil dikunci*
────────────────────────────
👤 *Username*    : \`${s.username}\`
────────────────────────────

✨ Terima kasih telah memperpanjang layanan kami!
*© Telegram Bots - 2025*`;

        return resolve(msg);
      });
    });
  });
}
//create shadowsocks ga ada di potato
  async function lockshadowsocks(username, exp, quota, limitip, serverId) {
    console.log(`Renewing Shadowsocks account for ${username} with expiry ${exp} days, quota ${quota} GB, limit IP ${limitip} on server ${serverId}`);
    
    // Validasi username
  if (!/^[a-z0-9-]+$/.test(username)) {
      return '❌ Username tidak valid. Mohon gunakan hanya huruf dan angka tanpa spasi.';
    }
  
    // Ambil domain dari database
    return new Promise((resolve, reject) => {
      db.get('SELECT * FROM Server WHERE id = ?', [serverId], (err, server) => {
        if (err) {
          console.error('Error fetching server:', err.message);
          return resolve('❌ Server tidak ditemukan. Silakan coba lagi.');
        }
  
        if (!server) return resolve('❌ Server tidak ditemukan. Silakan coba lagi.');
  
        const domain = server.domain;
        const auth = server.auth;
        const param = `:5888/renewshadowsocks?user=${username}&exp=${exp}&quota=${quota}&iplimit=${limitip}&auth=${auth}`;
        const url = `http://${domain}${param}`;
        axios.get(url)
          .then(response => {
            if (response.data.status === "success") {
              const shadowsocksData = response.data.data;
              const msg = `
  🌟 *RENEW SHADOWSOCKS PREMIUM* 🌟
  
  🔹 *Informasi Akun*
  ┌─────────────────────────────
  │ Username: \`${username}\`
  │ Kadaluarsa: \`${vmessData.exp}\`
  │ Kuota: \`${vmessData.quota}\`
  │ Batas IP: \`${shadowsocksData.limitip} IP\`
  └─────────────────────────────
  ✅ Akun ${username} berhasil diperbarui
  ✨ Selamat menggunakan layanan kami! ✨
  `;
           
                console.log('Shadowsocks account renewed successfully');
                return resolve(msg);
              } else {
                console.log('Error renewing Shadowsocks account');
                return resolve(`❌ Terjadi kesalahan: ${response.data.message}`);
              }
            })
          .catch(error => {
            console.error('Error saat memperbarui Shadowsocks:', error);
            return resolve('❌ Terjadi kesalahan saat memperbarui Shadowsocks. Silakan coba lagi nanti.');
          });
      });
    });
  }
  
  module.exports = { lockshadowsocks, locktrojan, lockvless, lockvmess, lockssh };
