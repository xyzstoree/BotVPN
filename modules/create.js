// modules/create.js

const axios = require('axios');
const { exec } = require('child_process');
const sqlite3 = require('sqlite3').verbose();

const db = new sqlite3.Database('./sellvpn.db');

// ===================== KONSTAN & HELPER =====================

const DAYS_IN_MONTH = 30;

// Hitung kuota otomatis berdasarkan quota bulanan per server (kolom Server.quota)
// contoh: quota server = 150 GB -> per hari = 150 / 30 = 5 GB
function calcQuotaFromServer(baseMonthlyQuota, days) {
  const base = Number(baseMonthlyQuota) || 0;
  const d = Number(days) || 0;

  // kalau quota server = 0 atau hari <= 0 → dianggap Unlimited (0)
  if (base <= 0 || d <= 0) return 0;

  const perDay = base / DAYS_IN_MONTH; // contoh: 150 / 30 = 5 GB/hari
  const q = Math.round(perDay * d);    // dibulatkan ke GB terdekat

  // minimal 1 GB kalau hasilnya 0
  return q > 0 ? q : 1;
}

// Update total_create_akun kalau exp di range tertentu
function updateCreateCount(serverId, exp) {
  const days = Number(exp) || 0;
  if (days < 3 || days > 135) {
    console.log(`⚠️ Exp ${days} hari tidak dicatat ke total_create_akun`);
    return;
  }

  db.run(
    'UPDATE Server SET total_create_akun = total_create_akun + 1 WHERE id = ?',
    [serverId],
    (err) => {
      if (err) {
        console.error('⚠️ Gagal update total_create_akun:', err.message);
      } else {
        console.log(`✅ total_create_akun++ untuk serverId ${serverId} (exp=${days})`);
      }
    }
  );
}

// Validasi username: huruf kecil / angka / dash saja
function validateUsername(username) {
  if (!/^[a-z0-9-]+$/.test(username)) {
    return '❌  Username tidak valid. Mohon gunakan hanya huruf kecil, angka, dan tanda - tanpa spasi.';
  }
  return null;
}

// Mapping pesan error “Client ... exists” → pesan custom
function mapDuplicateUsernameError(errMsg) {
  const t = String(errMsg || '').toLowerCase();

  if (
    t.includes('exists') ||
    t.includes('already exist') ||
    t.includes('duplicate') ||
    (t.includes('already') && t.includes('exist'))
  ) {
    return 'Username Akun Sudah Di Gunakan\nMasukan Username Baru!';
  }

  return errMsg;
}

// Safe getter untuk port (biar kalau panel beda struktur gak meledak)
function getPort(obj, key, fallback = '-') {
  try {
    const v = obj?.[key];
    if (v === undefined || v === null || v === '') return fallback;
    return v;
  } catch {
    return fallback;
  }
}


// ===================== API TYPE ROUTER =====================
// api_type 1 = API lama bot ini (/vps/sshvpn, /vps/vmessall, dst)
// api_type 2 = API Potato/BotVPN2 (:5889/createssh, :5889/createvmess, dst)
function getApiType(server) {
  return Number(server?.api_type || 1) === 2 ? 2 : 1;
}

function safeValue(v, fallback = '-') {
  return (v === undefined || v === null || v === '') ? fallback : v;
}

function buildPotatoUrl(server, endpoint, params) {
  const qs = new URLSearchParams({ ...params, auth: server.auth }).toString();
  return `http://${server.domain}:5889/${endpoint}?${qs}`;
}

// Compatibility fallback untuk beberapa API Potato lama yang mengikuti pola BotVPN2.
function buildPotatoLegacyQuotaUrl(server, endpoint, params) {
  const enc = encodeURIComponent;
  return `http://${server.domain}:5889/${endpoint}?user=${enc(params.user)}&exp=${enc(params.exp)}"a=${enc(params.quota)}&iplimit=${enc(params.iplimit)}&auth=${enc(server.auth)}`;
}

function isPotatoSuccess(payload) {
  return payload && String(payload.status || '').toLowerCase() === 'success' && payload.data;
}

function potatoError(payload) {
  return payload?.message || payload?.meta?.message || payload?.error || JSON.stringify(payload || {}, null, 2);
}

async function requestPotato(server, endpoint, params, useLegacyFallback = false) {
  const url = buildPotatoUrl(server, endpoint, params);
  let response;
  try {
    response = await axios.get(url, { timeout: 30000 });
    if (isPotatoSuccess(response.data)) return response.data.data;
    if (!useLegacyFallback) throw new Error(potatoError(response.data));
  } catch (err) {
    if (!useLegacyFallback) throw err;
  }

  // Fallback untuk API yang hanya cocok dengan pola query BotVPN2 lama.
  const legacyUrl = buildPotatoLegacyQuotaUrl(server, endpoint, params);
  response = await axios.get(legacyUrl, { timeout: 30000 });
  if (isPotatoSuccess(response.data)) return response.data.data;
  throw new Error(potatoError(response.data));
}

function formatPotatoSsh(s, username, password, iplimit) {
  const domain = safeValue(s.domain || s.hostname);
  const user = safeValue(s.username, username);
  const pass = safeValue(s.password, password);
  return `
┌─────────────────────
│ㅤ   🔹 *SSH & UDP Account* 🔹
└─────────────────────
┌─────────────────────
│ Host      : \`${domain}\`
│ Username  : \`${user}\`
│ Password  : \`${pass}\`
│ NS        : \`${safeValue(s.ns_domain)}\`
│ Pub Key   : \`${safeValue(s.pubkey)}\`
└─────────────────────
┌─────────────────────
│ Port TLS       : 443,8443
│ Port HTTP      : 80,8080,2086,8880
│ OpenSSH        : 22
│ Dropbear       : 109,110
│ SSH UDP        : 1-65535
│ DNS            : 53,2222
│ BadVPN UDP     : 7300
└─────────────────────
──────────────────────
🔐 *HTTP CUSTOM:* \`${domain}:80@${user}:${pass}\`

🧩 *Payload WS:* \`GET /cdn-cgi/trace HTTP/1.1[crlf]Host: Bug_Kalian[crlf][crlf]GET-RAY / HTTP/1.1[crlf]Host: [host][crlf]Connection: Upgrade[crlf]User-Agent: [ua][crlf]Upgrade: websocket[crlf][crlf]\`
┌─────────────────────
│ Save Account : https://${domain}:81/ssh-${user}.txt
│ Expired      : \`${safeValue(s.expired)}\`
│ Limit IP     : \`${safeValue(s.ip_limit, iplimit)}\`
└─────────────────────
🤖 @xyzstorevpnbot
✨  Selamat menggunakan layanan kami!
`.trim();
}

function formatPotatoVmess(s, quota, limitip) {
  const domain = safeValue(s.domain || s.hostname);
  const user = safeValue(s.username);
  return `
┌─────────────────────
│ㅤ  🔹 *XRAY / VMESS Account* 🔹
└─────────────────────
┌─────────────────────
│ Username : \`${user}\`
│ Domain   : \`${domain}\`
│ Port TLS : 443,8443
│ Port HTTP: 80,8080,2086,8880
│ Port gRPC: 443
│ UUID     : \`${safeValue(s.uuid)}\`
│ Alter ID : 0
│ Security : Auto
│ Network  : Websocket & gRPC
│ Path     : /vmess
│ Path GRPC: vmess-grpc
└─────────────────────
*- URL TLS:* \`${safeValue(s.vmess_tls_link)}\`
──────────────────────
*- URL NTLS:* \`${safeValue(s.vmess_nontls_link)}\`
──────────────────────
*- URL gRPC:* \`${safeValue(s.vmess_grpc_link)}\`
──────────────────────
┌─────────────────────
│ Save Account : https://${domain}:81/vmess-${user}.txt
│ Expired      : \`${safeValue(s.expired)}\`
│ Quota        : \`${safeValue(s.quota, quota === '0' ? 'Unlimited' : quota + ' GB')}\`
│ Limit IP     : \`${safeValue(s.ip_limit, limitip)} IP\`
└─────────────────────
🤖 @xyzstorevpnbot
✨ Selamat menggunakan layanan kami!
`.trim();
}

function formatPotatoVless(s, quota, limitip) {
  const domain = safeValue(s.domain || s.hostname);
  const user = safeValue(s.username);
  return `
┌─────────────────────
│ㅤ  🔹 *XRAY / VLESS Account* 🔹
└─────────────────────
┌─────────────────────
│ Username : \`${user}\`
│ Domain   : \`${domain}\`
│ Port TLS : 443,8443
│ Port HTTP: 80,8080,2086,8880
│ Port gRPC: 443
│ UUID     : \`${safeValue(s.uuid)}\`
│ Security : Auto
│ Network  : Websocket & gRPC
│ Path     : /vless
│ Path GRPC: vless-grpc
└─────────────────────
*- URL TLS:* \`${safeValue(s.vless_tls_link)}\`
──────────────────────
*- URL NTLS:* \`${safeValue(s.vless_nontls_link)}\`
──────────────────────
*- URL gRPC:* \`${safeValue(s.vless_grpc_link)}\`
──────────────────────
┌─────────────────────
│ Save Account : https://${domain}:81/vless-${user}.txt
│ Expired      : \`${safeValue(s.expired)}\`
│ Quota        : \`${safeValue(s.quota, quota === '0' ? 'Unlimited' : quota + ' GB')}\`
│ Limit IP     : \`${safeValue(s.ip_limit, limitip)} IP\`
└─────────────────────
🤖 @xyzstorevpnbot
✨ Selamat menggunakan layanan kami!
`.trim();
}

function formatPotatoTrojan(s, quota, limitip) {
  const domain = safeValue(s.domain || s.hostname);
  const user = safeValue(s.username);
  return `
┌─────────────────────
│ㅤ  🔹 *XRAY / TROJAN Account* 🔹
└─────────────────────
┌─────────────────────
│ Username : \`${user}\`
│ Domain   : \`${domain}\`
│ Port TLS : 443,8443
│ Port HTTP: 80,8080,2086,8880
│ Port gRPC: 443
│ UUID     : \`${safeValue(s.uuid)}\`
│ Network  : Websocket & gRPC
│ Path     : /trojan-ws
│ Path GRPC: trojan-grpc
└─────────────────────
*- URL TLS:* \`${safeValue(s.trojan_tls_link)}\`
──────────────────────
*- URL gRPC:* \`${safeValue(s.trojan_grpc_link)}\`
──────────────────────
┌─────────────────────
│ Save Account : https://${domain}:81/trojan-${user}.txt
│ Expired      : \`${safeValue(s.expired)}\`
│ Quota        : \`${safeValue(s.quota, quota === '0' ? 'Unlimited' : quota + ' GB')}\`
│ Limit IP     : \`${safeValue(s.ip_limit, limitip)} IP\`
└─────────────────────
🤖 @xyzstorevpnbot
✨ Selamat menggunakan layanan kami!
`.trim();
}

function formatPotatoShadowsocks(s, quota, limitip) {
  const domain = safeValue(s.domain || s.hostname);
  const user = safeValue(s.username);
  return `
┌─────────────────────
│ㅤ  🔹 *XRAY / SHADOWSOCKS Account* 🔹
└─────────────────────
┌─────────────────────
│ Username : \`${user}\`
│ Domain   : \`${domain}\`
│ Port TLS : 443,8443
│ Port HTTP: 80,8080,2086,8880
│ Port gRPC: 443
│ UUID     : \`${safeValue(s.uuid)}\`
│ Path     : /ss-ws
│ Path GRPC: ss-grpc
└─────────────────────
*- URL TLS:* \`${safeValue(s.ss_link_ws)}\`
──────────────────────
*- URL NTLS:* \`${safeValue(s.ss_link_nontls)}\`
──────────────────────
*- URL gRPC:* \`${safeValue(s.ss_link_grpc)}\`
──────────────────────
┌─────────────────────
│ Save Account : https://${domain}:81/ss-${user}.txt
│ Expired      : \`${safeValue(s.expired)}\`
│ Quota        : \`${safeValue(s.quota, quota === '0' ? 'Unlimited' : quota + ' GB')}\`
│ Limit IP     : \`${safeValue(s.ip_limit, limitip)} IP\`
└─────────────────────
🤖 @xyzstorevpnbot
✨ Selamat menggunakan layanan kami!
`.trim();
}

async function createSshPotato(username, password, exp, iplimit, server, serverId) {
  try {
    const s = await requestPotato(server, 'createssh', { user: username, password, exp, iplimit });
    updateCreateCount(serverId, exp);
    return formatPotatoSsh(s, username, password, iplimit);
  } catch (error) {
    const { status, msg } = extractPanelErrorMessage(error);
    const mapped = mapDuplicateUsernameError(msg);
    return `❌  Respons error${status ? ` (${status})` : ''}:\n${mapped}`;
  }
}

async function createVmessPotato(username, exp, quota, limitip, server, serverId) {
  try {
    const s = await requestPotato(server, 'createvmess', { user: username, exp, quota, iplimit: limitip }, true);
    updateCreateCount(serverId, exp);
    return formatPotatoVmess(s, quota, limitip);
  } catch (error) {
    const { status, msg } = extractPanelErrorMessage(error);
    const mapped = mapDuplicateUsernameError(msg);
    return `❌  Respons error${status ? ` (${status})` : ''}:\n${mapped}`;
  }
}

async function createVlessPotato(username, exp, quota, limitip, server, serverId) {
  try {
    const s = await requestPotato(server, 'createvless', { user: username, exp, quota, iplimit: limitip }, true);
    updateCreateCount(serverId, exp);
    return formatPotatoVless(s, quota, limitip);
  } catch (error) {
    const { status, msg } = extractPanelErrorMessage(error);
    const mapped = mapDuplicateUsernameError(msg);
    return `❌  Respons error${status ? ` (${status})` : ''}:\n${mapped}`;
  }
}

async function createTrojanPotato(username, exp, quota, limitip, server, serverId) {
  try {
    const s = await requestPotato(server, 'createtrojan', { user: username, exp, quota, iplimit: limitip }, true);
    updateCreateCount(serverId, exp);
    return formatPotatoTrojan(s, quota, limitip);
  } catch (error) {
    const { status, msg } = extractPanelErrorMessage(error);
    const mapped = mapDuplicateUsernameError(msg);
    return `❌  Respons error${status ? ` (${status})` : ''}:\n${mapped}`;
  }
}

async function createShadowsocksPotato(username, exp, quota, limitip, server, serverId) {
  try {
    const s = await requestPotato(server, 'createshadowsocks', { user: username, exp, quota, iplimit: limitip }, true);
    updateCreateCount(serverId, exp);
    return formatPotatoShadowsocks(s, quota, limitip);
  } catch (error) {
    const { status, msg } = extractPanelErrorMessage(error);
    const mapped = mapDuplicateUsernameError(msg);
    return `❌  Respons error${status ? ` (${status})` : ''}:\n${mapped}`;
  }
}

// ===================== SSH (UNLIMITED KUOTA) =====================

// Ambil pesan error dari axios/panel secara aman (tanpa bocorin header/token)
function extractPanelErrorMessage(error) {
  // axios error -> error.response.data biasanya berisi meta/message dari panel
  const status = error?.response?.status;
  const data = error?.response?.data;

  let msg =
    data?.message ||
    data?.meta?.message ||
    data?.meta?.error ||
    '';

  msg = (typeof msg === 'string') ? msg : JSON.stringify(msg);

  // fallback kalau panel gak ngasih message
  if (!msg || msg.trim() === '') {
    // axios timeout / network
    if (error?.code === 'ECONNABORTED') return { status, msg: 'Request timeout ke server panel.' };
    if (error?.code) return { status, msg: `Koneksi ke server panel gagal (${error.code}).` };
    return { status, msg: error?.message || 'Terjadi kesalahan tidak diketahui.' };
  }

  return { status, msg };
}

async function createssh(username, password, exp, iplimit, serverId) {
  console.log(`Creating SSH account for ${username} with expiry ${exp} days, IP limit ${iplimit}`);

  const valErr = validateUsername(username);
  if (valErr) return valErr;

  return new Promise((resolve) => {
    db.get('SELECT * FROM Server WHERE id = ?', [serverId], (err, server) => {
      if (err || !server) {
        console.error('❌  Error fetching server:', err?.message || 'server null');
        return resolve('❌  Server tidak ditemukan. Silakan coba lagi.');
      }

      if (getApiType(server) === 2) {
        return createSshPotato(username, password, exp, iplimit, server, serverId).then(resolve);
      }

      const domain = server.domain;
      const param = `/vps/sshvpn`;
      const web_URL = `http://${domain}${param}`;
      const AUTH_TOKEN = server.auth;
      const days = exp;

      // SSH: kuota tidak dibatasi (Unlimited)
      const KUOTA = '0';
      const LIMIT_IP = iplimit;

      const curlCommand = `curl -s -X POST "${web_URL}" \
-H "Authorization: ${AUTH_TOKEN}" \
-H "Content-Type: application/json" \
-H "Accept: application/json" \
-d '{"expired":${days},"kuota":"${KUOTA}","limitip":"${LIMIT_IP}","password":"${password}","username":"${username}"}'`;

      exec(curlCommand, (_, stdout) => {
        let d;
        try {
          d = JSON.parse(stdout);
        } catch (e) {
          console.error('❌  Gagal parsing JSON:', e.message);
          console.error('🪵 Output:', stdout);
          return resolve('❌  Format respon dari server tidak valid.');
        }

        if (d?.meta?.code !== 200 || !d.data) {
          let errMsg = d?.message || d?.meta?.message || JSON.stringify(d, null, 2);
          errMsg = mapDuplicateUsernameError(errMsg);
          return resolve(`❌  Respons error:\n${errMsg}`);
        }

        const s = d.data;

        // Optional: catat create juga untuk SSH
        updateCreateCount(serverId, exp);

        const portTls   = getPort(s.port || {}, 'tls');
        const portNone  = getPort(s.port || {}, 'none');
        const host      = s.hostname || domain;
        const user      = s.username || username;
        const pass      = s.password || password;
        const expLabel  = s.exp || `${exp} Hari`;
        const timeLabel = s.time || '';

        const msg = `
┌─────────────────────
│ㅤ   🔹 *SSH & UDP Account* 🔹
└─────────────────────
┌─────────────────────
│ Host      : \`${host}\`
│ Username  : \`${user}\`
│ Password  : \`${pass}\`
└─────────────────────
┌─────────────────────
│ Port TLS       : ${portTls}
│ Port NTLS      : ${portNone}
│ Port UDP       : 1-65535
│ DNS Selow      : 5300
│ SSH WS         : 80
│ SSH SSL WS     : 443
│ SSH UDP        : 1-65535
└─────────────────────
──────────────────────
🔐 *SSH WS:* \`${host}:80@${user}:${pass}\`
🔐 *SSH UDP:* \`${host}:1-65535@${user}:${pass}\`

🧩 *Payload WS:* \`GET / HTTP/1.1[crlf]Host: ${host}[crlf]Connection: Upgrade[crlf]User-Agent: [ua][crlf]Upgrade: websocket[crlf][crlf]\`
┌─────────────────────
│ Expired : \`${expLabel}${timeLabel ? ' (' + timeLabel + ')' : ''}\`
│ Limit IP: ${LIMIT_IP}
└─────────────────────
🤖 @xyzstorevpnbot
✨  Selamat menggunakan layanan kami!
`.trim();

        return resolve(msg);
      });
    });
  });
}

// ===================== VMESS =====================
async function createvmess(username, exp, quota, limitip, serverId) {
  console.log(`Creating VMESS account for ${username} with expiry ${exp} days`);

  const valErr = validateUsername(username);
  if (valErr) return valErr;

  return new Promise((resolve) => {
    db.get('SELECT * FROM Server WHERE id = ?', [serverId], (err, server) => {
      if (err || !server) {
        console.error('❌  Error fetching server:', err?.message || 'server null');
        return resolve('❌  Server tidak ditemukan. Silakan coba lagi.');
      }

      if (getApiType(server) === 2) {
        const autoQuota = calcQuotaFromServer(server.quota, exp);
        return createVmessPotato(username, exp, String(autoQuota), limitip, server, serverId).then(resolve);
      }

      const domain = server.domain;
      const param = `/vps/vmessall`;
      const web_URL = `http://${domain}${param}`;
      const AUTH_TOKEN = server.auth;
      const days = exp;

      // === Kuota otomatis dari Server.quota ===
      const autoQuota = calcQuotaFromServer(server.quota, days);
      const KUOTA = String(autoQuota);         // 0 = Unlimited, selain itu = GB
      const LIMIT_IP = limitip;

      const data = {
        expired: days,
        kuota: KUOTA,
        limitip: LIMIT_IP,
        username: username
      };

      axios.post(web_URL, data, {
        headers: {
          Authorization: AUTH_TOKEN,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        }
      })
        .then(response => {
          const d = response.data;
          if (d?.meta?.code !== 200 || !d.data) {
            let errMsg = d?.message || d?.meta?.message || JSON.stringify(d, null, 2);
            errMsg = mapDuplicateUsernameError(errMsg);
            return resolve(`❌  Respons error:\n${errMsg}`);
          }

          const s = d.data;

          // catat total_create_akun kalau exp di range 3–135 hari
          updateCreateCount(serverId, exp);

          // === TEMPLATE LAMA (PERSIS YANG KAMU MAU) ===
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
│ Expired: \`${s.expired}\` (${s.time})
│ Quota: \`${KUOTA === "0" ? "Unlimited" : KUOTA} GB\`
│ Limit IP: \`${LIMIT_IP === "0" ? "Unlimited" : LIMIT_IP} IP\`
└─────────────────────
🤖 @xyzstorevpnbot
✨ Selamat menggunakan layanan kami!
`.trim();

          return resolve(msg);
        })
        .catch((error) => {
          const { status, msg } = extractPanelErrorMessage(error);
          const mapped = mapDuplicateUsernameError(msg);
          if (mapped !== msg) return resolve(`❌  ${mapped}`);
          return resolve(`❌  Respons error${status ? ` (${status})` : ''}:\n${msg}`);
        });
    });
  });
} // <-- ini harus ada (tutup function createvmess)

// ===================== VLESS =====================
async function createvless(username, exp, quota, limitip, serverId) {
  console.log(`Creating VLESS account for ${username} with expiry ${exp} days`);

  const valErr = validateUsername(username);
  if (valErr) return valErr;

  return new Promise((resolve) => {
    db.get('SELECT * FROM Server WHERE id = ?', [serverId], (err, server) => {
      if (err || !server) {
        console.error('❌  Error fetching server:', err?.message || 'server null');
        return resolve('❌  Server tidak ditemukan. Silakan coba lagi.');
      }

      if (getApiType(server) === 2) {
        const autoQuota = calcQuotaFromServer(server.quota, exp);
        return createVlessPotato(username, exp, String(autoQuota), limitip, server, serverId).then(resolve);
      }

      const domain = server.domain;
      const param = `/vps/vlessall`;
      const web_URL = `http://${domain}${param}`;
      const AUTH_TOKEN = server.auth;
      const days = exp;

      // === Kuota otomatis dari Server.quota ===
      const autoQuota = calcQuotaFromServer(server.quota, days);
      const KUOTA = String(autoQuota);         // 0 = Unlimited, selain itu = GB
      const LIMIT_IP = limitip;

      const data = {
        expired: days,
        kuota: KUOTA,
        limitip: LIMIT_IP,
        username: username
      };

      axios.post(web_URL, data, {
        headers: {
          Authorization: AUTH_TOKEN,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        }
      })
        .then(response => {
          const d = response.data;
          if (d?.meta?.code !== 200 || !d.data) {
            let errMsg = d?.message || d?.meta?.message || JSON.stringify(d, null, 2);
            errMsg = mapDuplicateUsernameError(errMsg);
            return resolve(`❌  Respons error:\n${errMsg}`);
          }

          const s = d.data;

          // catat total_create_akun kalau exp di range 3–135 hari
          updateCreateCount(serverId, exp);

          const msg = `
┌─────────────────────
│ㅤ  🔹 *XRAY / VLESS Account* 🔹
└─────────────────────
┌─────────────────────
│ Username : \`${s.username}\`
│ Domain   : \`${s.hostname}\`
│ Port TLS : ${s.port.tls}
│ Port NTLS: ${s.port.none}
│ Port gRPC: 443
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
│ Expired: \`${s.expired}\` (${s.time})
│ Quota: \`${KUOTA === "0" ? "Unlimited" : KUOTA} GB\`
│ Limit IP: \`${LIMIT_IP === "0" ? "Unlimited" : LIMIT_IP} IP\`
└─────────────────────
🤖 @xyzstorevpnbot
✨ Selamat menggunakan layanan kami!
`.trim();

          return resolve(msg);
        })
        .catch((error) => {
          const { status, msg } = extractPanelErrorMessage(error);
          const mapped = mapDuplicateUsernameError(msg);
          if (mapped !== msg) return resolve(`❌  ${mapped}`);
          return resolve(`❌  Respons error${status ? ` (${status})` : ''}:\n${msg}`);
        });
    });
  });
} // <-- ini harus ada (tutup function createvless)

// ===================== TROJAN =====================
async function createtrojan(username, exp, quota, limitip, serverId) {
  console.log(`Creating TROJAN account for ${username} with expiry ${exp} days`);

  const valErr = validateUsername(username);
  if (valErr) return valErr;

  return new Promise((resolve) => {
    db.get('SELECT * FROM Server WHERE id = ?', [serverId], (err, server) => {
      if (err || !server) {
        console.error('❌  Error fetching server:', err?.message || 'server null');
        return resolve('❌  Server tidak ditemukan. Silakan coba lagi.');
      }

      if (getApiType(server) === 2) {
        const autoQuota = calcQuotaFromServer(server.quota, exp);
        return createTrojanPotato(username, exp, String(autoQuota), limitip, server, serverId).then(resolve);
      }

      const domain = server.domain;
      const param = `/vps/trojanall`;
      const web_URL = `http://${domain}${param}`;
      const AUTH_TOKEN = server.auth;
      const days = Number(exp) || 0;

      // === Kuota otomatis dari Server.quota ===
      const autoQuota = calcQuotaFromServer(server.quota, days);
      const KUOTA = String(autoQuota); // "0" = Unlimited
      const LIMIT_IP = String(limitip);

      const data = {
        expired: days,
        kuota: KUOTA,
        limitip: LIMIT_IP,
        username: username
      };

      axios.post(web_URL, data, {
        headers: {
          Authorization: AUTH_TOKEN,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        timeout: 20000
      })
      .then((response) => {
        const d = response.data;

        // Panel balik meta.code != 200 (walau HTTP 200)
        if (d?.meta?.code !== 200 || !d.data) {
          let errMsg = d?.message || d?.meta?.message || JSON.stringify(d, null, 2);
          errMsg = mapDuplicateUsernameError(errMsg);
          return resolve(`❌  Respons error:\n${errMsg}`);
        }

        const s = d.data;

        // catat total_create_akun kalau exp di range 3–135 hari
        updateCreateCount(serverId, days);

        const msg = `
┌─────────────────────
│ㅤ  🔹 *XRAY / TROJAN Account* 🔹
└─────────────────────
┌─────────────────────
│ Username : \`${s.username}\`
│ Domain   : \`${s.hostname}\`
│ Port TLS : ${s.port?.tls}
│ Port NTLS: ${s.port?.none}
│ Port gRPC: 443
│ UUID     : \`${s.uuid}\`
│ Security : Auto
│ Network  : Websocket & gRPC
│ Path     : ${s.path?.stn} | ${s.path?.multi}
│ Path GRPC: ${s.path?.grpc}
└─────────────────────
*- URL TLS:* \`${s.link?.tls}\`
──────────────────────
*- URL gRPC:* \`${s.link?.grpc}\`
──────────────────────
┌─────────────────────
│ Expired : \`${s.expired}\` (${s.time})
│ Quota   : \`${KUOTA === "0" ? "Unlimited" : KUOTA} GB\`
│ Limit IP: \`${LIMIT_IP === "0" ? "Unlimited" : LIMIT_IP} IP\`
└─────────────────────
🤖 @xyzstorevpnbot
✨ Selamat menggunakan layanan kami!
`.trim();

        return resolve(msg);
      })
      .catch((error) => {
        const { status, msg } = extractPanelErrorMessage(error);

        const mapped = mapDuplicateUsernameError(msg);
        if (mapped !== msg) {
          return resolve(`❌  ${mapped}`);
        }

        return resolve(`❌  Respons error${status ? ` (${status})` : ''}:\n${msg}`);
      });
    });
  });
}

// ===================== SHADOWSOCKS (placeholder) =====================
async function createshadowsocks(username, exp, quota, limitip, serverId) {
  const valErr = validateUsername(username);
  if (valErr) return valErr;

  return new Promise((resolve) => {
    db.get('SELECT * FROM Server WHERE id = ?', [serverId], (err, server) => {
      if (err || !server) {
        console.error('❌  Error fetching server:', err?.message || 'server null');
        return resolve('❌  Server tidak ditemukan. Silakan coba lagi.');
      }

      if (getApiType(server) === 2) {
        const autoQuota = calcQuotaFromServer(server.quota, exp);
        return createShadowsocksPotato(username, exp, String(autoQuota), limitip, server, serverId).then(resolve);
      }

      return resolve('❌  Shadowsocks belum dikonfigurasi untuk API lama. Gunakan server api_type 2.');
    });
  });
}

module.exports = {
  createssh,
  createvmess,
  createvless,
  createtrojan,
  createshadowsocks
};


