const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();

const db = new sqlite3.Database(require('path').join(__dirname, '..', 'sellvpn.db'));

async function addIpLimitAccount(type, username, iplimit, serverId) {
  const endpointMap = {
    ssh: '/vps/changelimipsshvpn',
    vmess: '/vps/changelimipvmess',
    vless: '/vps/changelimipvless',
    trojan: '/vps/changelimiptrojan',
    shadowsocks: '/vps/changelimipshadowsocks', // kalau ada
    zivpn: '/vps/changelimipzivpn'              // kalau ada
  };

  const endpoint = endpointMap[type];
  if (!endpoint) {
    throw new Error('Protocol tidak dikenal. Silakan pilih protocol yang benar.');
  }

  // Ambil data server
  const server = await new Promise((resolve, reject) => {
    db.get('SELECT * FROM Server WHERE id = ?', [serverId], (err, row) => {
      if (err) return reject(err);
      if (!row) return reject(new Error('Server tidak ditemukan di database.'));
      resolve(row);
    });
  });

  const url = `http://${server.domain}${endpoint}`;

  const payload = {
    username: username,
    limitip: iplimit
  };

  try {
    const res = await axios.post(url, payload, {
      headers: {
        Authorization: server.auth,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      timeout: 15000
    });

    const d = res.data;

    if (!d || d.meta?.code !== 200) {
      const rawMsg = d?.message || d?.meta?.message || 'User tidak ditemukan.';
      throw new Error(rawMsg);
    }

    return d.data;

} catch (err) {
    // Ambil pesan mentah
    let raw =
      err?.response?.data?.message ||
      err?.response?.data?.meta?.message ||
      err?.message ||
      'Terjadi kesalahan saat menghubungi server.';

    let msg = raw;
    const low = raw.toLowerCase();

    // ====== MAPPING ERROR PANEL KE BAHASA INDONESIA ======
    if (
      low.includes('not found') ||
      low.includes('not exists') ||
      low.includes('does not exist') ||
      low.includes('no such user') ||
      low.includes('client') && low.includes('not')
    ) {
      msg = 'User tidak ditemukan. Pastikan username & protocol sudah benar.';
    }
    else if (low.includes('protocol')) {
      msg = 'Protocol salah. Pastikan pilih jenis akun yang sesuai.';
    }
    else if (low.includes('unauthorized') || low.includes('401')) {
      msg = 'Akses ditolak oleh server. Periksa auth token.';
    }
    else if (low.includes('timeout')) {
      msg = 'Server tidak merespon (timeout). Coba lagi nanti.';
    }
    else if (
      low.includes('connect') ||
      low.includes('econnrefused') ||
      low.includes('network') ||
      low.includes('socket')
    ) {
      msg = 'Gagal terhubung ke server. Server mungkin offline.';
    }

    // lempar versi Indonesia
    throw new Error(msg);
  }
}

module.exports = { addIpLimitAccount };
