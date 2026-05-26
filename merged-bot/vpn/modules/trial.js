const axios = require('axios');
const { exec } = require('child_process');
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database(require('path').join(__dirname, '..', 'sellvpn.db'));
async function trialssh(username, password, exp, iplimit, serverId) {
  console.log(`Creating SSH account for ${username} with expiry ${exp} days, IP limit ${iplimit}, and password ${password}`);

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
      const param = `/vps/trialsshvpn`;
      const web_URL = `http://${domain}${param}`; // misalnya: http://idnusastb.domain.web.id/vps/sshvpn
      const AUTH_TOKEN = server.auth;
      const days = exp;
      const KUOTA = "0"; // jika perlu di-hardcode, bisa diubah jadi parameter juga
      const LIMIT_IP = iplimit;

  const curlCommand = `curl -s -X POST "${web_URL}" \
-H "Authorization: ${AUTH_TOKEN}" \
-H "Content-Type: application/json" \
-H "Accept: application/json" \
-d '{"timelimit":"30m"}'`;

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

     const msg = `
┌─────────────────────
│ㅤ  🔹 *SSH & UDP Account* 🔹
└─────────────────────
┌─────────────────────
│ Host      : \`${s.hostname}\`
│ Username  : \`${s.username}\`
│ Password  : \`${s.password}\`
└─────────────────────
┌─────────────────────
│ Port TLS       : ${s.port.tls}
│ Port NTLS      : ${s.port.none}
│ Port UDP       : 1-65535
│ DNS Selow      : 5300
│ SSH WS         : 80
│ SSH SSL WS     : 443
│ SSH UDP        : 1-65535
└─────────────────────
──────────────────────
🔐 *SSH WS:*  \`${s.hostname}:80@${s.username}:${s.password}\`
🔐 *SSH UDP:* \`${s.hostname}:1-65535@${s.username}:${s.password}\`

🧩 *Payload WS:* \`GET / HTTP/1.1[crlf]Host: ${s.hostname}[crlf]Connection: Upgrade[crlf]User-Agent: [ua][crlf]Upgrade: websocket[crlf][crlf]\`
┌─────────────────────
│ Expired : \`${s.time}\`
│ Limit IP: ${LIMIT_IP}
└─────────────────────
🤖 @xyzstorevpnbot
✨ Selamat menggunakan layanan kami!
`;
        return resolve(msg);
      });
    });
  });
}
async function trialvmess(username, exp, quota, limitip, serverId) {
  console.log(`Creating VMess account for ${username} with expiry ${exp} days, quota ${quota} GB, IP limit ${limitip}`);

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
      const param = `/vps/trialvmessall`;
      const web_URL = `http://${domain}${param}`; // contoh: http://idnusastb.domain.web.id/vps/vmess
      const AUTH_TOKEN = server.auth;
      const days = exp;
      const KUOTA = quota;
      const LIMIT_IP = limitip;

  const curlCommand = `curl -s -X POST "${web_URL}" \
-H "Authorization: ${AUTH_TOKEN}" \
-H "Content-Type: application/json" \
-H "Accept: application/json" \
-d '{"timelimit":"30m"}'`;

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

        const msg = `
┌─────────────────────
│ㅤ  🔹 *XRAY / VMESS Account* 🔹
└─────────────────────
┌─────────────────────
│ Username : \`${s.username}\`
│ Domain   : \`${s.hostname}\`
│ Port TLS : ${s.port.tls}
│ Port NTLS: ${s.port.none}
│ Port gRPC: 443
│ Alter ID : 0
│ UUID     : \`${s.uuid}\`
│ Security : Auto
│ Network  : Websocket & gRPC
│ Path     : ${s.path.stn} | ${s.path.multi}
│ Path GRPC: ${s.path.grpc}
└─────────────────────
*- URL TLS:* \`${s.link.tls}\`
──────────────────────
*- URL NTLS:* \`${s.link.none}\`
──────────────────────
*- URL gRPC:* \`${s.link.grpc}\`
──────────────────────
┌─────────────────────
│ Expired: \`${s.time}\`
│ Quota: \`${KUOTA === "0" ? "Unlimited" : KUOTA} GB\`
│ Limit IP: \`${LIMIT_IP === "0" ? "Unlimited" : LIMIT_IP} IP\`
└─────────────────────
🤖 @xyzstorevpnbot
✨ Selamat menggunakan layanan kami!
`;

        return resolve(msg);
      });
    });
  });
}

async function trialvless(username, exp, quota, limitip, serverId) {
  console.log(`Creating VLESS account for ${username} with expiry ${exp} days, quota ${quota} GB, limit IP ${limitip}`);

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
      const param = `/vps/trialvlessall`;
      const web_URL = `http://${domain}${param}`; // Contoh: http://domainmu.com/vps/vless
      const AUTH_TOKEN = server.auth;
      const days = exp;
      const KUOTA = quota;
      const LIMIT_IP = limitip;

  const curlCommand = `curl -s -X POST "${web_URL}" \
-H "Authorization: ${AUTH_TOKEN}" \
-H "Content-Type: application/json" \
-H "Accept: application/json" \
-d '{"timelimit":"30m"}'`;

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

        const msg = `
┌─────────────────────
│ㅤ   🔹 *XRAY / VLESS Account* 🔹
└─────────────────────
┌─────────────────────
│ Username : \`${s.username}\`
│ Domain   : \`${s.hostname}\`
│ Port TLS : ${s.port.tls}
│ Port NTLS: ${s.port.none}
│ Port gRPC: 443
│ Alter ID : 0
│ UUID     : \`${s.uuid}\`
│ Security : Auto
│ Network  : Websocket & gRPC
│ Path     : ${s.path.stn} | ${s.path.multi}
│ Path GRPC: ${s.path.grpc}
└─────────────────────
*- URL TLS:* \`${s.link.tls}\`
──────────────────────
*- URL NTLS:* \`${s.link.none}\`
──────────────────────
*- URL gRPC:* \`${s.link.grpc}\`
──────────────────────
┌─────────────────────
│ Expired: \`${s.time}\`
│ Quota: \`${KUOTA === "0" ? "Unlimited" : KUOTA} GB\`
│ Limit IP: \`${LIMIT_IP === "0" ? "Unlimited" : LIMIT_IP} IP\`
└─────────────────────
🤖 @xyzstorevpnbot
✨  Selamat menggunakan layanan kami!
`;

        return resolve(msg);
      });
    });
  });
}
async function trialtrojan(username, exp, quota, limitip, serverId) {
  console.log(`Creating Trojan account for ${username} with expiry ${exp} days, quota ${quota} GB, limit IP ${limitip}`);

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
      const param = `/vps/trialtrojanall`;
      const web_URL = `http://${domain}${param}`; // contoh: http://domainmu.com/vps/trojan
      const AUTH_TOKEN = server.auth;
      const days = exp;
      const KUOTA = quota;
      const LIMIT_IP = limitip;

  const curlCommand = `curl -s -X POST "${web_URL}" \
-H "Authorization: ${AUTH_TOKEN}" \
-H "Content-Type: application/json" \
-H "Accept: application/json" \
-d '{"timelimit":"30m"}'`;

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

        const msg = `
┌─────────────────────
│ㅤ 🔹 *XRAY/TROJAN Account* 🔹
└─────────────────────
┌─────────────────────
│ Username : \`${s.username}\`
│ Domain   : \`${s.hostname}\`
│ UUID     : \`${s.uuid}\`
│ Port TLS : ${s.port.tls}
│ Any Port : ${s.port.any}
│ Security : Auto
│ Network  : Ws, gRPC, Upgrade 
│ Path     : ${s.path.stn} | ${s.path.multi}
│ Path GRPC: ${s.path.grpc}
└─────────────────────
*- Link TLS :* \`${s.link.tls}\`
──────────────────────
*-Link gRPC :* \`${s.link.grpc}\`
──────────────────────
*-Link Up TLS :* \`${s.link.uptls}\`

┌─────────────────────
│ Expired: \`${s.time}\`
│ Quota: \`${KUOTA === "0" ? "Unlimited" : KUOTA} GB\`
│ Limit IP: \`${LIMIT_IP === "0" ? "Unlimited" : LIMIT_IP} IP\`
└─────────────────────
🤖 @xyzstorevpnbot
✨ Selamat menggunakan layanan kami!
`;

        return resolve(msg);
      });
    });
  });
}


//create shadowsocks ga ada di potato
async function trialshadowsocks(username, exp, quota, limitip, serverId) {
  console.log(`Creating Shadowsocks account for ${username} with expiry ${exp} days, quota ${quota} GB, limit IP ${limitip} on server ${serverId}`);
  
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
      const param = `:5888/createshadowsocks?user=${username}&exp=${exp}&quota=${quota}&iplimit=${limitip}&auth=${auth}`;
      const url = `http://${domain}${param}`;
      axios.get(url)
        .then(response => {
          if (response.data.status === "success") {
            const shadowsocksData = response.data.data;
            const msg = `
🌟 *AKUN SHADOWSOCKS PREMIUM* 🌟

🔹 *Informasi Akun*
┌─────────────────────
│ *Username* : \`${shadowsocksData.username}\`
│ *Domain*   : \`${shadowsocksData.domain}\`
│ *NS*       : \`${shadowsocksData.ns_domain}\`
│ *Port TLS* : \`443\`
│ *Port HTTP*: \`80\`
│ *Alter ID* : \`0\`
│ *Security* : \`Auto\`
│ *Network*  : \`Websocket (WS)\`
│ *Path*     : \`/shadowsocks\`
│ *Path GRPC*: \`shadowsocks-grpc\`
└─────────────────────
🔐 *URL SHADOWSOCKS TLS*
\`\`\`
${shadowsocksData.ss_link_ws}
\`\`\`
🔒 *URL SHADOWSOCKS GRPC*
\`\`\`
${shadowsocksData.ss_link_grpc}
\`\`\`
🔒 *PUBKEY*
\`\`\`
${shadowsocksData.pubkey}
\`\`\`
┌─────────────────────
│ Expiry: \`${shadowsocksData.expired}\`
│ Quota: \`${shadowsocksData.quota === '0 GB' ? 'Unlimited' : shadowsocksData.quota}\`
│ IP Limit: \`${shadowsocksData.ip_limit === '0' ? 'Unlimited' : shadowsocksData.ip_limit} IP\`
└─────────────────────
Save Account Link: [Save Account](https://${shadowsocksData.domain}:81/shadowsocks-${shadowsocksData.username}.txt)
✨ Selamat menggunakan layanan kami! ✨
`;
              console.log('Shadowsocks account created successfully');
              return resolve(msg);
            } else {
              console.log('Error creating Shadowsocks account');
              return resolve(`❌ Terjadi kesalahan: ${response.data.message}`);
            }
          })
        .catch(error => {
          console.error('Error saat membuat Shadowsocks:', error);
          return resolve('❌ Terjadi kesalahan saat membuat Shadowsocks. Silakan coba lagi nanti.');
        });
    });
  });
}

module.exports = { trialssh, trialvmess, trialvless, trialtrojan, trialshadowsocks }; 



