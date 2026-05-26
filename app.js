const os = require('os');
const sqlite3 = require('sqlite3').verbose();
const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const app = express();
const axios = require('axios');
const { buildPayload, headers, API_URL, parseTransactions } = require('./api-cekpayment-orkut');
const { isUserReseller, addReseller, removeReseller, listResellersSync } = require('./modules/reseller');
const bugProxyTexts = require('./modules/bugproxy_texts');
const bugCategories = bugProxyTexts.bugCategories || [];
const { createzivpn } = require('./modules/createzivpn');
const { renewzivpn } = require('./modules/renewzivpn');
const { trialzivpn } = require('./modules/trialzivpn');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const { createCanvas, loadImage } = require('canvas');
const { buildQrisWithAmount } = require('./modules/qris_emv');

const MIN_DURASI_POIN = 7; // Minimal durasi akun (hari) agar dapat poin
const REDEEM_PACKAGES = [
  { points: 10, bonus: 2000 },   // Nilai: Rp 300/poin
  { points: 20, bonus: 5000 },   // Nilai: Rp 325/poin
  { points: 30, bonus: 9000 },  // Nilai: Rp 333/poin
  { points: 50, bonus: 16000 }   // Nilai: Rp 340/poin (JACKPOT)
];

const BUG_OVERRIDE_PATH = path.join(__dirname, 'modules', 'bugproxy_overrides.json');

function loadBugOverrides() {
  try {
    if (!fs.existsSync(BUG_OVERRIDE_PATH)) return {};
    const raw = fs.readFileSync(BUG_OVERRIDE_PATH, 'utf8');
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch (e) {
    console.error('Gagal load bug overrides:', e);
    return {};
  }
}

function getMonthRangeJakartaMs(date = new Date()) {
  // bikin tanggal berdasarkan WIB (Asia/Jakarta)
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });

  const parts = fmt.formatToParts(date).reduce((a, p) => (a[p.type] = p.value, a), {});
  const y = Number(parts.year);
  const m = Number(parts.month);

  const tzOffsetMs = 7 * 60 * 60 * 1000; // Asia/Jakarta (UTC+7)

  const startMonth = Date.UTC(y, m - 1, 1, 0, 0, 0) - tzOffsetMs;
  const startNext  = Date.UTC(y, m, 1, 0, 0, 0) - tzOffsetMs;

  return { startMonthMs: startMonth, startNextMonthMs: startNext };
}

const ACCOUNT_TRX_TYPES = ['ssh', 'vmess', 'vless', 'trojan', 'zivpn', 'shadowsocks'];

function normalizeEpochMs(ts) {
  const n = Number(ts) || 0;
  // kalau masih detik (10 digit) → kali 1000
  return n > 0 && n < 1e12 ? (n * 1000) : n;
}

function getJakartaOffsetMs() {
  return 7 * 60 * 60 * 1000; // WIB fixed
}

function startOfJakartaDayMs(date = new Date()) {
  const off = getJakartaOffsetMs();
  const local = new Date(date.getTime() + off); // treat as WIB
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const d = local.getUTCDate();
  return Date.UTC(y, m, d, 0, 0, 0) - off;
}

// Fungsi hitung waktu sampai jam 00:00 WIB (Tengah Malam)
function msUntilNextMidnightWIB() {
  const now = Date.now();
  const offset = 7 * 60 * 60 * 1000; // WIB = UTC+7
  
  // Ambil waktu sekarang + offset
  const d = new Date(now + offset);
  
  // Set target ke jam 00:00:00 (Tengah Malam)
  d.setUTCHours(24, 0, 0, 0); 
  
  // Kembalikan ke timestamp UTC asli
  const targetTime = d.getTime() - offset; 
  
  return targetTime - now;
}

// ✅ SCHEDULER BARU: Cek setiap 1 jam (lebih aman & akurat)
// (startCleanupScheduler versi lengkap didefinisikan di bagian bawah file —
// versi lama yang hanya menjalankan cleanup tanpa downgrade reseller telah
// dihapus karena selalu di-override oleh definisi di bawah.)

function cleanupExpiredUserAccounts() {
  const now = Date.now();
  // Toleransi 1 Hari (24 Jam)
  // Akun baru dihapus kalau sudah mati > 24 jam
  const oneDayMs = 24 * 60 * 60 * 1000; 
  const cutoff = now - oneDayMs;

  db.run(`DELETE FROM user_accounts WHERE expire_at > 0 AND expire_at <= ?`, [cutoff], function (err) {
    if (err) { 
      logger.error('❌ Cleanup gagal:', err.message); 
      return; 
    }
    if (this.changes > 0) {
      logger.info(`🧹 Membersihkan ${this.changes} akun yang sudah expired > 24 jam.`);
    } else {
      logger.info('🧹 Tidak ada akun yang perlu dihapus malam ini.');
    }
  });
}

// ♻️ FITUR AUTO-DOWNGRADE RESELLER PASIF & TARGET BULANAN
async function checkAndDowngradeResellers() {
  const resselDbPath = './ressel.db';

  if (!fs.existsSync(resselDbPath)) return;

  try {
    const data = fs.readFileSync(resselDbPath, 'utf8');
    const resselList = data.split('\n').map(line => line.trim()).filter(Boolean);

    if (resselList.length === 0) return;

    const now = Date.now();
    const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000;

    let isModified = false;
    let activeResellers = [];

    for (const userIdStr of resselList) {
      const userId = Number(userIdStr);

      // Ambil 3 data sekaligus dari database:
      // 1. last_ts: Transaksi terakhir (buat cek mati suri)
      // 2. first_ts: Transaksi pertama (buat cek umur reseller)
      // 3. count_vpn: Jumlah buat akun VPN murni 30 hari terakhir
      const stats = await new Promise((resolve) => {
        db.get(
          `SELECT
             MAX(timestamp) as last_ts,
             MIN(timestamp) as first_ts,
             SUM(CASE WHEN timestamp >= ? AND type IN ('ssh', 'vmess', 'vless', 'trojan', 'shadowsocks', 'zivpn') THEN 1 ELSE 0 END) as count_vpn
           FROM transactions
           WHERE user_id = ?`,
          [now - ONE_MONTH_MS, userId],
          (err, row) => resolve(row || { last_ts: 0, first_ts: 0, count_vpn: 0 })
        );
      });

      const lastTxTime = Number(stats.last_ts) || 0;
      const firstTxTime = Number(stats.first_ts) || 0;
      const countVpn = Number(stats.count_vpn) || 0;

      const timeSinceLastTrx = now - lastTxTime;
      const timeSinceFirstTrx = now - firstTxTime;

      let kickReason = null;

      // Syarat 1: Tidak ada aktivitas sama sekali (topup/beli/upgrade) > 30 hari
      if (lastTxTime === 0 || timeSinceLastTrx > ONE_MONTH_MS) {
        kickReason = 'Tidak ada aktivitas transaksi sama sekali selama 30 hari terakhir.';
      }
      // Syarat 2: Pembuatan akun VPN <= 5 dalam 30 hari terakhir.
      // 💡 PENTING: Hanya berlaku untuk reseller yang umur gabungnya sudah > 30 hari.
      // Tujuannya biar reseller yang baru upgrade kemarin tidak langsung ditendang bot hari ini.
      else if (timeSinceFirstTrx > ONE_MONTH_MS && countVpn <= 5) {
        kickReason = `Pembuatan akun VPN di bawah target (Hanya buat ${countVpn} akun dalam 30 hari terakhir, minimal 6 akun).`;
      }

      // Jika ada alasan kick (Syarat 1 atau Syarat 2 terpenuhi)
      if (kickReason) {
        isModified = true;
        logger.info(`♻️ Downgrade Reseller ${userId}: ${kickReason}`);

        // Notif PM ke User
        const msg = 
          `⚠️ *PEMBERITAHUAN SISTEM*\n\n` +
          `Mohon maaf, status *Reseller* Anda telah dicabut otomatis oleh sistem.\n` +
          `*Alasan:* ${kickReason}\n\n` +
          `Status akun Anda saat ini kembali menjadi *Member Biasa*.\n` +
          `Silakan lakukan Upgrade Reseller kembali di menu bot jika ingin mengaktifkan fitur khusus.`;

        bot.telegram.sendMessage(userId, msg, { parse_mode: 'Markdown' }).catch(() => {});

        // Notif ke Grup Admin
        try {
          let userMention = await getUserMentionHtml(userId);
          userMention = userMention ? userMention.replace('@', '') : userId;
          
          const groupMsg =
            `<pre>` +
            `<b>♻️ DOWNGRADE RESELLER</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `👤 User      : ${userMention}\n` +
            `🆔 User ID   : ${userId}\n` +
            `🎭 Role Lama : Reseller\n` +
            `🎭 Role Baru : Member Biasa\n` +
            `📝 Alasan    : ${kickReason}\n` +
            `━━━━━━━━━━━━━━━━━━━━` +
            `</pre>`;

          await bot.telegram.sendMessage(GROUP_ID, groupMsg, { parse_mode: 'HTML' }).catch(() => {});
        } catch (err) {
          logger.error('Error saat menyusun notif grup downgrade:', err.message);
        }

      } else {
        activeResellers.push(userIdStr);
      }
    }

    if (isModified) {
      fs.writeFileSync(resselDbPath, activeResellers.join('\n') + (activeResellers.length ? '\n' : ''), 'utf8');
      logger.info(`✅ Update Reseller selesai. Sisa reseller aktif: ${activeResellers.length} orang.`);
    }

  } catch (err) {
    logger.error('❌ Gagal menjalankan auto-downgrade reseller:', err.message);
  }
}

function startOfJakartaWeekMs(date = new Date()) {
  const off = getJakartaOffsetMs();
  const local = new Date(date.getTime() + off); // WIB
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const d = local.getUTCDate();
  const dow = local.getUTCDay(); // 0=Sun
  const diffToMon = (dow + 6) % 7; // Mon=0
  return Date.UTC(y, m, d - diffToMon, 0, 0, 0) - off;
}

async function getGlobalAccountStats() {
  const now = new Date();
  const { startMonthMs, startNextMonthMs } = getMonthRangeJakartaMs(now);
  const startDayMs = startOfJakartaDayMs(now);
  const startWeekMs = startOfJakartaWeekMs(now);

  const placeholders = ACCOUNT_TRX_TYPES.map(() => '?').join(',');

  const sql = `
    WITH tnorm AS (
      SELECT user_id,
             LOWER(type) AS type,
             CASE WHEN timestamp < 1000000000000 THEN timestamp*1000 ELSE timestamp END AS ts
      FROM transactions
      WHERE LOWER(type) IN (${placeholders})
    )
    SELECT
      SUM(CASE WHEN ts >= ? THEN 1 ELSE 0 END) AS today,
      SUM(CASE WHEN ts >= ? THEN 1 ELSE 0 END) AS week,
      SUM(CASE WHEN ts >= ? AND ts < ? THEN 1 ELSE 0 END) AS month
    FROM tnorm
  `;

  return new Promise((resolve) => {
    db.get(
      sql,
      [...ACCOUNT_TRX_TYPES, startDayMs, startWeekMs, startMonthMs, startNextMonthMs],
      (err, row) => {
        if (err || !row) return resolve({ today: 0, week: 0, month: 0 });
        resolve({
          today: Number(row.today) || 0,
          week: Number(row.week) || 0,
          month: Number(row.month) || 0,
        });
      }
    );
  });
}

async function getTopAccountBuyersThisMonth(limit = 3) {
  const now = new Date();
  const { startMonthMs, startNextMonthMs } = getMonthRangeJakartaMs(now);
  const placeholders = ACCOUNT_TRX_TYPES.map(() => '?').join(',');

  const admins = Array.isArray(adminIds) && adminIds.length ? adminIds : [-1];
  const adminPH = admins.map(() => '?').join(',');

  const MIN_DAYS_TOP3 = 5;

  const sql = `
    WITH tnorm AS (
      SELECT
        user_id,
        COALESCE(amount, 0) AS days,
        CASE WHEN timestamp < 1000000000000 THEN timestamp*1000 ELSE timestamp END AS ts
      FROM transactions
      WHERE LOWER(type) IN (${placeholders})
        AND user_id NOT IN (${adminPH})
    ),
    filt AS (
      SELECT user_id, ts
      FROM tnorm
      WHERE ts >= ? AND ts < ?
        AND days >= ?
    ),
    agg AS (
      SELECT user_id, COUNT(*) AS cnt, MAX(ts) AS last_ts
      FROM filt
      GROUP BY user_id
      ORDER BY cnt DESC, last_ts DESC
      LIMIT ?
    )
    SELECT a.user_id, a.cnt, tu.username
    FROM agg a
    LEFT JOIN tg_users tu ON tu.user_id = a.user_id
    ORDER BY a.cnt DESC, a.last_ts DESC
  `;

  return new Promise((resolve) => {
    db.all(
      sql,
      [...ACCOUNT_TRX_TYPES, ...admins, startMonthMs, startNextMonthMs, MIN_DAYS_TOP3, limit],
      (err, rows) => {
        if (err || !rows) return resolve([]);
        resolve(rows.map(r => ({
          user_id: Number(r.user_id),
          cnt: Number(r.cnt) || 0,
          username: (r.username ? String(r.username).trim() : ''),
        })));
      }
    );
  });
}

async function getTopAccountBuyers(limit = 3) {
  return getTopAccountBuyersThisMonth(limit);
}

function formatTop3Block(topRows) {
  const medals = ['🥇', '🥈', '🥉'];
  const lines = [];

  for (let i = 0; i < Math.min(3, topRows.length); i++) {
    const r = topRows[i];
    const name = r.username ? `${r.username}` : String(r.user_id);
    const cnt = r.cnt ?? r.total ?? 0;
    lines.push(`${medals[i]} ${name} | ${cnt} Akun`);
  }

  if (!lines.length) lines.push('(Belum ada transaksi bulan ini)');

  return [
    'ℹ️ <b>Top 3 Statistik User</b>',
    ...lines
  ].join('\n');
}

// Simpan BUG hasil edit admin ke file JSON
function saveBugOverride(key, value) {
  const data = loadBugOverrides();
  data[key] = value;
  fs.writeFileSync(BUG_OVERRIDE_PATH, JSON.stringify(data, null, 2), 'utf8');
}

// Ambil teks BUG (prioritas ke override, kalau gak ada pakai default)
function getBugText(key) {
  const overrides = loadBugOverrides();

  if (overrides[key]) return overrides[key];           // pakai teks edit dari bot
  if (bugProxyTexts[key]) return bugProxyTexts[key];   // fallback ke teks default
  return 'Teks BUG belum diatur.';
}

// lanjut logger...
const winston = require('winston');
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [${level.toUpperCase()}]: ${message}`;
    })
  ),
  transports: [
    new winston.transports.File({ filename: 'bot-error.log', level: 'error' }),
    new winston.transports.File({ filename: 'bot-combined.log' }),
  ],
});

if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.simple(),
  }));
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const { 
  createssh, 
  createvmess, 
  createvless, 
  createtrojan, 
  createshadowsocks 
} = require('./modules/create');

const { 
  trialssh, 
  trialvmess, 
  trialvless, 
  trialtrojan, 
  trialshadowsocks 
} = require('./modules/trial');

const { 
  renewssh, 
  renewvmess, 
  renewvless, 
  renewtrojan, 
  renewshadowsocks 
} = require('./modules/renew');

const { addIpLimitAccount } = require('./modules/addip');

const { 
  delssh, 
  delvmess, 
  delvless, 
  deltrojan, 
  delshadowsocks 
} = require('./modules/del');

const { 
  lockssh, 
  lockvmess, 
  lockvless, 
  locktrojan, 
  lockshadowsocks 
} = require('./modules/lock');

const { 
  unlockssh, 
  unlockvmess, 
  unlockvless, 
  unlocktrojan, 
  unlockshadowsocks 
} = require('./modules/unlock');

const fsPromises = require('fs/promises');
const trialFile = path.join(__dirname, 'trial.db');
const resselFilePath = path.join(__dirname, 'ressel.db');

// Mengecek apakah user sudah pakai trial hari ini
async function checkTrialAccess(userId) {
  try {
    const data = await fsPromises.readFile(trialFile, 'utf8');
    const trialData = JSON.parse(data);
    const lastAccess = trialData[userId];

    const today = new Date().toISOString().slice(0, 10); // format YYYY-MM-DD
    return lastAccess === today;
  } catch (err) {
    return false; // anggap belum pernah pakai kalau file belum ada
  }
}

async function canCreateNewTopupQr(userId) {
  const now = Date.now();
  const cooldownMs = 5 * 60 * 1000; // 5 menit

  return new Promise((resolve) => {
    db.all(
      `SELECT unique_code, timestamp
       FROM pending_deposits
       WHERE user_id = ? AND status = 'pending'
       ORDER BY timestamp DESC`,
      [userId],
      (err, rows) => {
        if (err) {
          logger.error('canCreateNewTopupQr DB error:', err.message);
          return resolve({ ok: true }); // fail-open biar user tidak stuck
        }

        const pendingCount = rows.length;
        const lastTs = pendingCount ? Number(rows[0].timestamp) : 0;

        // ✅ masih < 2 pending → boleh
        if (pendingCount < 2) {
          return resolve({ ok: true });
        }

        // ❌ sudah 2 pending, cek cooldown
        if (lastTs && (now - lastTs) < cooldownMs) {
          const waitSec = Math.ceil((cooldownMs - (now - lastTs)) / 1000);
          return resolve({
            ok: false,
            reason:
              `⚠️ *Batas Topup Tercapai*\n\n` +
              `Kamu masih punya *${pendingCount} QR Topup* yang belum dibayar.\n\n` +
              `Silakan bayar salah satu dulu, atau tunggu *${waitSec} detik* untuk buat QR baru.\n\n` +
              `_Ini untuk mencegah spam QR._`
          });
        }

        // ✅ sudah lewat 5 menit → boleh lagi
        return resolve({ ok: true });
      }
    );
  });
}

function expireOldPendingDeposits() {
  const now = Date.now();
  const ttlMs = 5 * 60 * 1000; // 5 menit

  db.run(
    `UPDATE pending_deposits
     SET status = 'expired'
     WHERE status = 'pending' AND timestamp <= ?`,
    [now - ttlMs],
    (err) => {
      if (err) logger.error('expireOldPendingDeposits error:', err.message);
    }
  );
}
async function checkServerAccess(serverId, userId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT is_reseller_only FROM Server WHERE id = ?', [serverId], async (err, row) => {
      if (err) return reject(err);
      // jika server tidak ada => tolak (caller menangani pesan)
      if (!row) return resolve({ ok: false, reason: 'not_found' });
      const flag = row.is_reseller_only === 1 || row.is_reseller_only === '1';
      if (!flag) return resolve({ ok: true }); // publik
      // jika reseller-only, cek apakah user terdaftar reseller
      try {
        const isR = await isUserReseller(userId);
        if (isR) return resolve({ ok: true });
        return resolve({ ok: false, reason: 'reseller_only' });
      } catch (e) {
        // fallback: tolak akses
        return resolve({ ok: false, reason: 'reseller_only' });
      }
    });
  });
}

// Menyimpan bahwa user sudah pakai trial hari ini
async function saveTrialAccess(userId) {
  let trialData = {};
  try {
    const data = await fsPromises.readFile(trialFile, 'utf8');
    trialData = JSON.parse(data);
  } catch (err) {
    // file belum ada, lanjut
  }

  const today = new Date().toISOString().slice(0, 10);
  trialData[userId] = today;
  await fsPromises.writeFile(trialFile, JSON.stringify(trialData, null, 2));
}

// Escape text untuk parse_mode: 'HTML' (biar aman kalau ada karakter aneh)
function escapeHtml(str = '') {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}
// Ambil nama server (nama_server / domain) dari DB untuk kebutuhan notifikasi grup
async function getServerName(serverId) {
  return new Promise((resolve) => {
    db.get('SELECT nama_server FROM Server WHERE id = ?', [serverId], (err, row) => {
      if (err || !row) return resolve(`Server ${serverId}`);
      const nama = (row.nama_server || '').trim();
      return resolve(nama || `Server ${serverId}`);
    });
  });
}

const vars = JSON.parse(fs.readFileSync('./.vars.json', 'utf8'));

const BOT_TOKEN = vars.BOT_TOKEN;
const port = vars.PORT || 6969;
const ADMIN = vars.USER_ID; 
const NAMA_STORE = vars.NAMA_STORE || '@ARI_VPN_STORE';
const DATA_QRIS = vars.DATA_QRIS;
const MERCHANT_ID = vars.MERCHANT_ID;
const API_KEY = vars.API_KEY;
const GROUP_ID = vars.GROUP_ID;

// Admin IDs (boleh banyak, pisahkan dengan koma di .vars.json -> USER_ID)
const adminIds = String(ADMIN || '')
  .split(',')
  .map(s => Number(String(s).trim()))
  .filter(Number.isFinite);

// ====================== RESELLER UPGRADE CONFIG ======================
const RESELLER_UPGRADE_CFG = {
  enabled: vars.RESELLER_UPGRADE_ENABLED !== undefined ? Boolean(vars.RESELLER_UPGRADE_ENABLED) : true,
  // Harga upgrade reseller (tanpa bonus)
  price: Number.isFinite(Number(vars.RESELLER_UPGRADE_PRICE)) ? Number(vars.RESELLER_UPGRADE_PRICE) : 50000,
  // Text benefit bisa diubah dari .vars.json (optional)
  benefits:
    (typeof vars.RESELLER_UPGRADE_BENEFITS === 'string' && vars.RESELLER_UPGRADE_BENEFITS.trim())
      ? vars.RESELLER_UPGRADE_BENEFITS.trim()
      : (
        '✅  Akses panel khusus reseller\n' +
        '✅  Bisa jual akun sendiri\n' +
        '✅  Trial Unlimited Untuk Calon Pembeli\n' +
        '✅  Harga akun lebih murah\n' +
        '✅  Prioritas Support'
      ),
};

const RESELLER_ADDIP_CFG = {
  enabled: true,
  pricePerIp: 1000 // default, nanti dioverride dari DB
};

const bot = new Telegraf(BOT_TOKEN);

function requireUsername(ctx) {
  const uname = ctx.from?.username;
  if (uname && uname.trim()) return true;

  if (ctx.updateType === 'callback_query') {
    ctx.answerCbQuery('Buat username dulu ya 🙂', { show_alert: true }).catch(() => {});
  }

  const text =
    `⚠️ <b>USERNAME TELEGRAM WAJIB</b>\n\n` +
    `Akun Telegram kamu belum punya <b>username</b>.\n` +
    `Silakan buat dulu supaya bisa menggunakan bot ini.\n\n` +
    `<b>Cara buat username:</b>\n` +
    `• Telegram → <b>Settings</b>\n` +
    `• Tap <b>Username</b>\n` +
    `• Isi username (<code>Bebas</code>)\n\n` +
    `Setelah ada username, kembali ke bot lalu ketik /start`;

  ctx.reply(text, { parse_mode: 'HTML' }).catch(() => {});
  return false;
}

// ✅ Gate global (Wajib setelah const bot)
bot.use(async (ctx, next) => {
  const uid = Number(ctx.from?.id);

  // admin boleh lewat
  if (adminIds.includes(uid)) return next();

  if (!requireUsername(ctx)) return;
  return next();
});

let ADMIN_USERNAME = '';
logger.info('Bot initialized');

const lastWelcomeMsgId = new Map();

// ====================== TOPUP BONUS CONFIG ======================
const TOPUP_BONUS_CFG = {
  enabled: Boolean(vars.TOPUP_BONUS_ENABLED),
  applyToReseller: Boolean(vars.TOPUP_BONUS_APPLY_RESELLER),
  maxBonus: Number.isFinite(Number(vars.TOPUP_BONUS_MAX)) ? Number(vars.TOPUP_BONUS_MAX) : 0,
  rules: Array.isArray(vars.TOPUP_BONUS_RULES) ? vars.TOPUP_BONUS_RULES : []
};

function pickBonusRule(nominal) {
  const n = Number(nominal) || 0;
  if (!Array.isArray(TOPUP_BONUS_CFG.rules) || TOPUP_BONUS_CFG.rules.length === 0) return null;

  // pilih rule dengan min terbesar yang masih <= nominal
  const sorted = [...TOPUP_BONUS_CFG.rules]
    .map(r => ({ min: Number(r.min) || 0, percent: Number(r.percent) || 0, flat: Number(r.flat) || 0 }))
    .filter(r => r.min > 0 && (r.percent > 0 || r.flat > 0))
    .sort((a, b) => b.min - a.min);

  return sorted.find(r => n >= r.min) || null;
}

async function calcTopupBonus(userId, nominalTopup) {
  if (!TOPUP_BONUS_CFG.enabled) return 0;

  // kalau reseller tidak dapat bonus (default), skip
  if (!TOPUP_BONUS_CFG.applyToReseller) {
    try {
      const isR = await isUserReseller(userId);
      if (isR) return 0;
    } catch (_) {
      // kalau error cek reseller, default aman: anggap tidak dapat bonus
      return 0;
    }
  }

  const rule = pickBonusRule(nominalTopup);
  if (!rule) return 0;

  const nominal = Number(nominalTopup) || 0;
  let bonus = 0;

  if (rule.flat > 0) bonus = rule.flat;
  else bonus = Math.floor(nominal * (rule.percent / 100));

  if (!Number.isFinite(bonus) || bonus < 0) bonus = 0;

  if (TOPUP_BONUS_CFG.maxBonus > 0) {
    bonus = Math.min(bonus, TOPUP_BONUS_CFG.maxBonus);
  }

  return bonus;
}
// ====================== END TOPUP BONUS CONFIG ======================
(async () => {
  try {
    const adminId = Array.isArray(adminIds) ? adminIds[0] : adminIds;
    const chat = await bot.telegram.getChat(adminId);
    ADMIN_USERNAME = chat.username ? `@${chat.username}` : 'Admin';
    logger.info(`Admin username detected: ${ADMIN_USERNAME}`);
  } catch (e) {
    ADMIN_USERNAME = 'Admin';
    logger.warn('Tidak bisa ambil username admin otomatis.');
  }
})();

// ====================== SQLITE INIT ======================
const db = new sqlite3.Database('./sellvpn.db', (err) => {
  if (err) logger.error('Kesalahan koneksi SQLite3:', err.message);
  else logger.info('Terhubung ke SQLite3');
});
// ====================== USER MENTION (UNIFIKASI NOTIF GRUP) ======================
function buildUserMentionHtml(userId, usernameRaw = "") {
  const uid = Number(userId) || 0;
  const uname = String(usernameRaw || "").replace(/^@/, "").trim();
  const label = uname ? `@${escapeHtml(uname)}` : (uid ? `User ${uid}` : "User");
  return uid ? `<a href="tg://user?id=${uid}">${label}</a>` : label;
}

function getCachedUsername(uid) {
  const userId = Number(uid) || 0;
  if (!userId) return Promise.resolve("");
  return new Promise((resolve) => {
    db.get("SELECT username FROM tg_users WHERE user_id = ? LIMIT 1", [userId], (err, row) => {
      if (err || !row) return resolve("");
      const u = row.username ? String(row.username).trim() : "";
      resolve(u);
    });
  });
}

async function getUserMentionHtml(uid) {
  const userId = Number(uid) || 0;
  if (!userId) return "User";

  // 1) cache DB
  const cached = await getCachedUsername(userId).catch(() => "");
  if (cached) return buildUserMentionHtml(userId, cached);

  // 2) fallback getChat (kalau cache kosong)
  try {
    const chat = await bot.telegram.getChat(userId);
    const uname = chat?.username ? String(chat.username).trim() : "";
    return buildUserMentionHtml(userId, uname);
  } catch (_) {
    return buildUserMentionHtml(userId, "");
  }
}

const isDupColErr = (err) => /duplicate column/i.test(String(err?.message || ''));
// settings (untuk set harga Add IP, dll)
db.run(
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`,
  (err) => {
    if (err) logger.error('Kesalahan membuat tabel settings:', err.message);
  }
);

// pending_deposit
db.run(
  `CREATE TABLE IF NOT EXISTS pending_deposits (
    unique_code TEXT PRIMARY KEY,
    user_id INTEGER,
    amount INTEGER,
    original_amount INTEGER,
    timestamp INTEGER,
    status TEXT,
    qr_message_id INTEGER,
    bonus_amount INTEGER DEFAULT 0,
    purpose TEXT DEFAULT "deposit"
  )`,
  (err) => {
    if (err) logger.error('Kesalahan membuat tabel pending_deposits:', err.message);
  }
);

// migrate kolom untuk DB lama (yang belum punya bonus_amount / purpose)
db.run(`ALTER TABLE pending_deposits ADD COLUMN bonus_amount INTEGER DEFAULT 0`, (err) => {
  if (err && !isDupColErr(err)) logger.error('Gagal menambahkan kolom bonus_amount:', err.message);
});
db.run(`ALTER TABLE pending_deposits ADD COLUMN purpose TEXT DEFAULT "deposit"`, (err) => {
  if (err && !isDupColErr(err)) logger.error('Gagal menambahkan kolom purpose:', err.message);
});

// Server
db.run(
  `CREATE TABLE IF NOT EXISTS Server (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT,
    auth TEXT,
    harga INTEGER,
    nama_server TEXT,
    quota INTEGER,
    iplimit INTEGER,
    batas_create_akun INTEGER,
    total_create_akun INTEGER,
    is_reseller_only INTEGER DEFAULT 0,
    api_type INTEGER DEFAULT 1
  )`,
  (err) => {
    if (err) logger.error('Kesalahan membuat tabel Server:', err.message);
    else logger.info('Server table ready');
  }
);

// migrate kolom Server untuk DB lama
db.run(`ALTER TABLE Server ADD COLUMN is_reseller_only INTEGER DEFAULT 0`, (err) => {
  if (err && !isDupColErr(err)) logger.error('Gagal menambahkan kolom is_reseller_only:', err.message);
});
db.run(`ALTER TABLE Server ADD COLUMN api_type INTEGER DEFAULT 1`, (err) => {
  if (err && !isDupColErr(err)) logger.error('Gagal menambahkan kolom api_type:', err.message);
});
db.run(`ALTER TABLE Server ADD COLUMN service TEXT DEFAULT 'ssh'`, (err) => {
  if (err && !isDupColErr(err)) logger.error('Gagal menambahkan kolom service:', err.message);
});
db.run(`UPDATE Server SET service = 'ssh' WHERE service IS NULL OR TRIM(service) = ''`, (err) => {
  if (err) logger.error('Gagal normalisasi kolom service Server:', err.message);
});

// users
db.run(
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER UNIQUE,
    saldo INTEGER DEFAULT 0,
    poin INTEGER DEFAULT 0
  )`,
  (err) => {
    if (err) logger.error('Kesalahan membuat tabel users:', err.message);
    else {
      // Perintah ini aman dijalankan untuk database lama agar kolom poin bertambah
      db.run("ALTER TABLE users ADD COLUMN poin INTEGER DEFAULT 0", () => {});
    }
  }
);
// tg_users (cache username agar TOP transaksi tidak perlu getChat → anti delay)
db.run(
  `CREATE TABLE IF NOT EXISTS tg_users (
    user_id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    updated_at INTEGER
  )`,
  (err) => {
    if (err) logger.error('Kesalahan membuat tabel tg_users:', err.message);
  }
);

function upsertTgUser(from) {
  try {
    const uid = Number(from?.id);
    if (!Number.isFinite(uid)) return;
    const uname = from?.username ? String(from.username).trim() : '';
    const fname = from?.first_name ? String(from.first_name).trim() : '';
    const now = Date.now();
    db.run(
      `INSERT INTO tg_users (user_id, username, first_name, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         username=excluded.username,
         first_name=excluded.first_name,
         updated_at=excluded.updated_at`,
      [uid, uname, fname, now],
      () => {}
    );
  } catch (_) {}
}

// transactions
db.run(
  `CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    amount INTEGER,
    type TEXT,
    reference_id TEXT,
    timestamp INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(user_id)
  )`,
  (err) => {
    if (err) logger.error('Kesalahan membuat tabel transactions:', err.message);
    else logger.info('Transactions table ready');
  }
);
// simpan akun yang pernah dibuat/renew user untuk menu Renew otomatis
db.run(
  `CREATE TABLE IF NOT EXISTS user_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    type TEXT,
    server_id INTEGER,
    username TEXT,
    quota INTEGER,
    iplimit INTEGER,
    total_days INTEGER DEFAULT 0,
    created_at INTEGER,
    last_renew_at INTEGER,
    expire_at INTEGER,
    UNIQUE(user_id, type, server_id, username)
  )`,
  (err) => {
    if (err) logger.error('Kesalahan membuat tabel user_accounts:', err.message);
    else logger.info('Table user_accounts ready');
  }
);

// migrate kolom user_accounts untuk DB lama (aman kalau kolom sudah ada)
db.run(`ALTER TABLE user_accounts ADD COLUMN quota INTEGER`, (err) => {
  if (err && !isDupColErr(err)) logger.error('Gagal menambahkan kolom user_accounts.quota:', err.message);
});
db.run(`ALTER TABLE user_accounts ADD COLUMN iplimit INTEGER`, (err) => {
  if (err && !isDupColErr(err)) logger.error('Gagal menambahkan kolom user_accounts.iplimit:', err.message);
});
db.run(`ALTER TABLE user_accounts ADD COLUMN total_days INTEGER DEFAULT 0`, (err) => {
  if (err && !isDupColErr(err)) logger.error('Gagal menambahkan kolom user_accounts.total_days:', err.message);
});
db.run(`ALTER TABLE user_accounts ADD COLUMN created_at INTEGER`, (err) => {
  if (err && !isDupColErr(err)) logger.error('Gagal menambahkan kolom user_accounts.created_at:', err.message);
});
db.run(`ALTER TABLE user_accounts ADD COLUMN last_renew_at INTEGER`, (err) => {
  if (err && !isDupColErr(err)) logger.error('Gagal menambahkan kolom user_accounts.last_renew_at:', err.message);
});
db.run(`ALTER TABLE user_accounts ADD COLUMN expire_at INTEGER`, (err) => {
  if (err && !isDupColErr(err)) logger.error('Gagal menambahkan kolom user_accounts.expire_at:', err.message);
});

const userState = {};
const upgradeCooldowns = new Map();
logger.info('User state initialized');

function fmtDateId(ms) {
  const t = Number(ms) || 0;
  if (!t) return '-';
  const d = new Date(t);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = d.getFullYear();
  return `${dd}-${mm}-${yy}`;
}

// parse tanggal dari panel (contoh: "02 Feb, 2026" / "2026-02-02" / "02-02-2026") -> ms
function parsePanelToMs(input) {
  if (!input) return 0;
  const s = String(input).trim();

  // ISO / yyyy-mm-dd
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const [_, y, mo, d] = m;
    const dt = new Date(Number(y), Number(mo) - 1, Number(d), 0, 0, 0);
    return dt.getTime();
  }

  // dd-mm-yyyy / dd/mm/yyyy
  m = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (m) {
    const [_, d, mo, y] = m;
    const dt = new Date(Number(y), Number(mo) - 1, Number(d), 0, 0, 0);
    return dt.getTime();
  }

  // "02 Feb, 2026" / "2 Feb 2026"
  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,})\,?\s+(\d{4})/);
  if (m) {
    const day = Number(m[1]);
    const monTxt = m[2].slice(0, 3).toLowerCase();
    const year = Number(m[3]);
    const map = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
    if (map[monTxt] !== undefined) {
      const dt = new Date(year, map[monTxt], day, 0, 0, 0);
      return dt.getTime();
    }
  }

  // fallback Date.parse
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

function extractToFromMsg(msg) {
  const text = String(msg || '');
  const m = text.match(/Sampai:\s*`([^`]+)`/i) || text.match(/Sampai:\s*([^ \n]+)/i);
  return m ? String(m[1]).trim() : '';
}

async function listUserAccounts(userId) {
  return new Promise((resolve) => {
    db.all(
      `SELECT ua.id, ua.user_id, ua.type, ua.server_id, ua.username, ua.quota, ua.iplimit, ua.expire_at,
              s.nama_server AS server_name, s.harga AS server_price, s.quota AS server_quota, s.iplimit AS server_iplimit
       FROM user_accounts ua
       LEFT JOIN Server s ON s.id = ua.server_id
       WHERE ua.user_id = ?
       ORDER BY ua.created_at DESC, ua.id DESC`,
      [userId],
      (err, rows) => {
        if (err) return resolve([]);
        resolve(rows || []);
      }
    );
  });
}

async function getUserAccountById(userId, accountId) {
  return new Promise((resolve) => {
    db.get(
      `SELECT ua.id, ua.user_id, ua.type, ua.server_id, ua.username, ua.quota, ua.iplimit, ua.expire_at,
              s.nama_server AS server_name, s.harga AS server_price, s.quota AS server_quota, s.iplimit AS server_iplimit
       FROM user_accounts ua
       LEFT JOIN Server s ON s.id = ua.server_id
       WHERE ua.user_id = ? AND ua.id = ?`,
      [userId, accountId],
      (err, row) => {
        if (err) return resolve(null);
        resolve(row || null);
      }
    );
  });
}

async function syncUserAccountAfterSuccess({ userId, type, serverId, username, quota, iplimit, expDays, action, expireAtMs }) {
  const days = Number(expDays) || 0;
  if (!userId || !type || !serverId || !username) return;

  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  const existing = await new Promise((resolve) => {
    db.get(
      `SELECT id, total_days, expire_at, created_at, last_renew_at FROM user_accounts
       WHERE user_id = ? AND type = ? AND server_id = ? AND username = ?`,
      [userId, String(type).toLowerCase(), serverId, username],
      (err, row) => resolve(err ? null : (row || null))
    );
  });

  let newExpire = 0;
  if (Number(expireAtMs) > 0) {
    newExpire = Number(expireAtMs);
  } else if (days > 0) {
    const prevExpire = existing?.expire_at ? Number(existing.expire_at) : 0;
    const base = prevExpire > now ? prevExpire : now;
    newExpire = base + (days * dayMs);
  }

  const newTotalDays = (Number(existing?.total_days) || 0) + (days > 0 ? days : 0);

  return new Promise((resolve) => {
    db.run(
      `INSERT INTO user_accounts (user_id, type, server_id, username, quota, iplimit, total_days, created_at, last_renew_at, expire_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, type, server_id, username) DO UPDATE SET
         quota=excluded.quota,
         iplimit=excluded.iplimit,
         total_days=excluded.total_days,
         last_renew_at=excluded.last_renew_at,
         expire_at=excluded.expire_at`,
      [
        userId,
        String(type).toLowerCase(),
        serverId,
        username,
        quota ?? null,
        iplimit ?? null,
        newTotalDays,
        existing?.created_at || now,
        action === 'renew' ? now : (existing?.last_renew_at || 0),
        newExpire || (existing?.expire_at || 0),
      ],
      (err) => {
        if (err) logger.error('syncUserAccountAfterSuccess error:', err.message);
        resolve();
      }
    );
  });
}

// helper edit jika dari callback, reply jika bukan
async function replyOrEdit(ctx, text, extra = {}) {
  if (ctx.update && ctx.update.callback_query) {
    try {
      return await ctx.editMessageText(text, extra);
    } catch (e) {
      // Abaikan error "message is not modified"
      if (String(e?.description || e?.message || '').includes('message is not modified')) {
        return;
      }
      throw e;
    }
  }
  return ctx.reply(text, extra);
}

async function showRenewQuickMenu(ctx, page = 0) {
  const userId = ctx.from.id;
  const rows = await listUserAccounts(userId);

  if (!rows || rows.length === 0) {
    return replyOrEdit(
      ctx,
      "⚠️ <b>Belum ada data akun untuk Renew otomatis.</b>\n\n" +
        "Silakan Renew manual dulu (sekali saja). Setelah itu akun akan muncul di menu Otomatis.",
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[{ text: "🏠 Menu", callback_data: "send_main_menu" }]],
        },
      }
    );
  }

  const perPage = 8;
  const totalPages = Math.max(1, Math.ceil(rows.length / perPage));
  const p = Math.min(Math.max(0, page), totalPages - 1);
  const slice = rows.slice(p * perPage, p * perPage + perPage);

  let text = `⚡ <b>RENEW OTOMATIS (Pilih akun)</b>\n\n`;
  text += `Total akun: <b>${rows.length}</b>\n`;
  text += `Halaman: <b>${p + 1}/${totalPages}</b>\n\n`;

  const now = Date.now();
  const lines = [];

  slice.forEach((a, i) => {
    const expAt = Number(a.expire_at) || 0;
    const isExpired = expAt > 0 && expAt <= now;
    const statusLabel = isExpired ? "❌ EXPIRED" : "✅ AKTIF";
    const no = p * perPage + i + 1;

    lines.push(`${no}. ${a.username} | ${statusLabel} | ${fmtDateId(expAt)}`);
  });

  // satukan jadi 1 blockquote
  text += `<blockquote>${escapeHtml(lines.join("\n"))}</blockquote>\n`;

  const kb = [];
 
   slice.forEach((a, i) => {
    const expAt = Number(a.expire_at) || 0;
    const isExpired = expAt > 0 && expAt <= now;
    const statusLabel = isExpired ? "❌ EXPIRED" : "✅ AKTIF";
    const no = p * perPage + i + 1;

    kb.push([
      {
        text: `${no}. ${a.username} | ${statusLabel}`,
        callback_data: `renew_pick_${a.id}`,
      },
    ]);
  });

  // baris 1: Prev + Next
  const navRow1 = [];
  if (p > 0) navRow1.push({ text: "⬅️ Prev", callback_data: `renew_page_${p - 1}` });
  if (p < totalPages - 1) navRow1.push({ text: "Next ➡️", callback_data: `renew_page_${p + 1}` });
  if (navRow1.length) kb.push(navRow1);

  kb.push([
    { text: "🔁 Refresh", callback_data: `renew_page_${p}` },
    { text: "🏠 Menu", callback_data: "send_main_menu" },
  ]);

  return replyOrEdit(ctx, text, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: kb },
  });
}

function getSetting(key) {
  return new Promise((resolve) => {
    db.get('SELECT value FROM settings WHERE key = ?', [key], (err, row) => {
      if (err || !row) return resolve(null);
      resolve(row.value);
    });
  });
}

function setSetting(key, value) {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      [key, String(value)],
      (err) => {
        if (err) return reject(err);
        resolve(true);
      }
    );
  });
}

(async () => {
  const v = await getSetting('RESELLER_ADDIP_PRICE');
  if (v && !isNaN(v)) {
    RESELLER_ADDIP_CFG.pricePerIp = Number(v);
    logger.info(`Add IP price loaded from DB: ${RESELLER_ADDIP_CFG.pricePerIp}`);
  } else {
    logger.info('Add IP price pakai default:', RESELLER_ADDIP_CFG.pricePerIp);
  }
})();

function ensureUserExists(userId) {
  return new Promise((resolve, reject) => {
    const uid = Number(userId);
    if (!Number.isFinite(uid) || uid <= 0) return resolve(false);

    db.run(
      "INSERT OR IGNORE INTO users (user_id) VALUES (?)",
      [uid],
      (err) => {
        if (err) {
          logger.error("ensureUserExists error:", err.message);
          return reject(err);
        }
        resolve(true);
      }
    );
  });
}

bot.use(async (ctx, next) => {
  try {
    const uid = Number(ctx.from?.id);
    if (Number.isFinite(uid) && uid > 0) {
      await ensureUserExists(uid);
      if (ctx.from) upsertTgUser(ctx.from);
    }
  } catch (e) {
    logger.error("bot.use ensureUserExists error:", e.message);
  }
  return next();
});

function toBlockQuote(text) {
  return String(text)
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

bot.command("start", async (ctx) => {
  try {
    const userId = Number(ctx.from?.id);
    if (!Number.isFinite(userId) || userId <= 0) {
      return ctx.reply("❌ User ID tidak valid.");
    }

    await ensureUserExists(userId);

    const username = ctx.from?.username ? `${ctx.from.username}` : "(tanpa username)";
    const now = new Date();

    const hour = Number(
      new Intl.DateTimeFormat("id-ID", {
        timeZone: "Asia/Jakarta",
        hour: "2-digit",
        hour12: false,
      }).format(now)
    );

    const greeting =
      hour < 11 ? "Selamat pagi" :
      hour < 15 ? "Selamat siang" :
      hour < 18 ? "Selamat sore" : "Selamat malam";

    // Format tanggal & jam WIB
    const options = {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "Asia/Jakarta",
    };

    const dateStr = now.toLocaleDateString("id-ID", options);
    const timeStr = now
      .toLocaleTimeString("id-ID", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Asia/Jakarta",
      })
      .replace(".", ":");

    const topRows = await getTopAccountBuyersThisMonth(3);
    const topBlock = formatTop3Block(topRows);
    const g = await getGlobalAccountStats();
    const globalBlock =
      `📊 <b>Statistik Global</b>\n` +
      `➥ Hari ini   : <b>${g.today}</b> Akun\n` +
      `➥ Minggu ini : <b>${g.week}</b> Akun\n` +
      `➥ Bulan ini  : <b>${g.month}</b> Akun`;

    const welcomeText =
      `<b>${escapeHtml(greeting)}, ${escapeHtml(username)}</b>\n` +
      `${escapeHtml(dateStr)} | ${escapeHtml(timeStr)} WIB\n\n` +
      `${topBlock}\n\n` +
      `${globalBlock}\n\n` +
      `Silahkan klik menu utama di bawah!`;

    const sentMsg = await ctx.reply(welcomeText, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[{ text: "MENU UTAMA", callback_data: "send_main_menu" }]],
      },
    });

    // Simpan message_id
    if (sentMsg?.message_id) lastWelcomeMsgId.set(userId, sentMsg.message_id);
  } catch (e) {
    logger.error("Error /start:", e.message);
    return ctx.reply("❌  Terjadi error saat memproses /start.");
  }
});

bot.command('menu', async (ctx) => {
  const userId = ctx.from.id;
  await ensureUserExists(userId);
  await sendMainMenu(ctx);
});

bot.command('admin', async (ctx) => {
  logger.info('Admin menu requested');
  if (!adminIds.includes(ctx.from.id)) {
    await ctx.reply('🚫 Anda tidak memiliki izin untuk mengakses menu admin.');
    return;
  }
  await sendAdminMenu(ctx);
});

const topUserLabelCache = new Map();

async function getUserLabel(userId) {
  if (topUserLabelCache.has(userId)) {
    return topUserLabelCache.get(userId);
  }

  let label = String(userId);

  try {
    const chat = await bot.telegram.getChat(userId);

    if (chat.username) {
      label = '@' + chat.username;
    } else if (chat.first_name) {
      label = chat.first_name;
    }

  } catch (e) {
    // user belum pernah chat bot / block bot → biarin fallback ke ID
  }

  topUserLabelCache.set(userId, label);
  return label;
}


async function addResellerPoint(userId, durationDays) {
  const days = parseInt(durationDays);
  
  if (isNaN(days) || days <= 0) return;

  let pointsToAdd = 0;

  // --- ATURAN BARU (SESUAI SARAN) ---
  if (days >= 7 && days <= 20) {

      pointsToAdd = 1;       
  } else if (days >= 21 && days <= 59) {

      pointsToAdd = 2;       
  } else if (days >= 60) {
      // Mengcover paket 2 Bulan (60 hari) dst
      pointsToAdd = 3;       
  } else {
      // Di bawah 5 hari (misal trial 1-3 hari) -> ZonK
      return; 
  }

  // ... (Sisa kode sama: cek reseller & update db) ...
  try {
    const isR = await isUserReseller(userId);
    if (!isR) return;
  } catch (e) { return; }

  db.run("UPDATE users SET poin = poin + ? WHERE user_id = ?", [pointsToAdd, userId], function(err) {
    if (!err && this.changes > 0) {
        logger.info(`🎁 Reward: User ${userId} +${pointsToAdd} Poin (${days} hari)`);
        // Notifikasi bonus besar
        if (pointsToAdd >= 2) {
            bot.telegram.sendMessage(userId, 
                `🎁 <b>BONUS POIN!</b>\nOrder <b>${days} hari</b> sukses. Bonus: <b>+${pointsToAdd} Poin</b>.`,
                { parse_mode: 'HTML' }
            ).catch(()=>{});
        }
    }
  });
}

async function sendMainMenuNewMessage(ctx) {
  // trik: panggil sendMainMenu dengan ctx "palsu" yang editMessageText-nya dipaksa gagal
  const ctxForceReply = Object.create(ctx);

  ctxForceReply.editMessageText = async () => {
    // paksa gagal supaya sendMainMenu jatuh ke fallback ctx.reply(...)
    throw new Error('FORCE_REPLY_MODE');
  };

  return await sendMainMenu(ctxForceReply);
}

async function sendMainMenu(ctx) {
  // Ambil data user
  const userId = ctx.from.id;
  const userName = ctx.from.first_name || '-';
  let saldo = 0;
  try {
    const row = await new Promise((resolve, reject) => {
      db.get('SELECT saldo FROM users WHERE user_id = ?', [userId], (err, row) => {
        if (err) reject(err); else resolve(row);
      });
    });
    saldo = row ? row.saldo : 0;
  } catch (e) { saldo = 0; }
// ====================== STATISTIK USER ======================
const now = new Date();
const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay()).getTime();
const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
let userToday = 0, userWeek = 0, userMonth = 0;

// Semua type yang dihitung statistik (TAMBAH ZIVPN)
const STAT_TYPES = `"ssh","vmess","vless","trojan","shadowsocks","zivpn"`;

try {
  userToday = await new Promise((resolve) => {
    db.get(
      `SELECT COUNT(*) as count
       FROM transactions
       WHERE user_id = ? AND timestamp >= ? AND type IN (${STAT_TYPES})`,
      [userId, todayStart],
      (err, row) => resolve(row ? row.count : 0)
    );
  });

  userWeek = await new Promise((resolve) => {
    db.get(
      `SELECT COUNT(*) as count
       FROM transactions
       WHERE user_id = ? AND timestamp >= ? AND type IN (${STAT_TYPES})`,
      [userId, weekStart],
      (err, row) => resolve(row ? row.count : 0)
    );
  });

  userMonth = await new Promise((resolve) => {
    db.get(
      `SELECT COUNT(*) as count
       FROM transactions
       WHERE user_id = ? AND timestamp >= ? AND type IN (${STAT_TYPES})`,
      [userId, monthStart],
      (err, row) => resolve(row ? row.count : 0)
    );
  });
} catch (e) {
  logger.error('Error hitung statistik user:', e.message);
}
// Jumlah pengguna bot
  let jumlahPengguna = 0;
  let isReseller = false;
  let isAdmin = false; // <-- tambahin
  // Cek admin dari USER_ID (.vars.json lewat vars.USER_ID)
  if (typeof ADMIN === 'string') {
    isAdmin = ADMIN.trim() === userId.toString();
  } else if (Array.isArray(ADMIN)) {
    isAdmin = ADMIN.map(a => a.toString().trim()).includes(userId.toString());
  }
  // Cek reseller dari file
  if (fs.existsSync(resselFilePath)) {
    const resellerList = fs.readFileSync(resselFilePath, 'utf8')
      .split('\n')
      .map(x => x.trim())
      .filter(Boolean);
    isReseller = resellerList.includes(userId.toString());
  }
  // Tentukan role (Admin > Reseller > Member)
  let statusReseller = 'Member';
  if (isAdmin) {
    statusReseller = 'Admin';
  } else if (isReseller) {
    statusReseller = 'Reseller';
  }

  try {
    const row = await new Promise((resolve, reject) => {
      db.get('SELECT COUNT(*) AS count FROM users', (err, row) => { if (err) reject(err); else resolve(row); });
    });
    jumlahPengguna = row.count;
  } catch (e) { jumlahPengguna = 0; }

// Latency (dummy, bisa diubah sesuai kebutuhan)
  const latency = (Math.random() * 0.1 + 0.01).toFixed(2);

  // Hitung server publik & server reseller
  const { totalMemberServer, totalResellerServer } = await new Promise((resolve) => {
    db.get(
      `
      SELECT
        SUM(CASE WHEN is_reseller_only = 0 THEN 1 ELSE 0 END) AS totalMemberServer,
        SUM(CASE WHEN is_reseller_only = 1 THEN 1 ELSE 0 END) AS totalResellerServer
      FROM Server
      `,
      [],
      (err, row) => {
        if (err) {
          logger.error('Gagal hitung total server (member/reseller):', err.message);
          return resolve({ totalMemberServer: 0, totalResellerServer: 0 });
        }
        resolve({
          totalMemberServer: row?.totalMemberServer || 0,
          totalResellerServer: row?.totalResellerServer || 0
        });
      }
    );
  });

  // Pilih angka sesuai ROLE yang lagi buka menu
  let totalServer;
  if (statusReseller === 'Reseller') {
    // Kalau user reseller → pakai jumlah server reseller-only
    totalServer = totalResellerServer;
  } else if (statusReseller === 'Admin') {
    // Terserah: admin bisa lihat semua
    totalServer = totalMemberServer + totalResellerServer;
  } else {
    // Member biasa → pakai jumlah server publik
    totalServer = totalMemberServer;
  }

  const messageText = `
╭──────────────────╮
        <b>BOT AUTO ORDER VPN</b> 
╰──────────────────╯
╭─── <b>RINGKASAN AKUN</b>
│ 👤 <b>Username :</b> <code>${userName}!</code>
│ 🎭 <b>Status Role :</b> <code>${statusReseller}</code>
│ 🆔 <b>User ID :</b> <code>${userId}</code>
│ 💰 <b>Saldo :</b> <code>Rp${saldo}</code>
╰──────────────────
╭─── <b>STATISTIK ANDA</b>
│ Hari Ini   : ${userToday} Akun
│ Minggu Ini : ${userWeek} Akun
│ Bulan Ini  : ${userMonth} Akun
╰──────────────────
╭──────────────────
│ <b>Total Server:</b> ${totalServer}
│ <b>Total Pengguna :</b> ${jumlahPengguna}
│ <b>Latency :</b> ${latency} ms
│ <b>Trx Succes:</b> t.me/xyzgrub/1
╰──────────────────

<b>Pilih Opsi Layanan:</b>`;

let keyboard;

if (isReseller) {
  // Keyboard untuk reseller
  keyboard = [
    [
      { text: '➕ Create Akun', callback_data: 'service_create' },
      { text: '📂 Manage Akun', callback_data: 'manage_account_menu' }
    ],
    [
      { text: '❌ Hapus Akun', callback_data: 'service_del' },
      { text: '📶 Cek Server', callback_data: 'cek_service' }
    ],
    [
      { text: '🗝️ Lock Akun', callback_data: 'service_lock' },
      { text: '🔐 Unlock Akun', callback_data: 'service_unlock' }
    ],
    [
      { text: '⌛ Trial Akun', callback_data: 'service_trial' },
      { text: '💰 TopUp Saldo', callback_data: 'topup_saldo' }
    ],
    [
      { text: '➕ Ubah Limit IP', callback_data: 'reseller_addip_menu' }
    ],
    [
      { text: '🐛 Payload/Proxy', callback_data: 'bug_proxy_menu' },
      { text: '🎁 Tukar Poin', callback_data: 'redeem_point_menu' } // <--- TOMBOL POIN RESELLER
    ]
  ];
} else {
  // Keyboard untuk buyer (member biasa)
  keyboard = [
    [
      { text: '➕ Buat Akun', callback_data: 'service_create' },
      { text: '♻️  Perpanjang', callback_data: 'service_renew' }
    ],
    [
      { text: '⌛ Uji Coba', callback_data: 'service_trial' },
      { text: '💰 Isi Saldo', callback_data: 'topup_saldo' }
    ],
    [
      { text: '👤 Hub. Admin', url: 'https://t.me/xyztunnn' },
      { text: '🤖 Bot DOR', url: 'tg://resolve?domain=xyuzppob_bot&start=start' }
    ],
    [
      { text: '⭐ Upgrade Reseller', callback_data: 'upgrade_reseller' }
    ],
  ];
}

  try {
    if (ctx.updateType === 'callback_query') {
      try {
      await ctx.editMessageText(messageText, {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: keyboard }
        });
      } catch (error) {
        // Jika error karena message sudah diedit/dihapus, abaikan
        if (error && error.response && error.response.error_code === 400 &&
            (error.response.description.includes('message is not modified') ||
             error.response.description.includes('message to edit not found') ||
             error.response.description.includes('message can\'t be edited'))
        ) {
          logger.info('Edit message diabaikan karena pesan sudah diedit/dihapus atau tidak berubah.');
    } else {
          logger.error('Error saat mengedit menu utama:', error);
        }
      }
    } else {
      try {
        await ctx.reply(messageText, {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: keyboard }
        });
      } catch (error) {
        logger.error('Error saat mengirim menu utama:', error);
      }
    }
    logger.info('Main menu sent');
  } catch (error) {
    logger.error('Error umum saat mengirim menu utama:', error);
  }
}

bot.command('hapuslog', async (ctx) => {
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Tidak ada izin!');
  try {
    if (fs.existsSync('bot-combined.log')) fs.unlinkSync('bot-combined.log');
    if (fs.existsSync('bot-error.log')) fs.unlinkSync('bot-error.log');
    ctx.reply('Log berhasil dihapus.');
    logger.info('Log file dihapus oleh admin.');
  } catch (e) {
    ctx.reply('Gagal menghapus log: ' + e.message);
    logger.error('Gagal menghapus log: ' + e.message);
  }
});

bot.command('tesnotif', async (ctx) => {
  if (!adminIds.includes(ctx.from.id)) return;
  ctx.reply('🚀 Menjalankan tes notifikasi expired sekarang...');
  await sendExpirationAlerts();
  ctx.reply('✅ Selesai.');
});

bot.command('helpadmin', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!adminIds.includes(userId)) {
    return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.', { parse_mode: 'Markdown' });
  }

const helpMessage = `
*📋 Daftar Perintah Admin:*

1. /addsaldo - Menambahkan saldo ke akun pengguna.
2. /addserver - Menambahkan server baru.
3. /addressel - Menambahkan reseller baru.
4. /delressel - Menghapus ID reseller.
5. /listressel - Menampilkan daftar reseller.
6. /broadcast - Mengirim pesan siaran ke semua pengguna.
7. /editharga - Mengedit harga layanan.
8. /editauth - Mengedit auth server.
9. /editdomain - Mengedit domain server.
10. /editlimitcreate - Mengedit batas pembuatan akun server.
11. /editlimitip - Mengedit batas IP server.
12. /editlimitquota - Mengedit batas quota server.
13. /editnama - Mengedit nama server.
14. /edittotalcreate - Mengedit total pembuatan akun server.
15. /hapuslog - Menghapus log bot.
16. /backup - Menjalankan backup otomatis.
17. /delsaldo - menghapus saldo user jadi 0
18. /broadcastresel - broadcast khusus resseler
19. /setaddip - ubah harga edit limit IP
20. /getaddip - Cek Harga Ubah IP
21. Tombol Admin → 🛰️ Tambah ZIVPN - add server ZIVPN member/public
22. Tombol Admin → 🛒 ZIVPN Reseller - add server ZIVPN khusus reseller
24. /cleandb - clean akun expired
25. /addpoint - add point resssler
26. /tesnotif - notif akun expired

Gunakan perintah ini dengan format yang benar untuk menghindari kesalahan.
`;

  ctx.reply(helpMessage, { parse_mode: 'Markdown' });
});

// Tambahkan di area command Admin
bot.command('cleandb', async (ctx) => {
  if (!adminIds.includes(ctx.from.id)) return;

  const now = Date.now();
  // Hitung cutoff 24 jam lalu
  const cutoff = now - (24 * 60 * 60 * 1000); 

  db.run(
    `DELETE FROM user_accounts WHERE expire_at > 0 AND expire_at <= ?`,
    [cutoff],
    function (err) {
      if (err) return ctx.reply(`❌ Error: ${err.message}`);
      
      const count = this.changes || 0;
      ctx.reply(
        `🧹 *Pembersihan Manual Selesai*\n\n` +
        `Akun dihapus: \`${count}\`\n` +
        `Kriteria: Expired lebih dari 24 jam.\n\n` +
        `_Cek kembali menu Manage Akun._`,
        { parse_mode: 'Markdown' }
      );
    }
  );
});

bot.command('broadcast', async (ctx) => {
  // PAKAI VARIABEL YANG BENAR: adminIds (dari .vars.json)
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.reply('Anda tidak punya izin.');
  }

  let messageToBroadcast = null;
  let broadcastText = null;

  // CASE 1: Balas pesan (foto QR, stiker, video, dll)
  if (ctx.message.reply_to_message) {
    messageToBroadcast = ctx.message.reply_to_message;
  } 
  // CASE 2: Ketik langsung /broadcast tes bro
  else {
    broadcastText = ctx.message.text.split(' ').slice(1).join(' ');
    if (!broadcastText.trim()) {
      return ctx.reply(
        'Cara pakai broadcast:\n\n' +
        '• Balas pesan (foto/stiker/video) → ketik /broadcast\n' +
        '• Atau ketik: /broadcast pesan kamu di sini'
      );
    }
  }

  await ctx.reply('Broadcast sedang dikirim ke semua user...');

  db.all("SELECT user_id FROM users", async (err, rows) => {
    if (err || rows.length === 0) {
      return ctx.reply('Database user kosong.');
    }

    let sukses = 0;
    let gagal = 0;
    let dihapus = 0;

    for (const row of rows) {
      try {
        if (messageToBroadcast) {
          await ctx.telegram.copyMessage(
            row.user_id,
            ctx.chat.id,
            messageToBroadcast.message_id
          );
        } else {
          await ctx.telegram.sendMessage(row.user_id, broadcastText, {
            parse_mode: 'HTML',
            disable_web_page_preview: true
          });
        }
        sukses++;
      } catch (error) {
        gagal++;
        const code = error.response?.error_code;
        if (code === 403 || code === 400 || error.message?.includes('chat not found')) {
          db.run("DELETE FROM users WHERE user_id = ?", [row.user_id]);
          dihapus++;
        }
      }
      await new Promise(r => setTimeout(r, 40)); // anti flood
    }

    ctx.reply(
      `*Broadcast Selesai!*\n\n` +
      `Berhasil  : \`${sukses}\`\n` +
      `Gagal     : \`${gagal}\`\n` +
      `Dihapus   : \`${dihapus}\`\n` +
      `Sisa user : \`${rows.length - dihapus}\``,
      { parse_mode: 'Markdown' }
    );
  });
});
// ====================== AKHIR BROADCAST ======================

bot.command('setaddip', async (ctx) => {
  try {
    const userId = ctx.from.id;

    if (!adminIds.includes(userId)) {
      return ctx.reply('❌ Perintah ini hanya untuk admin.');
    }

    const parts = ctx.message.text.split(' ').filter(Boolean);
    if (parts.length < 2) {
      return ctx.reply('⚠️ Contoh: /setaddip 2000');
    }

    const price = parseInt(parts[1], 10);
    if (!Number.isFinite(price) || price <= 0) {
      return ctx.reply('❌ Harga tidak valid. Masukkan angka > 0.');
    }

    await setSetting('RESELLER_ADDIP_PRICE', price);
    RESELLER_ADDIP_CFG.pricePerIp = price;

    return ctx.reply(
      `✅ *Harga Add IP berhasil diupdate!*\nHarga sekarang: *Rp${price.toLocaleString()}* / 1 IP`,
      { parse_mode: 'Markdown' }
    );

  } catch (e) {
    logger.error('setaddip error:', e.message);
    return ctx.reply('❌ Gagal set harga Add IP.');
  }
});

bot.command('getaddip', async (ctx) => {
  const price = RESELLER_ADDIP_CFG.pricePerIp || 0;
  return ctx.reply(
    `ℹ️ *Harga Add IP Saat Ini*\nRp${Number(price).toLocaleString()} / 1 IP`,
    { parse_mode: 'Markdown' }
  );
});
// ====================== BROADCAST KHUSUS RESELLER ======================
bot.command('broadcastresel', async (ctx) => {
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.reply('Anda tidak punya izin.');
  }

  let messageToBroadcast = null;
  let broadcastText = null;

  // CASE 1: Balas pesan (foto/stiker/video/dll)
  if (ctx.message.reply_to_message) {
    messageToBroadcast = ctx.message.reply_to_message;
  } 
  // CASE 2: /broadcast_reseller isi pesan
  else {
    broadcastText = ctx.message.text.split(' ').slice(1).join(' ');
    if (!broadcastText.trim()) {
      return ctx.reply(
        'Cara pakai broadcast reseller:\n\n' +
        '• Balas pesan (foto/stiker/video) → ketik /broadcast_reseller\n' +
        '• Atau ketik: /broadcast_reseller pesan kamu di sini'
      );
    }
  }

  // Ambil daftar reseller
  let resellerIds;
  try {
    resellerIds = listResellersSync();   // diasumsikan return array string ID telegram
  } catch (e) {
    logger.error('Gagal mengambil list reseller:', e);
    return ctx.reply('❌ Gagal mengambil daftar reseller.');
  }

  if (!Array.isArray(resellerIds) || resellerIds.length === 0) {
    return ctx.reply('⚠️ Daftar reseller kosong.');
  }

  await ctx.reply(`Broadcast sedang dikirim ke ${resellerIds.length} reseller...`);

  let sukses = 0;
  let gagal = 0;
  let dihapus = 0;

  for (const rid of resellerIds) {
    const targetId = parseInt(rid, 10);
    if (!targetId) continue;

    try {
      if (messageToBroadcast) {
        await ctx.telegram.copyMessage(
          targetId,
          ctx.chat.id,
          messageToBroadcast.message_id
        );
      } else {
        await ctx.telegram.sendMessage(targetId, broadcastText, {
          parse_mode: 'HTML',
          disable_web_page_preview: true
        });
      }
      sukses++;
    } catch (error) {
      gagal++;
      const code = error.response?.error_code;
      if (code === 403 || code === 400 || error.message?.includes('chat not found')) {
        dihapus++;
        // optional: bersihkan dari daftar reseller
        try {
          await removeReseller(targetId);
        } catch (e) {
          logger.error(`Gagal removeReseller(${targetId}):`, e);
        }
      }
    }

    // anti flood
    await new Promise(r => setTimeout(r, 40));
  }

  ctx.reply(
    `*Broadcast Reseller Selesai!*\n\n` +
    `Berhasil  : \`${sukses}\`\n` +
    `Gagal     : \`${gagal}\`\n` +
    `Dihapus   : \`${dihapus}\`\n` +
    `Total target : \`${resellerIds.length}\``,
    { parse_mode: 'Markdown' }
  );
});

// ====================== TAMBAH POIN MANUAL (ADMIN) ======================
bot.command('addpoint', async (ctx) => {
  const userId = ctx.message.from.id;
  
  // Cek Izin Admin
  if (!adminIds.includes(userId)) {
      return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.', { parse_mode: 'Markdown' });
  }

  // Parse Argumen
  const args = ctx.message.text.split(' ');
  if (args.length !== 3) {
      return ctx.reply('⚠️ Format salah. Gunakan: `/addpoint <user_id> <jumlah>`\nContoh: `/addpoint 123456789 10`', { parse_mode: 'Markdown' });
  }

  const targetUserId = parseInt(args[1]);
  const amount = parseInt(args[2]);

  // Validasi Angka
  if (isNaN(targetUserId) || isNaN(amount)) {
      return ctx.reply('⚠️ `user_id` dan `jumlah` harus berupa angka.', { parse_mode: 'Markdown' });
  }

  // Cek User di Database
  db.get("SELECT poin FROM users WHERE user_id = ?", [targetUserId], (err, row) => {
      if (err) {
          logger.error('⚠️ Kesalahan saat memeriksa user:', err.message);
          return ctx.reply('❌ Terjadi kesalahan database.');
      }

      if (!row) {
          // Jika user belum ada di tabel users (jarang terjadi tapi mungkin)
          return ctx.reply('⚠️ `user_id` tersebut belum terdaftar di database bot.', { parse_mode: 'Markdown' });
      }

      const oldPoin = row.poin || 0;

      // Eksekusi Tambah Poin
      db.run("UPDATE users SET poin = poin + ? WHERE user_id = ?", [amount, targetUserId], function(errUp) {
          if (errUp) {
              logger.error('⚠️ Gagal update poin:', errUp.message);
              return ctx.reply('❌ Gagal menambahkan poin.');
          }

          const newPoin = oldPoin + amount;

          // Kirim Konfirmasi ke Admin
          ctx.reply(
            `✅ *SUKSES ADD POIN*\n\n` +
            `👤 User ID: \`${targetUserId}\`\n` +
            `➕ Tambah: *${amount} Poin*\n` +
            `💰 Total Poin User: *${newPoin}*`, 
            { parse_mode: 'Markdown' }
          );

          // (Opsional) Notifikasi ke User yang ditambah poinnya
          bot.telegram.sendMessage(targetUserId, 
            `🎉 *SELAMAT!* Admin telah menambahkan *${amount} Poin Reward* ke akun Anda.\n` +
            `Total Poin Anda sekarang: *${newPoin}*\n\n` +
            `_Tukarkan poin dengan saldo di menu Manage Akun!_`,
            { parse_mode: 'Markdown' }
          ).catch(() => {}); // catch error kalau user blokir bot
      });
  });
});

bot.command('addsaldo', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!adminIds.includes(userId)) {
      return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.', { parse_mode: 'Markdown' });
  }

  const args = ctx.message.text.split(' ');
  if (args.length !== 3) {
      return ctx.reply('⚠️ Format salah. Gunakan: `/addsaldo <user_id> <jumlah>`', { parse_mode: 'Markdown' });
  }

  const targetUserId = parseInt(args[1]);
  const amount = parseInt(args[2]);

  if (isNaN(targetUserId) || isNaN(amount)) {
      return ctx.reply('⚠️ `user_id` dan `jumlah` harus berupa angka.', { parse_mode: 'Markdown' });
  }

  if (/\s/.test(args[1]) || /\./.test(args[1]) || /\s/.test(args[2]) || /\./.test(args[2])) {
      return ctx.reply('⚠️ `user_id` dan `jumlah` tidak boleh mengandung spasi atau titik.', { parse_mode: 'Markdown' });
  }

  db.get("SELECT * FROM users WHERE user_id = ?", [targetUserId], (err, row) => {
      if (err) {
          logger.error('⚠️ Kesalahan saat memeriksa `user_id`:', err.message);
          return ctx.reply('⚠️ Kesalahan saat memeriksa `user_id`.', { parse_mode: 'Markdown' });
      }

      if (!row) {
          return ctx.reply('⚠️ `user_id` tidak terdaftar.', { parse_mode: 'Markdown' });
      }

      db.run("UPDATE users SET saldo = saldo + ? WHERE user_id = ?", [amount, targetUserId], function(err) {
          if (err) {
              logger.error('⚠️ Kesalahan saat menambahkan saldo:', err.message);
              return ctx.reply('⚠️ Kesalahan saat menambahkan saldo.', { parse_mode: 'Markdown' });
          }

          if (this.changes === 0) {
              return ctx.reply('⚠️ Pengguna tidak ditemukan.', { parse_mode: 'Markdown' });
          }

          ctx.reply(`✅ Saldo sebesar \`${amount}\` berhasil ditambahkan untuk \`user_id\` \`${targetUserId}\`.`, { parse_mode: 'Markdown' });
      });
  });
});

// 🔻 HAPUS SELURUH SALDO USER (RESET JADI 0)
bot.command('delsaldo', async (ctx) => {
  const adminId = ctx.message.from.id;

  // Hanya admin yang boleh
  if (!adminIds.includes(adminId)) {
    return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.', { parse_mode: 'Markdown' });
  }

  const args = ctx.message.text.split(' ');

  // Format: /delsaldo <user_id>
  if (args.length !== 2) {
    return ctx.reply('⚠️ Format salah. Gunakan: `/delsaldo <user_id>`', { parse_mode: 'Markdown' });
  }

  const targetUserId = parseInt(args[1]);

  // Validasi angka
  if (isNaN(targetUserId) || /\s/.test(args[1]) || /\./.test(args[1])) {
    return ctx.reply('⚠️ `user_id` harus berupa angka tanpa spasi/titik.', { parse_mode: 'Markdown' });
  }

  // Cek user dulu
  db.get("SELECT saldo FROM users WHERE user_id = ?", [targetUserId], (err, row) => {
    if (err) {
      logger.error('⚠️ Kesalahan saat mengambil data user:', err.message);
      return ctx.reply('⚠️ Terjadi kesalahan saat mengambil data user.', { parse_mode: 'Markdown' });
    }

    if (!row) {
      return ctx.reply('⚠️ `user_id` tidak terdaftar.', { parse_mode: 'Markdown' });
    }

    const saldoLama = row.saldo || 0;

    // Reset saldo jadi 0
    db.run("UPDATE users SET saldo = 0 WHERE user_id = ?", [targetUserId], function (err2) {
      if (err2) {
        logger.error('⚠️ Kesalahan saat menghapus saldo user:', err2.message);
        return ctx.reply('⚠️ Gagal menghapus saldo user.', { parse_mode: 'Markdown' });
      }

      if (this.changes === 0) {
        return ctx.reply('⚠️ Pengguna tidak ditemukan.', { parse_mode: 'Markdown' });
      }

      ctx.reply(
        `✅ Saldo user \`${targetUserId}\` berhasil dihapus.\n` +
        `💳 Saldo sebelumnya: \`Rp${saldoLama}\`\n` +
        `💳 Saldo sekarang : \`Rp0\``,
        { parse_mode: 'Markdown' }
      );

      logger.info(`Admin ${adminId} menghapus saldo user ${targetUserId} dari Rp${saldoLama} menjadi Rp0.`);
    });
  });
});

bot.command('checkressel', async (ctx) => {
  const userId = ctx.from.id;
  const isR = await isUserReseller(userId);
  ctx.reply(`ID ${userId} ${isR ? 'adalah reseller ✅' : 'bukan reseller ❌'}`);
});


bot.command('addserver', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!adminIds.includes(userId)) {
      return ctx.reply('⚠️ Anda tidak memiliki izin.', { parse_mode: 'Markdown' });
  }

  // Menggunakan separator '|' agar nama server bisa menggunakan spasi
  const text = ctx.message.text.replace('/addserver', '').trim();
  const parts = text.split('|').map(p => p.trim());

  if (parts.length < 8) {
      return ctx.reply('⚠️ *Format salah!*\nGunakan: `/addserver domain|auth|harga_member|harga_reseller|nama_server|quota|iplimit|batas_create|api_type`\n\napi_type: `1` = API lama, `2` = API Potato/BotVPN2.\nKalau tidak diisi, default `1`.\n\nContoh API lama: `/addserver vpn.com|12345|5000|2500|Server SG|50|2|100|1`\nContoh API Potato: `/addserver vpn2.com|12345|5000|2500|Server SG2|50|2|100|2`', { parse_mode: 'Markdown' });
  }

  const [domain, auth, harga_member, harga_reseller, nama_server, quota, iplimit, batas_create_akun, api_type_raw] = parts;
  const api_type = Number(api_type_raw || 1);
  if (![1, 2].includes(api_type)) {
      return ctx.reply('❌ api_type tidak valid. Gunakan `1` untuk API lama atau `2` untuk API Potato/BotVPN2.', { parse_mode: 'Markdown' });
  }

  // 1. Insert untuk Member (is_reseller_only = 0)
  db.run("INSERT INTO Server (domain, auth, harga, nama_server, quota, iplimit, batas_create_akun, total_create_akun, is_reseller_only, api_type, service) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 'ssh')", 
      [domain, auth, parseInt(harga_member), nama_server, parseInt(quota), parseInt(iplimit), parseInt(batas_create_akun), api_type]);

  // 2. Insert untuk Reseller (is_reseller_only = 1)
  db.run("INSERT INTO Server (domain, auth, harga, nama_server, quota, iplimit, batas_create_akun, total_create_akun, is_reseller_only, api_type, service) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, ?, 'ssh')", 
      [domain, auth, parseInt(harga_reseller), `${nama_server} [RS]`, parseInt(quota), parseInt(iplimit), parseInt(batas_create_akun), api_type], function(err) {
      
      if (err) {
          logger.error('⚠️ Kesalahan saat menambahkan server:', err.message);
          return ctx.reply('❌ Kesalahan saat menambahkan server.', { parse_mode: 'Markdown' });
      }

      ctx.reply(`✅ Server \`${nama_server}\` berhasil ditambahkan sekaligus ke panel **Member** dan **Reseller**!\nAPI Type: ${api_type === 2 ? '2 - Potato/BotVPN2' : '1 - Lama'}`, { parse_mode: 'Markdown' });
  });
});


bot.command('setapitype', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!adminIds.includes(userId)) {
    return ctx.reply('⚠️ Anda tidak memiliki izin.', { parse_mode: 'Markdown' });
  }

  const text = ctx.message.text.replace('/setapitype', '').trim();
  const parts = text.split('|').map(p => p.trim()).filter(Boolean);
  if (parts.length < 2) {
    return ctx.reply(`⚠️ Format salah!
Gunakan: /setapitype domain|api_type
Contoh: /setapitype sg1.domain.com|2

api_type: 1 = API lama, 2 = API Potato/BotVPN2`, { parse_mode: 'Markdown' });
  }

  const [domain, apiTypeRaw] = parts;
  const apiType = Number(apiTypeRaw);
  if (![1, 2].includes(apiType)) {
    return ctx.reply('❌ api_type tidak valid. Gunakan `1` atau `2`.', { parse_mode: 'Markdown' });
  }

  db.run('UPDATE Server SET api_type = ? WHERE domain = ?', [apiType, domain], function(err) {
    if (err) {
      logger.error('Gagal update api_type:', err.message);
      return ctx.reply('❌ Gagal update api_type server.', { parse_mode: 'Markdown' });
    }
    if (this.changes === 0) {
      return ctx.reply('❌ Domain server tidak ditemukan.', { parse_mode: 'Markdown' });
    }
    ctx.reply(`✅ API type untuk server \`${domain}\` diubah ke \`${apiType}\` (${apiType === 2 ? 'Potato/BotVPN2' : 'API lama'}).`, { parse_mode: 'Markdown' });
  });
});

bot.command('editharga', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!adminIds.includes(userId)) {
      return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.', { parse_mode: 'Markdown' });
  }

  const args = ctx.message.text.split(' ');
  if (args.length !== 3) {
      return ctx.reply('⚠️ Format salah. Gunakan: `/editharga <domain> <harga>`', { parse_mode: 'Markdown' });
  }

  const [domain, harga] = args.slice(1);

  if (!/^\d+$/.test(harga)) {
      return ctx.reply('⚠️ `harga` harus berupa angka.', { parse_mode: 'Markdown' });
  }

  db.run("UPDATE Server SET harga = ? WHERE domain = ?", [parseInt(harga), domain], function(err) {
      if (err) {
          logger.error('⚠️ Kesalahan saat mengedit harga server:', err.message);
          return ctx.reply('⚠️ Kesalahan saat mengedit harga server.', { parse_mode: 'Markdown' });
      }

      if (this.changes === 0) {
          return ctx.reply('⚠️ Server tidak ditemukan.', { parse_mode: 'Markdown' });
      }

      ctx.reply(`✅ Harga server \`${domain}\` berhasil diubah menjadi \`${harga}\`.`, { parse_mode: 'Markdown' });
  });
});

bot.command('editnama', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!adminIds.includes(userId)) {
      return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.', { parse_mode: 'Markdown' });
  }

  const args = ctx.message.text.split(' ');
  if (args.length !== 3) {
      return ctx.reply('⚠️ Format salah. Gunakan: `/editnama <domain> <nama_server>`', { parse_mode: 'Markdown' });
  }

  const [domain, nama_server] = args.slice(1);

  db.run("UPDATE Server SET nama_server = ? WHERE domain = ?", [nama_server, domain], function(err) {
      if (err) {
          logger.error('⚠️ Kesalahan saat mengedit nama server:', err.message);
          return ctx.reply('⚠️ Kesalahan saat mengedit nama server.', { parse_mode: 'Markdown' });
      }

      if (this.changes === 0) {
          return ctx.reply('⚠️ Server tidak ditemukan.', { parse_mode: 'Markdown' });
      }

      ctx.reply(`✅ Nama server \`${domain}\` berhasil diubah menjadi \`${nama_server}\`.`, { parse_mode: 'Markdown' });
  });
});

bot.command('editdomain', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!adminIds.includes(userId)) {
      return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.', { parse_mode: 'Markdown' });
  }

  const args = ctx.message.text.split(' ');
  if (args.length !== 3) {
      return ctx.reply('⚠️ Format salah. Gunakan: `/editdomain <old_domain> <new_domain>`', { parse_mode: 'Markdown' });
  }

  const [old_domain, new_domain] = args.slice(1);

  db.run("UPDATE Server SET domain = ? WHERE domain = ?", [new_domain, old_domain], function(err) {
      if (err) {
          logger.error('⚠️ Kesalahan saat mengedit domain server:', err.message);
          return ctx.reply('⚠️ Kesalahan saat mengedit domain server.', { parse_mode: 'Markdown' });
      }

      if (this.changes === 0) {
          return ctx.reply('⚠️ Server tidak ditemukan.', { parse_mode: 'Markdown' });
      }

      ctx.reply(`✅ Domain server \`${old_domain}\` berhasil diubah menjadi \`${new_domain}\`.`, { parse_mode: 'Markdown' });
  });
});

bot.command('editauth', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!adminIds.includes(userId)) {
      return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.', { parse_mode: 'Markdown' });
  }

  const args = ctx.message.text.split(' ');
  if (args.length !== 3) {
      return ctx.reply('⚠️ Format salah. Gunakan: `/editauth <domain> <auth>`', { parse_mode: 'Markdown' });
  }

  const [domain, auth] = args.slice(1);

  db.run("UPDATE Server SET auth = ? WHERE domain = ?", [auth, domain], function(err) {
      if (err) {
          logger.error('⚠️ Kesalahan saat mengedit auth server:', err.message);
          return ctx.reply('⚠️ Kesalahan saat mengedit auth server.', { parse_mode: 'Markdown' });
      }

      if (this.changes === 0) {
          return ctx.reply('⚠️ Server tidak ditemukan.', { parse_mode: 'Markdown' });
      }

      ctx.reply(`✅ Auth server \`${domain}\` berhasil diubah menjadi \`${auth}\`.`, { parse_mode: 'Markdown' });
  });
});

bot.command('editlimitquota', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!adminIds.includes(userId)) {
      return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.', { parse_mode: 'Markdown' });
  }

  const args = ctx.message.text.split(' ');
  if (args.length !== 3) {
      return ctx.reply('⚠️ Format salah. Gunakan: `/editlimitquota <domain> <quota>`', { parse_mode: 'Markdown' });
  }

  const [domain, quota] = args.slice(1);

  if (!/^\d+$/.test(quota)) {
      return ctx.reply('⚠️ `quota` harus berupa angka.', { parse_mode: 'Markdown' });
  }

  db.run("UPDATE Server SET quota = ? WHERE domain = ?", [parseInt(quota), domain], function(err) {
      if (err) {
          logger.error('⚠️ Kesalahan saat mengedit quota server:', err.message);
          return ctx.reply('⚠️ Kesalahan saat mengedit quota server.', { parse_mode: 'Markdown' });
      }

      if (this.changes === 0) {
          return ctx.reply('⚠️ Server tidak ditemukan.', { parse_mode: 'Markdown' });
      }

      ctx.reply(`✅ Quota server \`${domain}\` berhasil diubah menjadi \`${quota}\`.`, { parse_mode: 'Markdown' });
  });
});

bot.command('editlimitip', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!adminIds.includes(userId)) {
      return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.', { parse_mode: 'Markdown' });
  }

  const args = ctx.message.text.split(' ');
  if (args.length !== 3) {
      return ctx.reply('⚠️ Format salah. Gunakan: `/editlimitip <domain> <iplimit>`', { parse_mode: 'Markdown' });
  }

  const [domain, iplimit] = args.slice(1);

  if (!/^\d+$/.test(iplimit)) {
      return ctx.reply('⚠️ `iplimit` harus berupa angka.', { parse_mode: 'Markdown' });
  }

  db.run("UPDATE Server SET iplimit = ? WHERE domain = ?", [parseInt(iplimit), domain], function(err) {
      if (err) {
          logger.error('⚠️ Kesalahan saat mengedit iplimit server:', err.message);
          return ctx.reply('⚠️ Kesalahan saat mengedit iplimit server.', { parse_mode: 'Markdown' });
      }

      if (this.changes === 0) {
          return ctx.reply('⚠️ Server tidak ditemukan.', { parse_mode: 'Markdown' });
      }

      ctx.reply(`✅ Iplimit server \`${domain}\` berhasil diubah menjadi \`${iplimit}\`.`, { parse_mode: 'Markdown' });
  });
});

bot.command('editlimitcreate', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!adminIds.includes(userId)) {
      return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.', { parse_mode: 'Markdown' });
  }

  const args = ctx.message.text.split(' ');
  if (args.length !== 3) {
      return ctx.reply('⚠️ Format salah. Gunakan: `/editlimitcreate <domain> <batas_create_akun>`', { parse_mode: 'Markdown' });
  }

  const [domain, batas_create_akun] = args.slice(1);

  if (!/^\d+$/.test(batas_create_akun)) {
      return ctx.reply('⚠️ `batas_create_akun` harus berupa angka.', { parse_mode: 'Markdown' });
  }

  db.run("UPDATE Server SET batas_create_akun = ? WHERE domain = ?", [parseInt(batas_create_akun), domain], function(err) {
      if (err) {
          logger.error('⚠️ Kesalahan saat mengedit batas_create_akun server:', err.message);
          return ctx.reply('⚠️ Kesalahan saat mengedit batas_create_akun server.', { parse_mode: 'Markdown' });
      }

      if (this.changes === 0) {
          return ctx.reply('⚠️ Server tidak ditemukan.', { parse_mode: 'Markdown' });
      }

      ctx.reply(`✅ Batas create akun server \`${domain}\` berhasil diubah menjadi \`${batas_create_akun}\`.`, { parse_mode: 'Markdown' });
  });
});
bot.command('edittotalcreate', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!adminIds.includes(userId)) {
      return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.', { parse_mode: 'Markdown' });
  }

  const args = ctx.message.text.split(' ');
  if (args.length !== 3) {
      return ctx.reply('⚠️ Format salah. Gunakan: `/edittotalcreate <domain> <total_create_akun>`', { parse_mode: 'Markdown' });
  }

  const [domain, total_create_akun] = args.slice(1);

  if (!/^\d+$/.test(total_create_akun)) {
      return ctx.reply('⚠️ `total_create_akun` harus berupa angka.', { parse_mode: 'Markdown' });
  }

  db.run("UPDATE Server SET total_create_akun = ? WHERE domain = ?", [parseInt(total_create_akun), domain], function(err) {
      if (err) {
          logger.error('⚠️ Kesalahan saat mengedit total_create_akun server:', err.message);
          return ctx.reply('⚠️ Kesalahan saat mengedit total_create_akun server.', { parse_mode: 'Markdown' });
      }

      if (this.changes === 0) {
          return ctx.reply('⚠️ Server tidak ditemukan.', { parse_mode: 'Markdown' });
      }

      ctx.reply(`✅ Total create akun server \`${domain}\` berhasil diubah menjadi \`${total_create_akun}\`.`, { parse_mode: 'Markdown' });
  });
});
async function handleServiceAction(ctx, action) {
  let keyboard;
  if (action === 'create') {
    keyboard = [
      [{ text: '➕ UDP ZIVPN', callback_data: 'create_zivpn' }, { text: '➕ SSH WS', callback_data: 'create_ssh' }],
      [{ text: '➕ VMESS', callback_data: 'create_vmess' }, { text: '➕ VLESS', callback_data: 'create_vless' }],
      [{ text: '➕ TROJAN', callback_data: 'create_trojan' }], /*{ text: 'Buat Shadowsocks', callback_data: 'create_shadowsocks' }*/
      [{ text: '🔙 Menu Utama', callback_data: 'send_main_menu' }]
    ];
} else if (action === 'trial') {
  keyboard = [
    [
      { text: '⌛  Trial ZIVPN', callback_data: 'trial_zivpn' },
      { text: '⌛  Trial SSH', callback_data: 'trial_ssh' }
    ],
    [
      { text: '⌛  Trial VMESS', callback_data: 'trial_vmess' },
      { text: '⌛  Trial VLESS', callback_data: 'trial_vless' }
    ],
    [
      { text: '⌛  Trial TROJAN', callback_data: 'trial_trojan' }
      // { text: '⌛  Trial Shadowsocks', callback_data: 'trial_shadowsocks' }
    ],
    [
      { text: '🔙 Kembali', callback_data: 'send_main_menu' }
    ]
  ];
  } else if (action === 'renew') {
    keyboard = [
      [{ text: '♻️ Perpanjang SSH & UDP', callback_data: 'renew_ssh' }],
      [{ text: '♻️ Perpanjang VMESS Ws & Grpc', callback_data: 'renew_vmess' }],
      [{ text: '♻️ Perpanjang VLESS Ws & Grpc', callback_data: 'renew_vless' }],
      [{ text: '♻️ Perpanjang TROJAN Ws & Grpc', callback_data: 'renew_trojan' }], /*{ text: 'Perpanjang Shadowsocks', callback_data: 'renew_shadowsocks' }*/
      [{ text: '🔙 Menu Utama', callback_data: 'send_main_menu' }],
    ];
  } else if (action === 'del') {
    keyboard = [
      [{ text: 'Hapus Ssh/Ovpn', callback_data: 'del_ssh' }],      
      [{ text: 'Hapus Vmess', callback_data: 'del_vmess' }, { text: 'Hapus Vless', callback_data: 'del_vless' }],
      [{ text: 'Hapus Trojan', callback_data: 'del_trojan' }, { text: '🔙 Kembali', callback_data: 'send_main_menu' }],
    ];
  } else if (action === 'lock') {
    keyboard = [
      [{ text: 'Lock Ssh/Ovpn', callback_data: 'lock_ssh' }],      
      [{ text: 'Lock Vmess', callback_data: 'lock_vmess' }, { text: 'Lock Vless', callback_data: 'lock_vless' }],
      [{ text: 'Lock Trojan', callback_data: 'lock_trojan' }, { text: '🔙 Kembali', callback_data: 'send_main_menu' }],
    ];
  } else if (action === 'unlock') {
    keyboard = [
      [{ text: 'Unlock Ssh/Ovpn', callback_data: 'unlock_ssh' }],      
      [{ text: 'Unlock Vmess', callback_data: 'unlock_vmess' }, { text: 'Unlock Vless', callback_data: 'unlock_vless' }],
      [{ text: 'Unlock Trojan', callback_data: 'unlock_trojan' }, { text: '🔙 Kembali', callback_data: 'send_main_menu' }],
    ];
  } 
  try {
    await ctx.editMessageReplyMarkup({
      inline_keyboard: keyboard
    });
    logger.info(`${action} service menu sent`);
  } catch (error) {
    if (error.response && error.response.error_code === 400) {
      await ctx.reply(`Pilih jenis layanan yang ingin Anda ${action}:`, {
        reply_markup: {
          inline_keyboard: keyboard
        }
      });
      logger.info(`${action} service menu sent as new message`);
    } else {
      logger.error(`Error saat mengirim menu ${action}:`, error);
    }
  }
}
async function sendAdminMenu(ctx) {
  const adminKeyboard = [
    [
      { text: '➕ Tambah Server', callback_data: 'addserver' },
      { text: '❌ Hapus Server', callback_data: 'deleteserver' }
    ],
    [
      { text: '🛰️ Tambah ZIVPN', callback_data: 'addserver_zivpn' },
      { text: '🛒 ZIVPN Reseller', callback_data: 'addserver_zivpn_reseller' }
    ],
    [
      { text: '💲 Edit Harga', callback_data: 'editserver_harga' },
      { text: '📝 Edit Nama', callback_data: 'nama_server_edit' }
    ],
    [
      { text: '🌐 Edit Domain', callback_data: 'editserver_domain' },
      { text: '🔑 Edit Auth', callback_data: 'editserver_auth' }
    ],
    [
      { text: '📊 Edit Quota', callback_data: 'editserver_quota' },
      { text: '📶 Edit Limit IP', callback_data: 'editserver_limit_ip' }
    ],
    [
      { text: '🔢 Edit Batas Create', callback_data: 'editserver_batas_create_akun' },
      { text: '🔢 Edit Total Create', callback_data: 'editserver_total_create_akun' }
    ],
    [
      { text: '💵 Tambah Saldo', callback_data: 'addsaldo_user' },
      { text: '📋 List Server', callback_data: 'listserver' }
    ],
   [
    { text: '💳 Lihat Saldo User', callback_data: 'cek_saldo_user'},
    { text: '♻️ Restart bot', callback_data: 'restart_bot'}
    ],
    [
      { text: '♻️ Reset Server', callback_data: 'resetdb' },
      { text: 'ℹ️ Detail Server', callback_data: 'detailserver' }
    ],
    [
      { text: '📑 ADD BUG & PROXY', callback_data: 'admin_edit_bug' }
    ],
    [
      { text: '🔙 Kembali', callback_data: 'send_main_menu' }
    ]
  ];

  try {
    await ctx.editMessageReplyMarkup({
      inline_keyboard: adminKeyboard
    });
    logger.info('Admin menu sent');
  } catch (error) {
    if (error.response && error.response.error_code === 400) {
      await ctx.reply('Menu Admin:', {
        reply_markup: {
          inline_keyboard: adminKeyboard
        }
      });
      logger.info('Admin menu sent as new message');
    } else {
      logger.error('Error saat mengirim menu admin:', error);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// BACKUP UTILITY (native, tidak bergantung script /usr/bin/backup_sellvpn)
// ─────────────────────────────────────────────────────────────────────
const BOT_DIR = __dirname;
const BACKUP_DB_FILES = ['sellvpn.db', 'trial.db', 'ressel.db', 'database.db'];

async function runBackup({ targetIds, label = 'Manual' } = {}) {
  const ids = (targetIds && targetIds.length ? targetIds : adminIds).filter(Boolean);
  if (!ids.length) {
    logger.warn('[BACKUP] Tidak ada admin ID tujuan, backup di-skip.');
    return { sent: 0, missing: [], errors: [] };
  }

  const sent = [];
  const missing = [];
  const errors = [];
  const stamp = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false });

  for (const dbName of BACKUP_DB_FILES) {
    const filePath = path.join(BOT_DIR, dbName);
    if (!fs.existsSync(filePath)) {
      missing.push(dbName);
      continue;
    }
    let size = 0;
    try { size = fs.statSync(filePath).size; } catch (_) {}
    if (size <= 0) {
      // Telegram menolak dokumen kosong — skip dengan rapi
      missing.push(`${dbName} (kosong)`);
      logger.warn(`[BACKUP] Skip ${dbName} karena file kosong (0 byte).`);
      continue;
    }
    for (const adminId of ids) {
      try {
        await bot.telegram.sendDocument(
          adminId,
          { source: filePath, filename: dbName },
          { caption: `🗄️ Backup ${label} — ${dbName} (${size} B)\n🕒 ${stamp} WIB` }
        );
        sent.push(`${dbName} → ${adminId}`);
      } catch (err) {
        const reason =
          err?.response?.description ||
          err?.description ||
          err?.message ||
          String(err);
        errors.push(`${dbName} → ${adminId}: ${reason}`);
        logger.error(`[BACKUP] Gagal kirim ${dbName} ke ${adminId}: ${reason}`);
      }
    }
  }
  logger.info(`[BACKUP][${label}] sent=${sent.length} missing=${missing.length} errors=${errors.length}`);
  return { sent, missing, errors };
}

bot.command('backup', async (ctx) => {
  try {
    const requesterId = ctx.from.id;
    if (!adminIds.includes(requesterId)) {
      return ctx.reply('🚫 Anda tidak memiliki izin untuk menjalankan perintah ini.');
    }

    await ctx.reply('⚙️ Menjalankan backup... Mohon tunggu sebentar.');

    const { sent, missing, errors } = await runBackup({
      targetIds: [requesterId],
      label: 'Manual'
    });

    let msg = `✅ Backup selesai.\n\n📤 Terkirim: ${sent.length} file`;
    if (missing.length) msg += `\n⚠️ Tidak ditemukan: ${missing.join(', ')}`;
    if (errors.length)  msg += `\n❌ Error: ${errors.length}\n${errors.slice(0, 3).join('\n')}`;
    await ctx.reply(msg);
  } catch (e) {
    logger.error('❌ Exception di command /backup:', e);
    await ctx.reply(`❌ Terjadi kesalahan internal saat memproses backup.\n${e.message}`);
  }
});

bot.command('addressel', async (ctx) => {
  try {
    const requesterId = ctx.from.id;

    // Hanya admin yang bisa menjalankan perintah ini
    if (!adminIds.includes(requesterId)) {
      return ctx.reply('🚫 Anda tidak memiliki izin untuk melakukan tindakan ini.');
    }

    // Ambil ID Telegram dari argumen
    const args = ctx.message.text.split(' ');
    if (args.length < 2) {
      return ctx.reply('❌ Format salah. Gunakan perintah:\n/addressel <id_telegram_user>');
    }

    const targetId = args[1];

    // Baca file ressel.db jika ada, kalau tidak, buat file baru
    let resellerList = [];
    if (fs.existsSync(resselFilePath)) {
      const fileContent = fs.readFileSync(resselFilePath, 'utf8');
      resellerList = fileContent.split('\n').filter(line => line.trim() !== '');
    }

    // Cek apakah ID sudah ada
    if (resellerList.includes(targetId)) {
      return ctx.reply(`⚠️ User dengan ID ${targetId} sudah menjadi reseller.`);
    }

    // Tambahkan ID ke file
    fs.appendFileSync(resselFilePath, `${targetId}\n`);
    ctx.reply(`✅ User dengan ID ${targetId} berhasil dijadikan reseller.`);

  } catch (e) {
    logger.error('❌ Error di command /addressel:', e.message);
    ctx.reply('❌ Terjadi kesalahan saat menjalankan perintah.');
  }
});

bot.command('listressel', async (ctx) => {
  try {
    const requesterId = ctx.from.id;

    // Hanya admin yang bisa menjalankan perintah ini
    if (!adminIds.includes(requesterId)) {
      return ctx.reply('🚫 Anda tidak memiliki izin untuk melakukan tindakan ini.');
    }

    // Baca file ressel.db
    let resellerList = [];
    if (fs.existsSync(resselFilePath)) {
      const fileContent = fs.readFileSync(resselFilePath, 'utf8');
      resellerList = fileContent.split('\n').filter(line => line.trim() !== '');
    }

    if (resellerList.length === 0) {
      return ctx.reply('⚠️ Saat ini belum ada reseller yang terdaftar.');
    }

    // Buat pesan daftar reseller
    let message = '📋 *Daftar Reseller:* \n\n';
    resellerList.forEach((id, index) => {
      message += `${index + 1}. ID Telegram: ${id}\n`;
    });

    ctx.reply(message, { parse_mode: 'Markdown' });

  } catch (e) {
    logger.error('❌ Error di command /listressel:', e.message);
    ctx.reply('❌ Terjadi kesalahan saat menampilkan daftar reseller.');
  }
});

bot.command('delressel', async (ctx) => {
  try {
    const requesterId = ctx.from.id;

    // Hanya admin yang bisa menjalankan perintah ini
    if (!adminIds.includes(requesterId)) {
      return ctx.reply('🚫 Anda tidak memiliki izin untuk melakukan tindakan ini.');
    }

    // Ambil ID Telegram dari argumen
    const args = ctx.message.text.split(' ');
    if (args.length < 2) {
      return ctx.reply('❌ Format salah. Gunakan perintah:\n/delressel <id_telegram_user>');
    }

    const targetId = args[1];

    // Cek apakah file ressel.db ada
    if (!fs.existsSync(resselFilePath)) {
      return ctx.reply('📁 File reseller belum dibuat.');
    }

    // Baca file dan filter ulang tanpa targetId
    const fileContent = fs.readFileSync(resselFilePath, 'utf8');
    const resellerList = fileContent.split('\n').filter(line => line.trim() !== '' && line.trim() !== targetId);

    // Tulis ulang file dengan data yang sudah difilter
    fs.writeFileSync(resselFilePath, resellerList.join('\n') + (resellerList.length ? '\n' : ''));

    ctx.reply(`✅ User dengan ID ${targetId} berhasil dihapus dari daftar reseller.`);

  } catch (e) {
    logger.error('❌ Error di command /delressel:', e.message);
    ctx.reply('❌ Terjadi kesalahan saat menjalankan perintah.');
  }
});

bot.action('jadi_reseller', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from.id;

  await ctx.reply(
    `📩 Hubungi admin ${ADMIN_USERNAME} untuk menjadi Reseller.\n\n` +
    `💰 <b>Minimal deposit:</b> Rp50,000\n\n` +
    `Kirim pesan ke admin dengan format:\n` +
    `<code>Mau jadi reseller ${userId}</code>`,
    { parse_mode: 'HTML' }
  );
});

bot.action(/server_page_(create|trial)_(vmess|vless|trojan|shadowsocks|ssh|zivpn)_(\d+)/, async (ctx) => {
  const action = ctx.match[1];
  const type = ctx.match[2];
  const page = parseInt(ctx.match[3], 10) || 0;
  await ctx.answerCbQuery();
  return startSelectServer(ctx, action, type, page);
});

bot.action('noop', async (ctx) => ctx.answerCbQuery());

bot.action('admin_edit_bug', async (ctx) => {
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.answerCbQuery('Akses ditolak', { show_alert: true });
  }

  // Tombol kategori diambil dari bugCategories
  const buttons = bugCategories.map(cat => ([
    {
      text: cat.adminLabel || cat.userLabel,
      callback_data: `bugcat_edit_${cat.id}`,
    }
  ]));

  // Tombol reset & kembali
  buttons.push([{ text: '🗑 Hapus Semua BUG (Reset)', callback_data: 'editbug_reset' }]);
  buttons.push([{ text: '🔙 Kembali', callback_data: 'admin' }]);

  await ctx.editMessageText('✏️ *Pilih BUG yang ingin diedit:*', {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: buttons,
    },
  });
});

// 🔁 Handler dinamis untuk edit teks BUG via admin
bugCategories.forEach((cat) => {
  bot.action(`bugcat_edit_${cat.id}`, async (ctx) => {
    await ctx.answerCbQuery();

    userState[ctx.chat.id] = { step: 'edit_bug', key: cat.key };

    const label = cat.adminLabel || cat.userLabel || cat.key;

    await ctx.editMessageText(
      `✏️ Kirim teks baru untuk *${label}*.\n\n` +
      'Disarankan pakai format yang rapi (1 bug per baris) agar reseller mudah salin.',
      { parse_mode: 'Markdown' }
    );
  });
});

bot.action('editbug_reset', async (ctx) => {
  await ctx.answerCbQuery();

  try {
    fs.writeFileSync(
      path.join(__dirname, 'modules', 'bugproxy_overrides.json'),
      JSON.stringify({}, null, 2)
    );
    await ctx.editMessageText('✔️ Semua BUG telah direset ke default.');
  } catch (e) {
    await ctx.editMessageText('❌ Gagal reset BUG.');
  }
});

bot.action('service_trial', async (ctx) => {
  if (!ctx || !ctx.from) {
    return ctx.reply('❌  Terjadi kesalahan.');
  }

  const userId = ctx.from.id.toString();

  // === CEK ADMIN ===
  if (adminIds.includes(Number(userId))) {
    return handleServiceAction(ctx, 'trial'); // admin bebas
  }

  // === CEK RESELLER ===
  let isRessel = false;
  try {
    const data = fs.readFileSync('./ressel.db', 'utf8');
    const resselList = data.split('\n').map(a => a.trim()).filter(Boolean);
    isRessel = resselList.includes(userId);
  } catch (err) {
    console.error('ressel.db error:', err.message);
  }

  if (isRessel) {
    return handleServiceAction(ctx, 'trial'); // reseller bebas
  }

  // === CEK SALDO MEMBER ===
  const saldo = await getUserBalance(userId);
  if (saldo === null || saldo === undefined) {
    return ctx.reply('❌ Tidak dapat mengambil data saldo user.');
  }

if (saldo < 1000) {
  return ctx.reply('⚠️ *Saldo anda kurang 1000 untuk akses menu ini!*', {
    parse_mode: 'Markdown'
  });
}

  // === Saldo cukup → lanjutan pilih protocol/server ===
  await handleServiceAction(ctx, 'trial');
});


bot.action('reseller_addip_menu', async (ctx) => {
  try {
    const isR = await isUserReseller(ctx.from.id);
    if (!isR) {
      return ctx.answerCbQuery('Fitur ini khusus reseller.', { show_alert: true });
    }
    if (!RESELLER_ADDIP_CFG.enabled) {
      return ctx.answerCbQuery('Fitur Add IP sedang dimatikan.', { show_alert: true });
    }

    const keyboard = [
      [
        { text: '➕ UDP ZIVPN', callback_data: 'reseller_addip_type_zivpn' },
        { text: '➕ SSH WS', callback_data: 'reseller_addip_type_ssh' }
      ],
      [
        { text: '➕ VMESS', callback_data: 'reseller_addip_type_vmess' },
        { text: '➕ VLESS', callback_data: 'reseller_addip_type_vless' }
      ],
      [
        { text: '➕ TROJAN', callback_data: 'reseller_addip_type_trojan' }
      ],
      [
        { text: '🔙 Menu Utama', callback_data: 'send_main_menu' }
      ]
    ];

    await ctx.editMessageText(
      `*➕  Add IP (Reseller)*\n` +
      `Harga: *Rp${RESELLER_ADDIP_CFG.pricePerIp.toLocaleString()}* / 1 IP\n\n` +
      `ℹ️ *Penting:*\n` +
      `Yang dimasukkan adalah *TOTAL limit IP baru*, bukan jumlah tambahannya.\n\n` +
      `Contoh:\n` +
      `• Limit awal 2 → mau +1 → isi *3*\n` +
      `• Limit awal 2 → mau +2 → isi *4*\n\n` +
      `❗  Limit baru *harus lebih besar* dari limit awal.\n` +
      `Saldo dipotong *hanya jika proses berhasil*.\n\n` +
      `Pilih tipe akun yang mau ditambah IP:`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
    );
  } catch (e) {
    logger.error('Error reseller_addip_menu:', e.message);
    return ctx.reply('❌  Terjadi kesalahan saat membuka menu Add IP.', { parse_mode: 'Markdown' });
  }
});

bot.action(/reseller_addip_type_(vmess|vless|trojan|shadowsocks|ssh|zivpn)/, async (ctx) => {
  try {
    const type = ctx.match[1];
    const isR = await isUserReseller(ctx.from.id);
    if (!isR) return ctx.answerCbQuery('Fitur ini khusus reseller.', { show_alert: true });
    if (!RESELLER_ADDIP_CFG.enabled) return ctx.answerCbQuery('Fitur Add IP sedang dimatikan.', { show_alert: true });

    // pilih server dulu (pakai flow startSelectServer yg sama)
    await startSelectServer(ctx, 'addip', type, 0);
  } catch (e) {
    logger.error('Error reseller_addip_type:', e.message);
    return ctx.reply('❌ Terjadi kesalahan saat memilih tipe Add IP.', { parse_mode: 'Markdown' });
  }
});


bot.action('service_create', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await handleServiceAction(ctx, 'create');
});

// 📚 Menu utama BUG khusus reseller
bot.action('bug_proxy_menu', async (ctx) => {
  try {
    const isR = await isUserReseller(ctx.from.id);
    if (!isR) {
      return ctx.answerCbQuery('Fitur ini hanya untuk reseller.', { show_alert: true });
    }

    // Bangun tombol dari bugCategories
    const keyboard = bugCategories.map(cat => ([
      {
        text: cat.userLabel,
        callback_data: `bugcat_view_${cat.id}`,
      }
    ]));

    // Tambah tombol kembali
    keyboard.push([{ text: '🔙 Kembali ke Menu Utama', callback_data: 'send_main_menu' }]);

    // Hapus pesan sebelumnya (efek debu) lalu kirim menu baru
    try {
      await ctx.deleteMessage();
    } catch (e) {}

    await ctx.reply('📚 *Daftar BUG & PROXY:*\nSilakan pilih kategori.', {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: keyboard,
      },
    });
  } catch (err) {
    logger.error('Error bug_proxy_menu:', err);
  }
});

// 🔁 Handler dinamis untuk setiap kategori BUG (tampilan ke reseller)
bugCategories.forEach((cat) => {
  bot.action(`bugcat_view_${cat.id}`, async (ctx) => {
    try {
      const isR = await isUserReseller(ctx.from.id);
      if (!isR) {
        return ctx.answerCbQuery('Fitur ini hanya untuk reseller.', { show_alert: true });
      }

      const text = getBugText(cat.key);

      try {
        await ctx.deleteMessage();
      } catch (e) {}

      await ctx.reply(text, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '⬅️ Kembali', callback_data: 'bug_proxy_menu' }]
          ]
        }
      });
    } catch (err) {
      logger.error(`Error bugcat_view_${cat.id}:`, err);
    }
  });
});

bot.action('manage_account_menu', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    // Memperbarui tombol saja, teks di atasnya tetap utuh
    await ctx.editMessageReplyMarkup({
      inline_keyboard: [
        // Baris 1
        [
          { text: '📁 Lihat Semua Akun', callback_data: 'view_all_accounts' }
        ],
        // Baris 2
        [
          { text: '♻️ Renew Akun | Otomatis', callback_data: 'renew_quick' }
        ],
        // Baris 3
        [
          { text: '♻️ Renew Akun | Manual', callback_data: 'renew_manual' }
        ],
        // Baris 4
        [
          { text: '🔙 Menu Utama', callback_data: 'send_main_menu' }
        ]
      ]
    });
  } catch (e) {
    console.error('Error Manage Akun: ', e);
  }
});

// --- PERBAIKAN FITUR LIHAT SEMUA AKUN (TEXT LIST ONLY) ---

bot.action('view_all_accounts', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  return showAllAccountsList(ctx, 0);
});

bot.action(/view_all_page_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const page = parseInt(ctx.match[1], 10) || 0;
  return showAllAccountsList(ctx, page);
});

async function showAllAccountsList(ctx, page = 0) {
  const userId = ctx.from.id;
  const rows = await listUserAccounts(userId);

  if (!rows || rows.length === 0) {
    return replyOrEdit(ctx, "⚠️ <b>Kamu belum memiliki akun apapun.</b>", {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[{ text: "🔙 Kembali", callback_data: "manage_account_menu" }]],
      },
    });
  }

  // Pengaturan Pagination (Misal 15 akun per halaman karena hanya teks)
  const perPage = 15;
  const totalPages = Math.ceil(rows.length / perPage);
  const p = Math.min(Math.max(0, page), totalPages - 1);
  const slice = rows.slice(p * perPage, p * perPage + perPage);

  let text = `📂 <b>DAFTAR KOLEKSI AKUN ANDA</b>\n`;
  text += `━━━━━━━━━━━━━━━━━━━━\n`;
  text += `Total: <b>${rows.length}</b> | Hal: <b>${p + 1}/${totalPages}</b>\n\n`;

  const now = Date.now();
  let listTeks = "";

  slice.forEach((a, i) => {
    const expAt = Number(a.expire_at) || 0;
    const isExpired = expAt > 0 && expAt <= now;
    const statusIcon = isExpired ? "🔴" : "🟢";
    const no = p * perPage + i + 1;
    const srv = a.server_name ? a.server_name.split(' ')[0] : 'Srv'; // Ambil nama depan server biar ringkas

    // Format: No. Username | Server | Expired
    listTeks += `${no}. ${statusIcon} <code>${a.username}</code> | ${srv} | ${fmtDateId(expAt)}\n`;
  });

  text += `<blockquote>${listTeks}</blockquote>\n`;
  text += `━━━━━━━━━━━━━━━━━━━━\n`;
  text += `<i>Keterangan: 🟢 Aktif | 🔴 Expired</i>`;

  const kb = [];
  const navRow = [];
  
  // Tombol navigasi muncul jika halaman lebih dari satu
  if (p > 0) navRow.push({ text: "⬅️ Prev", callback_data: `view_all_page_${p - 1}` });
  if (p < totalPages - 1) navRow.push({ text: "Next ➡️", callback_data: `view_all_page_${p + 1}` });
  
  if (navRow.length) kb.push(navRow);
  kb.push([{ text: "🔙 Kembali ke Manage Akun", callback_data: "manage_account_menu" }]);

  return replyOrEdit(ctx, text, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: kb },
  });
}

// 2. MENU TUKAR POIN
bot.action('redeem_point_menu', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    const now = Date.now();
    const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();

    // 1. Hitung Statistik Riwayat Transaksi (Penjualan)
    const stats = await new Promise((resolve) => {
      db.all(`SELECT type, timestamp FROM transactions WHERE user_id = ?`, [userId], (err, rows) => {
        if (err || !rows) return resolve({ total: 0, month: 0 });
        let total = 0, month = 0;
        rows.forEach(r => {
          const t = (r.type || '').toLowerCase();
          if (['ssh','vmess','vless','trojan','shadowsocks','zivpn'].includes(t) || t.includes('renew')) {
            total++;
            if (r.timestamp >= startOfMonth) month++;
          }
        });
        resolve({ total, month });
      });
    });

    // 2. Hitung Akun yang Masih AKTIF
    const activeCount = await new Promise((resolve) => {
      db.get(`SELECT COUNT(*) as count FROM user_accounts WHERE user_id = ? AND expire_at > ?`, [userId, now], (err, row) => resolve(row ? row.count : 0));
    });

    // 3. Ambil Poin
    const userRow = await new Promise(r => db.get("SELECT poin FROM users WHERE user_id = ?", [userId], (e, row) => r(row)));
    const myPoints = userRow ? (userRow.poin || 0) : 0;

    // 4. Susun Teks (Statistik masuk sini)
    const text = 
      `🎁 <b>TUKAR POIN REWARD!</b>\n\n` +
      `<blockquote>` +
      `🟢 <b>Status Akun:</b>\n` +
      `├ Akun Aktif: <b>${activeCount}</b>\n` +
      `├ Terjual (Bulan ini): <b>${stats.month}</b>\n` +
      `└ Terjual (Lifetime): <b>${stats.total}</b>\n\n` +
      `🎁 <b>Skema Poin Reward:</b>\n` +
      `├ Durasi 07 - 20 Hari : <b>1 Poin</b>\n` +
      `├ Durasi 21 - 59 Hari : <b>2 Poin</b>\n` +
      `└ Durasi 60 Hari ++   : <b>3 Poin</b>\n\n` +
      `<b>Saldo Poin Anda: ${myPoints}</b>\n` +
      `</blockquote>\n` +
      `Kumpulkan poin & tukar dengan saldo bot!`;

    const buttons = REDEEM_PACKAGES.map(pkg => {
      const label = myPoints >= pkg.points ? '✅' : '🔒'; 
      return [{ text: `${label} Tukar ${pkg.points} Poin = Rp ${pkg.bonus.toLocaleString()}`, callback_data: `redeem_exec_${pkg.points}` }];
    });
    buttons.push([{ text: '🔙 Menu Utama', callback_data: 'send_main_menu' }]);

    await ctx.editMessageText(text, { 
      parse_mode: 'HTML', 
      reply_markup: { inline_keyboard: buttons } 
    }).catch(() => {});
  } catch (e) { console.error(e); }
});

// 3. EKSEKUSI PENUKARAN
bot.action(/redeem_exec_(\d+)/, async (ctx) => {
  const cost = parseInt(ctx.match[1], 10);
  const userId = ctx.from.id;
  const pkg = REDEEM_PACKAGES.find(p => p.points === cost);
  
  if (!pkg) return ctx.answerCbQuery('❌ Paket tidak valid.');

  // Ambil poin dan saldo sekaligus untuk data notifikasi
  db.get("SELECT poin, saldo FROM users WHERE user_id = ?", [userId], async (err, row) => {
    if (err || !row) return ctx.answerCbQuery('❌ Gagal ambil data.');
    
    const currentPoints = row.poin || 0;
    const currentSaldo = row.saldo || 0;
    
    if (currentPoints < cost) {
      return ctx.answerCbQuery(`⚠️ Poin tidak cukup! Butuh ${cost} Poin.`, { show_alert: true });
    }

    const sisaPoin = currentPoints - cost;
    const saldoBaru = currentSaldo + pkg.bonus;

    db.serialize(() => {
      // Potong Poin & Tambah Saldo
      db.run("UPDATE users SET poin = poin - ?, saldo = saldo + ? WHERE user_id = ?", [cost, pkg.bonus, userId]);
      // Catat History
      const ref = `redeem-${cost}pt-${Date.now()}`;
      db.run("INSERT INTO transactions (user_id, amount, type, reference_id, timestamp) VALUES (?, ?, 'bonus_redeem', ?, ?)", 
        [userId, pkg.bonus, ref, Date.now()]);
    });

    // 1. Notifikasi Pribadi ke User
    ctx.reply(`🎉 *SUKSES TUKAR POIN*\n\n➖ ${cost} Poin\n➕ Rp ${pkg.bonus.toLocaleString('id-ID')} Saldo`, { parse_mode: 'Markdown' });

    // 2. Notifikasi ke Grup (Gaya Rapi)
    try {
      let userMention = await getUserMentionHtml(userId);
      if (userMention) userMention = userMention.replace('@', ''); // Hapus @ agar seragam

      const tanggalOnly = new Date().toLocaleDateString("id-ID", { timeZone: "Asia/Jakarta" });

      const notifGroup =
        `<pre>` +
        `<b>🎁 TUKAR POIN BERHASIL</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `👤 User     : ${userMention}\n` +
        `🆔 User ID  : ${userId}\n` +
        `🎯 Tukar    : ${cost} Poin\n` +
        `💰 Reward   : Rp ${pkg.bonus.toLocaleString('id-ID')}\n` +
        `💳 Sisa Poin: ${sisaPoin} Poin\n` +
        `💳 Saldo Now: Rp ${saldoBaru.toLocaleString('id-ID')}\n` +
        `📆 Tanggal  : ${tanggalOnly}\n` +
        `━━━━━━━━━━━━━━━━━━━━` +
        `</pre>`;

      bot.telegram.sendMessage(GROUP_ID, notifGroup, { parse_mode: 'HTML' }).catch(e => {
        logger.error('Gagal kirim notif grup tukar poin:', e.message);
      });
    } catch (e) {
      logger.error('Error menyusun notif grup tukar poin:', e.message);
    }
  });
});

bot.action('service_renew', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  // 2 opsi: Manual (flow lama) dan Otomatis (Quick Renew)
  return replyOrEdit(
    ctx,
    '♻️ *MENU RENEW*\n\nPilih metode Renew:',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '📝 Manual', callback_data: 'renew_manual' },
            { text: '⚡ Otomatis', callback_data: 'renew_quick' }
          ],
          [
            { text: '🏠 Menu utama', callback_data: 'send_main_menu' }
          ]
        ]
      }
    }
  );
});

bot.action('renew_manual', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  return handleServiceAction(ctx, 'renew'); // flow lama
});

bot.action('renew_quick', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  return showRenewQuickMenu(ctx, 0);
});

bot.action(/renew_page_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const page = parseInt(ctx.match[1], 10) || 0;

  return showRenewQuickMenu(ctx, page, true);
});

bot.action(/renew_pick_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const accountId = parseInt(ctx.match[1], 10);
  if (!accountId) {
    return replyOrEdit(ctx, '❌ Akun tidak valid.', { parse_mode: 'Markdown' });
  }

  try {
    const userId = ctx.from.id;
    const acc = await getUserAccountById(userId, accountId);
    if (!acc) {
      return replyOrEdit(ctx, '⚠️ Data akun tidak ditemukan.', { parse_mode: 'Markdown' });
    }

    const serverName = acc.server_name || `Server ${acc.server_id}`;
    const hargaHari = Number(acc.server_price) || 0;
    const hargaBulan = hargaHari * 30;

    const keyboard = [
      [
        { text: '➕ 2 Hari', callback_data: `renew_days_${acc.id}_2` },
        { text: '➕ 7 Hari', callback_data: `renew_days_${acc.id}_7` }
      ],
      [
        { text: '➕ 15 Hari', callback_data: `renew_days_${acc.id}_15` },
        { text: '➕ 30 Hari', callback_data: `renew_days_${acc.id}_30` }
      ],
      [
        { text: '✍️ Input Manual', callback_data: `renew_manual_input_${acc.id}` }
      ],
      [
        { text: '⬅️ Kembali', callback_data: 'renew_quick' }
      ]
    ];

    return replyOrEdit(
      ctx,
      `♻️ *Renew Akun*\n\n` +
      `👤 Username: \`${acc.username}\`\n` +
      `📦 Type: *${String(acc.type).toUpperCase()}*\n` +
      `🖥️ Server: *${serverName}*\n` +
      `💸 Harga/hari: *Rp${hargaHari.toLocaleString()}*\n` +
      `📅 Harga/bulan: *Rp${hargaBulan.toLocaleString()}*\n` +
      `⏳ Expired sekarang: *${fmtDateId(acc.expire_at)}*\n\n` +
      `Pilih durasi perpanjangan:`,
      {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
      }
    );

  } catch (e) {
    logger.error('Error renew_pick:', e.message);
    return replyOrEdit(ctx, '❌ Terjadi kesalahan.', { parse_mode: 'Markdown' });
  }
});

bot.action(/renew_days_(\d+)_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const accountId = parseInt(ctx.match[1], 10);
  const days = parseInt(ctx.match[2], 10);

  const userId = ctx.from.id;
  const acc = await getUserAccountById(userId, accountId);
  if (!acc) {
    return replyOrEdit(ctx, '⚠️ Data akun tidak ditemukan.', { parse_mode: 'Markdown' });
  }

  // simpan state
  userState[ctx.chat.id] = {
    action: 'renew',
    type: String(acc.type).toLowerCase(),
    serverId: acc.server_id,
    username: acc.username,
    quota: acc.server_quota ?? acc.quota,
    iplimit: acc.server_iplimit ?? acc.iplimit,
    accountId: acc.id,
    exp: days,
    step: `confirm_renew`
  };

  const hargaHari = Number(acc.server_price) || 0;
  const totalHarga = hargaHari * days;

  return replyOrEdit(
    ctx,
    `🔄 *Konfirmasi Renew*\n\n` +
    `👤 Username: \`${acc.username}\`\n` +
    `📦 Type: *${String(acc.type).toUpperCase()}*\n` +
    `⏳ Durasi: *${days} Hari*\n` +
    `💰 Total: *Rp${totalHarga.toLocaleString()}*\n\n` +
    `Lanjutkan perpanjang akun?`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Ya, Lanjutkan', callback_data: 'renew_confirm_yes' },
            { text: '❌ Batal', callback_data: 'renew_confirm_cancel' }
          ]
        ]
      }
    }
  );
});

bot.action('renew_confirm_yes', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const state = userState[ctx.chat.id];

  if (!state || state.action !== 'renew' || !state.exp) {
    return ctx.reply('⚠️ Sesi tidak valid. Silakan ulangi.', { parse_mode: 'Markdown' });
  }

  try {
    // set step ke flow lama (yang biasanya nunggu input masa aktif)
    state.step = `exp_renew_${String(state.type).toLowerCase()}`;

    // inject input exp (tanpa user ketik)
    return bot.handleUpdate({
      update_id: Date.now(),
      message: {
        message_id: Date.now(),
        from: ctx.from,
        chat: ctx.chat,
        date: Math.floor(Date.now() / 1000),
        text: String(state.exp)
      }
    });

  } catch (e) {
    logger.error('renew_confirm_yes error:', e.message);
    delete userState[ctx.chat.id];
    return ctx.reply('❌ Terjadi kesalahan saat memproses renew.', { parse_mode: 'Markdown' });
  }
});

bot.action('renew_confirm_cancel', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  delete userState[ctx.chat.id];

  await ctx.editMessageText(
    '↩️ *Dibatalkan.*\n\nKembali ke menu Renew...',
    { parse_mode: 'Markdown' }
  ).catch(() => {});

  return showRenewQuickMenu(ctx, 0);
});
bot.action(/renew_manual_input_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const accountId = parseInt(ctx.match[1], 10);

  const userId = ctx.from.id;
  const acc = await getUserAccountById(userId, accountId);
  if (!acc) {
    return replyOrEdit(ctx, '⚠️ Data akun tidak ditemukan.', { parse_mode: 'Markdown' });
  }

  userState[ctx.chat.id] = {
    action: 'renew',
    type: String(acc.type).toLowerCase(),
    serverId: acc.server_id,
    username: acc.username,
    quota: acc.server_quota ?? acc.quota,
    iplimit: acc.server_iplimit ?? acc.iplimit,
    accountId: acc.id,
    step: `exp_renew_${String(acc.type).toLowerCase()}`
  };

  return replyOrEdit(
    ctx,
    `✍️ *Input Manual*\n\nMasukkan jumlah hari (contoh: 5):`,
    { parse_mode: 'Markdown' }
  );
});

bot.action('service_del', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await handleServiceAction(ctx, 'del');
});

bot.action('service_lock', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await handleServiceAction(ctx, 'lock');
});

bot.action('service_unlock', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  } 
  await handleServiceAction(ctx, 'unlock');
});

const { exec } = require('child_process');

bot.action('cek_service', async (ctx) => {
  try {
    const resselDbPath = './ressel.db';
    const idUser = ctx.from.id.toString().trim();

    // 🔍 Cek apakah user termasuk reseller
    fs.readFile(resselDbPath, 'utf8', async (err, data) => {
      if (err) {
        console.error('❌ Gagal membaca file ressel.db:', err.message);
        return ctx.reply('❌ *Terjadi kesalahan saat membaca data reseller.*', { parse_mode: 'Markdown' });
      }

      const resselList = data.split('\n').map(line => line.trim()).filter(Boolean);
      const isRessel = resselList.includes(idUser);

      if (!isRessel) {
        return ctx.reply('❌ *Fitur ini hanya untuk Ressel VPN.*', { parse_mode: 'Markdown' });
      }

      // ✅ Jika reseller, lanjut jalankan cek service
      const message = await ctx.reply('⏳ Sedang mengecek status server...');

      exec('chmod +x cek-port.sh && bash cek-port.sh', (error, stdout, stderr) => {
        if (error) {
          console.error(`Gagal menjalankan skrip: ${error}`);
          return ctx.reply('❌ Terjadi kesalahan saat menjalankan pengecekan.');
        }

        if (stderr) {
          console.error(`Error dari skrip: ${stderr}`);
          return ctx.reply('❌ Ada output error dari skrip pengecekan.');
        }

        // Bersihkan kode warna ANSI agar output rapi
        const cleanOutput = stdout.replace(/\x1b\[[0-9;]*m/g, '');

        ctx.reply(`📡 *Hasil Cek Port:*\n\n\`\`\`\n${cleanOutput}\n\`\`\``, {
          parse_mode: 'Markdown'
        });
      });
    });
  } catch (err) {
    console.error(err);
    ctx.reply('❌ Gagal menjalankan pengecekan server.');
  }
});

bot.action('send_main_menu1', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch (e) {}

  // 1) efek "debu": hilangkan tombol welcome dulu (instan)
  try {
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  } catch (e) {}

  // 2) opsional: tampilkan "loading" sebentar (biar terasa transisi)
  try {
    await ctx.editMessageText('⏳ Memuat menu Bot VPN...', { parse_mode: 'HTML' });
  } catch (e) {}

  // 3) tampilkan menu utama dengan mekanisme edit milik sendMainMenu
  await sendMainMenu(ctx);
});

bot.action('send_main_menu', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await sendMainMenu(ctx);
});

bot.action('trial_vmess', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'trial', 'vmess');
});

bot.action('trial_vless', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'trial', 'vless');
});

bot.action('trial_trojan', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'trial', 'trojan');
});

bot.action('trial_shadowsocks', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'trial', 'shadowsocks');
});

bot.action('trial_ssh', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'trial', 'ssh');
});


bot.action('create_vmess', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'create', 'vmess');
});

bot.action('create_vless', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'create', 'vless');
});

bot.action('create_trojan', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'create', 'trojan');
});

bot.action('create_shadowsocks', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'create', 'shadowsocks');
});

// ==== ZIVPN ACTION HANDLERS (PASTE) ====
bot.action('create_zivpn', async (ctx) => {
  await startSelectServer(ctx, 'create', 'zivpn');
});

bot.action('trial_zivpn', async (ctx) => {
  await startSelectServer(ctx, 'trial', 'zivpn');
});
// ==== END ZIVPN ACTION HANDLERS ====

bot.action('create_ssh', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'create', 'ssh');
});

//DELETE SSH
bot.action('del_ssh', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'del', 'ssh');
});

bot.action('del_vmess', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'del', 'vmess');
});

bot.action('del_vless', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'del', 'vless');
});

bot.action('del_trojan', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'del', 'trojan');
});
//DELETE BREAK

//LOCK
bot.action('lock_ssh', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'lock', 'ssh');
});

bot.action('lock_vmess', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'lock', 'vmess');
});

bot.action('lock_vless', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'lock', 'vless');
});

bot.action('lock_trojan', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'lock', 'trojan');
});
//LOCK BREAK
//UNLOCK
bot.action('unlock_ssh', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'unlock', 'ssh');
});

bot.action('unlock_vmess', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'unlock', 'vmess');
});

bot.action('unlock_vless', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'unlock', 'vless');
});

bot.action('unlock_trojan', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'unlock', 'trojan');
});
//UNLOCK BREAK

bot.action('renew_vmess', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'renew', 'vmess');
});

bot.action('renew_vless', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'renew', 'vless');
});

bot.action('renew_trojan', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'renew', 'trojan');
});

bot.action('renew_shadowsocks', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'renew', 'shadowsocks');
});

bot.action('renew_ssh', async (ctx) => {
  if (!ctx || !ctx.match) {
    return ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
  }
  await startSelectServer(ctx, 'renew', 'ssh');
});

async function startSelectServer(ctx, action, type, page = 0) {

try {
  const isR = await isUserReseller(ctx.from.id);
const service = type === 'zivpn' ? 'zivpn' : 'ssh';

let query;
let params = [];

if (isR) {
  // 🔥 RESELLER: HANYA server reseller
  query = `
    SELECT * FROM Server
    WHERE service = ?
      AND is_reseller_only = 1
  `;
  params = [service];
} else {
  // 🔹 USER BIASA: HANYA server non-reseller
  query = `
    SELECT * FROM Server
    WHERE service = ?
      AND (is_reseller_only = 0 OR is_reseller_only IS NULL)
  `;
  params = [service];
}

db.all(query, params, (err, servers) => {
  if (err) {
    logger.error('⚠️ Error fetching servers:', err.message);
    return ctx.reply('⚠️ Tidak ada server yang tersedia saat ini.', { parse_mode: 'HTML' });
  }
    // ==== mulai logika pagination di bawah ini ====
    const serversPerPage = 6;
    const totalPages = Math.ceil(servers.length / serversPerPage);
    const currentPage = Math.min(Math.max(page, 0), totalPages - 1);
    const start = currentPage * serversPerPage;
    const end = start + serversPerPage;
    const currentServers = servers.slice(start, end);

    const keyboard = [];
    for (let i = 0; i < currentServers.length; i += 2) {
      const row = [];
      const server1 = currentServers[i];
      const server2 = currentServers[i + 1];
      row.push({
  text: String((currentPage * serversPerPage) + i + 1),
  callback_data: `${action}_username_${type}_${server1.id}`
});
if (server2) {
  row.push({
    text: String((currentPage * serversPerPage) + i + 2),
    callback_data: `${action}_username_${type}_${server2.id}`
  });
}
      keyboard.push(row);
    }

    const navButtons = [];
    if (totalPages > 1) {
      if (currentPage > 0) {
        navButtons.push({ text: '⬅️ Back', callback_data: `navigate_${action}_${type}_${currentPage - 1}` });
      }
      if (currentPage < totalPages - 1) {
        navButtons.push({ text: '➡️ Next', callback_data: `navigate_${action}_${type}_${currentPage + 1}` });
      }
    }
    if (navButtons.length > 0) keyboard.push(navButtons);
    keyboard.push([{ text: '🔙 Kembali ke Menu Utama', callback_data: 'send_main_menu' }]);

    const serverList = currentServers.map((server, idx) => {
      const nomor = (currentPage * serversPerPage) + idx + 1;
      const hargaPer30Hari = server.harga * 30;
      const isFull = server.total_create_akun >= server.batas_create_akun;
      const statusIcon = isFull ? "🔴 Penuh" : "🟢 Tersedia";
      const quotaDisplay = server.quota > 0 ? `${server.quota} GB` : "Unlimited";

      return (
`*${nomor}. ${server.nama_server.toUpperCase()}*
├ 💰 Rp${server.harga.toLocaleString()}/hari • Rp${hargaPer30Hari.toLocaleString()}/bln
├ 📡 Limit Quota: ${quotaDisplay}
├ 🔐 Limit Login: ${server.iplimit} Device
└ 📊 Stok: ${server.total_create_akun}/${server.batas_create_akun} (${statusIcon})
`
      );
    }).join('\n');
    if (ctx.updateType === 'callback_query') {
      ctx.editMessageText(`📋 *List Server (Halaman ${currentPage + 1} dari ${totalPages})*\n\n${serverList}`, {
        reply_markup: { inline_keyboard: keyboard },
        parse_mode: 'Markdown'
      });
    } else {
      ctx.reply(`📋 *List Server (Halaman ${currentPage + 1} dari ${totalPages})*\n\n${serverList}`, {
        reply_markup: { inline_keyboard: keyboard },
        parse_mode: 'Markdown'
      });
    }

    userState[ctx.chat.id] = { step: `${action}_username_${type}`, page: currentPage };
  });
} catch (error) {
  logger.error(`❌ Error saat memulai proses ${action} untuk ${type}:`, error);
  await ctx.reply(`❌ *GAGAL!* Terjadi kesalahan saat memproses permintaan.`, { parse_mode: 'Markdown' });
}
}

bot.action(/navigate_(\w+)_(\w+)_(\d+)/, async (ctx) => {
  const [, action, type, page] = ctx.match;
  await startSelectServer(ctx, action, type, parseInt(page, 10));
});

bot.action(/(create|renew)_username_(vmess|vless|trojan|shadowsocks|ssh|zivpn)_(.+)/, async (ctx) => {
  const action = ctx.match[1];
  const type = ctx.match[2];
  const serverId = ctx.match[3];

  // Simpan state langkah user
  userState[ctx.chat.id] = { step: `username_${action}_${type}`, serverId, type, action };

  db.get(
    'SELECT nama_server, batas_create_akun, total_create_akun FROM Server WHERE id = ?',
    [serverId],
    async (err, server) => {
      if (err) {
        // Pastikan variabel 'logger' sudah didefinisikan di kode atas, jika error ganti console.error
        try { logger.error('⚠️ Error fetching server details:', err.message); } catch(e) { console.error(err); }
        return ctx.reply('❌  Terjadi kesalahan saat mengambil detail server.');
      }

      if (!server) {
        return ctx.reply('❌  Server tidak ditemukan.');
      }

      const batasCreateAkun = server.batas_create_akun || 0;
      const totalCreateAkun = server.total_create_akun || 0;

      // ✅ LOGIC FIX: 
      // Cek batas kuota HANYA jika action adalah 'create'. 
      // Jika 'renew', biarkan lolos karena user hanya memperpanjang akun yang sudah ada.
      if (action === 'create' && totalCreateAkun >= batasCreateAkun) {
        return ctx.reply(
          '❌  *Server penuh (Limit Akun Tercapai).*\nTidak dapat membuat akun baru, tapi user lama masih bisa renew.',
          { parse_mode: 'Markdown' }
        );
      }

      const textAction = action === 'create' ? 'Masukan username akun baru:' : 'Masukan username akun yang akan diperpanjang:';

      await ctx.reply(
        `✅  *${server.nama_server}*\n\n${textAction}`,
        { parse_mode: 'Markdown' }
      );
    }
  ); 
});

// === HANDLER TRIAL DENGAN LOADING BAR MINIMALIS ===
bot.action(/(trial)_username_(vmess|vless|trojan|shadowsocks|ssh|zivpn)_(.+)/, async (ctx) => {
  try {
    if (ctx.answerCbQuery) await ctx.answerCbQuery();

    const [action, type, serverId] = [ctx.match[1], ctx.match[2], ctx.match[3]];
    const idUser = ctx.from.id.toString().trim();
    const resselDbPath = './ressel.db';

    // === Cek reseller ===
    let isRessel = false;
    try {
      const data = fs.readFileSync(resselDbPath, 'utf8');
      const resselList = data.split('\n').map(line => line.trim()).filter(Boolean);
      isRessel = resselList.includes(idUser);
    } catch (err) {
      console.error('❌ Gagal membaca file ressel.db:', err.message);
      await ctx.reply('❌ *Terjadi kesalahan saat membaca data reseller.*', { parse_mode: 'Markdown' });
      return;
    }

    // === Kalau bukan reseller, cek limit trial harian ===
    if (!isRessel) {
      const sudahPakai = await checkTrialAccess(ctx.from.id);
      if (sudahPakai) {
        return ctx.reply('❌ *Anda sudah menggunakan fitur trial hari ini. Silakan coba lagi besok.*', { parse_mode: 'Markdown' });
      }
      await saveTrialAccess(ctx.from.id); 
    }

    // === Buat Data Trial ===
    const username = 'trial-' + Math.random().toString(36).substring(2, 7); 
    const password = 'none';
    const exp = '1';
    const iplimit = '1';

    userState[ctx.chat.id] = { username, password, type, serverId, action, trial: true };

    // 1. TAMPILAN LOADING AWAL (Cuma Bar 10%)
    const loadingMsg = await ctx.reply(
      `⏳ [█░░░░░░░░░] 10%`,
      { parse_mode: 'Markdown' }
    );

    // Fungsi update loading bar (Tanpa teks tambahan)
    const updateProgress = async (bar, percent) => {
      try {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          loadingMsg.message_id,
          null,
          `⏳ [${bar}] ${percent}%`,
          { parse_mode: 'Markdown' }
        );
      } catch (e) {} 
    };

    logger.info(`✅ Trial ${type} dibuat oleh ${ctx.from.id}`);

    const trialFunctions = {
      ssh: trialssh,
      vmess: trialvmess,
      vless: trialvless,
      trojan: trialtrojan,
      shadowsocks: trialshadowsocks,
      zivpn: trialzivpn
    };

    const func = trialFunctions[type];
    if (!func) throw new Error(`Fungsi trial untuk tipe ${type} tidak ditemukan`);

    // 2. Simulasi Loading Jalan (40% -> 80% -> 100%)
    
    // Update ke 40%
    await new Promise(r => setTimeout(r, 500)); 
    await updateProgress('████░░░░░░', 40);

    // EKSEKUSI PEMBUATAN AKUN (Background)
    const msg = await func(username, password, exp, iplimit, serverId);

    // Update ke 80%
    await updateProgress('████████░░', 80);
    await new Promise(r => setTimeout(r, 400)); 

    // Update ke 100%
    await updateProgress('██████████', 100);
    await new Promise(r => setTimeout(r, 500));

    // 3. Hapus Loading & Kirim Hasil Akhir
    await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(()=>{});
    await ctx.reply(msg, { parse_mode: 'Markdown' });

  } catch (err) {
    console.error('❌ Error handler trial:', err);
    await ctx.reply('❌ Terjadi kesalahan saat membuat trial. Coba lagi nanti.');
  }
});

bot.action(/(addip)_username_(vmess|vless|trojan|shadowsocks|ssh|zivpn)_(.+)/, async (ctx) => {
  const action = ctx.match[1];
  const type = ctx.match[2];
  const serverId = ctx.match[3];

  try {
    const isR = await isUserReseller(ctx.from.id);
    if (!isR) return ctx.answerCbQuery('Fitur ini khusus reseller.', { show_alert: true });
    if (!RESELLER_ADDIP_CFG.enabled) return ctx.answerCbQuery('Fitur Add IP sedang dimatikan.', { show_alert: true });

    userState[ctx.chat.id] = {
      step: `username_${action}_${type}`,
      action,
      type,
      serverId
    };

    await ctx.reply('🔎 *Masukkan username akun yang mau ditambah IP:*', { parse_mode: 'Markdown' });
  } catch (err) {
    logger.error('❌ Error addip_username handler:', err.message);
    await ctx.reply('❌ Terjadi kesalahan saat memulai Add IP.', { parse_mode: 'Markdown' });
  }
});



bot.action(/(del)_username_(vmess|vless|trojan|shadowsocks|ssh|zivpn)_(.+)/, async (ctx) => {
  const [action, type, serverId] = [ctx.match[1], ctx.match[2], ctx.match[3]];

  userState[ctx.chat.id] = {
    step: `username_${action}_${type}`,
    serverId, type, action
  };
  await ctx.reply('👤 *Masukkan username yang ingin dihapus:*', { parse_mode: 'Markdown' });
});
bot.action(/(unlock)_username_(vmess|vless|trojan|shadowsocks|ssh|zivpn)_(.+)/, async (ctx) =>
{
  const [action, type, serverId] = [ctx.match[1], ctx.match[2], ctx.match[3]];

  userState[ctx.chat.id] = {
    step: `username_${action}_${type}`,
    serverId, type, action
  };
  await ctx.reply('👤 *Masukkan username yang ingin dibuka:*', { parse_mode: 'Markdown' });
});
bot.action(/(lock)_username_(vmess|vless|trojan|shadowsocks|ssh|zivpn)_(.+)/, async (ctx) => {
  const [action, type, serverId] = [ctx.match[1], ctx.match[2], ctx.match[3]];

  userState[ctx.chat.id] = {
    step: `username_${action}_${type}`,
    serverId, type, action
  };
  await ctx.reply('👤 *Masukkan username yang ingin dikunci:*', { parse_mode: 'Markdown' });
});


function parseAddServerZivpnInput(input) {
  const raw = String(input || '').trim();
  // domain|auth|harga|nama_server|quota|iplimit|batas_create|api_type
  // api_type optional: default 1
  const re = /^([^|\s][^|]*)\|([^|\s][^|]*)\|(\d+)\|([^|\s][^|]*(?:\s+[^|]+)*)\|(\d+)\|(\d+)\|(\d+)(?:\|(1|2))?$/;
  const match = raw.match(re);
  if (!match) return null;

  const data = {
    domain: match[1].trim(),
    auth: match[2].trim(),
    harga: Number(match[3]),
    nama_server: match[4].trim(),
    quota: Number(match[5]),
    iplimit: Number(match[6]),
    batas_create_akun: Number(match[7]),
    api_type: Number(match[8] || 1),
  };

  if (!data.domain || !data.auth || !data.nama_server) return null;
  if (![1, 2].includes(data.api_type)) return null;
  if (![data.harga, data.quota, data.iplimit, data.batas_create_akun].every(n => Number.isFinite(n) && n >= 0)) return null;

  return data;
}

function replyAddServerZivpnFormat(ctx, resellerOnly = false) {
  const cmdLabel = resellerOnly ? 'ZIVPN RESELLER' : 'ZIVPN MEMBER';
  return ctx.reply(
    `🛰️ <b>Tambah Server ${escapeHtml(cmdLabel)}</b>\n\n` +
    `Kirim data server dalam 1 baris:\n` +
    `<code>domain|auth|harga|nama_server|quota|iplimit|batas_create|api_type</code>\n\n` +
    `<code>api_type</code>: <code>1</code> = API lama, <code>2</code> = API Potato/BotVPN2. Kalau kosong default <code>1</code>.\n\n` +
    `Contoh:\n` +
    `<code>sg.domain.com|AUTHKEY|5000|ZIVPN SG|50|2|100|1</code>\n\n` +
    `Ketik /batal untuk membatalkan.`,
    { parse_mode: 'HTML' }
  );
}

function insertSingleZivpnServer(data, resellerOnly) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO Server (domain, auth, harga, nama_server, quota, iplimit, batas_create_akun, total_create_akun, is_reseller_only, api_type, service)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'zivpn')`,
      [
        data.domain,
        data.auth,
        data.harga,
        data.nama_server,
        data.quota,
        data.iplimit,
        data.batas_create_akun,
        resellerOnly ? 1 : 0,
        data.api_type,
      ],
      function(err) {
        if (err) return reject(err);
        resolve(this.lastID);
      }
    );
  });
}

bot.on('text', async (ctx) => {
  const state = userState[ctx.chat.id];
  if (!state) return;

  const rawText = ctx.message.text;        // jangan trim utk kasus tertentu
  const text = rawText.trim();

  // ✅ BATALKAN STATE (taruh PALING ATAS supaya tidak kebaca sebagai input)
  if (text === '/batal') {
    delete userState[ctx.chat.id];
    return ctx.reply('✅  Dibatalkan.', { parse_mode: 'Markdown' });
  }

  // === EDIT BUG (punyamu)
  if (state.step === 'edit_bug') {
    const newText = rawText; // biar spasi/emoji aman
    const key = state.key;
    try {
      saveBugOverride(key, newText);
      await ctx.reply('✅  Teks BUG berhasil diperbarui.');
    } catch (e) {
      logger.error('Gagal update BUG:', e);
      await ctx.reply('❌  Gagal menyimpan teks BUG.');
    }
    delete userState[ctx.chat.id];
    return;
  }
  if (state.step === 'addserver_zivpn_regex') {
    const data = parseAddServerZivpnInput(text);
    const resellerOnly = Boolean(state.resellerOnly);

    if (!data) {
      return ctx.reply(
        '❌ <b>Format tidak valid.</b>\n\n' +
        'Gunakan format:\n' +
        '<code>domain|auth|harga|nama_server|quota|iplimit|batas_create|api_type</code>\n\n' +
        'Contoh:\n' +
        '<code>sg.domain.com|AUTHKEY|5000|ZIVPN SG|50|2|100|1</code>',
        { parse_mode: 'HTML' }
      );
    }

    try {
      const id = await insertSingleZivpnServer(data, resellerOnly);
      await ctx.reply(
        `✅ <b>Server ZIVPN berhasil ditambahkan!</b>\n\n` +
        `🆔 ID: <code>${id}</code>\n` +
        `🌐 Domain: <code>${escapeHtml(data.domain)}</code>\n` +
        `🏷️ Nama: <b>${escapeHtml(data.nama_server)}</b>\n` +
        `🎭 Akses: <b>${resellerOnly ? 'Reseller Only' : 'Member/Public'}</b>\n` +
        `💰 Harga: <b>Rp${data.harga.toLocaleString('id-ID')}</b>\n` +
        `📦 Quota: <b>${data.quota} GB</b>\n` +
        `📶 IP Limit: <b>${data.iplimit}</b>\n` +
        `🔢 Batas Create: <b>${data.batas_create_akun}</b>\n` +
        `⚙️ API Type: <b>${data.api_type === 2 ? '2 - Potato/BotVPN2' : '1 - Lama'}</b>`,
        { parse_mode: 'HTML' }
      );
    } catch (e) {
      logger.error('Gagal tambah server ZIVPN:', e.message);
      await ctx.reply(`❌ Gagal menambahkan server ZIVPN: ${escapeHtml(e.message)}`, { parse_mode: 'HTML' });
    }

    delete userState[ctx.chat.id];
    return;
  }


  // ✅ INPUT MANUAL EDIT NAMA SERVER (BEBAS SPASI/EMOJI)
  if (state.step === 'edit_nama_text') {
    const newName = String(rawText || '').trim();

    if (!newName) {
      return ctx.reply('⚠️ Nama server tidak boleh kosong. Kirim ulang atau /batal.', { parse_mode: 'Markdown' });
    }
    if (newName.length > 64) {
      return ctx.reply('⚠️ Maksimal 64 karakter. Pendekin dulu ya.', { parse_mode: 'Markdown' });
    }

    const serverId = state.serverId;

    db.run(
      'UPDATE Server SET nama_server = ? WHERE id = ?',
      [newName, serverId],
      function (err) {
        if (err) {
          logger.error('⚠️ Kesalahan saat mengedit nama server:', err.message);
          ctx.reply('❌  Gagal mengubah nama server.', { parse_mode: 'Markdown' });
        } else if (this.changes === 0) {
          ctx.reply('⚠️ Server tidak ditemukan.', { parse_mode: 'Markdown' });
        } else {
          ctx.reply(
            `✅  Nama server (ID: \`${serverId}\`) berhasil diubah menjadi:\n<b>${escapeHtml(newName)}</b>`,
            { parse_mode: 'HTML' }
          );
        }
        delete userState[ctx.chat.id];
      }
    );
    return;
  }

  // ...lanjutkan step kamu yang lain (topup_manual, cek_saldo_userid, dst)

// === INPUT MANUAL NOMINAL TOP UP (NON-RESELLER) ===
if (state.step === 'topup_manual') {
  const userId = ctx.from.id;

  // validasi: cuma angka
  if (!/^\d+$/.test(text)) {
    return ctx.reply(
      '⚠️ *Nominal harus berupa angka tanpa titik/koma.*\n' +
      'Silakan kirim ulang. Contoh: `20000`',
      { parse_mode: 'Markdown' }
    );
  }

  const amount = Number(text);

  const minDeposit = 2000;
  if (amount === 0) {
    return ctx.reply('⚠️ *Jumlah tidak boleh 0!*', { parse_mode: 'Markdown' });
  }
  if (amount < minDeposit) {
    return ctx.reply(
      `⚠️ *Jumlah minimal deposit adalah* Rp${minDeposit.toLocaleString()}!`,
      { parse_mode: 'Markdown' }
    );
  }
  if (text.length > 12) {
    return ctx.reply('⚠️ *Jumlah maksimal adalah 12 digit!*', { parse_mode: 'Markdown' });
  }

  // ✅ LIMIT QR ANTI SPAM (maks 2 pending, QR ke-3 tunggu 5 menit / bayar dulu)
  // (opsional) expire otomatis pending yg udah lewat 5 menit
  expireOldPendingDeposits?.();

  const gate = await canCreateNewTopupQr(userId);
  if (!gate.ok) {
    return ctx.reply(gate.reason, { parse_mode: 'Markdown' });
  }

  // ambil id pesan prompt sebelum state dibersihkan
  const promptMsgId = state && state.promptMsgId ? state.promptMsgId : null;

  // bersihkan state baru lanjut
  delete userState[ctx.chat.id];

  // edit pesan prompt jadi indikator loading "Membuat QRIS untuk nominal xxxx"
  if (promptMsgId) {
    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        promptMsgId,
        undefined,
        `🔄 *Membuat QRIS untuk nominal Rp ${Number(amount).toLocaleString('id-ID')}...*`,
        { parse_mode: 'Markdown' }
      );
    } catch (_) { /* abaikan jika sudah ke-edit/dihapus */ }
  }

  // lanjut ke flow deposit yang sudah ada
  await processDeposit(ctx, amount, { loadingMsgId: promptMsgId });
  return;
}

if (state.step === 'cek_saldo_userid') {
  const targetId = ctx.message.text.trim();

  db.get('SELECT saldo FROM users WHERE user_id = ?', [targetId], (err, row) => {
    if (err) {
      logger.error('❌  Gagal mengambil saldo:', err.message);
      return ctx.reply('❌  Terjadi kesalahan saat mengambil data saldo.');
    }
    if (!row) {
      // tetap bersihin state biar gak nyangkut
      delete userState[ctx.chat.id];
      return ctx.reply(`⚠️ User dengan ID ${targetId} belum terdaftar di database.`);
    }

    ctx.reply(`💰 Saldo user ${targetId}: Rp${row.saldo.toLocaleString()}`);
    logger.info(`Admin ${ctx.from.id} mengecek saldo user ${targetId}: Rp${row.saldo}`);

    delete userState[ctx.chat.id];
  });

  return;
}
//
    if (state.step?.startsWith('username_unlock_')) {
    const username = text;
    // Validasi username (hanya huruf kecil dan angka, 3-20 karakter)
    if (!/^[a-z0-9]{3,20}$/.test(username)) {
      return ctx.reply('❌ *Username tidak valid. Gunakan huruf kecil dan angka (3–20 karakter).*', { parse_mode: 'Markdown' });
    }
       //izin ressel saja
    const resselDbPath = './ressel.db';
    fs.readFile(resselDbPath, 'utf8', async (err, data) => {
      if (err) {
        logger.error('❌ Gagal membaca file ressel.db:', err.message);
        return ctx.reply('❌ *Terjadi kesalahan saat membaca data reseller.*', { parse_mode: 'Markdown' });
      }

      const idUser = ctx.from.id.toString().trim();
      const resselList = data.split('\n').map(line => line.trim()).filter(Boolean);

      const isRessel = resselList.includes(idUser);

      if (!isRessel) {
        return ctx.reply('❌ *Fitur ini hanya untuk Ressel VPN.*', { parse_mode: 'Markdown' });
      }
  //izin ressel saja
    const { type, serverId } = state;
    delete userState[ctx.chat.id];

    let msg = 'none';
    try {
      const password = 'none', exp = 'none', iplimit = 'none';

      const delFunctions = {
        vmess: unlockvmess,
        vless: unlockvless,
        trojan: unlocktrojan,
        shadowsocks: unlockshadowsocks,
        ssh: unlockssh
      };

      if (delFunctions[type]) {
        msg = await delFunctions[type](username, password, exp, iplimit, serverId);
        //await recordAccountTransaction(ctx.from.id, type);
      }

      await ctx.reply(msg, { parse_mode: 'Markdown' });
      logger.info(`✅ Akun ${type} berhasil unlock oleh ${ctx.from.id}`);
    } catch (err) {
      logger.error('❌ Gagal hapus akun:', err.message);
      await ctx.reply('❌ *Terjadi kesalahan saat menghapus akun.*', { parse_mode: 'Markdown' });
    }});
    return; // Penting! Jangan lanjut ke case lain
  }
    if (state.step?.startsWith('username_lock_')) {
    const username = text;
    // Validasi username (hanya huruf kecil dan angka, 3-20 karakter)
    if (!/^[a-z0-9]{3,20}$/.test(username)) {
      return ctx.reply('❌ *Username tidak valid. Gunakan huruf kecil dan angka (3–20 karakter).*', { parse_mode: 'Markdown' });
    }
       //izin ressel saja
    const resselDbPath = './ressel.db';
    fs.readFile(resselDbPath, 'utf8', async (err, data) => {
      if (err) {
        logger.error('❌ Gagal membaca file ressel.db:', err.message);
        return ctx.reply('❌ *Terjadi kesalahan saat membaca data reseller.*', { parse_mode: 'Markdown' });
      }

      const idUser = ctx.from.id.toString().trim();
      const resselList = data.split('\n').map(line => line.trim()).filter(Boolean);

      const isRessel = resselList.includes(idUser);

      if (!isRessel) {
        return ctx.reply('❌ *Fitur ini hanya untuk Ressel VPN.*', { parse_mode: 'Markdown' });
      }
  //izin ressel saja
    const { type, serverId } = state;
    delete userState[ctx.chat.id];

    let msg = 'none';
    try {
      const password = 'none', exp = 'none', iplimit = 'none';

      const delFunctions = {
        vmess: lockvmess,
        vless: lockvless,
        trojan: locktrojan,
        shadowsocks: lockshadowsocks,
        ssh: lockssh
      };

      if (delFunctions[type]) {
        msg = await delFunctions[type](username, password, exp, iplimit, serverId);
        //await recordAccountTransaction(ctx.from.id, type);
      }

      await ctx.reply(msg, { parse_mode: 'Markdown' });
      logger.info(`✅ Akun ${type} berhasil di kunci oleh ${ctx.from.id}`);
    } catch (err) {
      logger.error('❌ Gagal hapus akun:', err.message);
      await ctx.reply('❌ *Terjadi kesalahan saat menghapus akun.*', { parse_mode: 'Markdown' });
    }});
    return; // Penting! Jangan lanjut ke case lain
  }
  if (state.step?.startsWith('username_del_')) {
    const username = text;
    
    // Validasi username
    if (!/^[a-z0-9]{3,20}$/.test(username)) {
      return ctx.reply('❌ *Username tidak valid. Gunakan huruf kecil dan angka (3–20 karakter).*', { parse_mode: 'Markdown' });
    }

    // Izin ressel check (Logic bawaan kamu)
    const resselDbPath = './ressel.db';
    fs.readFile(resselDbPath, 'utf8', async (err, data) => {
      if (err) {
        logger.error('❌ Gagal membaca file ressel.db:', err.message);
        return ctx.reply('❌ *Terjadi kesalahan saat membaca data reseller.*', { parse_mode: 'Markdown' });
      }

      const idUser = ctx.from.id.toString().trim();
      const resselList = data.split('\n').map(line => line.trim()).filter(Boolean);
      const isRessel = resselList.includes(idUser);

      if (!isRessel) {
        return ctx.reply('❌ *Fitur ini hanya untuk Reseller VPN.*', { parse_mode: 'Markdown' });
      }

      // Mulai Proses Delete & Refund
      const { type, serverId } = state;
      delete userState[ctx.chat.id]; // Hapus state agar tidak double proses

      try {
        // 1. AMBIL DATA AKUN & HARGA SERVER UNTUK HITUNGAN REFUND
        // Kita butuh: expire_at (dari user_accounts) dan harga (dari Server)
        const accData = await new Promise((resolve) => {
          db.get(
            `SELECT ua.expire_at, s.harga 
             FROM user_accounts ua 
             LEFT JOIN Server s ON s.id = ua.server_id 
             WHERE ua.username = ? AND ua.server_id = ? AND ua.user_id = ?`,
            [username, serverId, ctx.from.id],
            (err, row) => resolve(row)
          );
        });

        // 2. LOGIKA HITUNG REFUND
        let refundAmount = 0;
        let sisaHari = 0;

        if (accData && accData.expire_at) {
          const now = Date.now();
          const exp = Number(accData.expire_at);
          
          // Hanya refund jika belum expired
          if (exp > now) {
            const msPerDay = 24 * 60 * 60 * 1000;
            sisaHari = Math.floor((exp - now) / msPerDay);
            
            // Rumus: Sisa Hari * Harga Harian Server
            // Pastikan accData.harga adalah harga harian (sesuai create logic kamu)
            if (sisaHari > 0 && accData.harga > 0) {
              refundAmount = sisaHari * accData.harga;
            }
          }
        }

        // 3. EKSEKUSI PENGHAPUSAN DI PANEL (API)
        let msg = 'Gagal menghapus akun.';
        const password = 'none', exp = 'none', iplimit = 'none';

        const delFunctions = {
          vmess: delvmess,
          vless: delvless,
          trojan: deltrojan,
          shadowsocks: delshadowsocks,
          ssh: delssh
        };

        if (delFunctions[type]) {
          msg = await delFunctions[type](username, password, exp, iplimit, serverId);
        }

        // 4. CEK HASIL PANEL & PROSES REFUND
        const lowerMsg = String(msg).toLowerCase();
        // Asumsi sukses jika tidak ada kata 'gagal', 'error', atau 'not found'
        const isSuccess = !lowerMsg.includes('gagal') && !lowerMsg.includes('error') && !lowerMsg.includes('not found');

        if (isSuccess) {
          // A. Hapus dari database lokal agar sinkron
          db.run("DELETE FROM user_accounts WHERE username = ? AND server_id = ?", [username, serverId]);

          // B. Proses Refund ke Saldo User
          if (refundAmount > 0) {
             // Update Saldo
             db.run("UPDATE users SET saldo = saldo + ? WHERE user_id = ?", [refundAmount, ctx.from.id]);
             
             // Catat di Riwayat Transaksi
             const refId = `refund-${username}-${Date.now()}`;
             db.run(
               "INSERT INTO transactions (user_id, amount, type, reference_id, timestamp) VALUES (?, ?, 'refund', ?, ?)",
               [ctx.from.id, refundAmount, refId, Date.now()]
             );

             // Tambahkan info refund ke pesan balasan
             msg += `\n\n💰 *REFUND BERHASIL*\n` +
                    `📅 Sisa Masa Aktif: ${sisaHari} Hari\n` +
                    `💸 Saldo Kembali: Rp ${refundAmount.toLocaleString()}`;
          }
        }

        await ctx.reply(msg, { parse_mode: 'Markdown' });
        logger.info(`✅ Akun ${type} dihapus oleh ${ctx.from.id}. Refund: ${refundAmount}`);

      } catch (err) {
        logger.error('❌ Gagal hapus akun:', err.message);
        await ctx.reply('❌ *Terjadi kesalahan saat menghapus akun.*', { parse_mode: 'Markdown' });
      }
    });
    return; // Penting! Jangan lanjut ke case lain
  }
  if (state.step?.startsWith('username_')) {
    state.username = text;

    if (!state.username) {
      return ctx.reply('❌ *Username tidak valid. Masukkan username yang valid.*', { parse_mode: 'Markdown' });
    }
    if (state.username.length < 4 || state.username.length > 20) {
      return ctx.reply('❌ *Username harus terdiri dari 4 hingga 20 karakter.*', { parse_mode: 'Markdown' });
    }
    if (/[A-Z]/.test(state.username)) {
      return ctx.reply('❌ *Username tidak boleh menggunakan huruf kapital. Gunakan huruf kecil saja.*', { parse_mode: 'Markdown' });
    }
    if (/[^a-z0-9]/.test(state.username)) {
      return ctx.reply('❌ *Username tidak boleh mengandung karakter khusus atau spasi. Gunakan huruf kecil dan angka saja.*', { parse_mode: 'Markdown' });
    }
const { type, action } = state;

    if (action === 'create') {
      if (type === 'ssh') {
        state.step = `password_${state.action}_${state.type}`;
        await ctx.reply('🔑 *Masukkan password:*', { parse_mode: 'Markdown' });
      } else {
        state.step = `exp_${state.action}_${state.type}`;
        await ctx.reply('⏳  *Masukkan masa aktif (hari):*', { parse_mode: 'Markdown' });
      }
    } else if (action === 'renew') {
      state.step = `exp_${state.action}_${state.type}`;
      await ctx.reply('⏳  *Masukkan masa aktif (hari):*', { parse_mode: 'Markdown' });
    } else if (action === 'addip') {
      state.step = `addip_amount_${state.type}`;
      await ctx.reply('➕  *Masukkan IP limit BARU (angka):*', { parse_mode: 'Markdown' });
    }
  } else if (state.step?.startsWith('password_')) {
    state.password = ctx.message.text.trim();
    if (!state.password) {
      return ctx.reply('❌ *Password tidak valid. Masukkan password yang valid.*', { parse_mode: 'Markdown' });
    }
    if (state.password.length < 3) {
      return ctx.reply('❌ *Password harus terdiri dari minimal 3 karakter.*', { parse_mode: 'Markdown' });
    }
    if (/[^a-zA-Z0-9]/.test(state.password)) {
      return ctx.reply('❌ *Password tidak boleh mengandung karakter khusus atau spasi.*', { parse_mode: 'Markdown' });
    }
    state.step = `exp_${state.action}_${state.type}`;
    await ctx.reply('⏳ *Masukkan masa aktif (hari):*', { parse_mode: 'Markdown' });

} else if (state.step?.startsWith('addip_amount_')) {
  try {
    const isR = await isUserReseller(ctx.from.id);
    if (!isR) {
      delete userState[ctx.chat.id];
      return ctx.reply('❌ Fitur ini khusus reseller.', { parse_mode: 'Markdown' });
    }
    if (!RESELLER_ADDIP_CFG.enabled) {
      delete userState[ctx.chat.id];
      return ctx.reply('❌ Fitur Add IP sedang dimatikan.', { parse_mode: 'Markdown' });
    }

    const addStr = ctx.message.text.trim();
    if (!/^\d+$/.test(addStr)) {
      return ctx.reply('❌ IP limit harus angka. Contoh: 2', { parse_mode: 'Markdown' });
    }
    const newLimit = parseInt(addStr, 10);
    if (!Number.isFinite(newLimit) || newLimit <= 0) {
      return ctx.reply('❌ IP limit tidak valid.', { parse_mode: 'Markdown' });
    }
    if (newLimit > 200) {
      return ctx.reply('❌ Maksimal IP limit 200.', { parse_mode: 'Markdown' });
    }


    // cek saldo
    db.get('SELECT saldo FROM users WHERE user_id = ?', [ctx.from.id], async (err, user) => {
      if (err || !user) {
        delete userState[ctx.chat.id];
        return ctx.reply('❌ Pengguna tidak ditemukan.', { parse_mode: 'Markdown' });
      }
      // Ambil baseline iplimit server (saat create) untuk hitung kenaikan & biaya
      db.get('SELECT iplimit FROM Server WHERE id = ?', [state.serverId], async (err2, server) => {
        if (err2 || !server) {
          delete userState[ctx.chat.id];
          return ctx.reply('❌ Server tidak ditemukan.', { parse_mode: 'Markdown' });
        }

        const baseline = Number(server.iplimit) || 0;
        const addCount = newLimit - baseline;

        if (addCount <= 0) {
          return ctx.reply(
            `❌ IP limit baru harus lebih besar dari baseline server.\n` +
            `Baseline: *${baseline}*\n` +
            `Kamu isi: *${newLimit}*`,
            { parse_mode: 'Markdown' }
          );
        }
        if (addCount > 50) {
          return ctx.reply('❌ Maksimal kenaikan 50 IP per transaksi.', { parse_mode: 'Markdown' });
        }

        const biaya = addCount * RESELLER_ADDIP_CFG.pricePerIp;

        if ((Number(user.saldo) || 0) < biaya) {
          return ctx.reply(
            `❌ Saldo tidak cukup.\n\nBiaya: *Rp${biaya.toLocaleString()}*\nSaldo kamu: *Rp${Number(user.saldo).toLocaleString()}*`,
            { parse_mode: 'Markdown' }
          );
        }

        const targetIpLimit = newLimit;


        // jalankan update iplimit akun via modul addip
        try {
          const msg = await addIpLimitAccount(state.type, state.username, targetIpLimit, state.serverId);

          // potong saldo setelah sukses
          db.run('UPDATE users SET saldo = saldo - ? WHERE user_id = ?', [biaya, ctx.from.id], async (err3) => {
            if (err3) {
              logger.error('❌ Gagal potong saldo addip:', err3.message);
            }
            await ctx.reply(
              `✅ *Add IP berhasil!*\n` +
              `👤 Username: \`${state.username}\`\n` +
              `🔐 IP Limit Baru: *${targetIpLimit}*\n` +
              `💸 Biaya: *Rp${biaya.toLocaleString()}*\n\n` +
              `${msg ? msg : ''}`,
              { parse_mode: 'Markdown' }
            );
            delete userState[ctx.chat.id];
          });
} catch (e) {
  console.error('❌ addIpLimitAccount FULL ERROR:', e);
  delete userState[ctx.chat.id];

  const errMsg = e?.message || 'Terjadi kesalahan saat Add IP.';
  return ctx.reply(
    `❌ *Gagal Add IP!*\n${errMsg}`,
    { parse_mode: 'Markdown' }
  );
}
      });
    });
  } catch (e) {
    logger.error('❌ addip_amount handler error:', e.message);
    delete userState[ctx.chat.id];
    return ctx.reply('❌ Terjadi kesalahan saat proses Add IP.', { parse_mode: 'Markdown' });
  }

  } else if (state.step?.startsWith('exp_')) {
    const expInput = ctx.message.text.trim();
    
    // Validasi Input Angka
    if (!/^\d+$/.test(expInput)) {
      return ctx.reply('❌ Masa aktif hanya boleh angka (contoh: 30).', { parse_mode: 'Markdown' });
    }
    const exp = parseInt(expInput, 10);
    if (isNaN(exp) || exp <= 0) {
      return ctx.reply('❌ Masa aktif tidak valid. Masukkan angka > 0.', { parse_mode: 'Markdown' });
    }
    if (exp > 365) {
      return ctx.reply('❌ Masa aktif maksimal 365 hari.', { parse_mode: 'Markdown' });
    }

    state.exp = exp;

    // Ambil Data Server
    db.get('SELECT quota, iplimit, harga FROM Server WHERE id = ?', [state.serverId], async (err, server) => {
      if (err) {
        logger.error('Error fetching server details:', err.message);
        return ctx.reply('❌ Gagal mengambil data server.', { parse_mode: 'Markdown' });
      }
      if (!server) {
        return ctx.reply('❌ Server tidak ditemukan.', { parse_mode: 'Markdown' });
      }

      state.quota = server.quota;
      state.iplimit = server.iplimit;
      
      const { username, password, exp, quota, iplimit, serverId, type, action } = state;
      const harga = server.harga;
      const totalHarga = harga * state.exp;

      // Cek Saldo User
      db.get('SELECT saldo FROM users WHERE user_id = ?', [ctx.from.id], async (err, user) => {
        if (err || !user) {
          return ctx.reply('❌ Data pengguna tidak ditemukan.', { parse_mode: 'Markdown' });
        }

        const saldo = user.saldo;
        if (saldo < totalHarga) {
          return ctx.reply(
            `❌ *Saldo Tidak Cukup!*\n` +
            `💰 Total Harga: Rp${totalHarga.toLocaleString()}\n` +
            `💳 Saldo Anda: Rp${saldo.toLocaleString()}`, 
            { parse_mode: 'Markdown' }
          );
        }

        // ==========================================
        // ⏳ START ANIMASI LOADING BAR (MINIMALIS)
        // ==========================================
        let loadingMsg;
        try {
          loadingMsg = await ctx.reply(`⏳ [█░░░░░░░░░] 10%`, { parse_mode: 'Markdown' });
        } catch (e) { return; }

        const updateProgress = async (bar, percent) => {
          try {
            await ctx.telegram.editMessageText(
              ctx.chat.id,
              loadingMsg.message_id,
              null,
              `⏳ [${bar}] ${percent}%`,
              { parse_mode: 'Markdown' }
            );
          } catch (e) {} 
        };

        try {
          // --- STEP 1: Persiapan (10% -> 40%) ---
          await new Promise(r => setTimeout(r, 300));
          await updateProgress('████░░░░░░', 40);

          // --- STEP 2: Eksekusi API (Proses Berat) ---
          let res;            
          let msg;            
          let expireAtMs = 0; 

          if (type === 'vmess') {
            res = action === 'create'
              ? await createvmess(username, exp, quota, iplimit, serverId)
              : await renewvmess(username, exp, quota, iplimit, serverId, true);
          } else if (type === 'vless') {
            res = action === 'create'
              ? await createvless(username, exp, quota, iplimit, serverId)
              : await renewvless(username, exp, quota, iplimit, serverId, true);
          } else if (type === 'trojan') {
            res = action === 'create'
              ? await createtrojan(username, exp, quota, iplimit, serverId)
              : await renewtrojan(username, exp, quota, iplimit, serverId, true);
          } else if (type === 'shadowsocks') {
            res = action === 'create'
              ? await createshadowsocks(username, exp, quota, iplimit, serverId)
              : await renewshadowsocks(username, exp, quota, iplimit, serverId, true);
          } else if (type === 'ssh') {
            res = action === 'create'
              ? await createssh(username, password, exp, iplimit, serverId)
              : await renewssh(username, exp, iplimit, serverId, true);
          } else if (type === 'zivpn') {
            if (action === 'create') {
               res = await createzivpn(username, password, exp, iplimit, serverId);
            } else {
               res = await renewzivpn(username, 'none', exp, iplimit, serverId);
            }
          }

          // --- STEP 3: Validasi Hasil (80%) ---
          await updateProgress('████████░░', 80);

          // Normalisasi Hasil
          if (typeof res === 'object' && res && res.ok) {
            msg = res.msg;
            expireAtMs = parsePanelToMs(res.to) || parsePanelToMs(extractToFromMsg(res.msg));
          } else if (typeof res === 'object' && res) {
            msg = res.msg || String(res);
          } else {
            msg = res; 
          }

          // Cek Kegagalan
          const safeMsg = (typeof msg === 'string') ? msg : String(msg || '');
          const lower = safeMsg.toLowerCase().trim();
          const isFail = lower === '' || lower.startsWith('❌') || lower.includes('gagal') || lower.includes('error');

          if (isFail) {
            // Jika gagal, hapus loading dan tampilkan error
            await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(()=>{});
            const errText = safeMsg.trim() || '⚠️ Proses gagal (panel tidak merespon sukses).';
            logger.error(`Transaksi gagal user ${ctx.from.id} (${action}): ${lower}`);
            await ctx.reply(errText, { parse_mode: 'Markdown' });
            return; 
          }

          // --- STEP 4: Database Update (Saldo & Poin) ---
          
          // Potong Saldo
          db.run('UPDATE users SET saldo = saldo - ? WHERE user_id = ?', [totalHarga, ctx.from.id]);

          // Tambah Poin (Logic Baru: Create & Renew dapat poin)
          if (action === 'create' || action === 'renew') {
              const durasiPoin = state.exp || exp; 
              addResellerPoint(ctx.from.id, durasiPoin).catch(e => console.error('Gagal add poin:', e));
          }

          // Catat Transaksi
          await recordAccountTransaction(ctx.from.id, type, exp);

          // Simpan Akun (Sync)
          try {
            let panelExpireMs = 0;
            if (action === 'renew') {
              panelExpireMs = expireAtMs || parsePanelToMs(extractToFromMsg(msg));
            }
            await syncUserAccountAfterSuccess({
              userId: ctx.from.id,
              type, serverId, username, quota, iplimit,
              expDays: exp, action, expireAtMs: panelExpireMs
            });
          } catch (e) {
            logger.error('Gagal sync user_accounts:', e.message);
          }

          // --- STEP 5: Selesai (100%) ---
          await updateProgress('██████████', 100);
          await new Promise(r => setTimeout(r, 400)); // Delay dikit biar bar penuh terlihat

          // Hapus Loading Bar & Kirim Pesan Sukses
          await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(()=>{});
          
          const successText = safeMsg.trim() || `✅ Akun ${type.toUpperCase()} berhasil diproses.`;
          logger.info(`Account ${action} sukses user ${ctx.from.id}, type: ${type}`);
          await ctx.reply(successText, { parse_mode: 'Markdown' });

          // --- STEP 6: Notifikasi Grup ---
          let role = 'Member';
          if (ctx.from.id == ADMIN) role = 'Admin 👑';
          
          try {
            if (fs.existsSync('ressel.db')) {
                const resselData = fs.readFileSync('ressel.db', 'utf8');
                if (resselData.includes(ctx.from.id.toString())) role = 'Reseller ⚡';
            }
          } catch (err) {}

          const masked = username.length > 3 ? username.slice(0, 3) + 'x'.repeat(username.length - 3) : username;
          const serverName = await getServerName(serverId);
          
          // UBAH DI SINI: Tambahkan .replace('@', '') di akhir
          const userMention = buildUserMentionHtml(ctx.from.id, ctx.from.username).replace('@', '');

          // Siapkan variabel tanggal & label
          const actionTitle = action === 'create' ? 'CREATE' : 'RENEW';
          const timeLabel   = action === 'create' ? 'Duration' : 'Extended';
          const expDate     = new Date(Date.now() + parseInt(exp) * 86400000).toISOString().split('T')[0];

          const msgGroup =
            `<pre>` +
            `<b>📡 SUCCESS ${actionTitle} ${type.toUpperCase()}</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `👤 User     : ${userMention}\n` +          // 4 huruf + 6 spasi
            `🆔 User ID  : ${ctx.from.id}\n` +          // 7 huruf + 3 spasi
            `🎭 Role     : ${escapeHtml(role)}\n` +     // 4 huruf + 6 spasi
            `🌐 Server   : ${escapeHtml(serverName)}\n` + // 6 huruf + 4 spasi
            `📝 Remark   : ${escapeHtml(masked)}\n` +   // 6 huruf + 4 spasi
            `🔐 Limit IP : ${iplimit} Device\n` +       // 8 huruf + 2 spasi
            `⏳ ${timeLabel} : ${exp} Days\n` +         // 8 huruf + 2 spasi
            `📆 Expired  : ${expDate}\n` +              // 7 huruf + 3 spasi
            `━━━━━━━━━━━━━━━━━━━━` +
            `</pre>`;

          // Kirim ke Group (Syntax sudah diperbaiki)
          await bot.telegram.sendMessage(GROUP_ID, msgGroup, { parse_mode: 'HTML' })
              .catch(err => console.log('Gagal kirim notif:', err.message));

          delete userState[ctx.chat.id];

        } catch (error) {
          console.error(error);
          await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});
          await ctx.reply('❌ Terjadi kesalahan sistem saat memproses akun.', { parse_mode: 'Markdown' });
        }
      });
    });
  }
else if (state.step === 'addserver') {
  const domain = ctx.message.text.trim();
  if (!domain) {
    await ctx.reply('Domain tidak boleh kosong. Silakan masukkan domain server yang valid.', { parse_mode: 'Markdown' });
    return;
  }
  state.step = 'addserver_auth';
  state.domain = domain;
  await ctx.reply('Silakan masukkan auth server:', { parse_mode: 'Markdown' });
} 
else if (state.step === 'addserver_auth') {
  const auth = ctx.message.text.trim();
  if (!auth) {
    await ctx.reply('Auth tidak boleh kosong. Silakan masukkan auth server yang valid.', { parse_mode: 'Markdown' });
    return;
  }
  state.step = 'addserver_nama_server';
  state.auth = auth;
  await ctx.reply('Silakan masukkan nama server:', { parse_mode: 'Markdown' });
} 
else if (state.step === 'addserver_nama_server') {
  const nama_server = ctx.message.text.trim();
  if (!nama_server) {
    await ctx.reply('Nama server tidak boleh kosong. Silakan masukkan nama server yang valid.', { parse_mode: 'Markdown' });
    return;
  }
  state.step = 'addserver_quota';
  state.nama_server = nama_server;
  await ctx.reply('Silakan masukkan quota server (GB):', { parse_mode: 'Markdown' });
} 
else if (state.step === 'addserver_quota') {
  const quota = parseInt(ctx.message.text.trim(), 10);
  if (isNaN(quota)) {
    await ctx.reply('Quota tidak valid. Silakan masukkan angka.', { parse_mode: 'Markdown' });
    return;
  }
  state.step = 'addserver_iplimit';
  state.quota = quota;
  await ctx.reply('Silakan masukkan limit IP server:', { parse_mode: 'Markdown' });
} 
else if (state.step === 'addserver_iplimit') {
  const iplimit = parseInt(ctx.message.text.trim(), 10);
  if (isNaN(iplimit)) {
    await ctx.reply('Limit IP tidak valid. Silakan masukkan angka.', { parse_mode: 'Markdown' });
    return;
  }
  state.step = 'addserver_batas_create_akun';
  state.iplimit = iplimit;
  await ctx.reply('Silakan masukkan batas create akun server:', { parse_mode: 'Markdown' });
} 
else if (state.step === 'addserver_batas_create_akun') {
  const batas_create_akun = parseInt(ctx.message.text.trim(), 10);
  if (isNaN(batas_create_akun)) {
    await ctx.reply('Batas create akun tidak valid. Silakan masukkan angka.', { parse_mode: 'Markdown' });
    return;
  }
  state.step = 'addserver_harga';
  state.batas_create_akun = batas_create_akun;
  await ctx.reply('💰 Silakan masukkan harga server **UNTUK MEMBER** (angka):', { parse_mode: 'Markdown' });
} 
else if (state.step === 'addserver_harga') {
  const harga = parseFloat(ctx.message.text.trim());
  if (isNaN(harga) || harga <= 0) {
    return ctx.reply('❌ Harga tidak valid. Silakan masukkan harga member yang valid.', { parse_mode: 'Markdown' });
  }
  
  // Setel harga member dan minta harga reseller
  state.step = 'addserver_harga_reseller';
  state.harga = harga; 
  await ctx.reply('💰 Silakan masukkan harga server **KHUSUS RESELLER** (angka):', { parse_mode: 'Markdown' });
} 
else if (state.step === 'addserver_harga_reseller') {
  const harga_reseller = parseFloat(ctx.message.text.trim());
  if (isNaN(harga_reseller) || harga_reseller <= 0) {
    return ctx.reply('❌ Harga reseller tidak valid. Silakan masukkan angka yang valid.', { parse_mode: 'Markdown' });
  }

  state.harga_reseller = harga_reseller;
  state.step = 'addserver_api_type';
  await ctx.reply('Pilih API type server:\n`1` = API lama bot ini\n`2` = API Potato/BotVPN2\n\nKirim angka 1 atau 2.', { parse_mode: 'Markdown' });
}
else if (state.step === 'addserver_api_type') {
  const api_type = Number(ctx.message.text.trim() || 1);
  if (![1, 2].includes(api_type)) {
    return ctx.reply('❌ API type tidak valid. Kirim `1` atau `2`.', { parse_mode: 'Markdown' });
  }

  const { domain, auth, nama_server, quota, iplimit, batas_create_akun, harga, harga_reseller } = state;

  // 1. Insert Member (is_reseller_only = 0)
  db.run("INSERT INTO Server (domain, auth, nama_server, quota, iplimit, batas_create_akun, harga, total_create_akun, is_reseller_only, api_type, service) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 'ssh')", 
    [domain, auth, nama_server, quota, iplimit, batas_create_akun, harga, api_type]);

  // 2. Insert Reseller (is_reseller_only = 1)
  db.run("INSERT INTO Server (domain, auth, nama_server, quota, iplimit, batas_create_akun, harga, total_create_akun, is_reseller_only, api_type, service) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, ?, 'ssh')", 
    [domain, auth, `${nama_server} [RS]`, quota, iplimit, batas_create_akun, harga_reseller, api_type], function(err) {
      if (err) {
        logger.error('Error saat menambahkan server:', err.message);
        ctx.reply('❌ Terjadi kesalahan saat menambahkan server baru.', { parse_mode: 'Markdown' });
      } else {
        ctx.reply(`✅ Server **${nama_server}** telah berhasil ditambahkan!\n\n📋 **Sistem otomatis memisahkan:**\n- Harga Member: Rp ${harga}\n- Harga Reseller: Rp ${harga_reseller}\n- API Type: ${api_type === 2 ? '2 - Potato/BotVPN2' : '1 - Lama'}`, { parse_mode: 'Markdown' });
      }
    });

  delete userState[ctx.chat.id];
}

// === 💰 TAMBAH SALDO (LANGKAH 1: INPUT USER ID) ===
else if (state && state.step === 'addsaldo_userid') {
  const targetId = Number(String(text).trim());

  if (!Number.isFinite(targetId) || targetId <= 0) {
    return ctx.reply('⚠️ Masukkan *User ID* angka yang valid.\nContoh: 6544156764', { parse_mode: 'Markdown' });
  }

  state.targetId = targetId;
  state.step = 'addsaldo_amount';
  return ctx.reply('💰 Masukkan jumlah saldo yang ingin ditambahkan (angka saja):');
}

// === 💰 TAMBAH SALDO (LANGKAH 2: INPUT JUMLAH SALDO) ===
else if (state && state.step === 'addsaldo_amount') {
  const amount = Number(String(text).trim());
  if (!Number.isFinite(amount) || amount <= 0) {
    return ctx.reply('⚠️ Jumlah saldo harus berupa angka dan lebih dari 0.');
  }

  const targetId = Number(state.targetId);

  // 1) Pastikan user ada dulu (anti "User not found")
  db.run(
    'INSERT OR IGNORE INTO users (user_id) VALUES (?)',
    [targetId],
    (errIns) => {
      if (errIns) {
        logger.error('❌  Gagal memastikan user ada:', errIns.message);
        delete userState[ctx.from.id];
        return ctx.reply('❌  Gagal memproses (insert user).');
      }

      // 2) Tambahkan saldo
      db.run(
        'UPDATE users SET saldo = saldo + ? WHERE user_id = ?',
        [amount, targetId],
        function (errUp) {
          if (errUp) {
            logger.error('❌  Gagal menambah saldo:', errUp.message);
            delete userState[ctx.from.id];
            return ctx.reply('❌  Gagal menambah saldo ke user.');
          }

          if (this.changes === 0) {
            delete userState[ctx.from.id];
            return ctx.reply(`❌ User ID ${targetId} tidak ditemukan.`);
          }

          // 3) Ambil saldo terbaru
          db.get(
            'SELECT saldo FROM users WHERE user_id = ?',
            [targetId],
            (err2, updated) => {
              if (err2 || !updated) {
                ctx.reply(`✅ Saldo Rp${amount} berhasil ditambahkan ke User ID ${targetId}.`);
                logger.info(`Admin ${ctx.from.id} menambah saldo Rp${amount} ke user ${targetId}.`);
              } else {
                ctx.reply(
                  `✅ Saldo Rp${amount} berhasil ditambahkan ke User ID ${targetId}.\n💳 Saldo sekarang: Rp${updated.saldo}`
                );
                logger.info(
                  `Admin ${ctx.from.id} menambah saldo Rp${amount} ke user ${targetId} (Saldo akhir: Rp${updated.saldo}).`
                );
              }
              delete userState[ctx.from.id];
            }
          );
        }
      );
    }
  );

  return;
}
});


// === 💳 CEK SALDO USER ===
bot.action('cek_saldo_user', async (ctx) => {
  const adminId = ctx.from.id;

  if (!adminIds.includes(adminId)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk menggunakan fitur ini.');
  }

  await ctx.answerCbQuery();
  await ctx.reply('🔍 Masukkan ID Telegram user yang ingin dicek saldonya:');
  userState[adminId] = { step: 'cek_saldo_userid' };
});
//

// === 🔄 RESTART BOT ===
bot.action('restart_bot', async (ctx) => {
  const adminId = ctx.from.id;

  if (!adminIds.includes(adminId)) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk menggunakan fitur ini.');
  }

  await ctx.answerCbQuery();
  await ctx.reply('♻️ Restarting bot, Please wait...');

  exec("pm2 restart all", (error, stdout, stderr) => {
    if (error) {
      return ctx.reply(`❌ Gagal restart bot:\n${error.message}`);
    }
    ctx.reply("✅ Bot berhasil direstart!");
  });
});
bot.action('addserver', async (ctx) => {
  try {
    logger.info('📥 Proses tambah server dimulai');
    await ctx.answerCbQuery();
    await ctx.reply('🌐 *Silakan masukkan domain/ip server:*', { parse_mode: 'Markdown' });
    userState[ctx.chat.id] = { step: 'addserver' };
  } catch (error) {
    logger.error('❌ Kesalahan saat memulai proses tambah server:', error);
    await ctx.reply('❌ *GAGAL! Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.*', { parse_mode: 'Markdown' });
  }
});
bot.action('addserver_zivpn', async (ctx) => {
  try {
    if (!adminIds.includes(ctx.from.id)) return ctx.reply('⚠️ Anda tidak memiliki izin.', { parse_mode: 'Markdown' });
    logger.info('📥 Proses tambah server ZIVPN member dimulai');
    await ctx.answerCbQuery();
    userState[ctx.chat.id] = { step: 'addserver_zivpn_regex', resellerOnly: false };
    await replyAddServerZivpnFormat(ctx, false);
  } catch (error) {
    logger.error('❌ Kesalahan saat memulai tambah ZIVPN member:', error);
    await ctx.reply('❌ *GAGAL! Terjadi kesalahan saat memproses permintaan Anda.*', { parse_mode: 'Markdown' });
  }
});

bot.action('addserver_zivpn_reseller', async (ctx) => {
  try {
    if (!adminIds.includes(ctx.from.id)) return ctx.reply('⚠️ Anda tidak memiliki izin.', { parse_mode: 'Markdown' });
    logger.info('📥 Proses tambah server ZIVPN reseller dimulai');
    await ctx.answerCbQuery();
    userState[ctx.chat.id] = { step: 'addserver_zivpn_regex', resellerOnly: true };
    await replyAddServerZivpnFormat(ctx, true);
  } catch (error) {
    logger.error('❌ Kesalahan saat memulai tambah ZIVPN reseller:', error);
    await ctx.reply('❌ *GAGAL! Terjadi kesalahan saat memproses permintaan Anda.*', { parse_mode: 'Markdown' });
  }
});
bot.action('detailserver', async (ctx) => {
  try {
    logger.info('📋 Proses detail server dimulai');
    await ctx.answerCbQuery();
    
    const servers = await new Promise((resolve, reject) => {
      db.all('SELECT * FROM Server', [], (err, servers) => {
        if (err) {
          logger.error('⚠️ Kesalahan saat mengambil detail server:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil detail server.*');
        }
        resolve(servers);
      });
    });

    if (servers.length === 0) {
      logger.info('⚠️ Tidak ada server yang tersedia');
      return ctx.reply('⚠️ *PERHATIAN! Tidak ada server yang tersedia saat ini.*', { parse_mode: 'Markdown' });
    }

    const buttons = [];
    for (let i = 0; i < servers.length; i += 2) {
      const row = [];
      row.push({
        text: `${servers[i].nama_server}`,
        callback_data: `server_detail_${servers[i].id}`
      });
      if (i + 1 < servers.length) {
        row.push({
          text: `${servers[i + 1].nama_server}`,
          callback_data: `server_detail_${servers[i + 1].id}`
        });
      }
      buttons.push(row);
    }

    await ctx.reply('📋 *Silakan pilih server untuk melihat detail:*', {
      reply_markup: { inline_keyboard: buttons },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    logger.error('⚠️ Kesalahan saat mengambil detail server:', error);
    await ctx.reply('⚠️ *Terjadi kesalahan saat mengambil detail server.*', { parse_mode: 'Markdown' });
  }
});

bot.action('listserver', async (ctx) => {
  try {
    logger.info('📜 Proses daftar server dimulai');
    await ctx.answerCbQuery();
    
    const servers = await new Promise((resolve, reject) => {
      db.all('SELECT * FROM Server', [], (err, servers) => {
        if (err) {
          logger.error('⚠️ Kesalahan saat mengambil daftar server:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil daftar server.*');
        }
        resolve(servers);
      });
    });

    if (servers.length === 0) {
      logger.info('⚠️ Tidak ada server yang tersedia');
      return ctx.reply('⚠️ *PERHATIAN! Tidak ada server yang tersedia saat ini.*', { parse_mode: 'Markdown' });
    }

    let serverList = '📜 *Daftar Server* 📜\n\n';
    servers.forEach((server, index) => {
      serverList += `🔹 ${index + 1}. ${server.domain}\n`;
    });

    serverList += `\nTotal Jumlah Server: ${servers.length}`;

    await ctx.reply(serverList, { parse_mode: 'Markdown' });
  } catch (error) {
    logger.error('⚠️ Kesalahan saat mengambil daftar server:', error);
    await ctx.reply('⚠️ *Terjadi kesalahan saat mengambil daftar server.*', { parse_mode: 'Markdown' });
  }
});
bot.action('resetdb', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await ctx.reply('🚨 *PERHATIAN! Anda akan menghapus semua server yang tersedia. Apakah Anda yakin?*', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Ya', callback_data: 'confirm_resetdb' }],
          [{ text: '❌ Tidak', callback_data: 'cancel_resetdb' }]
        ]
      },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    logger.error('❌ Error saat memulai proses reset database:', error);
    await ctx.reply(`❌ *${error}*`, { parse_mode: 'Markdown' });
  }
});

bot.action('confirm_resetdb', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await new Promise((resolve, reject) => {
      db.run('DELETE FROM Server', (err) => {
        if (err) {
          logger.error('❌ Error saat mereset tabel Server:', err.message);
          return reject('❗️ *PERHATIAN! Terjadi KESALAHAN SERIUS saat mereset database. Harap segera hubungi administrator!*');
        }
        resolve();
      });
    });
    await ctx.reply('🚨 *PERHATIAN! Database telah DIRESET SEPENUHNYA. Semua server telah DIHAPUS TOTAL.*', { parse_mode: 'Markdown' });
  } catch (error) {
    logger.error('❌ Error saat mereset database:', error);
    await ctx.reply(`❌ *${error}*`, { parse_mode: 'Markdown' });
  }
});

bot.action('cancel_resetdb', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await ctx.reply('❌ *Proses reset database dibatalkan.*', { parse_mode: 'Markdown' });
  } catch (error) {
    logger.error('❌ Error saat membatalkan reset database:', error);
    await ctx.reply(`❌ *${error}*`, { parse_mode: 'Markdown' });
  }
});
bot.action('deleteserver', async (ctx) => {
  try {
    logger.info('🗑️ Proses hapus server dimulai');
    await ctx.answerCbQuery();
    
    db.all('SELECT * FROM Server', [], (err, servers) => {
      if (err) {
        logger.error('⚠️ Kesalahan saat mengambil daftar server:', err.message);
        return ctx.reply('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil daftar server.*', { parse_mode: 'Markdown' });
      }

      if (servers.length === 0) {
        logger.info('⚠️ Tidak ada server yang tersedia');
        return ctx.reply('⚠️ *PERHATIAN! Tidak ada server yang tersedia saat ini.*', { parse_mode: 'Markdown' });
      }

      const keyboard = servers.map(server => {
        return [{ text: server.nama_server, callback_data: `confirm_delete_server_${server.id}` }];
      });
      keyboard.push([{ text: '🔙 Kembali ke Menu Utama', callback_data: 'kembali_ke_menu' }]);

      ctx.reply('🗑️ *Pilih server yang ingin dihapus:*', {
        reply_markup: {
          inline_keyboard: keyboard
        },
        parse_mode: 'Markdown'
      });
    });
  } catch (error) {
    logger.error('❌ Kesalahan saat memulai proses hapus server:', error);
    await ctx.reply('❌ *GAGAL! Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.*', { parse_mode: 'Markdown' });
  }
});


const getUsernameById = async (userId) => {
  try {
    const telegramUser = await bot.telegram.getChat(userId);
    return telegramUser.username || telegramUser.first_name;
  } catch (err) {
    logger.error('❌ Kesalahan saat mengambil username dari Telegram:', err.message);
    throw new Error('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil username dari Telegram.*');
  }
};

bot.action('addsaldo_user', async (ctx) => {
  try {
    logger.info('Add saldo user process started (manual input ID)');
    await ctx.answerCbQuery();

    // set state admin agar step berikutnya minta user id
    userState[ctx.from.id] = { step: 'addsaldo_userid' };

    const msg =
      '💰 <b>Tambah Saldo (Manual)</b>\n\n' +
      'Silakan kirim <b>User ID</b> (angka) target.\n' +
      'Contoh: <code>6544156764</code>\n\n' +
      'Ketik /cancel untuk membatalkan.';

    // coba edit pesan tombol biar rapi; kalau gagal, reply biasa
    try {
      await ctx.editMessageText(msg, { parse_mode: 'HTML' });
    } catch (e) {
      await ctx.reply(msg, { parse_mode: 'HTML' });
    }
  } catch (e) {
    logger.error('❌ addsaldo_user action error:', e.message);
    try {
      await ctx.reply('❌ Terjadi error saat memulai tambah saldo.');
    } catch (_) {}
  }
});

bot.action('editserver_limit_ip', async (ctx) => {
  try {
    logger.info('Edit server limit IP process started');
    await ctx.answerCbQuery();

    const servers = await new Promise((resolve, reject) => {
      db.all('SELECT id, nama_server FROM Server', [], (err, servers) => {
        if (err) {
          logger.error('❌ Kesalahan saat mengambil daftar server:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil daftar server.*');
        }
        resolve(servers);
      });
    });

    if (servers.length === 0) {
      return ctx.reply('⚠️ *PERHATIAN! Tidak ada server yang tersedia untuk diedit.*', { parse_mode: 'Markdown' });
    }

    const buttons = servers.map(server => ({
      text: server.nama_server,
      callback_data: `edit_limit_ip_${server.id}`
    }));

    const inlineKeyboard = [];
    for (let i = 0; i < buttons.length; i += 2) {
      inlineKeyboard.push(buttons.slice(i, i + 2));
    }

    await ctx.reply('📊 *Silakan pilih server untuk mengedit limit IP:*', {
      reply_markup: { inline_keyboard: inlineKeyboard },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    logger.error('❌ Kesalahan saat memulai proses edit limit IP server:', error);
    await ctx.reply(`❌ *${error}*`, { parse_mode: 'Markdown' });
  }
});
bot.action('editserver_batas_create_akun', async (ctx) => {
  try {
    logger.info('Edit server batas create akun process started');
    await ctx.answerCbQuery();

    const servers = await new Promise((resolve, reject) => {
      db.all('SELECT id, nama_server FROM Server', [], (err, servers) => {
        if (err) {
          logger.error('❌ Kesalahan saat mengambil daftar server:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil daftar server.*');
        }
        resolve(servers);
      });
    });

    if (servers.length === 0) {
      return ctx.reply('⚠️ *PERHATIAN! Tidak ada server yang tersedia untuk diedit.*', { parse_mode: 'Markdown' });
    }

    const buttons = servers.map(server => ({
      text: server.nama_server,
      callback_data: `edit_batas_create_akun_${server.id}`
    }));

    const inlineKeyboard = [];
    for (let i = 0; i < buttons.length; i += 2) {
      inlineKeyboard.push(buttons.slice(i, i + 2));
    }

    await ctx.reply('📊 *Silakan pilih server untuk mengedit batas create akun:*', {
      reply_markup: { inline_keyboard: inlineKeyboard },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    logger.error('❌ Kesalahan saat memulai proses edit batas create akun server:', error);
    await ctx.reply(`❌ *${error}*`, { parse_mode: 'Markdown' });
  }
});
bot.action('editserver_total_create_akun', async (ctx) => {
  try {
    logger.info('Edit server total create akun process started');
    await ctx.answerCbQuery();

    const servers = await new Promise((resolve, reject) => {
      db.all('SELECT id, nama_server FROM Server', [], (err, servers) => {
        if (err) {
          logger.error('❌ Kesalahan saat mengambil daftar server:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil daftar server.*');
        }
        resolve(servers);
      });
    });

    if (servers.length === 0) {
      return ctx.reply('⚠️ *PERHATIAN! Tidak ada server yang tersedia untuk diedit.*', { parse_mode: 'Markdown' });
    }

    const buttons = servers.map(server => ({
      text: server.nama_server,
      callback_data: `edit_total_create_akun_${server.id}`
    }));

    const inlineKeyboard = [];
    for (let i = 0; i < buttons.length; i += 2) {
      inlineKeyboard.push(buttons.slice(i, i + 2));
    }

    await ctx.reply('📊 *Silakan pilih server untuk mengedit total create akun:*', {
      reply_markup: { inline_keyboard: inlineKeyboard },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    logger.error('❌ Kesalahan saat memulai proses edit total create akun server:', error);
    await ctx.reply(`❌ *${error}*`, { parse_mode: 'Markdown' });
  }
});
bot.action('editserver_quota', async (ctx) => {
  try {
    logger.info('Edit server quota process started');
    await ctx.answerCbQuery();

    const servers = await new Promise((resolve, reject) => {
      db.all('SELECT id, nama_server FROM Server', [], (err, servers) => {
        if (err) {
          logger.error('❌ Kesalahan saat mengambil daftar server:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil daftar server.*');
        }
        resolve(servers);
      });
    });

    if (servers.length === 0) {
      return ctx.reply('⚠️ *PERHATIAN! Tidak ada server yang tersedia untuk diedit.*', { parse_mode: 'Markdown' });
    }

    const buttons = servers.map(server => ({
      text: server.nama_server,
      callback_data: `edit_quota_${server.id}`
    }));

    const inlineKeyboard = [];
    for (let i = 0; i < buttons.length; i += 2) {
      inlineKeyboard.push(buttons.slice(i, i + 2));
    }

    await ctx.reply('📊 *Silakan pilih server untuk mengedit quota:*', {
      reply_markup: { inline_keyboard: inlineKeyboard },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    logger.error('❌ Kesalahan saat memulai proses edit quota server:', error);
    await ctx.reply(`❌ *${error}*`, { parse_mode: 'Markdown' });
  }
});
bot.action('editserver_auth', async (ctx) => {
  try {
    logger.info('Edit server auth process started');
    await ctx.answerCbQuery();

    const servers = await new Promise((resolve, reject) => {
      db.all('SELECT id, nama_server FROM Server', [], (err, servers) => {
        if (err) {
          logger.error('❌ Kesalahan saat mengambil daftar server:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil daftar server.*');
        }
        resolve(servers);
      });
    });

    if (servers.length === 0) {
      return ctx.reply('⚠️ *PERHATIAN! Tidak ada server yang tersedia untuk diedit.*', { parse_mode: 'Markdown' });
    }

    const buttons = servers.map(server => ({
      text: server.nama_server,
      callback_data: `edit_auth_${server.id}`
    }));

    const inlineKeyboard = [];
    for (let i = 0; i < buttons.length; i += 2) {
      inlineKeyboard.push(buttons.slice(i, i + 2));
    }

    await ctx.reply('🌐 *Silakan pilih server untuk mengedit auth:*', {
      reply_markup: { inline_keyboard: inlineKeyboard },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    logger.error('❌ Kesalahan saat memulai proses edit auth server:', error);
    await ctx.reply(`❌ *${error}*`, { parse_mode: 'Markdown' });
  }
});

bot.action('editserver_harga', async (ctx) => {
  try {
    logger.info('Edit server harga process started');
    await ctx.answerCbQuery();

    const servers = await new Promise((resolve, reject) => {
      db.all('SELECT id, nama_server FROM Server', [], (err, servers) => {
        if (err) {
          logger.error('❌ Kesalahan saat mengambil daftar server:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil daftar server.*');
        }
        resolve(servers);
      });
    });

    if (servers.length === 0) {
      return ctx.reply('⚠️ *PERHATIAN! Tidak ada server yang tersedia untuk diedit.*', { parse_mode: 'Markdown' });
    }

    const buttons = servers.map(server => ({
      text: server.nama_server,
      callback_data: `edit_harga_${server.id}`
    }));

    const inlineKeyboard = [];
    for (let i = 0; i < buttons.length; i += 2) {
      inlineKeyboard.push(buttons.slice(i, i + 2));
    }

    await ctx.reply('💰 *Silakan pilih server untuk mengedit harga:*', {
      reply_markup: { inline_keyboard: inlineKeyboard },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    logger.error('❌ Kesalahan saat memulai proses edit harga server:', error);
    await ctx.reply(`❌ *${error}*`, { parse_mode: 'Markdown' });
  }
});

bot.action('editserver_domain', async (ctx) => {
  try {
    logger.info('Edit server domain process started');
    await ctx.answerCbQuery();

    const servers = await new Promise((resolve, reject) => {
      db.all('SELECT id, nama_server FROM Server', [], (err, servers) => {
        if (err) {
          logger.error('❌ Kesalahan saat mengambil daftar server:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil daftar server.*');
        }
        resolve(servers);
      });
    });

    if (servers.length === 0) {
      return ctx.reply('⚠️ *PERHATIAN! Tidak ada server yang tersedia untuk diedit.*', { parse_mode: 'Markdown' });
    }

    const buttons = servers.map(server => ({
      text: server.nama_server,
      callback_data: `edit_domain_${server.id}`
    }));

    const inlineKeyboard = [];
    for (let i = 0; i < buttons.length; i += 2) {
      inlineKeyboard.push(buttons.slice(i, i + 2));
    }

    await ctx.reply('🌐 *Silakan pilih server untuk mengedit domain:*', {
      reply_markup: { inline_keyboard: inlineKeyboard },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    logger.error('❌ Kesalahan saat memulai proses edit domain server:', error);
    await ctx.reply(`❌ *${error}*`, { parse_mode: 'Markdown' });
  }
});

bot.action('nama_server_edit', async (ctx) => {
  try {
    logger.info('Edit server nama process started');
    await ctx.answerCbQuery();

    const servers = await new Promise((resolve, reject) => {
      db.all('SELECT id, nama_server FROM Server', [], (err, servers) => {
        if (err) {
          logger.error('❌ Kesalahan saat mengambil daftar server:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil daftar server.*');
        }
        resolve(servers);
      });
    });

    if (servers.length === 0) {
      return ctx.reply('⚠️ *PERHATIAN! Tidak ada server yang tersedia untuk diedit.*', { parse_mode: 'Markdown' });
    }

    const buttons = servers.map(server => ({
      text: server.nama_server,
      callback_data: `edit_nama_${server.id}`
    }));

    const inlineKeyboard = [];
    for (let i = 0; i < buttons.length; i += 2) {
      inlineKeyboard.push(buttons.slice(i, i + 2));
    }

    await ctx.reply('🏷️ *Silakan pilih server untuk mengedit nama:*', {
      reply_markup: { inline_keyboard: inlineKeyboard },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    logger.error('❌ Kesalahan saat memulai proses edit nama server:', error);
    await ctx.reply(`❌ *${error}*`, { parse_mode: 'Markdown' });
  }
});

// ====================== UPGRADE RESELLER FLOW ======================
bot.action('upgrade_reseller', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;

    if (!RESELLER_UPGRADE_CFG.enabled) {
      return ctx.reply('⚠️ Fitur upgrade reseller sedang nonaktif. Silakan hubungi admin.');
    }

    const isR = await isUserReseller(userId);
    if (isR) {
      return ctx.reply('✅ Kamu sudah berstatus *Reseller*. Tidak perlu upgrade lagi.', { parse_mode: 'Markdown' });
    }

    // Format harga agar ada titiknya (contoh: 50.000)
    const priceFormatted = Number(RESELLER_UPGRADE_CFG.price).toLocaleString('id-ID');

    const text =
      `🚀 *UPGRADE MITRA RESELLER*\n\n` +
      `Tingkatkan status akun Anda menjadi Reseller untuk mendapatkan akses penuh dan harga modal setengah harga dari harga normal!.\n\n` +
      `💰 *Deposit Awal:* \`Rp ${priceFormatted}\`\n` +
      `_(Nominal ini 100% dikonversi menjadi Saldo Utama dan langsung dapat digunakan bertransaksi)_\n\n` +
      `✨ *Benefit Eksklusif Reseller:*\n` +
      `🔐 *Akses Panel Reseller:* Menu khusus untuk manajemen akun pelanggan.\n` +
      `⚡ *Create Akun Mandiri:* Buat akun SSH, VMess, VLess, & Trojan kapan saja tanpa batas.\n` +
      `📉 *Harga Modal Spesial:* Dapatkan potongan harga khusus reseller (Profit lebih besar).\n` +
      `🔄 *Unlimited Trial:* Fitur buat akun trial sepuasnya untuk meyakinkan calon pembeli.\n` +
      `🛡️ *Prioritas Support:* Bantuan teknis prioritas dari admin.\n`+
      `💥 *Bonus Penjualan:* Dapatkan bonus setiap transaksi akun.\n\n` +
      `_Silakan klik tombol di bawah untuk melanjutkan proses pembayaran & aktivasi otomatis._`;

    await ctx.reply(text, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🚀 Upgrade Sekarang', callback_data: 'upgrade_reseller_pay' }],
          [{ text: '🔙 Kembali', callback_data: 'send_main_menu' }]
        ]
      }
    });
  } catch (e) {
    logger.error('Error upgrade_reseller:', e);
    try {
      await ctx.reply('❌ Terjadi kesalahan saat membuka menu upgrade reseller.');
    } catch (_) {}
  }
});

bot.action('upgrade_reseller_pay', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;

    if (!RESELLER_UPGRADE_CFG.enabled) {
      return ctx.reply('⚠️ Fitur upgrade reseller sedang nonaktif. Silakan hubungi admin.');
    }

    const isR = await isUserReseller(userId);
    if (isR) {
      return ctx.reply('✅ Kamu sudah berstatus *Reseller*.', { parse_mode: 'Markdown' });
    }

    // Buat QRIS untuk pembayaran upgrade
    await processResellerUpgradePayment(ctx);
  } catch (e) {
    logger.error('Error upgrade_reseller_pay:', e);
    try {
      await ctx.reply('❌ Gagal memproses upgrade reseller. Coba lagi.');
    } catch (_) {}
  }
});
// ====================== END UPGRADE RESELLER FLOW ======================

bot.action('topup_saldo', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    logger.info(`🔍 User ${userId} memulai proses top-up saldo.`);
    const isReseller = await isUserReseller(userId);

    // Hapus pesan menu utama dulu (efek "debu")
    try {
      await ctx.deleteMessage();
    } catch (e) {
      logger.error('Gagal deleteMessage di topup_saldo:', e);
    }

    if (isReseller) {
      // 🔹 RESELLER: tetap pakai keypad lama
      if (!global.depositState) {
        global.depositState = {};
      }
      global.depositState[userId] = { action: 'request_amount', amount: '' };
      logger.info(`🔍 Reseller ${userId} diminta untuk memasukkan jumlah nominal saldo (keypad).`);

      const keyboard = keyboard_nomor();

      await ctx.reply(
        '💳 *Silahkan masukan nominal Top up!*\n\nJumlah Top up: Rp0',
        {
          reply_markup: {
            inline_keyboard: keyboard
          },
          parse_mode: 'Markdown'
        }
      );
    } else {
      // 🔹 USER BIASA: input manual via chat
      if (!global.depositState) {
        global.depositState = {};
      }
      delete global.depositState[userId]; // pastikan nggak kepake flow keypad

const promptMsg = await ctx.reply(
  '_Silahkan ketikan nominal topup:_\n' +
  '_Atau pilih nominal cepat di bawah!_\n\n' +
  'Minimal: `2000`\n' +
  'Contoh: `20000`',
  {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '2k', callback_data: 'topup_amt_2000' },
          { text: '3k', callback_data: 'topup_amt_3000' },
          { text: '4k', callback_data: 'topup_amt_4000' },
          { text: '5k', callback_data: 'topup_amt_5000' },
        ],
        [
          { text: '10k', callback_data: 'topup_amt_10000' },
          { text: '20k', callback_data: 'topup_amt_20000' },
          { text: '30k', callback_data: 'topup_amt_30000' },
          { text: '40k', callback_data: 'topup_amt_40000' },
        ],
        [
          { text: '🎁 Bonus Topup', url: 'https://t.me/chnlxyz/93' },
          { text: '❌ Batalkan', callback_data: 'topup_cancel' }
        ]
      ]
    }
  }
);
      userState[ctx.chat.id] = {
        step: 'topup_manual',
        promptMsgId: promptMsg && promptMsg.message_id ? promptMsg.message_id : null
      };
    }
  } catch (error) {
    logger.error('❌  Kesalahan saat memulai proses top-up saldo:', error);

    // Saat error, coba kirim pesan baru saja (bukan edit)
    try {
      await ctx.reply(
        '❌  *GAGAL! Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.*',
        { parse_mode: 'Markdown' }
      );
    } catch (_) {}
  }
});

bot.action(/topup_amt_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const amount = parseInt(ctx.match[1], 10);

  if (!amount || amount < 2000) {
    return ctx.reply('❌ Nominal tidak valid. Minimal 2000.', { parse_mode: 'Markdown' });
  }

  // kalau sudah cancel, jangan hidupkan lagi
  const st = userState?.[ctx.chat.id];
  if (!st || st.step !== 'topup_manual') return;

  const promptMsgId = st.promptMsgId || null;
  delete userState[ctx.chat.id]; // matikan state biar ga double

  if (promptMsgId) {
    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        promptMsgId,
        undefined,
        `🔄 *Membuat QRIS untuk nominal Rp ${Number(amount).toLocaleString('id-ID')}...*`,
        { parse_mode: 'Markdown' }
      );
    } catch (_) {}
  }

  return processDeposit(ctx, amount, { loadingMsgId: promptMsgId });
});

bot.action(/edit_harga_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  logger.info(`User ${ctx.from.id} memilih untuk mengedit harga server dengan ID: ${serverId}`);
  userState[ctx.chat.id] = { step: 'edit_harga', serverId: serverId };

  await ctx.reply('💰 *Silakan masukkan harga server baru:*', {
    reply_markup: { inline_keyboard: keyboard_nomor() },
    parse_mode: 'Markdown'
  });
});
bot.action(/add_saldo_(\d+)/, async (ctx) => {
  const userId = ctx.match[1];
  logger.info(`User ${ctx.from.id} memilih untuk menambahkan saldo user dengan ID: ${userId}`);
  userState[ctx.chat.id] = { step: 'add_saldo', userId: userId };

  await ctx.reply('📊 *Silakan masukkan jumlah saldo yang ingin ditambahkan:*', {
    reply_markup: { inline_keyboard: keyboard_nomor() },
    parse_mode: 'Markdown'
  });
});
bot.action(/edit_batas_create_akun_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  logger.info(`User ${ctx.from.id} memilih untuk mengedit batas create akun server dengan ID: ${serverId}`);
  userState[ctx.chat.id] = { step: 'edit_batas_create_akun', serverId: serverId };

  await ctx.reply('📊 *Silakan masukkan batas create akun server baru:*', {
    reply_markup: { inline_keyboard: keyboard_nomor() },
    parse_mode: 'Markdown'
  });
});
bot.action(/edit_total_create_akun_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  logger.info(`User ${ctx.from.id} memilih untuk mengedit total create akun server dengan ID: ${serverId}`);
  userState[ctx.chat.id] = { step: 'edit_total_create_akun', serverId: serverId };

  await ctx.reply('📊 *Silakan masukkan total create akun server baru:*', {
    reply_markup: { inline_keyboard: keyboard_nomor() },
    parse_mode: 'Markdown'
  });
});
bot.action(/edit_limit_ip_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  logger.info(`User ${ctx.from.id} memilih untuk mengedit limit IP server dengan ID: ${serverId}`);
  userState[ctx.chat.id] = { step: 'edit_limit_ip', serverId: serverId };

  await ctx.reply('📊 *Silakan masukkan limit IP server baru:*', {
    reply_markup: { inline_keyboard: keyboard_nomor() },
    parse_mode: 'Markdown'
  });
});
bot.action(/edit_quota_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  logger.info(`User ${ctx.from.id} memilih untuk mengedit quota server dengan ID: ${serverId}`);
  userState[ctx.chat.id] = { step: 'edit_quota', serverId: serverId };

  await ctx.reply('📊 *Silakan masukkan quota server baru:*', {
    reply_markup: { inline_keyboard: keyboard_nomor() },
    parse_mode: 'Markdown'
  });
});
bot.action(/edit_auth_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  logger.info(`User ${ctx.from.id} memilih untuk mengedit auth server dengan ID: ${serverId}`);
  userState[ctx.chat.id] = { step: 'edit_auth', serverId: serverId };

  await ctx.reply('🌐 *Silakan masukkan auth server baru:*', {
    reply_markup: { inline_keyboard: keyboard_full() },
    parse_mode: 'Markdown'
  });
});
bot.action(/edit_domain_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  logger.info(`User ${ctx.from.id} memilih untuk mengedit domain server dengan ID: ${serverId}`);
  userState[ctx.chat.id] = { step: 'edit_domain', serverId: serverId };

  await ctx.reply('🌐 *Silakan masukkan domain server baru:*', {
    reply_markup: { inline_keyboard: keyboard_full() },
    parse_mode: 'Markdown'
  });
});
bot.action(/edit_nama_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  await ctx.answerCbQuery().catch(() => {});
  logger.info(`User ${ctx.from.id} memilih untuk mengedit nama server dengan ID: ${serverId}`);

  // ✅ ganti step: input manual via keyboard HP
  userState[ctx.chat.id] = { step: 'edit_nama_text', serverId: String(serverId) };

  // (opsional) hilangkan inline keyboard lama biar ga ganggu
  try {
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  } catch (_) {}

  return ctx.reply(
    '🏷️ *Ketik nama server baru:*\n' +
    '• Boleh spasi, emoji, simbol.\n' +
    '• Maks 64 karakter.\n\n' +
    '_Ketik_ /batal _untuk membatalkan._',
    { parse_mode: 'Markdown' }
  );
});
bot.action(/confirm_delete_server_(\d+)/, async (ctx) => {
  try {
    db.run('DELETE FROM Server WHERE id = ?', [ctx.match[1]], function(err) {
      if (err) {
        logger.error('Error deleting server:', err.message);
        return ctx.reply('⚠️ *PERHATIAN! Terjadi kesalahan saat menghapus server.*', { parse_mode: 'Markdown' });
      }

      if (this.changes === 0) {
        logger.info('Server tidak ditemukan');
        return ctx.reply('⚠️ *PERHATIAN! Server tidak ditemukan.*', { parse_mode: 'Markdown' });
      }

      logger.info(`Server dengan ID ${ctx.match[1]} berhasil dihapus`);
      ctx.reply('✅ *Server berhasil dihapus.*', { parse_mode: 'Markdown' });
    });
  } catch (error) {
    logger.error('Kesalahan saat menghapus server:', error);
    await ctx.reply('❌ *GAGAL! Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.*', { parse_mode: 'Markdown' });
  }
});
bot.action(/server_detail_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  try {
    const server = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM Server WHERE id = ?', [serverId], (err, server) => {
        if (err) {
          logger.error('⚠️ Kesalahan saat mengambil detail server:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil detail server.*');
        }
        resolve(server);
      });
    });

    if (!server) {
      logger.info('⚠️ Server tidak ditemukan');
      return ctx.reply('⚠️ *PERHATIAN! Server tidak ditemukan.*', { parse_mode: 'Markdown' });
    }

    const serverDetails = `📋 *Detail Server* 📋\n\n` +
      `🌐 *Domain:* \`${server.domain}\`\n` +
      `🔑 *Auth:* \`${server.auth}\`\n` +
      `🏷️ *Nama Server:* \`${server.nama_server}\`\n` +
      `📊 *Quota:* \`${server.quota}\`\n` +
      `📶 *Limit IP:* \`${server.iplimit}\`\n` +
      `🔢 *Batas Create Akun:* \`${server.batas_create_akun}\`\n` +
      `📋 *Total Create Akun:* \`${server.total_create_akun}\`\n` +
      `💵 *Harga:* \`Rp ${server.harga}\`\n\n`;

    await ctx.reply(serverDetails, { parse_mode: 'Markdown' });
  } catch (error) {
    logger.error('⚠️ Kesalahan saat mengambil detail server:', error);
    await ctx.reply('⚠️ *Terjadi kesalahan saat mengambil detail server.*', { parse_mode: 'Markdown' });
  }
});

bot.on('callback_query', async (ctx) => {
  const userId = ctx.from.id;
  const data = ctx.callbackQuery.data;
  const userStateData = userState[ctx.chat.id];

const chatId = ctx.chat.id;

// === TOPUP: CANCEL (reseller + member) ===
if (data === 'topup_cancel') {
  if (global.depositState && global.depositState[userId]) delete global.depositState[userId];
  if (userState && userState[chatId]) delete userState[chatId];

  // optional: matikan pending QR
  db.run(
    `UPDATE pending_deposits SET status='CANCELLED'
     WHERE user_id=? AND status='PENDING'`,
    [userId]
  );

  try { await ctx.answerCbQuery('✅ Dibatalkan'); } catch (_) {}
  return sendMainMenu(ctx); // menu kamu yang sudah ada
}

// === TOPUP: BONUS INFO (reseller + member) ===
if (data === 'topup_bonusinfo') {
  try { await ctx.answerCbQuery(); } catch (_) {}

  const rules = Array.isArray(TOPUP_BONUS_CFG.rules) ? TOPUP_BONUS_CFG.rules : [];
  const sorted = [...rules]
    .map(r => ({
      min: Number(r.min) || 0,
      flat: Number(r.flat) || 0,
      percent: Number(r.percent) || 0
    }))
    .filter(r => r.min > 0)
    .sort((a, b) => a.min - b.min);

  let msg =
    `🎁 *Info Bonus Deposit*\n\n` +
    `• Member: *${TOPUP_BONUS_CFG.enabled ? 'ON' : 'OFF'}*\n` +
    `• Reseller: *${TOPUP_BONUS_CFG.applyToReseller ? 'ON' : 'OFF'}*\n\n`;

  if (!sorted.length) {
    msg += `*Bonus Deposit:*\n• (belum diatur)`;
  } else {
    msg += `*Bonus Deposit Saldo:*\n` + sorted.map(r => {
      const minTxt = r.min.toLocaleString('id-ID');
      if (r.flat > 0) return `• ≥ Rp ${minTxt} → bonus *Rp ${r.flat.toLocaleString('id-ID')}*`;
      if (r.percent > 0) return `• ≥ Rp ${minTxt} → bonus *${r.percent}%*`;
      return `• ≥ Rp ${minTxt} → bonus *Rp 0*`;
    }).join('\n');
  }

  await ctx.reply(msg, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'topup_cancel' }]] }
  });

  return;
}

  if (global.depositState && global.depositState[userId] && global.depositState[userId].action === 'request_amount') {
    await handleDepositState(ctx, userId, data);
  } else if (userStateData) {
    switch (userStateData.step) {
      case 'add_saldo':
        await handleAddSaldo(ctx, userStateData, data);
        break;
      case 'edit_batas_create_akun':
        await handleEditBatasCreateAkun(ctx, userStateData, data);
        break;
      case 'edit_limit_ip':
        await handleEditiplimit(ctx, userStateData, data);
        break;
      case 'edit_quota':
        await handleEditQuota(ctx, userStateData, data);
        break;
      case 'edit_auth':
        await handleEditAuth(ctx, userStateData, data);
        break;
      case 'edit_domain':
        await handleEditDomain(ctx, userStateData, data);
        break;
      case 'edit_harga':
        await handleEditHarga(ctx, userStateData, data);
        break;
      case 'edit_nama':
        await handleEditNama(ctx, userStateData, data);
        break;
      case 'edit_total_create_akun':
        await handleEditTotalCreateAkun(ctx, userStateData, data);
        break;
    }
  }
});

async function handleDepositState(ctx, userId, data) {
  // Cek apakah user reseller
  const isReseller = await isUserReseller(userId);
  const statusReseller = isReseller ? 'Reseller' : 'Bukan Reseller';
  const minDeposit = isReseller ? 50000 : 2000; // 100k untuk reseller, 1k untuk user biasa

  let currentAmount = global.depositState[userId].amount || '';

  if (data === 'delete') {
    currentAmount = currentAmount.slice(0, -1);
  } else if (data === 'confirm') {
    const amount = Number(currentAmount) || 0;

    if (amount === 0) {
      return await ctx.answerCbQuery('⚠️ Jumlah tidak boleh kosong!', { show_alert: true });
    }
    if (amount < minDeposit) {
      return await ctx.answerCbQuery(
        `⚠️ Jumlah minimal deposit  ${statusReseller} adalah Rp${minDeposit.toLocaleString()}!`,
        { show_alert: true }
      );
    }

    global.depositState[userId].action = 'confirm_amount';
    await processDeposit(ctx, currentAmount);
    return;
  } else {
    if (currentAmount.length < 12) {
      currentAmount += data;
    } else {
      return await ctx.answerCbQuery('⚠️ Jumlah maksimal adalah 12 digit!', { show_alert: true });
    }
  }

  global.depositState[userId].amount = currentAmount;
const newMessage = `💳 <b>Silahkan masukan nominal Top up!</b>\n\nJumlah Top up: Rp${currentAmount || '0'}`;

  try {
    if (newMessage !== ctx.callbackQuery.message.text) {
      await ctx.editMessageText(newMessage, {
        reply_markup: { inline_keyboard: keyboard_nomor() },
        parse_mode: 'HTML'
      });
    } else {
      await ctx.answerCbQuery();
    }
  } catch (error) {
    await ctx.answerCbQuery();
    logger.error('Error editing message:', error);
  }
}


async function handleAddSaldo(ctx, userStateData, data) {
  let currentSaldo = userStateData.saldo || '';

  if (data === 'backspace') {
    currentSaldo = currentSaldo.slice(0, -1);
  } else if (data === 'confirm') {
    if (currentSaldo.length === 0) {
      return await ctx.answerCbQuery('⚠️ *Jumlah saldo tidak boleh kosong!*', { show_alert: true });
    }

    try {
      await updateUserBalance(userStateData.userId, currentSaldo);
      ctx.reply(`✅ *Saldo user berhasil ditambahkan.*\n\n📄 *Detail Saldo:*\n- Jumlah Saldo: *Rp ${currentSaldo}*`, { parse_mode: 'Markdown' });
    } catch (error) {
      ctx.reply('❌ *Terjadi kesalahan saat menambahkan saldo user.*', { parse_mode: 'Markdown' });
    }
    delete userState[ctx.chat.id];
    return;
  } else if (data === 'cancel') {
    delete userState[ctx.chat.id];
      return await ctx.answerCbQuery('⚠️ *Jumlah saldo tidak valid!*', { show_alert: true });
  } else {
    if (currentSaldo.length < 10) {
      currentSaldo += data;
    } else {
      return await ctx.answerCbQuery('⚠️ *Jumlah saldo maksimal adalah 10 karakter!*', { show_alert: true });
    }
  }

  userStateData.saldo = currentSaldo;
  const newMessage = `📊 *Silakan masukkan jumlah saldo yang ingin ditambahkan:*\n\nJumlah saldo saat ini: *${currentSaldo}*`;
    await ctx.editMessageText(newMessage, {
      reply_markup: { inline_keyboard: keyboard_nomor() },
      parse_mode: 'Markdown'
    });
}

async function handleEditBatasCreateAkun(ctx, userStateData, data) {
  await handleEditField(ctx, userStateData, data, 'batasCreateAkun', 'batas create akun', 'UPDATE Server SET batas_create_akun = ? WHERE id = ?');
}

async function handleEditTotalCreateAkun(ctx, userStateData, data) {
  await handleEditField(ctx, userStateData, data, 'totalCreateAkun', 'total create akun', 'UPDATE Server SET total_create_akun = ? WHERE id = ?');
}

async function handleEditiplimit(ctx, userStateData, data) {
  await handleEditField(ctx, userStateData, data, 'iplimit', 'limit IP', 'UPDATE Server SET iplimit = ? WHERE id = ?');
}

async function handleEditQuota(ctx, userStateData, data) {
  await handleEditField(ctx, userStateData, data, 'quota', 'quota', 'UPDATE Server SET quota = ? WHERE id = ?');
}

async function handleEditAuth(ctx, userStateData, data) {
  await handleEditField(ctx, userStateData, data, 'auth', 'auth', 'UPDATE Server SET auth = ? WHERE id = ?');
}

async function handleEditDomain(ctx, userStateData, data) {
  await handleEditField(ctx, userStateData, data, 'domain', 'domain', 'UPDATE Server SET domain = ? WHERE id = ?');
}

async function handleEditHarga(ctx, userStateData, data) {
  let currentAmount = userStateData.amount || '';

  if (data === 'delete') {
    currentAmount = currentAmount.slice(0, -1);
  } else if (data === 'confirm') {
    if (currentAmount.length === 0) {
      return await ctx.answerCbQuery('⚠️ *Jumlah tidak boleh kosong!*', { show_alert: true });
    }
    const hargaBaru = parseFloat(currentAmount);
    if (isNaN(hargaBaru) || hargaBaru <= 0) {
      return ctx.reply('❌ *Harga tidak valid. Masukkan angka yang valid.*', { parse_mode: 'Markdown' });
    }
    try {
      await updateServerField(userStateData.serverId, hargaBaru, 'UPDATE Server SET harga = ? WHERE id = ?');
      ctx.reply(`✅ *Harga server berhasil diupdate.*\n\n📄 *Detail Server:*\n- Harga Baru: *Rp ${hargaBaru}*`, { parse_mode: 'Markdown' });
    } catch (err) {
      ctx.reply('❌ *Terjadi kesalahan saat mengupdate harga server.*', { parse_mode: 'Markdown' });
    }
    delete userState[ctx.chat.id];
    return;
  } else {
    if (!/^\d+$/.test(data)) {
      return await ctx.answerCbQuery('⚠️ *Hanya angka yang diperbolehkan!*', { show_alert: true });
    }
    if (currentAmount.length < 12) {
      currentAmount += data;
    } else {
      return await ctx.answerCbQuery('⚠️ *Jumlah maksimal adalah 12 digit!*', { show_alert: true });
    }
  }

  userStateData.amount = currentAmount;
  const newMessage = `💰 *Silakan masukkan harga server baru:*\n\nJumlah saat ini: *Rp ${currentAmount}*`;
  if (newMessage !== ctx.callbackQuery.message.text) {
    await ctx.editMessageText(newMessage, {
      reply_markup: { inline_keyboard: keyboard_nomor() },
      parse_mode: 'Markdown'
    });
  }
}

async function handleEditNama(ctx, userStateData, data) {
  await handleEditField(ctx, userStateData, data, 'name', 'nama server', 'UPDATE Server SET nama_server = ? WHERE id = ?');
}

async function handleEditField(ctx, userStateData, data, field, fieldName, query) {
  let currentValue = userStateData[field] || '';

  if (data === 'delete') {
    currentValue = currentValue.slice(0, -1);
  } else if (data === 'confirm') {
    if (currentValue.length === 0) {
      return await ctx.answerCbQuery(`⚠️ *${fieldName} tidak boleh kosong!*`, { show_alert: true });
    }
    try {
      await updateServerField(userStateData.serverId, currentValue, query);
      ctx.reply(`✅ *${fieldName} server berhasil diupdate.*\n\n📄 *Detail Server:*\n- ${fieldName.charAt(0).toUpperCase() + fieldName.slice(1)}: *${currentValue}*`, { parse_mode: 'Markdown' });
    } catch (err) {
      ctx.reply(`❌ *Terjadi kesalahan saat mengupdate ${fieldName} server.*`, { parse_mode: 'Markdown' });
    }
    delete userState[ctx.chat.id];
    return;
  } else {
    if (!/^[a-zA-Z0-9.-]+$/.test(data)) {
      return await ctx.answerCbQuery(`⚠️ *${fieldName} tidak valid!*`, { show_alert: true });
    }
    if (currentValue.length < 253) {
      currentValue += data;
    } else {
      return await ctx.answerCbQuery(`⚠️ *${fieldName} maksimal adalah 253 karakter!*`, { show_alert: true });
    }
  }

  userStateData[field] = currentValue;
  const newMessage = `📊 *Silakan masukkan ${fieldName} server baru:*\n\n${fieldName.charAt(0).toUpperCase() + fieldName.slice(1)} saat ini: *${currentValue}*`;
  if (newMessage !== ctx.callbackQuery.message.text) {
    await ctx.editMessageText(newMessage, {
      reply_markup: { inline_keyboard: keyboard_nomor() },
      parse_mode: 'Markdown'
    });
  }
}
async function updateUserSaldo(userId, saldo) {
  return new Promise((resolve, reject) => {
    db.run('UPDATE users SET saldo = saldo + ? WHERE user_id = ?', [saldo, userId], function (err) {
      if (err) {
        logger.error('⚠️ Kesalahan saat menambahkan saldo user:', err.message);
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

async function updateServerField(serverId, value, query) {
  return new Promise((resolve, reject) => {
    db.run(query, [value, serverId], function (err) {
      if (err) {
        // ✅ PERBAIKAN: Hapus ${fieldName} agar tidak error
        // Kita ganti jadi log Server ID saja biar tetap informatif
        logger.error(`⚠️ Kesalahan saat update server (ID: ${serverId}):`, err.message);
        reject(err);
      } else {
        resolve();
      }
    });
  });
}
function generateRandomAmount(baseAmount) {
  const random = Math.floor(Math.random() * 99) + 1;
  return baseAmount + random;
}

global.depositState = global.depositState || {};
global.pendingDeposits = global.pendingDeposits || {};
if (!global.lastTopupRequest) global.lastTopupRequest = {}; // rate limit per user (deposit)

let lastRequestTime = 0;
const requestInterval = 1000;

db.all(
  `SELECT * FROM pending_deposits WHERE UPPER(status) = 'PENDING'`,
  [],
  (err, rows) => {
    if (err) {
      logger.error('Gagal load pending_deposits:', err.message);
      return;
    }

    rows.forEach((row) => {
      global.pendingDeposits[row.unique_code] = {
        amount: row.amount,
        originalAmount: row.original_amount,
        bonusAmount: row.bonus_amount || 0,
        userId: row.user_id,
        timestamp: row.timestamp,
        expireAt: row.expire_at || null,
        status: row.status, // PENDING
        qrMessageId: row.qr_message_id,
        purpose: row.purpose || 'deposit'
      };
    });

    logger.info('Pending deposit loaded:', Object.keys(global.pendingDeposits).length);
  }
);

// UTIL
function generateRandomNumber(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function processDeposit(ctx, amount, opts = {}) {
  const loadingMsgId = opts && opts.loadingMsgId ? opts.loadingMsgId : null;
  const userId = ctx.from.id;
  const now = Date.now();

  const EXPIRE_MS = 5 * 60 * 1000; // 5 menit
  const expireAt = now + EXPIRE_MS;

  // === A) AUTO MARK EXPIRED (bersihin PENDING yg udah lewat 5 menit) ===
  await new Promise((resolve) => {
    db.run(
      `UPDATE pending_deposits
       SET status = 'EXPIRED'
       WHERE UPPER(status) = 'PENDING'
         AND (
           (expire_at IS NOT NULL AND expire_at <= ?)
           OR (expire_at IS NULL AND (timestamp + ?) <= ?)
         )`,
      [now, EXPIRE_MS, now],
      () => resolve()
    );
  });

  // === B) HITUNG QR AKTIF USER (maks 2) ===
  const activeRows = await new Promise((resolve) => {
    db.all(
      `SELECT unique_code, qr_message_id, timestamp, expire_at
       FROM pending_deposits
       WHERE user_id = ?
         AND UPPER(status) = 'PENDING'
         AND (
           (expire_at IS NOT NULL AND expire_at > ?)
           OR (expire_at IS NULL AND (timestamp + ?) > ?)
         )
       ORDER BY timestamp DESC`,
      [userId, now, EXPIRE_MS, now],
      (err, rows) => resolve(err ? [] : (rows || []))
    );
  });

  if (activeRows.length >= 2) {
    return ctx.reply(
      '⚠️ *Batas QR tercapai!*\n\n' +
      'Kamu sudah punya *2 QRIS aktif* yang belum dibayar.\n' +
      'Silakan bayar salah satunya, atau tunggu *±5 menit* sampai expired.\n\n' +
      '💡 Setelah expired, kamu bisa buat QR lagi.',
      { parse_mode: 'Markdown' }
    );
  }

  // === C) BUAT QRIS ===
  const uniqueCode = `user-${userId}-${Date.now()}`;
  const finalAmount = Number(amount) + generateRandomNumber(1, 300);
  const adminFee = finalAmount - Number(amount);
  const bonusAmount = await calcTopupBonus(userId, Number(amount));

  try {
    const qrisString = buildQrisWithAmount(DATA_QRIS, finalAmount);
    const qrBuffer = await createQRWithLogo(qrisString);

    const caption =
      `📝 *QRIS BERHASIL DIBUAT*\n\n` +
      `💰 Bayar Tepat: Rp ${finalAmount}\n` +
      `💵 Nominal: Rp ${amount}\n` +
      `🔢 Kode Unik: Rp ${adminFee}\n` +
      `⏱️ QRIS Aktif: 5 menit\n\n` +
      `📌 Petunjuk\n` +
      `- Silahkan scan QRIS di atas\n` +
      `- Scan di e-wallet / bank\n` +
      `- Jika pembayaran berhasil, saldo otomatis ditambahkan!`;

    const qrMessage = await ctx.replyWithPhoto(
      { source: qrBuffer },
      { caption, parse_mode: 'Markdown' }
    );

    // hapus pesan loading "Membuat QRIS..." kalau ada
    if (loadingMsgId) {
      try {
        await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsgId);
      } catch (_) { /* abaikan kalau sudah dihapus / tidak bisa dihapus */ }
    }

    // memory
    global.pendingDeposits = global.pendingDeposits || {};
    global.pendingDeposits[uniqueCode] = {
      amount: finalAmount,
      originalAmount: Number(amount),
      bonusAmount,
      userId,
      timestamp: now,
      expireAt,
      status: 'PENDING',
      qrMessageId: qrMessage.message_id,
      purpose: 'deposit'
    };

    // db (pastikan kolom expire_at ada)
    db.run(
      `INSERT INTO pending_deposits
       (unique_code, user_id, amount, original_amount, bonus_amount, timestamp, expire_at, status, qr_message_id, purpose)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [uniqueCode, userId, finalAmount, Number(amount), bonusAmount, now, expireAt, 'PENDING', qrMessage.message_id, 'deposit'],
      (err) => {
        if (err) logger.error('Gagal insert pending_deposits (deposit): ' + err.message);
      }
    );

    if (global.depositState && global.depositState[userId]) delete global.depositState[userId];

  } catch (error) {
    logger.error('❌ Kesalahan saat memproses deposit:', error);

    try {
      await ctx.reply('❌ *GAGAL!* Terjadi kesalahan saat memproses pembayaran. Silakan coba lagi nanti.', { parse_mode: 'Markdown' });
    } catch (_) {}

    if (global.depositState && global.depositState[userId]) delete global.depositState[userId];
    if (global.pendingDeposits && global.pendingDeposits[uniqueCode]) delete global.pendingDeposits[uniqueCode];

    db.run('DELETE FROM pending_deposits WHERE unique_code = ?', [uniqueCode], (err) => {
      if (err) logger.error('Gagal hapus pending_deposits (deposit error): ' + err.message);
    });
  }
}
async function processResellerUpgradePayment(ctx) {
  const userId = ctx.from.id;
  const now = Date.now();
  const lastReq = upgradeCooldowns.get(userId) || 0;
  const COOLDOWN_MS = 15000; // 15 Detik

  if (now - lastReq < COOLDOWN_MS) {
    // Jangan respon apa-apa atau respon singkat biar gak spam chat
    return; 
  }
  upgradeCooldowns.set(userId, now);

  const activeTx = await new Promise((resolve) => {
    db.get(
      `SELECT unique_code, expire_at FROM pending_deposits 
       WHERE user_id = ? AND purpose = 'upgrade_reseller' AND status = 'PENDING'
       ORDER BY timestamp DESC LIMIT 1`,
      [userId],
      (err, row) => resolve(row)
    );
  });

  if (activeTx) {
    const expireTime = Number(activeTx.expire_at);
    
    // SKENARIO A: Waktu Masih Ada -> TOLAK
    if (expireTime > now) {
      const sisaMs = expireTime - now;
      const menit = Math.floor(sisaMs / 60000);
      const detik = Math.ceil((sisaMs % 60000) / 1000);

      try {
        return await ctx.reply(
          `⚠️ *TAGIHAN AKTIF*\n\n` +
          `Anda masih memiliki tagihan Upgrade yang belum dibayar.\n` +
          `Silakan lunasi tagihan tersebut atau tunggu waktu habis.\n\n` +
          `⏳ Sisa Waktu: *${menit} menit ${detik} detik*`,
          { parse_mode: 'Markdown' }
        );
      } catch (_) {}
      return; // Stop proses
    } 
    
    // SKENARIO B: Waktu Sudah Habis tapi status masih PENDING (Zombie Transaction)
    // -> Kita bantu tandai EXPIRED sekarang, lalu LANJUT buat baru (biar user ga nunggu cronjob)
    else {
      db.run("UPDATE pending_deposits SET status = 'EXPIRED' WHERE unique_code = ?", [activeTx.unique_code]);
      // Lanjut ke bawah untuk buat QR baru...
    }
  }

  // -----------------------------------------------------------
  // 🚀 PROSES PEMBUATAN QR BARU
  // -----------------------------------------------------------
  const uniqueCode = `upgrade-${userId}-${now}`;
  const EXPIRE_DURATION = 5 * 60 * 1000; // 5 menit
  const expireAt = now + EXPIRE_DURATION;

  // Harga Upgrade (Default 50k jika config error)
  const baseAmount = Number(RESELLER_UPGRADE_CFG.price) || 50000;
  
  // Kode unik acak (1-500) untuk membedakan mutasi
  const randomCoin = generateRandomNumber(1, 500); 
  const finalAmount = baseAmount + randomCoin;
  const adminFee = finalAmount - baseAmount;

  try {
    const qrisString = buildQrisWithAmount(DATA_QRIS, finalAmount);
    const qrBuffer = await createQRWithLogo(qrisString);
    const caption =
      `⭐ *UPGRADE RESELLER*\n\n` +
      `🏷️ Harga: Rp ${baseAmount.toLocaleString('id-ID')}\n` +
      `🔢 Unik: Rp ${adminFee}\n` +
      `💳 *TOTAL: Rp ${finalAmount.toLocaleString('id-ID')}*\n` +
      `_(Transfer harus persis nominal Total)_\n\n` +
      `⏳ *Expired: 5 Menit*\n` +
      `Status reseller aktif otomatis setelah pembayaran sukses.`;

    const qrMessage = await ctx.replyWithPhoto(
      { source: qrBuffer },
      { caption, parse_mode: 'Markdown' }
    );

    // Simpan Memory
    global.pendingDeposits = global.pendingDeposits || {};
    global.pendingDeposits[uniqueCode] = {
      amount: finalAmount,
      originalAmount: baseAmount,
      bonusAmount: 0,
      userId,
      timestamp: now,
      expireAt,
      status: 'PENDING',
      qrMessageId: qrMessage.message_id,
      purpose: 'upgrade_reseller'
    };

    // Simpan Database
    db.run(
      `INSERT INTO pending_deposits
       (unique_code, user_id, amount, original_amount, bonus_amount, timestamp, expire_at, status, qr_message_id, purpose)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uniqueCode,
        userId,
        finalAmount,
        baseAmount,
        0,
        now,
        expireAt,
        'PENDING',
        qrMessage.message_id,
        'upgrade_reseller'
      ],
      (err) => {
        if (err) logger.error('DB Insert Error:', err.message);
      }
    );

  } catch (error) {
    logger.error('Create QR Error:', error);
    ctx.reply('❌ Gagal membuat QRIS. Coba lagi sesaat lagi.');
  }
}

// parseTanggalID lokal dihapus — sudah disediakan oleh
// ./api-cekpayment-orkut.js (lihat require di atas).

async function checkQRISStatus() {
  try {
    const pendingDeposits = Object.entries(global.pendingDeposits || {});
    const now = Date.now();
    const EXPIRE_MS = 5 * 60 * 1000;

    for (const [uniqueCode, deposit] of pendingDeposits) {
      if (!deposit) continue;

      // ✅ FIX UTAMA: support PENDING / pending
      const st = String(deposit.status || '').toUpperCase();
      if (st !== 'PENDING') continue;

      // ✅ expired pakai expireAt jika ada, kalau tidak fallback timestamp+5m
      const exp = Number(deposit.expireAt || 0);
      const isExpired = exp ? (now >= exp) : ((now - Number(deposit.timestamp || now)) > EXPIRE_MS);

      // === EXPIRED ===
      if (isExpired) {
        try {
          if (deposit.qrMessageId) {
            await bot.telegram.deleteMessage(deposit.userId, deposit.qrMessageId);
          }
          await bot.telegram.sendMessage(
            deposit.userId,
            '❌ *Pembayaran Expired*\n\n' +
              'Waktu pembayaran telah habis. Silakan klik Top Up lagi untuk mendapatkan QR baru.',
            { parse_mode: 'Markdown' }
          );
        } catch (error) {
          logger.error('Error deleting expired payment messages:', error);
        }

        // hapus memory
        delete global.pendingDeposits[uniqueCode];

        // kalau kamu tetap mau gaya lama: hapus row DB
        db.run(
          'DELETE FROM pending_deposits WHERE unique_code = ?',
          [uniqueCode],
          (err) => {
            if (err) logger.error('Gagal hapus pending_deposits (expired):', err.message);
          }
        );

        continue;
      }

      // === CEK MUTASI / PAYMENT ===
      try {
        const data = buildPayload(); // payload selalu fresh
        const resultcek = await axios.post(API_URL, data, { headers, timeout: 5000 });
        // Normalisasi response API (mendukung JSON baru & teks lama)
        const transaksiList = parseTransactions(resultcek.data);
        if (!transaksiList.length) {
          // Anti-spam: hanya warn saat state response API berubah,
          // bukan tiap 10 detik dengan isi yang sama persis.
          const preview = String(
            typeof resultcek.data === 'string' ? resultcek.data : JSON.stringify(resultcek.data)
          ).slice(0, 200);
          if (global.qrisLastEmptyPreview !== preview) {
            global.qrisLastEmptyPreview = preview;
            logger.warn(`[QRIS] Tidak ada transaksi terbaca dari API. Preview: ${preview.replace(/\s+/g, ' ').trim()}`);
          }
        } else {
          // ada transaksi → reset flag biar saat kosong lagi tetap dilog sekali
          global.qrisLastEmptyPreview = null;
        }

        // anti double & cocok nominal
        global.usedMutasiKeys ||= new Set();
        global.qrisLastSnap ||= {};
        const expectedAmount = Number(deposit.amount);
        // Toleransi ±2 rupiah jaga-jaga rounding QRIS provider
        const TOLERANCE = 2;

        // Log ringkas hanya saat daftar transaksi berubah (anti spam terminal)
        const snap = transaksiList.slice(0, 5).map(t => `${t.kredit}@${t.tanggal}`).join(',');
        if (global.qrisLastSnap[uniqueCode] !== snap) {
          global.qrisLastSnap[uniqueCode] = snap;
          if (transaksiList.length) {
            logger.info(
              `[QRIS][${uniqueCode}] expected=${expectedAmount} | transaksi(${transaksiList.length})=${snap}`
            );
          }
        }

        const matched = transaksiList.find((t) => {
          if (Math.abs(t.kredit - expectedAmount) > TOLERANCE) return false;

          const key = `${t.kredit}|${t.ts || t.tanggal}|${t.brand}`;
          if (global.usedMutasiKeys.has(key)) return false;

          global.usedMutasiKeys.add(key);
          return true;
        });

        if (matched) {
          const success = await processMatchingPayment(deposit, matched, uniqueCode);
          if (success) {
            logger.info(`Payment processed successfully for ${uniqueCode}`);

            // hapus memory
            delete global.pendingDeposits[uniqueCode];

            // gaya lama: hapus row DB saat sukses
            db.run(
              'DELETE FROM pending_deposits WHERE unique_code = ?',
              [uniqueCode],
              (err) => {
                if (err) logger.error('Gagal hapus pending_deposits (success):', err.message);
              }
            );
          }
        }
      } catch (error) {
        logger.error(`Error checking payment status for ${uniqueCode}:`, error);
      }
    }
  } catch (error) {
    logger.error('Error in checkQRISStatus:', error);
  }
}

function keyboard_abc() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  const buttons = [];
  for (let i = 0; i < alphabet.length; i += 3) {
    const row = alphabet.slice(i, i + 3).split('').map(char => ({
      text: char,
      callback_data: char
    }));
    buttons.push(row);
  }
  buttons.push([{ text: '🔙 Hapus', callback_data: 'delete' }, { text: '✅ Konfirmasi', callback_data: 'confirm' }]);
  buttons.push([{ text: '🔙 Kembali ke Menu Utama', callback_data: 'send_main_menu' }]);
  return buttons;
}

function keyboard_nomor() {
  const alphabet = '1234567890';
  const buttons = [];
  for (let i = 0; i < alphabet.length; i += 3) {
    const row = alphabet.slice(i, i + 3).split('').map(char => ({
      text: char,
      callback_data: char
    }));
    buttons.push(row);
  }
  buttons.push([{ text: '🔙 Hapus', callback_data: 'delete' }, { text: '✅ Konfirmasi', callback_data: 'confirm' }]);
  buttons.push([{ text: '🔙 Kembali ke Menu Utama', callback_data: 'send_main_menu' }]);
  return buttons;
}

function keyboard_full() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const buttons = [];
  for (let i = 0; i < alphabet.length; i += 3) {
    const row = alphabet.slice(i, i + 3).split('').map(char => ({
      text: char,
      callback_data: char
    }));
    buttons.push(row);
  }
  buttons.push([{ text: '🔙 Hapus', callback_data: 'delete' }, { text: '✅ Konfirmasi', callback_data: 'confirm' }]);
  buttons.push([{ text: '🔙 Kembali ke Menu Utama', callback_data: 'send_main_menu' }]);
  return buttons;
}

global.processedTransactions = new Set();
async function updateUserBalance(userId, amount) {
  return new Promise((resolve, reject) => {
    db.run("UPDATE users SET saldo = saldo + ? WHERE user_id = ?", [amount, userId], function(err) {
        if (err) {
        logger.error('⚠️ Kesalahan saat mengupdate saldo user:', err.message);
          reject(err);
      } else {
        resolve();
        }
    });
  });
}

async function getUserBalance(userId) {
  return new Promise((resolve, reject) => {
    db.get("SELECT saldo FROM users WHERE user_id = ?", [userId], function(err, row) {
        if (err) {
        logger.error('⚠️ Kesalahan saat mengambil saldo user:', err.message);
          reject(err);
      } else {
        resolve(row ? row.saldo : 0);
        }
    });
  });
}


async function sendResellerUpgradeSuccessNotification(userId, amount) {
  try {
    const a = Number(amount) || 0;
    await bot.telegram.sendMessage(
      userId,
      `✅  *Upgrade Reseller Berhasil!*\n\n` +
        `🎉 Status: *Reseller Aktif*\n` +
        `💰 Saldo masuk: *Rp${a.toLocaleString()}*\n\n` +
        `Sekarang saldo bisa langsung dipakai untuk transaksi!.\n` +
        `Silakan klik /start untuk melihat menu reseller.`,
      { parse_mode: 'Markdown' }
    );
    return true;
  } catch (e) {
    logger.error('Gagal kirim notif upgrade reseller:', e?.message || e);
    return false;
  }
}

async function processResellerUpgradeMatch(deposit, referenceId, uniqueCode) {
  const userId = deposit.userId;

  // ✅ SALDO MASUK = total yang dibayar (finalAmount)
  // kalau kamu mau cuma baseAmount, ganti jadi: Number(deposit.originalAmount) || 0
  const paidAmount = Number(deposit.amount) || 0;
  const baseAmount = Number(deposit.originalAmount) || paidAmount;

  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run("BEGIN TRANSACTION");

      // anti double-process (cek transaksi upgrade)
      db.get(
        "SELECT id FROM transactions WHERE reference_id = ? AND type = ?",
        [referenceId, "upgrade_reseller"],
        async (err, row) => {
          if (err) {
            db.run("ROLLBACK");
            return reject(err);
          }
          if (row) {
            db.run("ROLLBACK");
            return resolve(false);
          }

          // pastikan user ada di tabel users
          db.run(
            "INSERT OR IGNORE INTO users (user_id) VALUES (?)",
            [userId],
            async (errU) => {
              if (errU) {
                db.run("ROLLBACK");
                return reject(errU);
              }

              // cek sudah reseller atau belum
              let already = false;
              try {
                already = await isUserReseller(userId);
              } catch (_) {
                already = false;
              }

              // kalau belum reseller → aktifkan reseller
              if (!already) {
                try {
                  await addReseller(userId); // tulis ressel.db
                } catch (e) {
                  logger.error("Gagal addReseller:", e?.message || e);
                  db.run("ROLLBACK");
                  return resolve(false);
                }
              }

              // ✅ TAMBAH SALDO (ini inti yang kamu mau)
              db.run(
                "UPDATE users SET saldo = saldo + ? WHERE user_id = ?",
                [paidAmount, userId],
                (errS) => {
                  if (errS) {
                    db.run("ROLLBACK");
                    return reject(errS);
                  }

                  // catat transaksi upgrade reseller
                  db.run(
                    "INSERT INTO transactions (user_id, amount, type, reference_id, timestamp) VALUES (?, ?, ?, ?, ?)",
                    [userId, paidAmount, "upgrade_reseller", referenceId, Date.now()],
                    async (err2) => {
                      if (err2) {
                        db.run("ROLLBACK");
                        return reject(err2);
                      }

                      // OPTIONAL: catat juga sebagai deposit biar statistik deposit ikut naik
                      db.run(
                        "INSERT INTO transactions (user_id, amount, type, reference_id, timestamp) VALUES (?, ?, ?, ?, ?)",
                        [userId, paidAmount, "deposit", `deposit-upgrade-${uniqueCode}`, Date.now()],
                        async (errDep) => {
                          if (errDep) {
                            db.run("ROLLBACK");
                            return reject(errDep);
                          }

                          // ambil saldo terbaru untuk ditampilkan di notif (optional)
                          db.get(
                            "SELECT saldo FROM users WHERE user_id = ?",
                            [userId],
                            async (errBal, userRow) => {
                              if (errBal) {
                                db.run("ROLLBACK");
                                return reject(errBal);
                              }

                              db.run("COMMIT", async (errC) => {
                                if (errC) {
                                  db.run("ROLLBACK");
                                  return reject(errC);
                                }

                                // notif user (update fungsi notif kamu agar terima amount)
                                try {
                                  await sendResellerUpgradeSuccessNotification(userId, paidAmount);
                                } catch (_) {}

                                // hapus pesan QR
                                if (deposit.qrMessageId) {
                                  try {
                                    await bot.telegram.deleteMessage(userId, deposit.qrMessageId);
                                  } catch (e) {
                                    logger.error("Gagal menghapus pesan QR upgrade:", e?.message || e);
                                  }
                                }

                                // notif grup (HTML)
                                try {
                                  let userInfo = {};
                                  try { userInfo = await bot.telegram.getChat(userId); } catch (_) {}
                                  const userDisplay = userInfo.username
                                    ? `@${userInfo.username}`
                                    : (userInfo.first_name || String(userId));

                                  const tanggalOnly = new Date().toLocaleDateString("id-ID", { timeZone: "Asia/Jakarta" });
                                  const saldoNow = Number(userRow?.saldo) || 0;

                                  const notif = `
⭐  <b>UPGRADE RESELLER BERHASIL</b>
━━━━━━━━━━━━━━━━━━━━
👤 <b>User</b>       : ${escapeHtml(userDisplay)}
🆔 <b>User ID</b>    : ${userId}
💵 <b>Base</b>       : Rp ${baseAmount.toLocaleString("id-ID")}
💳 <b>Paid</b>       : Rp ${paidAmount.toLocaleString("id-ID")}
💰 <b>Saldo</b>      : Rp ${saldoNow.toLocaleString("id-ID")}
📆 <b>Tanggal</b>    : ${tanggalOnly}
━━━━━━━━━━━━━━━━━━━━`.trim();

                                  await bot.telegram.sendMessage(GROUP_ID, notif, { parse_mode: "HTML" });
                                } catch (e) {
                                  logger.error("Gagal kirim notif grup upgrade:", e?.message || e);
                                }

                                return resolve(true);
                              });
                            }
                          );
                        }
                      );
                    }
                  );
                }
              );
            }
          );
        }
      );
    });
  });
}

async function sendPaymentSuccessNotification(userId, deposit, currentBalance) {
  try {
    const adminFee = deposit.amount - deposit.originalAmount;
    const bonus = Number(deposit.bonusAmount) || 0;
    const saldoMasuk = Number(deposit.originalAmount) + bonus;

    await bot.telegram.sendMessage(
      userId,
      `✅  *Pembayaran Terdeteksi!*\n\n` +
        `💰 Deposit: Rp ${deposit.originalAmount}\n` +
        `🎁 Bonus Top Up: Rp ${bonus}\n` +
        `✅ Saldo Masuk: Rp ${saldoMasuk}\n` +
        `💼 Saldo Baru: Rp ${currentBalance}\n\n` +
        `👉 Klik /menu untuk lanjut!`,
      { parse_mode: 'Markdown' }
    );
    return true;
  } catch (error) {
    logger.error('Error sending payment notification:', error);
    return false;
  }
}

async function processMatchingPayment(deposit, matchingTransaction, uniqueCode) {
  // Purpose default: deposit
  let purpose = deposit.purpose || "deposit";

  if (typeof uniqueCode === "string" && uniqueCode.startsWith("upgrade-")) {
    purpose = "upgrade_reseller";
    deposit.purpose = "upgrade_reseller";
    deposit.bonusAmount = 0;
  }

  const referenceId =
    matchingTransaction && matchingTransaction.reference_id
      ? matchingTransaction.reference_id
      : uniqueCode;

  const transactionKey = referenceId;

  // Flow khusus upgrade reseller (tidak menambah saldo)
  if (purpose === "upgrade_reseller") {
    return await processResellerUpgradeMatch(deposit, referenceId, uniqueCode);
  }

  // bonus dari pending (kalau ada), default 0
  const bonusAmount = Number(deposit.bonusAmount) || 0;
  const originalAmount = Number(deposit.originalAmount) || 0;
  const creditAmount = originalAmount + bonusAmount;

  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run("BEGIN TRANSACTION", (errBegin) => {
        if (errBegin) return reject(errBegin);

        // Anti double-process
        db.get(
          "SELECT id FROM transactions WHERE reference_id = ? AND type = ?",
          [referenceId, "deposit"],
          (err, row) => {
            if (err) {
              db.run("ROLLBACK");
              return reject(err);
            }
            if (row) {
              db.run("ROLLBACK");
              return resolve(false);
            }

            const uid = Number(deposit.userId);
            if (!Number.isFinite(uid) || uid <= 0) {
              db.run("ROLLBACK");
              return reject(new Error(`Invalid userId: ${deposit.userId}`));
            }

            // pastikan user ada dulu (biar UPDATE tidak 0 changes)
            db.run(
              "INSERT OR IGNORE INTO users (user_id) VALUES (?)",
              [uid],
              (errU) => {
                if (errU) {
                  db.run("ROLLBACK");
                  return reject(errU);
                }

                // Update saldo: nominal + bonus
                db.run(
                  "UPDATE users SET saldo = saldo + ? WHERE user_id = ?",
                  [creditAmount, uid],
                  function (err2) {
                    if (err2) {
                      db.run("ROLLBACK");
                      return reject(err2);
                    }

                    // kalau masih 0, berarti user_id invalid / tidak match
                    if (this.changes === 0) {
                      db.run("ROLLBACK");
                      return reject(
                        new Error(`User not found (user_id=${deposit.userId})`)
                      );
                    }

                    // Record transaksi deposit (nominal asli)
                    db.run(
                      "INSERT INTO transactions (user_id, amount, type, reference_id, timestamp) VALUES (?, ?, ?, ?, ?)",
                      [uid, originalAmount, "deposit", referenceId, Date.now()],
                      (err3) => {
                        if (err3) {
                          db.run("ROLLBACK");
                          return reject(err3);
                        }

                        const afterBonusInsert = () => {
                          // Ambil saldo terbaru untuk notifikasi
                          db.get(
                            "SELECT saldo FROM users WHERE user_id = ?",
                            [uid],
                            async (err4, user) => {
                              if (err4 || !user) {
                                db.run("ROLLBACK");
                                return reject(
                                  err4 || new Error("User not found after update")
                                );
                              }

                              // Notif user
                              let notificationSent = false;
                              try {
                                notificationSent = await sendPaymentSuccessNotification(
                                  uid,
                                  deposit,
                                  user.saldo
                                );
                              } catch (e) {
                                notificationSent = false;
                              }

                              // Hapus pesan QR code (jika ada)
                              if (deposit.qrMessageId) {
                                try {
                                  await bot.telegram.deleteMessage(uid, deposit.qrMessageId);
                                } catch (e) {
                                  logger.error("Gagal menghapus pesan QR code:", e.message);
                                }
                              }

                              // Notif grup (tanpa await)
                              try {
                                // Ambil mention, lalu hapus @ nya
                                let userMention = await getUserMentionHtml(uid);
                                if (userMention) userMention = userMention.replace('@', '');

                                const tanggalOnly = new Date().toLocaleDateString("id-ID", {
                                  timeZone: "Asia/Jakarta",
                                });
                                
// Pastikan ini angka biar tidak error saat dijumlah
const saldoMasuk = parseInt(originalAmount) + parseInt(bonusAmount);

// Hitung kode unik (Total Bayar - Nominal Asli)
const adminFeeGroup = parseInt(deposit.amount) - parseInt(originalAmount);

const notifTopup =
  `<pre>` +
  `<b>💰 TOP UP VPN BERHASIL</b>\n` +
  `━━━━━━━━━━━━━━━━━━━━\n` +
  `👤 User       : ${userMention}\n` +
  `🆔 User ID    : ${uid}\n` +
  `💵 Nominal    : Rp ${originalAmount.toLocaleString('id-ID')}\n` +
  `💸 Total Bayar: Rp ${parseInt(deposit.amount).toLocaleString('id-ID')}\n` +
  `🎁 Bonus      : Rp ${bonusAmount.toLocaleString('id-ID')}\n` +
  `✅ Saldo Masuk: Rp ${saldoMasuk.toLocaleString('id-ID')}\n` +
  `💳 Saldo Baru : Rp ${user.saldo.toLocaleString('id-ID')}\n` +
  `📆 Tanggal    : ${tanggalOnly}\n` +
  `━━━━━━━━━━━━━━━━━━━━` +
  `</pre>`;

                                // PERBAIKAN: Titik koma (;) dihapus agar nyambung ke .catch
                                bot.telegram
                                  .sendMessage(GROUP_ID, notifTopup, { parse_mode: "HTML" })
                                  .catch((e) =>
                                    logger.error("Gagal kirim notif top up ke grup:", e.message)
                                  );

                              } catch (e) {
                                logger.error("Error saat susun/kirim notif grup:", e.message);
                              }

                              // Cleanup receipts (opsional)
                              try {
                                const receiptsDir = path.join(__dirname, "receipts");
                                if (fs.existsSync(receiptsDir)) {
                                  const files = fs.readdirSync(receiptsDir);
                                  for (const file of files) {
                                    fs.unlinkSync(path.join(receiptsDir, file));
                                  }
                                }
                              } catch (e) {
                                logger.error("Gagal menghapus file di receipts:", e.message);
                              }

                              // Kalau notif user gagal, flow lama kamu rollback (tetap dipertahankan)
                              if (!notificationSent) {
                                db.run("ROLLBACK");
                                return resolve(false);
                              }

                              // Commit + cleanup pending
                              db.run("COMMIT", (err5) => {
                                if (err5) {
                                  logger.error("Commit failed:", err5.message);
                                  db.run("ROLLBACK");
                                  return resolve(false);
                                }

                                try {
                                  if (!global.processedTransactions)
                                    global.processedTransactions = new Set();
                                  global.processedTransactions.add(transactionKey);

                                  if (global.pendingDeposits && global.pendingDeposits[uniqueCode]) {
                                    delete global.pendingDeposits[uniqueCode];
                                  }
                                } catch (_) {}

                                db.run(
                                  "DELETE FROM pending_deposits WHERE unique_code = ?",
                                  [uniqueCode],
                                  (err6) => {
                                    if (err6)
                                      logger.error(
                                        "Gagal delete pending_deposits:",
                                        err6.message
                                      );
                                    resolve(true);
                                  }
                                );
                              });
                            }
                          );
                        };

                        // Record transaksi bonus (kalau ada)
                        if (bonusAmount > 0) {
                          db.run(
                            "INSERT INTO transactions (user_id, amount, type, reference_id, timestamp) VALUES (?, ?, ?, ?, ?)",
                            [uid, bonusAmount, "bonus_topup", `bonus-${referenceId}`, Date.now()],
                            (errB) => {
                              if (errB) {
                                db.run("ROLLBACK");
                                return reject(errB);
                              }
                              afterBonusInsert();
                            }
                          );
                        } else {
                          afterBonusInsert();
                        }
                      }
                    );
                  }
                );
              }
            );
          }
        );
      });
    });
  });
}

setInterval(checkQRISStatus, 10000);

const AUTOBACKUP_HOURS = Number(vars.AUTOBACKUP_HOURS ?? 6);
if (AUTOBACKUP_HOURS > 0) {
  const ms = AUTOBACKUP_HOURS * 60 * 60 * 1000;
  setInterval(() => {
    runBackup({ label: `Auto ${AUTOBACKUP_HOURS}h` }).catch((e) =>
      logger.error('[AUTOBACKUP] error:', e.message)
    );
  }, ms);
  logger.info(`[AUTOBACKUP] Aktif setiap ${AUTOBACKUP_HOURS} jam (tanpa backup saat startup).`);
} else {
  logger.info('[AUTOBACKUP] Dinonaktifkan (AUTOBACKUP_HOURS=0).');
}

function startExpirationNotifier() {
  setInterval(() => {
    const now = new Date();

    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Jakarta',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false // Wajib false agar format 24 jam (0-23)
    });

    const parts = formatter.formatToParts(now);
    const hour = parseInt(parts.find(p => p.type === 'hour').value, 10);
    const minute = parseInt(parts.find(p => p.type === 'minute').value, 10);

    // 🔴 SETTING JAM 8 MALAM (20:00) DI SINI
    // Bot akan mengecek setiap menit. Jika jam = 20 dan menit = 0, jalankan notifikasi.
    if (hour === 20 && minute === 0) {
      logger.info(`⏰ Waktunya kirim notifikasi expired (20:00 WIB)`);
      sendExpirationAlerts();
    }

  }, 60 * 1000); // Loop cek setiap 60 detik

  logger.info('✅ Scheduler Notifikasi Aktif (Jadwal: 20:00 WIB)');
}

async function sendExpirationAlerts() {
  const nowMs = Date.now();
  const oneDayMs = 24 * 60 * 60 * 1000;
  const tomorrowMs = nowMs + oneDayMs;

  const sql = `
    SELECT user_id, username, type 
    FROM user_accounts 
    WHERE expire_at > ? AND expire_at <= ?
  `;

  db.all(sql, [nowMs, tomorrowMs], async (err, rows) => {
    if (err) return logger.error('❌ Gagal cek database:', err.message);
    if (!rows || rows.length === 0) return;

    // Grouping User ID
    const userGroups = {};

    rows.forEach(row => {
      if (!userGroups[row.user_id]) {
        userGroups[row.user_id] = [];
      }
      
      // Format: "username (Type)"
      // Huruf depan type jadi besar (vmess -> Vmess)
      const typeStr = row.type ? (row.type.charAt(0).toUpperCase() + row.type.slice(1)) : 'Unknown';
      
      userGroups[row.user_id].push(`${row.username} (${typeStr})`);
    });

    let countSent = 0;

    for (const [userId, accounts] of Object.entries(userGroups)) {
      // Gabungkan akun dengan koma
      const accountList = accounts.join(', ');

      // 👇 PERUBAHAN DI SINI: Pakai tag <code> di sekitar ${accountList}
      const msg = 
        `⚠️ <b>Peringatan Expired!</b>\n\n` +
        `Akun VPN <code>${accountList}</code> akan segera berakhir, silahkan perpanjang akun agar koneksi tidak terputus!`;

      try {
        await bot.telegram.sendMessage(userId, msg, { parse_mode: 'HTML' });
        countSent++;
        await new Promise(r => setTimeout(r, 150));
      } catch (e) {
        // Error wajar (user blokir bot)
      }
    }

    if (countSent > 0) {
      logger.info(`✅ Sukses mengirim notifikasi expired ke ${countSent} user.`);
    }
  });
}

// KONFIGURASI & FUNGSI QR LOGO
const LOGO_URL_FIX = 'https://i.ibb.co/JFkhKCHY/IMG-20260210-WA0002.jpg';

let CACHED_LOGO = null; // Tempat simpan logo di memori

// Fungsi 1: Download logo saat bot nyala (Otomatis)
(async () => {
  try {
    CACHED_LOGO = await loadImage(LOGO_URL_FIX);
    logger.info('✅ [SYSTEM] Logo QRIS berhasil disimpan di memori.');
  } catch (err) {
    logger.warn('⚠️ [SYSTEM] Gagal download logo awal: ' + (err && err.message ? err.message : err));
  }
})();

// Fungsi 2: Membuat QR dengan Logo
async function createQRWithLogo(qrisDataString) {
  try {
    // 1. Bikin QR Code Polos dulu
    const qrDataUrl = await QRCode.toDataURL(qrisDataString, {
      errorCorrectionLevel: 'H', // Level H wajib biar logo ga ngerusak data
      margin: 6,
      scale: 6,
      color: { dark: '#000000', light: '#ffffff' }
    });

    // 2. Siapkan Kanvas (Kertas Kosong)
    const size = 500;
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');

    // 3. Gambar QR ke Kanvas
    const qrImage = await loadImage(qrDataUrl);
    ctx.drawImage(qrImage, 0, 0, size, size);

    // 4. Ambil Logo (Prioritas dari Cache memori)
    let logoToUse = CACHED_LOGO;
    
    // Kalau cache kosong (gagal download pas awal), coba download lagi sekarang
    if (!logoToUse) {
      try {
        logoToUse = await loadImage(LOGO_URL_FIX);
        CACHED_LOGO = logoToUse; // Simpan biar next time ga download lagi
      } catch (e) {
        // Kalau gagal juga, ya sudah tanpa logo
      }
    }

    // 5. Tempel Logo (Kalau ada)
    if (logoToUse) {
      const logoSize = size * 0.25; // Ukuran logo 20% dari QR
      const center = (size - logoSize) / 2;

      // Kotak putih belakang logo
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(center - 5, center - 5, logoSize + 10, logoSize + 10);
      
      // Gambar logo
      ctx.drawImage(logoToUse, center, center, logoSize, logoSize);
    }

    return canvas.toBuffer(); // Kembalikan hasil jadi gambar

  } catch (error) {
    console.error('❌ Error createQRWithLogo:', error.message);
    // Kalau error parah, kembalikan QR biasa aja
    return await QRCode.toBuffer(qrisDataString);
  }
}

async function recordAccountTransaction(userId, type, days = 0) {
  return new Promise((resolve, reject) => {
    const referenceId = `account-${type}-${userId}-${Date.now()}`;
    const d = Number(days) || 0;

    db.run(
      'INSERT INTO transactions (user_id, amount, type, reference_id, timestamp) VALUES (?, ?, ?, ?, ?)',
      [userId, d, type, referenceId, Date.now()],
      (err) => (err ? reject(err) : resolve())
    );
  });
}

// ✅ SCHEDULER: Cek setiap 1 jam
function startCleanupScheduler() {
  const ONE_HOUR = 60 * 60 * 1000;

  const run = () => {
    try {
      cleanupExpiredUserAccounts();
      checkAndDowngradeResellers(); // <--- INI TAMBAHANNYA
    } catch (e) {
      logger.error('Cleanup scheduler error:', e);
    }
  };

  // Jalankan interval setiap 1 jam
  setInterval(run, ONE_HOUR);
  
  // Info di log
  logger.info('⏰ Scheduler Aktif: Pengecekan akun expired & reseller pasif berjalan setiap 1 jam.');
}

app.listen(port, () => {
  logger.info(`Server berjalan di port ${port}`);

  function expireOldPendingDeposits() {
    const now = Date.now();
    const ttlMs = 5 * 60 * 1000; // 5 menit
    db.run(
      `UPDATE pending_deposits
       SET status = 'expired'
       WHERE status = 'pending' AND timestamp <= ?`,
      [now - ttlMs],
      (err) => {
        if (err) logger.error('❌ Expire pending_deposits gagal:', err.message);
      }
    );
  }

  // Scheduler dijalankan di luar blok bot.launch agar tetap jalan walau Telegram timeout
  startCleanupScheduler(); 
  startExpirationNotifier(); 

  setInterval(expireOldPendingDeposits, 60 * 1000);
  cleanupExpiredUserAccounts();
  expireOldPendingDeposits();

  // Sistem Auto-Reconnect Telegraf
  function startBot() {
    bot.launch({ dropPendingUpdates: true })
      .then(() => {
        logger.info('Bot telah dimulai');
      })
      .catch((error) => {
        logger.error('Error saat memulai bot:', error.message);
        logger.info('🔄 Mencoba menyalakan ulang koneksi Telegram dalam 10 detik...');
        setTimeout(startBot, 10000); // Coba lagi otomatis setelah 10 detik
      });
  }

  startBot();
});


