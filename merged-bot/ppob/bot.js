// ============================================================
// PPOB MODULE — di-merge ke shared bot/app dari master entry.
// dotenv di-load di master entry, tidak di-load lagi di sini.
// ============================================================
require('./backup.js'); 
const { digiflazzTopup, digiflazzCekSaldo } = require("./modules/digiflazz");
const { Telegraf, Markup } = require("telegraf");
const redisSession = require("./modules/redisSession");
const { db, run, all, get, initDb, getMarkup, setMarkup } = require("./modules/database");
const { kbStartMenu, kbPpobMenu, kbQuickTopup, CATEGORIES } = require("./modules/keyboards");
const {
  md5hex, formatUptime, normalizeMsisdn, isValidMsisdn, htmlToText,
  msToReadable, parseAmount, maskTarget, fmtDateTimeID, fmtDateOnlyID,
  formatRupiah, clean, safeLabel, b64uEncode, b64uDecode,
  displayOrderId, mapDigiStatus, escapeMd, escapeHtml, chunk, timingSafeEq,
  humanExpire, // <--- TAMBAHKAN INI DI SINI
  statusIcon
} = require("./modules/helpers");
const { sidompulCekKuota, consumeKuotaLimit, KUOTA_LIMIT_MAX } = require("./modules/sidompul");
const { kmspCekIndosat } = require("./modules/indosat");
const axios = require("axios");
const fs = require("fs");
const crypto = require("crypto");
const QRCode = require("qrcode");
const WELCOME_IMAGE_URL =
  "https://i.ibb.co/dJDPgy8M/file-00000000966c71fd9c682db49852b08b.png";

// ============================================================
// SETUP FUNCTION — di-call dari master entry (index.js).
// {bot} dan {app} disediakan oleh master sehingga dishare antar modul.
// Ekspor:
//   - sendPpobHome(ctx, edit)  : menu utama PPOB (dipanggil saat user pilih PPOB di picker)
//   - sendStartMenu(ctx, edit) : welcome screen lama PPOB (opsional)
// ============================================================
module.exports = function setupPpob({ bot, app }) {

// CONFIG
const BOT_TOKEN = process.env.BOT_TOKEN;
const DIGI_USERNAME = process.env.DIGIFLAZZ_USERNAME;
const DIGI_APIKEY = process.env.DIGIFLAZZ_APIKEY;
if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN belum di-set di .env");
  process.exit(1);
}


const LOG_LEVEL = (process.env.LOG_LEVEL || "INFO").toUpperCase();
const LV = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };
function log(level, ...args) {
  if ((LV[level] ?? 2) <= (LV[LOG_LEVEL] ?? 2)) console.log(...args);
}

function extractDigiErr(err) {
  try {
    const obj = typeof err === "string" ? JSON.parse(err) : err;
    const d = obj?.data?.data || obj?.data || obj;
    return { rc: d?.rc || "-", message: d?.message || "Request gagal." };
  } catch {
    return { rc: "-", message: String(err || "Request gagal.") };
  }
}

function niceDigiMsg(rc, message, sn = "") {
  const m = String(message || "").trim();
  const s = String(sn || "").trim();

  // Jika SN berisi huruf (biasanya pesan error spesifik dari pusat seperti "Player Not Found")
  if (s && s.length > 3 && !s.match(/^[0-9]+$/)) {
      return s;
  }

  switch (String(rc)) {
    case "02": return "Tujuan salah atau gangguan pusat.";
    case "05": return "Nomor tujuan salah / tidak ditemukan.";
    case "20": return "Tujuan salah / format tidak sesuai.";
    case "44": return "Saldo provider tidak cukup. Hubungi admin.";
    case "43": return "Produk sedang gangguan/nonaktif. Pilih produk lain.";
    case "41": return "Provider error (signature). Hubungi admin.";
    case "67": return "Produk sedang kosong / gangguan pusat.";
    case "68": return "Sistem sedang antre/sibuk.";
    case "94": return "Server pusat sedang maintenance.";
    default:   
      if (m.toLowerCase().includes("transaksi gagal")) return "Dibatalkan oleh sistem pusat.";
      return m || "Transaksi dibatalkan oleh sistem.";
  }
}

// MODULE: MEMORY CACHE (TTL 1 JAM)
const MEM_CACHE = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // Cache Valid selama 60 Menit (1 Jam)

// Helper: Ambil dari Cache, kalau tidak ada baru ambil dari DB
async function getOrSetCache(key, fetchFunction) {
  if (MEM_CACHE.has(key)) {
    const { data, expire } = MEM_CACHE.get(key);
    if (Date.now() < expire) {
      return data; // ✅ Kembalikan data dari RAM (Cepat)
    }
    MEM_CACHE.delete(key); // Hapus kalau sudah expired
  }

  // ⚠️ Kalau tidak ada di cache, jalankan query DB asli
  const data = await fetchFunction();
  
  // Simpan ke RAM
  MEM_CACHE.set(key, { data, expire: Date.now() + CACHE_TTL_MS });
  return data;
}

// Helper: Hapus semua cache (Dipanggil saat Admin Edit Produk)
function clearProductCache() {
// console.log("[CACHE] Membersihkan seluruh cache produk karena ada update...");
  MEM_CACHE.clear();
}
// Expose ke handler lain (mis. adminHandler) supaya /onproduk /offproduk /delproduk
// bisa langsung me-refresh menu tanpa nunggu TTL 60 menit.
globalThis.clearProductCache = clearProductCache;

// Helper: Tandai produk sebagai gangguan / normal (real-time dari response Digiflazz)
async function markProductStatus(sku, status) {
  if (!sku) return;
  const st = status === "gangguan" ? "gangguan" : "normal";
  try {
    await run(
      `UPDATE products SET status=?, updated_at=datetime('now') WHERE sku=?`,
      [st, sku]
    );
    clearProductCache();
    console.log(`[STATUS] SKU ${sku} -> ${st}`);
  } catch (e) {
    console.log("[markProductStatus] error:", e?.message || e);
  }
}
async function removeReplyKeyboard(ctx) {
  try {
    const chatId =
      ctx.chat?.id ||
      ctx.update?.callback_query?.message?.chat?.id ||
      ctx.update?.message?.chat?.id;
    if (!chatId) return;

    const sent = await ctx.telegram.sendMessage(chatId, "\u200b", {
      reply_markup: { remove_keyboard: true },
    });

    if (sent?.message_id) {
      await ctx.telegram.deleteMessage(chatId, sent.message_id).catch(() => {});
    }
  } catch {}
}

function isUserInputTargetError(rc, message) {
  // Pastikan RC berupa string "00", "14", dst
  let r = String(rc || "").replace(/[^\d]/g, "");
  if (r) r = r.padStart(2, "0");

  const msg = String(message || "").toLowerCase();

  // --- DAFTAR RC YANG SALAH USER (TIDAK REFUND) ---
  // RC 14: Nomor Tujuan Salah / Tidak Terdaftar (MUTLAK SALAH USER)
  // RC 11: Format Salah
  // RC 12: Merchant/Target Diblokir
  // RC 17: Saldo User Kurang (Di sisi provider, jarang kena di kita)
  const NO_REFUND_RCS = ["14", "11", "12", "17"];

  if (NO_REFUND_RCS.includes(r)) {
    return true; // Salah user -> Jangan Refund
  }

  // --- CEK PESAN TEXT (FALLBACK) ---
  // Kadang RC-nya umum (02/00) tapi pesannya jelas "Nomor salah"
  const kwSalahNomor = [
    "nomor salah", "tujuan salah", "nomor tidak terdaftar", 
    "invalid number", "invalid target", "cek nomor", 
    "nomor tidak ditemukan", "salah nomor", "tidak valid"
  ];

  // Hanya anggap salah user jika pesannya SANGAT SPESIFIK menyebut nomor salah
  // Hati-hati dengan kata "Gagal", "Gangguan" -> Itu harus refund
  if (kwSalahNomor.some(kw => msg.includes(kw))) {
    // Double check: Jangan sampai pesan "Produk sedang gangguan" dianggap salah nomor
    if (!msg.includes("gangguan") && !msg.includes("kosong") && !msg.includes("error")) {
      return true;
    }
  }

  return false; // Selain itu -> Anggap kesalahan Provider/System -> REFUND
}

function shouldAutoRefundOnFailed(rc, message) {
  // Kebalikan dari error user = Auto Refund
  return !isUserInputTargetError(rc, message);
}

const ADMIN_IDS = (process.env.ADMIN_IDS || "")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean)
  .map(Number);

// DIGIFLAZZ WEBHOOK
const DIGI_WEBHOOK_SECRET = process.env.DIGIFLAZZ_WEBHOOK_SECRET || "";
const DIGI_WEBHOOK_PORT = Number(process.env.DIGIFLAZZ_WEBHOOK_PORT || process.env.WEBHOOK_PORT || 8787);

const PAGE_SIZE = 8;
const PENDING_CHECK_INTERVAL_MS = 20_000;
const MAX_PENDING_CHECKS = 25;
const MAX_PENDING_AGE_MIN = 60;

const BOT_START_TIME = Date.now();

// HELPER FUNCTIONS
function isAdmin(ctx) {
  const uid = ctx.from?.id;
  return ADMIN_IDS.includes(uid);
}

// === TOPUP QRIS (OrderKuota/Orkut) ===
const DATA_QRIS = process.env.DATA_QRIS || ""; // codeqr
// Expire QRIS bisa beda per jenis
const QRIS_EXPIRE_MIN_TOPUP = Number(process.env.QRIS_EXPIRE_MIN_TOPUP || process.env.QRIS_EXPIRE_MIN || 5); // topup tetap 5 menit
const QRIS_EXPIRE_MIN_DIRECT = Number(process.env.QRIS_EXPIRE_MIN_DIRECT || process.env.QRIS_EXPIRE_MIN || 5); // bayar langsung: default 60 menit (set 0 = tanpa auto-expire)
// Backward compat (dipakai beberapa bagian lama)
const QRIS_EXPIRE_MIN = QRIS_EXPIRE_MIN_TOPUP;

function generateRandomNumber(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// REFACTOR: CREATE QRIS (VIA API AUTOGOPAY)
async function createQrisPayment(amount, activeWindowMin = QRIS_EXPIRE_MIN_TOPUP) {
  const baseAmount = Number(amount);
  if (isNaN(baseAmount) || baseAmount <= 0) throw new Error("Nominal tidak valid");

  // Karena pakai API, nominal unik bisa digenerate seperti biasa
  const rows = await all(
    `SELECT amount_final FROM deposits
     WHERE status='PENDING'
       AND (julianday('now') - julianday(created_at)) * 24 * 60 < ?`,
    [activeWindowMin]
  );
  const pendingAmounts = new Set(rows.map((r) => Number(r.amount_final)));

  let finalAmount = 0;
  let adminFee = 0;

  for (let i = 0; i < 100; i++) {
    const kode = generateRandomNumber(1, 200); 
    const candidate = baseAmount + kode;
    if (!pendingAmounts.has(candidate)) {
      finalAmount = candidate;
      adminFee = kode;
      break;
    }
  }

  if (!finalAmount) throw new Error("Gagal membuat kode unik.");

  const apiKey = (process.env.AUTOGOPAY_TOKEN || process.env.AUTOGOPAY_API_KEY || '').trim();

  try {
      // 1. TEMBAK API AUTOGOPAY UNTUK BIKIN QRIS
      const res = await axios.post('https://v1-gateway.autogopay.site/qris/generate', {
          amount: finalAmount
      }, {
          headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`
          }
      });

      if (!res.data || !res.data.success) {
          throw new Error(res.data?.message || "Gagal dari API AutoGoPay");
      }

      // 2. AMBIL STRING QRIS DARI AUTOGOPAY
      const qrString = res.data.data.qr_string;
      
      // 3. JADIKAN GAMBAR
      const qrBuffer = await QRCode.toBuffer(qrString, {
        type: "png",
        errorCorrectionLevel: "M",
        margin: 5,
        scale: 6,
      });

      return { finalAmount, adminFee, qrBuffer };

  } catch (err) {
      console.error("❌ API AutoGoPay Error:", err.response?.data || err.message);
      throw new Error("Gagal request QRIS ke server pusat.");
  }
}

// DB
function cleanupOldHistory() {
  db.run(
    `DELETE FROM orders
     WHERE status IN ('SUCCESS','FAILED','CANCELED')
       AND datetime(created_at,'localtime') < datetime('now','localtime','-90 days')`
  );

  db.run(
    `DELETE FROM deposits
     WHERE status IN ('PAID','EXPIRED')
       AND datetime(created_at,'localtime') < datetime('now','localtime','-180 days')`
  );
}

cleanupOldHistory();
setInterval(cleanupOldHistory, 24 * 60 * 60 * 1000);

// SALDO USER (METODE B)
async function debitSaldoUser(user_id, amount) {
  const amt = Number(amount || 0);
  if (amt <= 0) return false;

  const r = await run(
    `UPDATE users
     SET saldo = saldo - ?, updated_at = datetime('now')
     WHERE user_id = ? AND saldo >= ?`,
    [amt, user_id, amt]
  );
  return (r?.changes || 0) > 0;
}

async function creditSaldoUser(user_id, amount) {
  const amt = Number(amount || 0);
  if (amt <= 0) return false;

  const r = await run(
    `UPDATE users
     SET saldo = saldo + ?, updated_at = datetime('now')
     WHERE user_id = ?`,
    [amt, user_id]
  );
  return (r?.changes || 0) > 0;
}

async function getLastDepositsByUser(userId, limit = 10) {
  limit = Number(limit) || 10;
  return all(
    `SELECT
       id,
       status,
       amount_final,
       amount_base,
       kode_unik AS admin_fee,
       paid_at,
       created_at
     FROM deposits
     WHERE user_id=?
     ORDER BY id DESC
     LIMIT ?`,
    [userId, limit]
  );
}

async function getLastOrdersByUser(userId, limit = 3) {
  limit = Number(limit) || 3;
  return all(
    `SELECT id,status,product_name,sku,target,price,sn,message,updated_at,created_at
     FROM orders
     WHERE user_id=?
     ORDER BY id DESC
     LIMIT ?`,
    [userId, limit]
  );
}

// USERS helpers (buat tampil saldo di menu)
async function ensureUser(user_id) {
  // buat user kalau belum ada
  await run(
    `INSERT OR IGNORE INTO users (user_id, saldo, updated_at)
     VALUES (?, 0, datetime('now'))`,
    [user_id]
  );
}

async function getUserSaldo(user_id) {
  const row = await get(`SELECT saldo FROM users WHERE user_id=?`, [user_id]);
  return Number(row?.saldo || 0);
}

// CHARGE / REFUND ORDER (saldo user)
async function chargeUserForOrder(orderId, userId, amount) {
  const amt = Number(amount || 0);
  if (amt <= 0) return false;

  await ensureUser(userId);

  const ok = await debitSaldoUser(userId, amt);
  if (!ok) return false;

  // tandai order sudah dipotong
  await updateOrder(orderId, { charged: 1, charged_amount: amt });
  return true;
}

async function refundUserForOrder(orderId, reason = "FAILED") {
  let txStarted = false;
  try {
    // 1. Cek Order Dulu (Baca data terbaru)
    const o = await get(`SELECT * FROM orders WHERE id=?`, [orderId]);
    if (!o) return false;

    // Hanya proses jika status FAILED (atau bisa diedit jika mau refund manual status SUCCESS)
    if (String(o.status || "").toUpperCase() !== "FAILED") return false;

    // Syarat Refund: Sudah dipotong (charged=1) DAN Belum direfund (refunded=0)
    if (Number(o.charged || 0) !== 1) return false;
    if (Number(o.refunded || 0) === 1) return false;

    // Tentukan nominal refund
    // Prioritas: charged_amount (real dipotong) > price (harga database)
    let amount = Number(o.charged_amount);
    if (!amount || amount <= 0) amount = Number(o.price || 0);

    if (!amount || amount <= 0) {
      console.log(`[REFUND SKIP] Order ${orderId} nominal 0`);
      return false;
    }

    // 2. Mulai Transaksi Database (Safety Lock) - ENHANCED
    await run("BEGIN IMMEDIATE");
    txStarted = true;

    // ─── ENHANCED DOUBLE-CHECK (FIX: Prevent Double Refund) ──────────────────
    // Cek ulang di dalam lock dengan FOR UPDATE semantics
    // Ini mencegah race condition dimana 2 proses masuk bersamaan
    const check = await get(
      `SELECT refunded, charged, processing_lock FROM orders WHERE id=?`,
      [orderId]
    );

    if (!check || check.refunded === 1 || check.charged !== 1) {
      await run("ROLLBACK");
      console.log(`[REFUND SKIP] Order ${orderId} sudah direfund atau tidak valid (race condition prevented)`);
      return false;
    }
    // ─────────────────────────────────────────────────────────────────────────

    // 3. Kembalikan Saldo User
    await ensureUser(o.user_id);
    const updSaldo = await run(
      `UPDATE users SET saldo = saldo + ?, updated_at = datetime('now') WHERE user_id = ?`,
      [amount, o.user_id]
    );

    if (!updSaldo || updSaldo.changes === 0) {
      await run("ROLLBACK");
      console.log(`[REFUND FAIL] Order ${orderId} gagal update saldo user`);
      return false;
    }

    // 4. Update Status Order jadi REFUNDED
    const note = `REFUND_OK(+${amount}; ${reason})`;
    const oldMsg = o.message || "";
    // Gabungkan pesan lama + note refund, tapi jangan sampai kepanjangan
    const newMsg = (oldMsg + " | " + note).slice(0, 500);

    await run(
      `UPDATE orders SET refunded=1, message=?, updated_at=datetime('now') WHERE id=?`,
      [newMsg, orderId]
    );

    await run("COMMIT");
    txStarted = false;

    console.log(`[REFUND SUCCESS] Order: ${orderId} User: ${o.user_id} Amount: ${amount} Reason: ${reason}`);

    // Opsional: Kirim notif ke user di sini jika mau (tapi biasanya di handler confirm_buy sudah ada)
    return true;

  } catch (e) {
    console.error("[REFUND ERROR]", e);
    if (txStarted) await run("ROLLBACK").catch(() => {});
    return false;
  }
}

function parseSaldoCmd(ctx, cmdName) {
  // Support:
  // 1) /cmd userId|nominal
  // 2) Reply user lalu: /cmd nominal
  const raw = clean(ctx.message.text.replace(`/${cmdName}`, ""));

  let targetUserId = null;
  let amountStr = null;

  if (raw.includes("|")) {
    const parts = raw.split("|").map((x) => clean(x));
    targetUserId = Number(parts[0]);
    amountStr = parts[1];
  } else {
    targetUserId = Number(ctx.message?.reply_to_message?.from?.id || 0);
    amountStr = raw;
  }

  const amount = parseInt(String(amountStr || "").replace(/[^\d]/g, ""), 10);
  return { targetUserId, amount };
}

async function insertPendingDeposit(userId, base, kodeUnik, finalAmount, kind = "TOPUP", orderId = null, purpose = null) {
  // Kolom kind/order_id/purpose mungkin belum ada di instalasi lama → fallback ke insert lama
  try {
    const res = await run(
      `INSERT INTO deposits (user_id, kind, purpose, order_id, amount_base, kode_unik, amount_final, status)
       VALUES (?,?,?,?,?,?,?, 'PENDING')`,
      [userId, kind, purpose, orderId, base, kodeUnik, finalAmount]
    );
    return res.lastID;
  } catch (e) {
    const res = await run(
      `INSERT INTO deposits (user_id, amount_base, kode_unik, amount_final, status)
       VALUES (?,?,?,?, 'PENDING')`,
      [userId, base, kodeUnik, finalAmount]
    );
    return res.lastID;
  }
}

// ✅ Limit pembuatan QRIS per user (anti spam) — max N QRIS dalam window menit
async function countRecentPendingQris(userId, kind, windowMin) {
  // windowMin: menit
  const w = Number(windowMin || 5);
  try {
    const row = await get(
      `SELECT COUNT(1) AS c
       FROM deposits
       WHERE user_id = ?
         AND status = 'PENDING'
         AND COALESCE(kind,'TOPUP') = ?
         AND (julianday('now') - julianday(created_at)) * 24 * 60 < ?`,
      [userId, kind, w]
    );
    return Number(row?.c || 0);
  } catch (e) {
    // instalasi lama (tanpa kolom kind) → hitung semua PENDING user tsb dalam window
    const row = await get(
      `SELECT COUNT(1) AS c
       FROM deposits
       WHERE user_id = ?
         AND status = 'PENDING'
         AND (julianday('now') - julianday(created_at)) * 24 * 60 < ?`,
      [userId, w]
    );
    return Number(row?.c || 0);
  }
}
// ✅ Lock + mark PAID (anti dobel topup)
async function lockAndMarkDepositPaid(depId, trxKey) {
  const r = await run(
    `UPDATE deposits
     SET status='PAID',
         paid_at=datetime('now'),
         trx_key=COALESCE(?, trx_key)
     WHERE id=? AND status='PENDING'`,
    [trxKey || null, depId]
  );
  return !!(r && r.changes > 0);
}

async function getUnnotifiedExpiredDeposits(limit = 50) {
  return all(
    `SELECT id, user_id, amount_base, amount_final, created_at
     FROM deposits
     WHERE status='EXPIRED' AND COALESCE(expired_notified,0)=0
     ORDER BY id ASC
     LIMIT ?`,
    [limit]
  );
}

async function markExpiredNotified(depId) {
  await run(`UPDATE deposits SET expired_notified=1 WHERE id=?`, [depId]);
}

async function findUnpaidDepositByFinalAmount(finalAmount) {
  const directWindow = (QRIS_EXPIRE_MIN_DIRECT > 0 ? QRIS_EXPIRE_MIN_DIRECT : 525600); // 525600 = 1 tahun
  return get(
    `SELECT * FROM deposits
     WHERE status='PENDING'
       AND amount_final=?
       AND (julianday('now') - julianday(created_at)) * 24 * 60 < (
         CASE WHEN COALESCE(kind,'TOPUP')='DIRECT' THEN ? ELSE ? END
       )
     ORDER BY id ASC LIMIT 1`,
    [finalAmount, directWindow, QRIS_EXPIRE_MIN_TOPUP]
  );
}

async function markDepositPaid(id) {
  await run(`UPDATE deposits SET status='PAID', paid_at=datetime('now') WHERE id=?`, [id]);
}

async function expireOldDeposits() {
  // Expire TOPUP (tetap 5 menit)
  try {
    await run(
      `UPDATE deposits
       SET status = 'EXPIRED'
       WHERE status = 'PENDING'
         AND COALESCE(kind,'TOPUP') = 'TOPUP'
         AND (julianday('now') - julianday(created_at)) * 24 * 60 >= ?`,
      [QRIS_EXPIRE_MIN_TOPUP]
    );

    // Expire DIRECT (opsional; set 0 agar tidak auto-expire)
    if (QRIS_EXPIRE_MIN_DIRECT > 0) {
      await run(
        `UPDATE deposits
         SET status = 'EXPIRED'
         WHERE status = 'PENDING'
           AND COALESCE(kind,'TOPUP') = 'DIRECT'
           AND (julianday('now') - julianday(created_at)) * 24 * 60 >= ?`,
        [QRIS_EXPIRE_MIN_DIRECT]
      );
    }
  } catch (e) {
    // Fallback instalasi lama (tanpa kolom kind) → expire semua pending pakai topup expire
    await run(
      `UPDATE deposits
       SET status = 'EXPIRED'
       WHERE status = 'PENDING'
         AND (julianday('now') - julianday(created_at)) * 24 * 60 >= ?`,
      [QRIS_EXPIRE_MIN_TOPUP]
    );
  }
}

async function notifyExpiredDeposits(limit = 50) {
  // Tambahkan msg_id di SELECT agar bot bisa menghapus pesannya
  const rows = await all(
    `SELECT id, user_id, COALESCE(kind,'TOPUP') AS kind, order_id, msg_id
     FROM deposits
     WHERE status = 'EXPIRED' AND COALESCE(expired_notified,0)=0
     ORDER BY id ASC
     LIMIT ?`,
    [limit]
  );

  if (!rows.length) return;

  for (const dep of rows) {
    const isDirect = String(dep.kind || 'TOPUP').toUpperCase() === 'DIRECT';

    if (isDirect && dep.order_id) {
      await updateOrder(dep.order_id, {
        status: 'CANCELED', // Saya sesuaikan dengan ejaan CANCELED di sistem cleanup kamu
        message: 'Pembayaran QRIS Expired (Waktu habis)',
        last_check_at: new Date().toISOString()
      }).catch(() => {});
    }

    const msg = isDirect
      ? ("❌ *Pembayaran QRIS Expired!*\n" +
         "Waktu pembayaran habis. Transaksi dibatalkan otomatis.\n" +
         "Silakan order ulang jika masih berminat.")
      : ("❌ *Pembayaran Expired!*\n" +
         "Waktu pembayaran Top Up telah habis. Silakan buat QRIS baru.");

    // --- FITUR BARU: Hapus Pesan QRIS ---
    if (dep.msg_id) {
      await bot.telegram.deleteMessage(dep.user_id, dep.msg_id).catch((err) => {
          console.error(`Gagal hapus pesan expired ${dep.msg_id}:`, err.message);
      });
    }

    // Kirim notifikasi expired ke user
    await bot.telegram.sendMessage(dep.user_id, msg, { parse_mode: "Markdown" }).catch(() => {});

    // Tandai bahwa notifikasi sudah dikirim
    await markExpiredNotified(dep.id);
  }
}

// Products
async function upsertProduct(p) {
  await run(
    `
    INSERT INTO products (sku,name,brand,category,subcat,buy_price,sell_price,description,active,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?, datetime('now'))
    ON CONFLICT(sku) DO UPDATE SET
      name=excluded.name,
      brand=excluded.brand,
      category=excluded.category,
      subcat=excluded.subcat,
      buy_price=excluded.buy_price,
      sell_price=excluded.sell_price,
      description=excluded.description,
      active=excluded.active,
      updated_at=datetime('now')
  `,
    [
      p.sku,
      p.name,
      p.brand,
      p.category,
      p.subcat || "",
      p.buy_price || 0,
      p.sell_price,
      p.description || "",     // ✅ ini kunci
      p.active ?? 1,
    ]
  );
  
  clearProductCache(); 
}
async function setProductActive(sku, active) {
  await run(`UPDATE products SET active=?, updated_at=datetime('now') WHERE sku=?`, [
    active ? 1 : 0,
    sku,
  ]);
  
  clearProductCache(); 
}
async function deleteProduct(sku) {
  await run(`DELETE FROM products WHERE sku=?`, [sku]);
  
  clearProductCache(); 
}

async function handleAddProdukWizardText(ctx) {
  // bukan mode addproduk → jangan ganggu flow lain
  if (!ctx.session?.addproduk_wiz) return false;

  // safety admin
  if (!isAdmin(ctx)) {
    resetAddProdukWizard(ctx);
    await ctx.reply("❌   Admin only");
    return true;
  }

  const txt = clean(ctx.message?.text || "");
  if (!txt) return true;
  if (txt.startsWith("/")) return true; // command lain: abaikan

  const st = ctx.session.addproduk_wiz;
  const idx = Number(st.step_index || 0);
  const step = ADDPRODUK_STEPS[idx];

  if (!step) {
    resetAddProdukWizard(ctx);
    await ctx.reply("❌ Wizard invalid. Jalankan /addproduk lagi.");
    return true;
  }

  const value = step.parse ? step.parse(txt) : txt;

  if (step.validate && !step.validate(value)) {
    await ctx.reply(step.err || "❌ Input tidak valid. Ulangi:");
    return true;
  }

  // simpan jawaban step ini
  st.data[step.key] = value;

  // lanjut step berikutnya
  st.step_index = idx + 1;

  // kalau masih ada step berikutnya → tanya
  if (st.step_index < ADDPRODUK_STEPS.length) {
    await ctx.reply(ADDPRODUK_STEPS[st.step_index].ask);
    return true;
  }

  // selesai → simpan ke DB
  const d = st.data;

  // validasi final
  if (!d.sku || !d.name || !d.brand || !d.category || !d.sell_price) {
    resetAddProdukWizard(ctx);
    await ctx.reply("❌ Data kurang/invalid. Jalankan /addproduk lagi.");
    return true;
  }

  await upsertProduct({
    sku: d.sku,
    name: d.name,
    brand: d.brand,
    category: d.category,
    subcat: d.subcat || "",
    buy_price: Number(d.buy_price) || 0,
    sell_price: Number(d.sell_price) || 0,
    description: d.description || "",
    active: 1,
  });

  const extra = d.subcat ? ` / ${d.subcat}` : "";

  resetAddProdukWizard(ctx);

  await ctx.reply(
    "✅ Produk tersimpan\n" +
      `SKU: ${d.sku}\n` +
      `Kategori: ${d.category} / ${d.brand}${extra}\n` +
      `Harga beli: ${formatRupiah(Number(d.buy_price) || 0)}\n` +
      `Harga jual: ${formatRupiah(Number(d.sell_price) || 0)}\n` +
      `Deskripsi: ${d.description || "-"}`
  );

  return true;
}

async function isFavorite(userId, sku) {
  const row = await get(`SELECT 1 as ok FROM favorites WHERE user_id=? AND sku=?`, [userId, sku]);
  return !!row;
}
async function addFavorite(userId, sku, alias = '') {
  await run(
    `INSERT OR REPLACE INTO favorites (user_id, sku, alias, created_at) VALUES (?, ?, ?, ?)`,
    [userId, sku, alias, Date.now()]
  );
}
async function removeFavorite(userId, sku) {
  await run(`DELETE FROM favorites WHERE user_id=? AND sku=?`, [userId, sku]);
}
async function listFavorites(userId) {
  return all(
    `SELECT 
      f.sku,
      COALESCE(NULLIF(f.alias,''), p.name, f.sku) AS title,
      p.sell_price,
      p.brand,
      p.category
     FROM favorites f
     LEFT JOIN products p ON p.sku=f.sku
     WHERE f.user_id=?
     ORDER BY f.created_at DESC`,
    [userId]
  );
}

async function getProduct(sku) {
  return get(`SELECT * FROM products WHERE sku=?`, [sku]);
}
async function listBrands(category) {
  const cacheKey = `brands:${category}`;
  return getOrSetCache(cacheKey, async () => {
    return all(
      `
      SELECT brand
      FROM products
      WHERE active=1 AND category=?
      GROUP BY brand
      ORDER BY MIN(rowid) ASC
      `,
      [category]
    );
  });
}
async function listSubcats(category, brand) {
  const cacheKey = `sub:${category}:${brand}`;
  return getOrSetCache(cacheKey, async () => {
    return all(
      `
      SELECT subcat
      FROM products
      WHERE active=1 AND category=? AND brand=?
        AND COALESCE(TRIM(subcat),'') <> ''
      GROUP BY subcat
      ORDER BY MIN(rowid) ASC
      `,
      [category, brand]
    );
  });
}
async function countProducts(category, brand, subcat) {
  const cacheKey = `cnt:${category}:${brand}:${subcat || 'ALL'}`;
  return getOrSetCache(cacheKey, async () => {
    if (!subcat || subcat === "ALL") {
      const row = await get(
        `SELECT COUNT(*) as c FROM products WHERE active=1 AND category=? AND brand=?`,
        [category, brand]
      );
      return Number(row?.c || 0);
    }
    const row = await get(
      `SELECT COUNT(*) as c FROM products
       WHERE active=1 AND category=? AND brand=? AND COALESCE(subcat,'')=?`,
      [category, brand, subcat]
    );
    return Number(row?.c || 0);
  });
}
async function listProducts(category, brand, subcat, page = 0) {
  const p = Number(page) || 0;
  const cacheKey = `list:${category}:${brand}:${subcat || 'ALL'}:${p}`;
  
  return getOrSetCache(cacheKey, async () => {
    const limit = PAGE_SIZE;
    const offset = p * limit;
    
    const params = (subcat && subcat !== "ALL")
      ? [category, brand, subcat, limit, offset]
      : [category, brand, limit, offset];

    const sql = `
      SELECT sku, name, sell_price, COALESCE(status,'normal') AS status
      FROM products
      WHERE active=1 AND category=? AND brand=?
        ${(subcat && subcat !== "ALL") ? "AND COALESCE(subcat,'')=?" : ""}
      ORDER BY sell_price ASC
      LIMIT ? OFFSET ?
    `;

    const rows = await all(sql, params);
    return rows || [];
  });
}

function nowIso() {
  return new Date().toISOString();
}
function makeRefId(userId) {
  const rnd = Math.floor(100 + Math.random() * 900);
  return `INV${userId}${Date.now()}${rnd}`;
}

async function createOrderPending({ user_id, username, sku, product_name, target, price, buy_price, ref_id }) {
  const res = await run(
    `
    INSERT INTO orders (user_id, username, sku, product_name, target, price, buy_price, ref_id, status, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', datetime('now'))
    `,
    // 2. Pastikan urutan parameter di bawah ini SESUAI dengan urutan kolom di atas
    [
      user_id,              // Kolom 1
      username || "",       // Kolom 2
      sku,                  // Kolom 3
      product_name || "",   // Kolom 4
      target,               // Kolom 5
      price,                // Kolom 6
      Number(buy_price) || 0, // Kolom 7 (Modal)
      ref_id                // Kolom 8
    ]
  );
  return res.lastID;
}

async function updateOrder(orderId, patch) {
  const fields = [];
  const params = [];
  for (const [k, v] of Object.entries(patch)) {
    fields.push(`${k}=?`);
    params.push(v);
  }
  params.push(orderId);
  await run(`UPDATE orders SET ${fields.join(", ")}, updated_at=datetime('now') WHERE id=?`, params);

  // ==========================================
  // 📡 RADAR ADMIN: NOTIFIKASI TRANSAKSI GAGAL
  // ==========================================
  if (patch.status === "FAILED") {
    try {
      // Pastikan ada ADMIN_IDS yang diset di .env
      if (ADMIN_IDS && ADMIN_IDS.length > 0) {
        // Tarik data order terbaru untuk melihat detail pesanan yang gagal
        const o = await get(`SELECT * FROM orders WHERE id=?`, [orderId]);
        if (o) {
           const adminMsg = 
             `⚠️ *LAPORAN TRANSAKSI GAGAL*\n\n` +
             `👤 User ID: \`${o.user_id}\`\n` +
             `📛 User   : ${o.username || "-"}\n` +
             `🔖 SKU    : \`${o.sku || "-"}\`\n` +
             `📦 Produk : *${o.product_name || "-"}*\n` +
             `🎯 Target : \`${o.target || "-"}\`\n` +
             `💰 Harga  : Rp ${Number(o.price).toLocaleString('id-ID')}\n` +
             `📝 Alasan : ${patch.message || o.message || "Gagal dari sistem pusat"}\n\n` +
             `💡 _Saldo user otomatis direfund jika gagal murni dari pusat._`;
           
           // Kirim notif ke Admin Utama (urutan pertama di env)
           await bot.telegram.sendMessage(ADMIN_IDS[0], adminMsg, { parse_mode: "Markdown" }).catch(() => {});
        }
      }
    } catch(e) {
      console.error("[RADAR GAGAL] Gagal kirim notif ke admin:", e.message);
    }
  }
}

async function getOrderById(orderId) {
  return get(`SELECT * FROM orders WHERE id=?`, [orderId]);
}
async function getPendingOrdersForCheck() {
  return all(
    `
    SELECT * FROM orders
    WHERE status='PENDING'
      AND check_count < ?
      AND (julianday('now') - julianday(created_at)) * 24 * 60 < ?
    ORDER BY id ASC
    LIMIT 20
  `,
    [MAX_PENDING_CHECKS, MAX_PENDING_AGE_MIN]
  );
}

// UTILS
function isAdmin(ctx) {
  return ADMIN_IDS.includes(ctx.from.id);
}

// `bot` dan `app` di-inject dari master entry. Tidak perlu new Telegraf di sini.
require("./handlers/adminHandler")(bot);
require("./handlers/historyHandler")(bot);
const PPOB_GROUP_IDS = String(process.env.PPOB_GROUP_IDS || process.env.PPOB_GROUP_ID || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean)
  .map(s => Number(s))
  .filter(n => Number.isFinite(n));

async function safeSendMessage(chatId, text, extra = {}) {
  try {
    return await bot.telegram.sendMessage(chatId, text, extra);
  } catch (e) {
    // fallback kalau Markdown error
    if ((extra?.parse_mode || "").toLowerCase().includes("markdown")) {
      try {
        const { parse_mode, ...rest } = extra || {};
        return await bot.telegram.sendMessage(chatId, text, rest);
      } catch {}
    }
    console.error("[safeSendMessage] error:", e?.description || e?.message || e);
    return null;
  }
}

async function sendToGroup(text, extra = {}) {
  if (!PPOB_GROUP_IDS.length) return false;

  const payload = {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    ...extra,
  };

  for (const gid of PPOB_GROUP_IDS) {
    await safeSendMessage(gid, text, payload);
  }
  return true;
}

async function getTgUserLabel(userId, mode = "link", usernameHint = "") {
  const uid = Number(userId) || 0;
  if (!uid) return "-";

  try {
    // kalau ada hint username, pakai dulu (lebih enteng, gak perlu getChat)
    let uname = String(usernameHint || "").trim().replace(/^@+/, "");

    let name = "";
    if (uname) {
      name = `@${uname}`;
    } else {
      const c = await bot.telegram.getChat(uid); // ambil username / nama
      name =
        (c?.username && `@${c.username}`) ||
        [c?.first_name, c?.last_name].filter(Boolean).join(" ").trim() ||
        String(uid);
    }

    if (mode === "plain") {
      // plain saja, tanpa link/id
      return String(name || "-");
    }

    // default: clickable mention di grup
    return `[${escapeMd(name)}](tg://user?id=${uid})`;
  } catch (e) {
    // fallback kalau getChat gagal
    if (mode === "plain") return String(uid);
    return `[${uid}](tg://user?id=${uid})`;
  }
}

bot.use(redisSession); 

// (Optional) Info log biar tau sudah jalan
console.log("✅ Menggunakn Redis Session (Custom Middleware)");

// 1. INISIALISASI GLOBAL VARIABLE (Agar terbaca di semua file)
global.MAINTENANCE_MODE = false;
global.MAINTENANCE_MESSAGE = "🔧 Bot sedang dalam perbaikan, mohon bersabar ya!\nKami akan segera kembali.";

const MAINT_THROTTLE_MS = 15_000; // Anti spam notif maintenance

function isAdminId(userId) {
  return ADMIN_IDS.includes(Number(userId || 0));
}

function maintenanceText() {
  return `🛠 *MAINTENANCE*\n\n${global.MAINTENANCE_MESSAGE}`;
}

// 2. MIDDLEWARE MAINTENANCE (MANUAL + AUTO JAM 23:30-00:30 WIB)
bot.use(async (ctx, next) => {
  const uid = Number(ctx.from?.id || 0);
  
  // Jika tidak ada ID user, skip
  if (!uid) return next();

  if (isAdminId(uid)) return next();
  const isManual = global.MAINTENANCE_MODE;

  // Logika Waktu UTC (23:30 - 00:30 WIB)
  const now = new Date();
  const h = now.getUTCHours();   
  const m = now.getUTCMinutes(); 
  const isAuto = (h === 16 && m >= 30) || (h === 17 && m < 30);

  // Jika SALAH SATU aktif (Manual ATAU Auto), blokir akses
  if (isManual || isAuto) {
    
    // Tentukan pesan
    let pesan = "🔧 Maaf, bot sedang maintenance perbaikan server.";
    if (isAuto && !isManual) {
        pesan = "⚠️  Sedang Maintenance (23:30 - 00:30 WIB)";
    }

    const isGroup = ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';

    // SKENARIO A: User KLIK TOMBOL (Di PC maupun Grup)
    if (ctx.updateType === 'callback_query') {
      // Kasih tau lewat pop-up (Alert) biar gak nyampah chat
      return ctx.answerCbQuery(pesan, { show_alert: true }).catch(() => {});
    }

    // SKENARIO B: User CHAT BIASA
    if (isGroup) {
        return; 
    }

    const nowMs = Date.now();
    const last = Number(ctx.session?._maint_last_notice || 0);
    if (nowMs - last < 15000) return; // Throttle 15 detik
    
    ctx.session._maint_last_notice = nowMs;
    return ctx.reply(pesan).catch(() => {});
  }

  return next();
});

function displayDepositId(id) {
  return `DEP-${id}`;
}

const LOG_SIMPLE = true;
function logSimple(type, msg) {
  if (!LOG_SIMPLE) return;
  log("DEBUG", `[${type}]`, msg);
}

bot.use((ctx, next) => {
  if (!LOG_SIMPLE) return next();

  const txt = (ctx.message?.text || "").trim();

  // ✅ hanya log saat /start atau /menu
  if (txt) {
    const isStart = txt === "/start" || txt.startsWith("/start ");
    const isMenu  = txt === "/menu"  || txt.startsWith("/menu ");
    if (isStart || isMenu) {
      const uid = ctx.from?.id;
      const uname = ctx.from?.username ? `@${ctx.from.username}` : "-";
      logSimple("START", `uid=${uid} user=${uname} text="${txt}"`);
    }
  }

  // ❌ tidak log callbackQuery sama sekali (biar tidak spam)
  return next();
});

bot.catch((err, ctx) => {
  console.error("❌  BOT ERROR:", err);
});

// ======================
// HELPER
// ======================
async function editOrReplace(ctx, text, extra) {
  try {
    return await ctx.editMessageText(text, extra);
  } catch (e) {
    const msg = (e?.description || "").toLowerCase();
    if (msg.includes("message is not modified")) {
      return ctx.answerCbQuery().catch(() => {});
    }
    // jangan delete message, cukup reply baru
    return ctx.reply(text, extra).catch(() => {});
  }
}

async function fastLoading(ctx, text = "⏳ Memuat...") {
  // 1) hilangkan spinner di telegram
  await ctx.answerCbQuery().catch(() => {});
  // 2) ubah UI secepatnya
  await editOrReplace(ctx, text, { parse_mode: "Markdown" });
}

async function getTotalUsers() {
  const row = await get(`SELECT COUNT(*) as c FROM users`);
  return Number(row?.c || 0);
}

async function getTotalTransactions() {
  const row = await get(`SELECT COUNT(*) as c FROM orders WHERE status = 'SUCCESS'`);
  return Number(row?.c || 0);
}

const LISTPRODUK_PAGE_SIZE = 12;

// kategori urut sesuai addproduk (MIN(rowid))
async function lpListCategories() {
  return all(
    `
    SELECT category, COUNT(*) AS cnt
    FROM products
    WHERE active=1
    GROUP BY category
    ORDER BY MIN(rowid) ASC
    `
  );
}

// brand urut sesuai addproduk (MIN(rowid))
async function lpListBrands(category) {
  return all(
    `
    SELECT brand, COUNT(*) AS cnt
    FROM products
    WHERE active=1 AND category=?
      AND TRIM(COALESCE(brand,'')) <> ''
    GROUP BY brand
    ORDER BY MIN(rowid) ASC
    `,
    [category]
  );
}

async function lpCountProducts({ category, brand, q, includeInactive }) {
  let sql = `SELECT COUNT(*) AS n FROM products WHERE 1=1`;
  const params = [];

  if (!includeInactive) sql += ` AND active=1`;
  if (category) { sql += ` AND category=?`; params.push(category); }
  if (brand) { sql += ` AND brand=?`; params.push(brand); }
  if (q) {
    sql += ` AND (sku LIKE ? OR name LIKE ?)`;
    params.push(`%${q}%`, `%${q}%`);
  }

  const r = await get(sql, params);
  return Number(r?.n || 0);
}

async function lpFetchProducts({ category, brand, page, q, includeInactive }) {
  const offset = Math.max(0, page) * LISTPRODUK_PAGE_SIZE;

  let sql =
    `SELECT sku, name, category, brand, subcat, sell_price, active
     FROM products
     WHERE 1=1`;
  const params = [];

  if (!includeInactive) sql += ` AND active=1`;
  if (category) { sql += ` AND category=?`; params.push(category); }
  if (brand) { sql += ` AND brand=?`; params.push(brand); }
  if (q) {
    sql += ` AND (sku LIKE ? OR name LIKE ?)`;
    params.push(`%${q}%`, `%${q}%`);
  }

  // urutan sesuai addproduk (insert order)
  sql += ` ORDER BY sell_price ASC LIMIT ? OFFSET ?`;
  params.push(LISTPRODUK_PAGE_SIZE, offset);

  return all(sql, params);
}

function lpKbCategories(rows) {
  const buttons = rows.map((r) => {
    const label = `${safeLabel(r.category)} (${r.cnt})`;
    const tok = b64uEncode(r.category);
    return Markup.button.callback(label, `lp_cat:${tok}`);
  });
  const keyboard = chunk(buttons, 2);
  keyboard.push([Markup.button.callback("❌ Tutup", "lp_close")]);
  return Markup.inlineKeyboard(keyboard);
}

function lpKbBrands(category, rows) {
  const catTok = b64uEncode(category);
  const buttons = rows.map((r) => {
    const label = `${safeLabel(r.brand)} (${r.cnt})`;
    const bTok = b64uEncode(r.brand);
    return Markup.button.callback(label, `lp_brand:${catTok}:${bTok}`);
  });
  const keyboard = chunk(buttons, 2);
  keyboard.push([Markup.button.callback("⬅️ Kembali", "lp_back_cats")]);
  return Markup.inlineKeyboard(keyboard);
}

function lpKbProducts({ category, brand, page, totalPages }) {
  const catTok = b64uEncode(category);
  const bTok = b64uEncode(brand);

  const navRow = [];
  if (page > 0) navRow.push(Markup.button.callback("⬅️ Prev", `lp_list:${catTok}:${bTok}:${page - 1}`));
  if (page + 1 < totalPages) navRow.push(Markup.button.callback("Next ➡️", `lp_list:${catTok}:${bTok}:${page + 1}`));

  const rows = [];
  if (navRow.length) rows.push(navRow);
  rows.push([Markup.button.callback("⬅️ Kembali", `lp_cat:${catTok}`)]);
  rows.push([Markup.button.callback("❌ Tutup", "lp_close")]);
  return Markup.inlineKeyboard(rows);
}

async function kbBrand(category) {
  const brands = await listBrands(category);

  if (!brands.length) {
    return Markup.inlineKeyboard([[Markup.button.callback("⬅️ Kembali", "go_ppob")]]);
  }

  const buttons = brands.map((b) =>
    Markup.button.callback(b.brand, `brand:${category}:${b.brand}`)
  );

  const COLS = 2; // ubah ke 3 kalau mau 3 tombol per baris
  const rows = chunk(buttons, COLS);

  rows.push([Markup.button.callback("⬅️ Kembali", "go_ppob")]);
  return Markup.inlineKeyboard(rows);
}

// KEYBOARD: SUBCATEGORY
async function kbSubcat(category, brand) {
  const subs = await listSubcats(category, brand);

  if (!subs.length) {
    // Tidak ada subkategori -> tampilkan tombol untuk melihat produk (ALL)
    return Markup.inlineKeyboard([
      [Markup.button.callback("📦 Lihat Produk", `sub:${category}:${brand}:ALL:0`)],
      [
        Markup.button.callback("⬅️ Kembali", `cat:${category}`),
        Markup.button.callback("🏠 Menu Utama", `go_ppob`),
      ],
    ]);
  }

  const buttons = subs.map((s) => {
    const label = safeLabel(s.subcat);
    const token = b64uEncode(s.subcat);
    return Markup.button.callback(label, `sub:${category}:${brand}:${token}:0`);
  });

  const COLS = 2; // ubah ke 3 kalau mau
  const rows = chunk(buttons, COLS);

  // tombol back + menu utama sejajar
  rows.push([
    Markup.button.callback("⬅️ Kembali", `cat:${category}`),
    Markup.button.callback("🏠 Menu Utama", `go_ppob`),
  ]);

  return Markup.inlineKeyboard(rows);
}

async function kbProduct(category, brand, subcat, page) {
  const total = await countProducts(category, brand, subcat);
  const items = await listProducts(category, brand, subcat, page);

  const rows = items.map((p) => [
    Markup.button.callback(
      `${statusIcon(p.status)} ${safeLabel(p.name)} • ${formatRupiah(p.sell_price)}`,
      `sku:${p.sku}`
    ),
  ]);

  // navigasi prev/next
  const nav = [];
  if (page > 0) {
    nav.push(
      Markup.button.callback(
        "⬅️ Prev",
        `sub:${category}:${brand}:${subcat === "ALL" ? "ALL" : b64uEncode(subcat)}:${page - 1}`
      )
    );
  }
  if ((page + 1) * PAGE_SIZE < total) {
    nav.push(
      Markup.button.callback(
        "Next ➡️",
        `sub:${category}:${brand}:${subcat === "ALL" ? "ALL" : b64uEncode(subcat)}:${page + 1}`
      )
    );
  }
  if (nav.length) rows.push(nav);

  // back ke subcat list + menu utama sejajar
  rows.push([
    Markup.button.callback("⬅️ Kembali", `brand:${category}:${brand}`),
    Markup.button.callback("🏠 Menu Utama", `go_ppob`),
  ]);

  return Markup.inlineKeyboard(rows);
}

const PRODUCT_PICK_PAGE_SIZE = 7;

async function listProductsPaged(category, brand, subcat, page = 0, limit = PRODUCT_PICK_PAGE_SIZE) {
  const p = Number(page) || 0;
  const lim = Number(limit) || PRODUCT_PICK_PAGE_SIZE;
  const cacheKey = `listPaged:${category}:${brand}:${subcat || 'ALL'}:${p}:${lim}`;

  return getOrSetCache(cacheKey, async () => {
    const offset = p * lim;
    const params = (subcat && subcat !== "ALL")
        ? [category, brand, subcat, lim, offset]
        : [category, brand, lim, offset];

    const sql = `
      SELECT sku, name, sell_price, COALESCE(status,'normal') AS status
      FROM products
      WHERE active=1 AND category=? AND brand=?
        ${(subcat && subcat !== "ALL") ? "AND COALESCE(subcat,'')=?" : ""}
      ORDER BY sell_price ASC
      LIMIT ? OFFSET ?
    `;

    return all(sql, params);
  });
}

function kbProductPickInline({ countOnPage, hasPrev, hasNext, category, brand, subcat, page }) {
  const rows = [];

  const startNum = (page * PRODUCT_PICK_PAGE_SIZE) + 1;

  const numBtns = Array.from({ length: countOnPage }, (_, i) =>
    Markup.button.callback(String(startNum + i), `pick:${i + 1}`)
  );

  if (numBtns.length) rows.push(numBtns);

  const navRow = [];
  if (hasPrev) navRow.push(Markup.button.callback("⬅️ Prev", "pick_prev"));
  if (hasNext) navRow.push(Markup.button.callback("Next ➡️", "pick_next"));
  if (navRow.length) rows.push(navRow);

rows.push([
    Markup.button.callback("⬅️ Kembali", "pick_back"),
    Markup.button.callback("🏠 Menu Utama", "go_ppob")
  ]);
  
  return Markup.inlineKeyboard(rows);
}

async function sendProductPickMenu(ctx, { category, brand, subcat, page }) {
  const limit = PRODUCT_PICK_PAGE_SIZE; // Biasanya bernilai 6
  const total = await countProducts(category, brand, subcat);
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);

  const items = await listProductsPaged(category, brand, subcat, safePage, limit);

  const titleSub = subcat === "ALL" ? "Semua" : subcat;

  const header =
    `━━━━━━━━━━━━━━━━━━\n` +
    `<b>${escapeHtml(category)} - ${escapeHtml(brand)}</b>\n` +
    `<b>Kategori: ${escapeHtml(titleSub)}</b>\n` +
    `━━━━━━━━━━━━━━━━━━\n`;

  const lines = items.map((p, i) => {
    const nm = escapeHtml(p.name);
    const price = escapeHtml(formatRupiah(p.sell_price));
    const icon = statusIcon(p.status);

    const nomorKontinu = (safePage * limit) + i + 1;

    return `<blockquote><b>${nomorKontinu}. ${icon} ${nm}</b>\n<b>💰 Harga:</b> ${price}</blockquote>`;
  });

  const footer = `\n\nKlik nomor sesuai Produk yang\ningin di beli:`;
  const text = header + (lines.length ? lines.join("\n") : "📭 Produk kosong.") + footer;

  ctx.session.productPick = {
    mode: "PRODUCT_PICK",
    category,
    brand,
    subcat,
    page: safePage,
    totalPages,
    items // Berisi daftar produk di halaman ini
  };

  const kb = kbProductPickInline({
    countOnPage: items.length,
    hasPrev: safePage > 0,
    hasNext: safePage + 1 < totalPages,
    category,
    brand,
    subcat,
    page: safePage
  });

  const extra = { parse_mode: "HTML", reply_markup: kb.reply_markup };

  // 3. Kirim atau edit pesan
  if (ctx.updateType === "callback_query") {
    return editOrReplace(ctx, text, extra);
  }
  return ctx.reply(text, extra);
}

// Reuse flow beli dari SKU (dipanggil dari inline sku: dan dari pilihan angka)
async function startBuyBySku(ctx, sku, { fromReplyPick = false } = {}) {
  const p = await getProduct(sku);

  if (!p || !p.active) {
    return ctx.reply("❌ Produk tidak ditemukan atau sedang nonaktif.");
  }

  if (String(p.status || "").toLowerCase() === "gangguan") {
    return ctx.reply(
      "🔴 <b>Produk sedang gangguan dari pusat.</b>\n" +
      "Silakan pilih produk lain atau coba lagi nanti.",
      { parse_mode: "HTML" }
    );
  }

  // kalau berasal dari reply keyboard, hapus keyboard dulu biar input target nyaman
  if (fromReplyPick) {
    await ctx.reply(" ", Markup.removeKeyboard()).catch(() => {});
  }

// 🔹 DESKRIPSI (quote HTML, tanpa <br>)
let descBlock = "";
if (p.description && p.description.trim()) {
  const desc = p.description.trim();

  if (desc.includes(",")) {
    // Jika deskripsi dipisah koma, buat jadi list bullet
    const items = desc.split(",").map(i => i.trim()).filter(Boolean);
    const quoted = items.map(i => `• ${escapeHtml(i)}`).join("\n");
    
    // PERUBAHAN DI SINI: Judul masuk ke dalam blockquote
    descBlock = `\n\n<blockquote><b>📝 Deskripsi:</b>\n${quoted}</blockquote>`;
    
  } else {
    // Jika deskripsi biasa
    // PERUBAHAN DI SINI: Judul masuk ke dalam blockquote
    descBlock = `\n\n<blockquote><b>📝 Deskripsi:</b>\n${escapeHtml(desc)}</blockquote>`;
  }
}

const fav = await isFavorite(ctx.from.id, p.sku).catch(() => false);

const keyboard = Markup.inlineKeyboard([
  [
    Markup.button.callback("⬅️ Kembali", "buy_back_pick"),
    Markup.button.callback(fav ? "⭐ Hapus Favorit" : "⭐ Simpan Favorit", `fav_toggle:${p.sku}`)
  ]
]);

ctx.session._lastProductPick =
ctx.session.productPick || ctx.session._lastProductPick || null;

const text =
  "<b>────────────────────</b>\n" +
  "ㅤ       📄 <b>Detail Produk!</b>\n" +
  "<b>────────────────────</b>\n" +
  `<code>Produk : ${statusIcon(p.status)} ${escapeHtml(p.name)}</code>\n` +
  `<code>SKU    :</code> <code>${escapeHtml(p.sku)}</code>\n` +
  `<code>Harga  : ${escapeHtml(formatRupiah(p.sell_price))}</code>` +
  descBlock +
  "\n\n<b>Silahkan Kirim Nomor Tujuan:</b>\n" +
  "📖 <a href=\"https://t.me/chnlxyz/95\">Panduan isi tujuan</a>\n" +
  "────────────────────";
  
const msg = await editOrReplace(ctx, text, {
  parse_mode: "HTML",
  reply_markup: keyboard.reply_markup,
  disable_web_page_preview: true
});

// Simpan ID-nya ke session (agar bisa dihapus nanti)
ctx.session.buy = {
  step: "WAIT_TARGET",
  sku: p.sku,
  lastMsgId: msg?.message_id 
};

return; 
}

// SCREENS
async function sendStartMenu(ctx, edit = false) {
  // 1. Hapus pesan ketikan '/start' atau '/menu' dari user biar chat bersih
  if (ctx.updateType === "message") {
    await ctx.deleteMessage().catch(() => {});
  }

  await removeReplyKeyboard(ctx);
  // Global info
  const totalUsers = await getTotalUsers();
  const totalTrx = await getTotalTransactions();
  const uptime = formatUptime(Date.now() - BOT_START_TIME);
  const now = new Date();
  const hours = now.getHours();
  const greeting = hours < 12 ? "Selamat pagi" : hours < 18 ? "Selamat siang" : "Selamat malam";
  const username = ctx.from?.username ? `@${ctx.from.username}` : "kak";
  const tanggal = now.toLocaleDateString("id-ID", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const jam = now.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });

const infoBlock =
  "ℹ️ <b>Statistik Bot!</b>\n" +
  `➥ Total users: <b>${totalUsers}</b>\n` +
  `➥ Transaksi global: <b>${totalTrx}</b>\n` +
  `➥ Bot Uptime: <b>${uptime}</b>\n` +
  '➥ Log Transaksi <a href="https://t.me/xyzgrub/1">@xyzgrub</a>\n\n';

const text =
  `<b>${greeting}, ${username}</b>\n` +
  `${tanggal} | ${jam}\n\n` +
  infoBlock +
  `Silahkan klik <b>Menu utama</b> di bawah!`;

const extra = { parse_mode: "HTML", ...kbStartMenu() };

  // Kalau dari callback dan message sebelumnya foto → edit CAPTION
  if (edit && ctx.updateType === "callback_query") {
    try {
      await ctx.editMessageCaption(text, extra);
      return;
    } catch {
      // fallback: kalau gagal edit caption
    }
  }

  const chatId = ctx.chat?.id || ctx.from?.id;

  // 2. Hapus pesan welcome LAMA jika ada di session biar ga numpuk
  if (ctx.session?.start_msg_id && chatId) {
    await ctx.telegram.deleteMessage(chatId, ctx.session.start_msg_id).catch(() => {});
  }

  // 3. Kirim gambar welcome + caption BARU
  const sentMsg = await ctx.replyWithPhoto(WELCOME_IMAGE_URL, {
    caption: text,
    parse_mode: "HTML",
    ...kbStartMenu(),
  });

  // 4. Simpan ID pesan baru ini ke memori (session) untuk dihapus nanti
  if (ctx.session && sentMsg?.message_id) {
    ctx.session.start_msg_id = sentMsg.message_id;
  }

  return sentMsg;
}

async function sendPpobHome(ctx, edit = false) {
  // 1. Hapus pesan '/menu' dari user biar chat bersih
  if (ctx.updateType === "message") {
    await ctx.deleteMessage().catch(() => {});
  }

  ctx.session.buy = null;

  if (ctx.updateType !== "callback_query") {
    await removeReplyKeyboard(ctx);
  }

  await ensureUser(ctx.from.id);
  const userId = ctx.from.id;
  const saldo = await getUserSaldo(userId);
  const username =
    ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name || "-";

  // Ambil ringkasan transaksi
  const trx = await get(
    `
    SELECT
      SUM(CASE WHEN status='SUCCESS' THEN 1 ELSE 0 END) AS total_success,
      SUM(CASE WHEN status='SUCCESS'
        AND created_at >= datetime('now','weekday 1','-7 days')
      THEN 1 ELSE 0 END) AS week_success,
      SUM(CASE WHEN status='SUCCESS'
        AND created_at >= datetime('now','start of month')
      THEN 1 ELSE 0 END) AS month_success
    FROM orders
    WHERE user_id = ?
    `,
    [userId]
  );

  const trxWeek = Number(trx?.week_success || 0);
  const trxMonth = Number(trx?.month_success || 0);
  const trxTotal = Number(trx?.total_success || 0);

const text =
  "╭───────────────────╮\n" +
  "ㅤ  ㅤ  <b>Menu Utama - BotPPOB</b>\n" +
  "╰───────────────────╯\n" +
  "╭─── <b>RINGKASAN AKUN</b>\n" +
  `│ 👤 Username: <b>${escapeHtml(username)}</b>\n` +
  `│ 🆔 User ID: <code>${escapeHtml(String(userId))}</code>\n` +
  `│ 💰 Saldo: <b>${escapeHtml(formatRupiah(saldo))}</b>\n` +
  "╰───────────────────\n" +
  "╭─── <b>STATISTIK ANDA</b>\n" +
  `│ 📆 Minggu ini: <b>${escapeHtml(String(trxWeek))}</b>\n` +
  `│ 🗓️ Bulan ini: <b>${escapeHtml(String(trxMonth))}</b>\n` +
  `│ 🧾 Total Transaksi: <b>${escapeHtml(String(trxTotal))}</b>\n` +
  "╰───────────────────\n\n" +
  "<b>Pilih Opsi Layanan:</b>";
  const extra = { parse_mode: "HTML", ...kbPpobMenu() };
  const chatId = ctx.chat?.id || ctx.from?.id;

  // ====== 1) Kalau ditekan dari tombol inline (Callback) ======
  if (edit && ctx.updateType === "callback_query") {
    const msg = ctx.callbackQuery?.message;
    const isPhotoMessage =
      !!msg?.photo?.length || !!msg?.video || !!msg?.animation || !!msg?.document || !!msg?.sticker;

    // Kalau sebelumnya gambar (seperti menu /start), hapus gambarnya lalu kirim teks baru
    if (isPhotoMessage) {
      try { await ctx.deleteMessage(msg.message_id); } catch (_) {}
      const sent = await ctx.reply(text, extra);
      if (sent?.message_id) ctx.session.ppob_home_msg_id = sent.message_id;
      return sent;
    }

    const mid = msg?.message_id;
    if (mid) ctx.session.ppob_home_msg_id = mid;

    try {
      // Edit pesannya agar smooth
      return await ctx.editMessageText(text, extra);
    } catch (e) {
      // Kalau gagal edit, lanjut ke proses kirim baru di bawah
    }
  }

  // ====== 2) Kalau diketik manual /menu ======
  // Hapus pesan menu utama yang LAMA biar ga nyampah
  if (ctx.session?.ppob_home_msg_id && chatId) {
    await ctx.telegram.deleteMessage(chatId, ctx.session.ppob_home_msg_id).catch(() => {});
  }

  // ====== 3) Kirim menu BARU ke posisi paling bawah ======
  const sent = await ctx.reply(text, extra);
  if (sent?.message_id) ctx.session.ppob_home_msg_id = sent.message_id;
  return sent;
}

const DB_RETENTION_DEPOSITS_DAYS = 120; // PAID/EXPIRED lebih lama dari ini dihapus
const DB_RETENTION_ORDERS_DAYS = 90;   // SUCCESS/FAILED lebih lama dari ini dihapus
const DB_RETENTION_DRAFT_DAYS = 14;     // DRAFT yang ditinggalin

let __lastVacuumYMD = null;

async function pruneDatabase() {
  try {
    // Bersihin deposits lama (PAID/EXPIRED)
    await run(
      `DELETE FROM deposits
       WHERE status IN ('PAID','EXPIRED')
         AND created_at < datetime('now', ?)`,
      ["-" + Number(DB_RETENTION_DEPOSITS_DAYS) + " day"]
    );

    // Bersihin orders lama (SUCCESS/FAILED)
    await run(
      `DELETE FROM orders
       WHERE status IN ('SUCCESS','FAILED')
         AND created_at < datetime('now', ?)`,
      ["-" + Number(DB_RETENTION_ORDERS_DAYS) + " day"]
    );

    // Bersihin order DRAFT yang ditinggal
    await run(
      `DELETE FROM orders
       WHERE status='DRAFT'
         AND created_at < datetime('now', ?)`,
      ["-" + Number(DB_RETENTION_DRAFT_DAYS) + " day"]
    );


    // ✅ setelah delete, rapihin WAL (lebih ringan dari VACUUM)
    try {
      await run("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch (e) {
      console.log("[DB] checkpoint warn:", e?.message || e);
    }

    // VACUUM seminggu sekali (jalan off-peak). Ini bisa makan waktu & lock sebentar.
    const now = new Date();
    const ymd = now.toISOString().slice(0, 10);
    const day = now.getUTCDay(); // 0 Minggu
    if (day === 0 && __lastVacuumYMD !== ymd) {
      __lastVacuumYMD = ymd;
      try { await run("VACUUM"); } catch (e) { console.log("[DB] VACUUM warn:", e?.message || e); }
    }
  } catch (e) {
    console.log("[DB] pruneDatabase error:", e?.message || e);
  }
}

// ======================
// START
// ======================
// /start, /panel, /menu di-handle oleh master entry (index.js)
// supaya tidak bentrok dengan modul VPN. Master akan memanggil
// sendPpobHome(ctx) saat user memilih menu PPOB di picker.

bot.command("sync", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const force = /\bforce\b/i.test(ctx.message?.text || "");
  const wait = await ctx.reply("🔄 Sinkronisasi manual Digiflazz... Mohon tunggu.");
  try {
    const { runSync } = require("./sync");
    // isAuto = false karena ini sync manual dari admin
    const r = await runSync({ silent: true, force, isAuto: false }); 
    
    if (!r.ok) {
      const prefix = r.cooldown ? "⏱️" : "❌";
      const tip = r.cooldown ? "\n\nKetik */sync force* untuk memaksa." : "";
      return ctx.telegram.editMessageText(wait.chat.id, wait.message_id, undefined, `${prefix} Sync gagal:\n${r.error || "unknown"}${tip}`, { parse_mode: "Markdown" });
    }
    
    clearProductCache();
    
    await ctx.telegram.editMessageText(
      wait.chat.id, wait.message_id, undefined,
      `✅ *SYNC MANUAL SELESAI*\n` +
      `• Diupdate      : *${r.masuk}*\n` +
      `🟢 Normal       : *${r.normal}*\n` +
      `🔴 Gangguan     : *${r.gangguan}*\n` +
      `🔄 Harga Berubah: *${r.hargaUpdate || 0}*`,
      { parse_mode: "Markdown" }
    );

    // NOTIFIKASI KHUSUS JIKA ADA PRODUK BARU DITEMUKAN
    if (r.newProducts && r.newProducts.length > 0) {
      let msgNew = `📦 *DITEMUKAN ${r.newProducts.length} PRODUK BARU!*\n\n`;
      msgNew += `Produk telah disembunyikan dan masuk ke subkategori "Produk Baru".\n\n`;
      
      // Tampilkan maksimal 10 biar chat ngga kepanjangan
      r.newProducts.slice(0, 10).forEach(p => {
        msgNew += `• \`${p.sku}\`\n  ${p.name}\n  Ketik: \`/setsubkat ${p.sku}|SubkategoriBaru\`\n\n`;
      });
      
      if (r.newProducts.length > 10) msgNew += `...dan ${r.newProducts.length - 10} lainnya.\n\n`;
      
      msgNew += `💡 *Tips:* Jika ada banyak produk baru dalam 1 Provider yg sama, Anda bisa langsung mindahin massal pakai:\n\`/editsubkat Produk Baru|SubkategoriBaru|NamaProvider\``;
      
      await ctx.reply(msgNew, { parse_mode: "Markdown" });
    }

  } catch (e) {
    return ctx.telegram.editMessageText(wait.chat.id, wait.message_id, undefined, `❌ Sync error: ${e.message}`);
  }
});

bot.action("back_start", async (ctx) => {
  await ctx.answerCbQuery().catch(()=>{});
  return sendStartMenu(ctx, true);
});

// pilih BotPPOB
bot.action("go_ppob", async (ctx) => {
  await ctx.answerCbQuery().catch(()=>{});
  return sendPpobHome(ctx, true);
});

const { exec } = require("child_process");

// HELPER: edit kalau bisa, fallback reply
async function editOrReply(ctx, text, extra = {}) {
  try {
    if (ctx?.updateType === "callback_query") {
      return await ctx.editMessageText(text, extra);
    }
  } catch (e) {}
  return ctx.reply(text, extra);
}

async function renderFavoritesMenu(ctx, userId) {
  const favs = await listFavorites(userId).catch(() => []);
  if (!favs || favs.length === 0) {
    const text =
      `⭐  *Favorit*\n\n` +
      `Kamu belum punya produk favorit.\n\n` +
      `Tips: buka produk → klik *Simpan Favorit*.`;
    return editOrReply(ctx, text, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([[Markup.button.callback("⬅️ Kembali", "go_ppob")]])
    });
  }

  const lines = favs.slice(0, 20).map((f, i) => {
    const price = f.sell_price != null ? ` (${formatRupiah(f.sell_price)})` : "";
    return `${i + 1}. *${f.title}*${price}`;
  });

  const rows = favs.slice(0, 20).map((f) => ([
    Markup.button.callback(`🛒 ${String(f.title).slice(0, 18)}`, `fav_pick:${f.sku}`),
    Markup.button.callback("🗑️", `fav_del:${f.sku}`)
  ]));
  rows.push([Markup.button.callback("⬅️ Kembali", "go_ppob")]);

  return editOrReply(ctx, `⭐  *Favorit*\n\n${lines.join("\n")}`, {
    parse_mode: "Markdown",
    reply_markup: Markup.inlineKeyboard(rows).reply_markup
  });
}

bot.action("fav_menu", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from.id;
  return renderFavoritesMenu(ctx, userId);
});

bot.action(/^fav_pick:(.+)$/i, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const sku = ctx.match[1];
  await ctx.deleteMessage().catch(() => {});
  return startBuyBySku(ctx, sku, { fromReplyPick: false });
});

bot.action(/^fav_del:(.+)$/i, async (ctx) => {
  // ✅ jawab dulu biar Telegram gak loading kelamaan
  await ctx.answerCbQuery("⏳ Menghapus...", { show_alert: false }).catch(() => {});
  const userId = ctx.from.id;
  const sku = ctx.match[1];

  // hapus favorit (abaikan error) - FIX TYPO
  await removeFavorite(userId, sku).catch(() => {});

  // toast kecil
  await ctx.answerCbQuery("✅ Favorit dihapus", { show_alert: false }).catch(() => {});

  // render ulang list favorit (edit/reply otomatis via helper)
  return renderFavoritesMenu(ctx, userId);
});

bot.action(/^fav_toggle:(.+)$/i, async (ctx) => {
  const userId = ctx.from.id;
  const sku = ctx.match[1];

  try {
    const nowFav = await isFavorite(userId, sku).catch(() => false);

    if (nowFav) {
      await removeFavorite(userId, sku).catch(() => {});
      await ctx.answerCbQuery("✅ Dihapus dari favorit", { show_alert: false }).catch(() => {});
    } else {
      await addFavorite(userId, sku, "").catch(() => {});
      await ctx.answerCbQuery("✅ Disimpan ke favorit", { show_alert: false }).catch(() => {});
    }

    // 🔄 update tombol di pesan produk yang sedang dibuka (kalau ada)
    // Ambil produk + rebuild keyboard yg sama seperti di startBuyBySku
    const p = await getProduct(sku).catch(() => null);
    if (!p) return;

    const favAfter = !nowFav;
    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback(
          favAfter ? "⭐ Hapus Favorit" : "⭐ Simpan Favorit",
          `fav_toggle:${p.sku}`
        ),
        Markup.button.callback("⬅️ Kembali", "buy_back_pick"),
      ],
    ]);

    // coba edit reply_markup saja (lebih ringan daripada edit text)
    return ctx.telegram
      .editMessageReplyMarkup(
        ctx.chat.id,
        ctx.callbackQuery.message.message_id,
        undefined,
        keyboard.reply_markup
      )
      .catch(() => {});
  } catch (e) {
    // kalau ada error, minimal balas callback biar gak loading terus
    await ctx.answerCbQuery("⚠️ Gagal memproses favorit", { show_alert: false }).catch(() => {});
  }
});

bot.action("menu_topup", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  // set step agar user bisa langsung ketik nominal manual kapanpun
  ctx.session.step = "input_topup_nominal";

  const text =
    "💰 *TOP UP SALDO*\n\n" +
    "Pilih nominal cepat di bawah, atau ketik nominal sendiri.\n" +
    "Minimal: *Rp 1.000*\n" +
    "Contoh: `10000`";

  return editOrReplace(ctx, text, {
    parse_mode: "Markdown",
    ...kbQuickTopup(),
  });
});

// klik "Nominal Lain" → tetap manual input
bot.action("topup_manual", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  ctx.session.step = "input_topup_nominal";

  return editOrReplace(
    ctx,
    "💰 *TOP UP SALDO*\n\nKirim nominal top up.\nMinimal: *Rp 1.000*\nContoh: `10000` ",
    { 
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([[Markup.button.callback("❌ Batal", "cancel_topup")]]) // Tambahkan keyboard ini
    }
  );
});

// tombol nominal cepat
bot.action(/^topup_amt:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const nominal = Number(ctx.match?.[1] || 0);

  // kalau masuk topup, matikan flow lain biar tidak nyasar
  if (ctx.session?.kuota) ctx.session.kuota = null;

  // anti salah input
  if (!nominal) {
    ctx.session.step = "input_topup_nominal";
    return editOrReplace(ctx, "❌ Nominal tidak valid. Coba lagi.", { parse_mode: "Markdown" });
  }
// tampilkan loading (edit kalau bisa)
  await editOrReplace(
    ctx,
    `⏳ Membuat QRIS untuk *${formatRupiah(nominal)}* ...`,
    { parse_mode: "Markdown" }
  );
return handleTopupNominal(ctx, nominal);
});

bot.action("cek_kuota", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  ctx.session.kuota = { step: "WAIT_MSISDN" };

  // Menggunakan editOrReplace agar tidak membuat pesan baru (chat tidak numpuk)
  return editOrReplace(
    ctx,
    "📱 <b>Cek Kuota XL / AXIS / INDOSAT</b>\n\nKirim nomor HP Anda\n(contoh: <code>0878xxxx</code> atau <code>0857xxxx</code>).",
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("⬅️ Kembali", "cancel_any")],
      ]),
    }
  );
});

bot.action("cancel_any", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  // hapus session flow cek kuota
  if (ctx.session?.kuota) ctx.session.kuota = null;
  if (ctx.session?.step === "cek_kuota") {
      ctx.session.step = null;
  }

  // balik ke menu PPOB
  return sendPpobHome(ctx, true);
});

bot.action(/^cat:(.+)$/i, async (ctx) => {
  const category = ctx.match[1];

  // 🔥 1. Stop loading spinner (Fire & Forget, gak usah ditunggu)
  ctx.answerCbQuery().catch(() => {}); 

  // ✅ Langsung gas ambil data (Cepat karena Cache)
  const text = 
          `━━━━━━━━━━━━━━━━━━\n` +
          `Kategori: *${category}*\n` +
          `Silahkan Pilih Provider:\n` +
          `━━━━━━━━━━━━━━━━━━`;
  
  // Fungsi kbBrand sudah pakai cache, jadi ini instan
  const extra = { parse_mode: "Markdown", ...(await kbBrand(category)) };

  return editOrReplace(ctx, text, extra);
});


bot.action(/^brand:(.+?):(.+)$/i, async (ctx) => {
  const category = ctx.match[1];
  const brand = ctx.match[2];

  // 🔥 1. Stop loading spinner
  ctx.answerCbQuery().catch(() => {});

  // ✅ Langsung gas
  const text = 
        `━━━━━━━━━━━━━━━━━━\n` +
        `*${category} - ${brand}*\n` +
        `Silahkan Pilih Varian:\n` +
        `━━━━━━━━━━━━━━━━━━`;
  const extra = { parse_mode: "Markdown", ...(await kbSubcat(category, brand)) };

  return editOrReplace(ctx, text, extra);
});

bot.action(/^sub:(.+?):(.+?):(.+?):(\d+)$/i, async (ctx) => {
  const category = ctx.match[1];
  const brand = ctx.match[2];
  const token = ctx.match[3];
  const page = parseInt(ctx.match[4], 10) || 0;

  const subcat = token === "ALL" ? "ALL" : b64uDecode(token);

  // 1. Matikan loading spinner di tombol (WAJIB)
  ctx.answerCbQuery().catch(() => {});

  // ❌ HAPUS BARIS INI (Biang kerok efek debu):
  // await ctx.deleteMessage().catch(() => {}); 

  // ✅ LANGSUNG PANGGIL INI
  // Fungsi ini otomatis akan mendeteksi: "Oh ini tombol klik, saya EDIT saja pesannya"
  return sendProductPickMenu(ctx, { category, brand, subcat, page });
});


bot.action(/^pick:(\d+)$/i, async (ctx) => {
  const pick = ctx.session?.productPick;
  
  if (!pick || pick.mode !== "PRODUCT_PICK") {
    return ctx.answerCbQuery("Session kadaluarsa. Ulangi pencarian.", { show_alert: true }).catch(() => {});
  }
  
  const n = parseInt(ctx.match[1], 10);

  if (!Number.isFinite(n) || n < 1 || n > (pick.items?.length || 0)) {
    return ctx.answerCbQuery("Pilihan tidak valid", { show_alert: true }).catch(() => {});
  }

  const chosen = pick.items[n - 1];

  ctx.session._lastProductPick = pick; 
  ctx.session.productPick = null; 

  await ctx.answerCbQuery().catch(() => {});
  await ctx.deleteMessage().catch(() => {});
  
  return startBuyBySku(ctx, chosen.sku, { fromReplyPick: false });
});

bot.action("pick_prev", async (ctx) => {
  const pick = ctx.session?.productPick;
  if (!pick || pick.mode !== "PRODUCT_PICK") return ctx.answerCbQuery().catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  return sendProductPickMenu(ctx, {
    category: pick.category,
    brand: pick.brand,
    subcat: pick.subcat,
    page: pick.page - 1
  });
});

bot.action("pick_next", async (ctx) => {
  const pick = ctx.session?.productPick;
  if (!pick || pick.mode !== "PRODUCT_PICK") return ctx.answerCbQuery().catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  return sendProductPickMenu(ctx, {
    category: pick.category,
    brand: pick.brand,
    subcat: pick.subcat,
    page: pick.page + 1
  });
});

bot.action("pick_back", async (ctx) => {
  const pick = ctx.session?.productPick;
  if (!pick || pick.mode !== "PRODUCT_PICK") return ctx.answerCbQuery().catch(() => {});
  ctx.session.productPick = null;
  await ctx.answerCbQuery().catch(() => {});

const text =
  `━━━━━━━━━━━━━━━━━━\n` +
  `*${escapeMd(pick.category)} - ${escapeMd(pick.brand)}*\n` +
  `Silahkan Pilih varian:\n` +
  `━━━━━━━━━━━━━━━━━━`;

const extra = { parse_mode: "Markdown", ...(await kbSubcat(pick.category, pick.brand)) };
return editOrReplace(ctx, text, extra);
});

// ======================
// LISTPRODUK FILTER (ACTIONS)
// ======================
bot.action("lp_back_cats", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const cats = await lpListCategories();
  if (!cats.length) return editOrReplace(ctx, "📭 Tidak ada produk aktif.", {});
  return editOrReplace(
    ctx,
    "📦 *LIST PRODUK (FILTER)*\n\nPilih *Kategori*:",
    { parse_mode: "Markdown", ...lpKbCategories(cats) }
  );
});

bot.action(/^lp_cat:(.+)$/i, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const cat = b64uDecode(ctx.match[1]);
  const brands = await lpListBrands(cat);
  if (!brands.length) {
    return editOrReplace(
      ctx,
      `📭 Tidak ada brand aktif untuk kategori *${escapeMd(cat)}*.`,
      { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("⬅️ Kembali", "lp_back_cats")]]) }
    );
  }
  return editOrReplace(
    ctx,
    `📦 *LIST PRODUK (FILTER)*\n\nKategori: *${escapeMd(cat)}*\nPilih *Brand*:`,
    { parse_mode: "Markdown", ...lpKbBrands(cat, brands) }
  );
});

bot.action(/^lp_brand:(.+?):(.+)$/i, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const category = b64uDecode(ctx.match[1]);
  const brand = b64uDecode(ctx.match[2]);

  const total = await lpCountProducts({ category, brand, q: null, includeInactive: false });
  if (!total) {
    return editOrReplace(
      ctx,
      `📭 Produk aktif kosong.\nKategori: *${escapeMd(category)}*\nBrand: *${escapeMd(brand)}*`,
      { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("⬅️ Kembali", `lp_cat:${b64uEncode(category)}`)]]) }
    );
  }

  const totalPages = Math.max(1, Math.ceil(total / LISTPRODUK_PAGE_SIZE));
  const page = 0;

  const rows = await lpFetchProducts({ category, brand, page, q: null, includeInactive: false });
  const body = rows.map((p, i) =>
    `${page * LISTPRODUK_PAGE_SIZE + i + 1}) *${escapeMd(p.sku)}*\n` +
    `${escapeMd(p.name)}\n` +
    `Sub: ${escapeMd(p.subcat || "-")}\n` +
    `Harga: *${formatRupiah(p.sell_price)}*`
  ).join("\n\n");

  const text =
    `📦 *DAFTAR PRODUK*\n` +
    `Kategori: *${escapeMd(category)}*\n` +
    `Brand: *${escapeMd(brand)}*\n` +
    `Hal: *${page + 1}/${totalPages}* (total ${total})\n\n` +
    body;

  return editOrReplace(ctx, text, {
    parse_mode: "Markdown",
    ...lpKbProducts({ category, brand, page, totalPages }),
  });
});

bot.action(/^lp_list:(.+?):(.+?):(\d+)$/i, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const category = b64uDecode(ctx.match[1]);
  const brand = b64uDecode(ctx.match[2]);
  const page = Math.max(0, parseInt(ctx.match[3], 10) || 0);

  const total = await lpCountProducts({ category, brand, q: null, includeInactive: false });
  const totalPages = Math.max(1, Math.ceil(total / LISTPRODUK_PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);

  const rows = await lpFetchProducts({ category, brand, page: safePage, q: null, includeInactive: false });
  if (!rows.length) {
    return editOrReplace(
      ctx,
      `📭 Produk aktif kosong.\nKategori: *${escapeMd(category)}*\nBrand: *${escapeMd(brand)}*`,
      { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("⬅️ Kembali", `lp_cat:${b64uEncode(category)}`)]]) }
    );
  }

  const body = rows.map((p, i) =>
    `${safePage * LISTPRODUK_PAGE_SIZE + i + 1}) *${escapeMd(p.sku)}*\n` +
    `${escapeMd(p.name)}\n` +
    `Sub: ${escapeMd(p.subcat || "-")}\n` +
    `Harga: *${formatRupiah(p.sell_price)}*`
  ).join("\n\n");

  const text =
    `📦 *DAFTAR PRODUK*\n` +
    `Kategori: *${escapeMd(category)}*\n` +
    `Brand: *${escapeMd(brand)}*\n` +
    `Hal: *${safePage + 1}/${totalPages}* (total ${total})\n\n` +
    body;

  return editOrReplace(ctx, text, {
    parse_mode: "Markdown",
    ...lpKbProducts({ category, brand, page: safePage, totalPages }),
  });
});

bot.action("lp_close", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await ctx.deleteMessage().catch(() => {});
});
bot.action("last_orders", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  return showHistoryMenu(ctx); // fungsi menu riwayat yang baru
});
bot.action("history_menu", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  return showHistoryMenu(ctx);
});
bot.action("cancel_topup", async (ctx) => {
  // Notifikasi pop-up kecil di atas layar
  await ctx.answerCbQuery("❌ Top Up dibatalkan", { show_alert: false }).catch(() => {});

  // Batalin mode input nominal agar pesan teks biasa tidak dianggap nominal
  if (ctx.session?.step === "input_topup_nominal") {
    ctx.session.step = null;
  }

  return sendPpobHome(ctx, true); // balik ke menu PPOB dengan mode edit
});

// BACK: kembali ke daftar produk terakhir (product picker)
bot.action("buy_back_pick", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (ctx.session?.buy?.step === "WAIT_TARGET") ctx.session.buy = null;

  const pick = ctx.session?.productPick || ctx.session?._lastProductPick;

  if (pick && pick.mode === "PRODUCT_PICK") {
    ctx.session.productPick = pick; // restore kalau hilang
    return sendProductPickMenu(ctx, {
      category: pick.category,
      brand: pick.brand,
      subcat: pick.subcat,
      page: pick.page,
    });
  }

  return sendPpobHome(ctx, true);
});

bot.action("cancel_buy", async (ctx) => {
  await ctx.answerCbQuery("✅ Pembelian dibatalkan!").catch(() => {});

  // Bersihkan session pembelian (ini yang paling penting!)
  ctx.session.buy = null;

  // Edit pesan "Kirim target..." menjadi konfirmasi batal (tampilan lebih smooth)
  await ctx.editMessageText(
    "❌ *Pembelian dibatalkan*\n\nKembali ke menu utama...",
    {
      parse_mode: "Markdown",
      reply_markup: kbPpobMenu().reply_markup
    }
  ).catch(async () => {
    // Fallback kalau edit gagal (pesan sudah dihapus atau terlalu lama)
    await ctx.reply(
      "❌ *Pembelian dibatalkan*\n\nKembali ke menu utama...",
      {
        parse_mode: "Markdown",
        reply_markup: kbPpobMenu().reply_markup
      }
    );
  });
});

// BAYAR LANGSUNG VIA QRIS (tanpa topup saldo)
bot.action("confirm_buy_qris", async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});
    const draft = ctx.session.buy;
    if (!draft || draft.step !== "WAIT_CONFIRM") return;

    await ctx.deleteMessage().catch(() => {});
    ctx.session.buy = null;

    const p = await getProduct(draft.sku);
    if (!p || !p.active) return ctx.reply("❌ Produk tidak tersedia.");

    const userId = ctx.from.id;
    const username = ctx.from.username ? `@${ctx.from.username}` : "";
    const ref_id = makeRefId(userId);
    await ensureUser(userId, username);

    const sellPrice = Number(p.sell_price || 0);
    const orderId = await createOrderPending({
      user_id: userId, username, sku: p.sku, product_name: p.name,
      target: draft.target, price: sellPrice, buy_price: p.buy_price, ref_id,
    });

    await updateOrder(orderId, { status: "WAITING_PAYMENT", message: "Menunggu pembayaran QRIS" });
    const { finalAmount, adminFee, qrBuffer } = await createQrisPayment(sellPrice, Number(QRIS_EXPIRE_MIN_DIRECT || 5));
    const depId = await insertPendingDeposit(userId, sellPrice, adminFee, finalAmount, "DIRECT", orderId, "PPOB_ORDER");

    const activeMin = Number(QRIS_EXPIRE_MIN_DIRECT || 5);
    const caption =
      "<b>────────────────────</b>\n" +
      "ㅤ <b>QRIS BERHASIL DIBUAT</b>\n" +
      "<b>────────────────────</b>\n" +
      `<code><b>ID Transaksi :</b> XYZSTORE-${orderId}</code>\n` +
      `<code><b>Total Bayar  :</b> ${formatRupiah(finalAmount)}</code>\n` +
      `<code><b>Waktu Berlaku:</b> ${humanExpire(activeMin)}</code>\n` +
      "<b>────────────────────</b>\n" +
      "Silahkan Scan QRIS di atas. Setelah berhasil, order akan diproses otomatis!";
    
    // KIRIM DAN SIMPAN ID PESAN
    const sentMsg = await ctx.replyWithPhoto(
      { source: qrBuffer },
      {
        caption, parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[{ text: "❌ Batal Transaksi", callback_data: `qris_cancel:${depId}` }]],
        },
      }
    );

    await run(`UPDATE deposits SET msg_id = ? WHERE id = ?`, [sentMsg.message_id, depId]).catch(() => {});
    return sentMsg;

  } catch (e) {
    return ctx.reply("❌ Gagal membuat QRIS.");
  }
});

// BATALKAN QRIS (HAPUS PERMANEN)
bot.action(/^qris_cancel:(\d+)$/, async (ctx) => {
  try {
    const depositId = Number(ctx.match?.[1] || 0);
    
    // Validasi ID
    if (!depositId) return ctx.answerCbQuery();

    // 1. Ambil data deposit dulu (buat cek order_id)
    const dep = await get(`SELECT * FROM deposits WHERE id=? LIMIT 1`, [depositId]);

    if (!dep) {
      // Kalau data tidak ada, anggap sudah terhapus
      await ctx.deleteMessage().catch(() => {});
      return sendPpobHome(ctx); 
    }

    // ⛔ PENGAMAN: Jangan hapus kalau statusnya sudah SUKSES (takut kepencet)
    if (dep.status === 'SUCCESS') {
         return ctx.answerCbQuery("❌ Transaksi sudah sukses, tidak bisa dibatalkan!", { show_alert: true });
    }

    // 2. 🔥 HAPUS PERMANEN DARI DATABASE (DELETE)
    // Hapus data deposit
    await run(`DELETE FROM deposits WHERE id=?`, [depositId]);
    
    // Hapus juga data ordernya (biar ga nyampah di history order)
    if (dep.order_id) {
      await run(`DELETE FROM orders WHERE id=?`, [dep.order_id]);
    }

    await ctx.answerCbQuery("🗑️ Transaksi dihapus.", { show_alert: false });

    await ctx.deleteMessage().catch(() => {});

    return sendPpobHome(ctx);

  } catch (e) {
    console.error("[QRIS_CANCEL] error:", e);
    await ctx.answerCbQuery("❌ Error sistem.", { show_alert: true }).catch(() => {});
  }
});

bot.action("confirm_buy_ask", async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});

    const draft = ctx.session.buy;
    if (!draft || draft.step !== "WAIT_CONFIRM") {
      return ctx.answerCbQuery("Session tidak ada. Pilih produk lagi.", { show_alert: true }).catch(() => {});
    }

    const p = await getProduct(draft.sku);
    if (!p || !p.active) {
      ctx.session.buy = null;
      return ctx.reply("❌ Produk sudah tidak tersedia. Silakan pilih ulang.");
    }

    const userId = ctx.from.id;
    const saldoNow = await getUserSaldo(userId);

    const text =
      "<b>────────────────────</b>\n" +
      "ㅤ ✅ <b>Konfirm Pembayaran!</b>\n" +
      "<b>────────────────────</b>\n" +
      `<code><b>Metode :</b> Saldo Bot</code>\n` +
      `<code><b>Produk :</b> ${p.name}</code>\n` +
      `<code><b>Tujuan :</b> ${draft.target}</code>\n` +
      `<code><b>Harga  :</b> ${formatRupiah(p.sell_price)}</code>\n` +
      `<code><b>Saldo  :</b> ${formatRupiah(saldoNow)}</code>\n` +
      "<b>────────────────────</b>\n" +
      "Tekan <b>Konfirmasi</b> untuk memotong\nsaldo bot & memproses transaksi!";

    return ctx.editMessageText(text, {
      parse_mode: "HTML", // <--- Pastikan diganti jadi HTML
      ...Markup.inlineKeyboard([
        [Markup.button.callback("✅ Konfirmasi", "confirm_buy")],
        [
          Markup.button.callback("⬅️ Kembali", "back_payment"),
          Markup.button.callback("❌ Batal Transaksi", "cancel_buy"),
        ],
      ]),
    });
  } catch (e) {
    console.error("[confirm_buy_ask] error:", e?.message || e);
    return ctx.answerCbQuery("Terjadi error. Coba lagi.", { show_alert: true }).catch(() => {});
  }
});

bot.action("confirm_buy_qris_ask", async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});

    const draft = ctx.session.buy;
    if (!draft || draft.step !== "WAIT_CONFIRM") {
      return ctx.answerCbQuery("Session tidak ada. Pilih produk lagi.", { show_alert: true }).catch(() => {});
    }

    const p = await getProduct(draft.sku);
    if (!p || !p.active) {
      ctx.session.buy = null;
      return ctx.reply("❌ Produk sudah tidak tersedia. Silakan pilih ulang.");
    }

    const sellPrice = Number(p.sell_price || 0);
    if (sellPrice <= 0) {
      ctx.session.buy = null;
      return ctx.reply("❌ Harga produk tidak valid. Hubungi admin.");
    }

    const text =
      "⚠️ *KONFIRMASI PEMBAYARAN*\n\n" +
      `• Metode: QRIS (Direct)\n` +
      `• Produk: *${escapeMd(p.name)}*\n` +
      `• Target: \`${escapeMd(draft.target)}\`\n` +
      `• Harga: *${formatRupiah(sellPrice)}*\n\n` +
      "Silahkan Klik *BUAT QRIS* untuk lanjut pembayaran";

    return ctx.editMessageText(text, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("✅ BUAT QRIS", "confirm_buy_qris")],
        [
          Markup.button.callback("⬅️ Kembali", "back_payment"),
          Markup.button.callback("❌ Batal", "cancel_buy"),
        ],
      ]),
    });
  } catch (e) {
    console.error("[confirm_buy_qris_ask] error:", e?.message || e);
    return ctx.answerCbQuery("Terjadi error. Coba lagi.", { show_alert: true }).catch(() => {});
  }
});

bot.action("back_payment", async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});

    const draft = ctx.session.buy;
    if (!draft || draft.step !== "WAIT_CONFIRM") {
      return ctx.answerCbQuery("Session tidak ada. Pilih produk lagi.", { show_alert: true }).catch(() => {});
    }

    const p = await getProduct(draft.sku);
    if (!p || !p.active) {
      ctx.session.buy = null;
      return ctx.reply("❌ Produk sudah tidak tersedia. Silakan pilih ulang.");
    }

    const text =
      "*────────────────────*\n" +
      "ㅤ💵 *Methode Pembayaran!*\n" +
      `*────────────────────*\n` +
      `\`Produk : ${p.name}\`\n` +
      `\`Tujuan : ${draft.target}\`\n` +
      `\`Harga  : ${formatRupiah(p.sell_price)}\`\n` +
      `*────────────────────*\n` +
      "Silahkan Pilih Pembayaran\nyang anda inginkan:";
      
    return ctx.editMessageText(text, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback("💰 Saldo Bot", "confirm_buy_ask"),
          Markup.button.callback("💳 QRIS", "confirm_buy_qris"),
        ],
          [Markup.button.callback("❌ Batal Transaksi", "cancel_buy")],
      ]),
    });
  } catch (e) {
    console.error("[back_payment] error:", e?.message || e);
    return ctx.answerCbQuery("Terjadi error. Coba lagi.", { show_alert: true }).catch(() => {});
  }
});

bot.action("confirm_buy", async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});

    const draft = ctx.session.buy;
    if (!draft || draft.step !== "WAIT_CONFIRM") {
      return ctx.answerCbQuery("Session tidak ada. Pilih produk lagi.", { show_alert: true });
    }

    // lock session (anti double click)
    ctx.session.buy = null;

    const p = await getProduct(draft.sku);
    if (!p || !p.active) {
      return ctx.reply("❌ Produk sudah tidak tersedia. Silakan pilih ulang.");
    }

    const userId = ctx.from.id;
    const username = ctx.from.username ? `@${ctx.from.username}` : "";
    const ref_id = makeRefId(userId);

    await ensureUser(userId, username);

    const sellPrice = Number(p.sell_price || 0);
    if (sellPrice <= 0) {
      return ctx.reply("❌ Harga produk tidak valid. Hubungi admin.");
    }

    // ======================
    // 4. PRE-CHECK SALDO & CREATE ORDER (ATOMIC TRANSACTION)
    // ======================
    const saldoPre = await getUserSaldo(userId);
    if (Number(saldoPre || 0) < sellPrice) {
      await ctx.answerCbQuery(
        `Saldo tidak cukup.\nSaldo: ${formatRupiah(saldoPre)}\nHarga: ${formatRupiah(sellPrice)}`,
        { show_alert: true }
      ).catch(() => {});

      const t =
        `❌  <b>Saldo bot tidak cukup</b>\n` +
        `Saldo Anda: <b>${escapeHtml(formatRupiah(saldoPre))}</b>\n` +
        `Harga Produk: <b>${escapeHtml(formatRupiah(sellPrice))}</b>\n\n` +
        `Silakan Top Up terlebih dahulu.`;

      return editOrReplace(ctx, t, {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback("➕  Top Up Saldo", "menu_topup")],
          [Markup.button.callback("⬅️ Kembali", "go_ppob")]
        ]).reply_markup
      });
    }

    // ─── ENHANCED: Atomic Transaction (FIX: Saldo Inconsistency) ────────────
    let orderId;
    try {
      await run("BEGIN IMMEDIATE");

      orderId = await createOrderPending({
        user_id: userId,
        username,
        sku: p.sku,
        product_name: p.name,
        target: draft.target,
        price: sellPrice,
        buy_price: p.buy_price,
        ref_id,
      });

      // ======================
      // 5. POTONG SALDO USER (HOLD) — DALAM TRANSACTION
      // ======================
      const charged = await chargeUserForOrder(orderId, userId, sellPrice);
      if (!charged) {
        // Rollback transaction jika charge gagal
        await run("ROLLBACK");
        const saldoNow = await getUserSaldo(userId);
        await ctx.answerCbQuery(`Saldo tidak cukup. Saldo: ${formatRupiah(saldoNow)} | Harga: ${formatRupiah(sellPrice)}`, { show_alert: true }).catch(() => {});
        return sendPpobHome(ctx, true);
      }

      // Commit transaction setelah order created dan saldo charged
      await run("COMMIT");

    } catch (e) {
      // Rollback jika ada error
      await run("ROLLBACK").catch(() => {});
      console.error("[CONFIRM_BUY] Transaction error:", e);
      await ctx.answerCbQuery("Terjadi kesalahan sistem", { show_alert: true }).catch(() => {});
      return sendPpobHome(ctx, true);
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ======================
    // 5. NOTIF AWAL (1/2) — edit pesan konfirmasi (bukan chat baru)
    // ======================
    await ctx.editMessageText(
      `⏳ *Diproses...* (ID: ${displayOrderId(orderId)})`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: [] } }
    ).catch(async () => {
      // Fallback kalau edit gagal
      await ctx.reply(`⏳ *Diproses...* (ID: ${displayOrderId(orderId)})`, { parse_mode: "Markdown" }).catch(() => {});
    });

    // ======================
    // 6. VALIDASI DIGIFLAZZ ENV
    // ======================
    if (!DIGI_USERNAME || !DIGI_APIKEY) {
      await updateOrder(orderId, {
        status: "FAILED",
        message: "DIGIFLAZZ env belum dikonfigurasi.",
        last_check_at: nowIso(),
      });
      const refunded = await refundUserForOrder(orderId, "ENV_MISSING");
      return ctx.reply(refunded
        ? "❌ Provider belum dikonfigurasi. Hubungi admin.\n💰 Saldo kamu sudah dikembalikan."
        : "❌ Provider belum dikonfigurasi. Hubungi admin.\n⚠️ Saldo belum bisa direfund otomatis, hubungi admin.");
    }

    // ======================
    // 7. CEK SALDO PROVIDER (OPTIONAL, PAKAI buy_price)
    // ======================
    const saldoRes = await digiflazzCekSaldo();
    if (!saldoRes.ok) {
      await updateOrder(orderId, {
        status: "FAILED",
        message: "Gagal cek saldo provider.",
        last_check_at: nowIso(),
      });
      const refunded = await refundUserForOrder(orderId, "CEK_SALDO_PROVIDER_FAIL");
      return ctx.reply(refunded
        ? "❌ Provider sedang gangguan. Coba lagi nanti.\n💰 Saldo kamu sudah dikembalikan."
        : "❌ Provider sedang gangguan. Coba lagi nanti.\n⚠️ Saldo belum bisa direfund otomatis, hubungi admin.");
    }

    const need = Number(p.buy_price || 0);
    if (need > 0 && Number(saldoRes.deposit || 0) < need) {
      await updateOrder(orderId, {
        status: "FAILED",
        message: `Saldo provider tidak cukup (need=${need})`.slice(0, 250),
        last_check_at: nowIso(),
      });
      const refunded = await refundUserForOrder(orderId, "SALDO_PROVIDER_KURANG");
      return ctx.reply(refunded
        ? "❌ Saldo provider tidak cukup. Coba lagi nanti.\n💰 Saldo kamu sudah dikembalikan."
        : "❌ Saldo provider tidak cukup. Coba lagi nanti.\n⚠️ Saldo belum bisa direfund otomatis, hubungi admin.");
    }

    // ======================
    // 8. KIRIM TRANSAKSI KE DIGIFLAZZ
    // ======================
    const res = await digiflazzTopup({
      buyer_sku_code: p.sku,
      customer_no: draft.target,
      ref_id,
    });

    // ======================
    // 9. ERROR REQUEST
    // ======================
    if (!res.ok) {
      const { rc, message } = extractDigiErr(res.error);
      const nice = niceDigiMsg(rc, message);

      await updateOrder(orderId, {
        status: "FAILED",
        message: `RC ${rc}: ${message}`.slice(0, 250),
        last_check_at: nowIso(),
      });

      // Auto-tandai gangguan kalau RC pusat
      const _rcStr = String(rc || "").replace(/[^\d]/g, "").padStart(2, "0");
      const _msg = String(message || "").toLowerCase();
      if (["43", "67", "94"].includes(_rcStr) || 
          /kosong|maintenance/i.test(_msg) || 
          (_msg.includes("gangguan") && !_msg.includes("tujuan") && !_msg.includes("nomor"))) {
        markProductStatus(p.sku, "gangguan").catch(() => {});
      }

      const autoRefund = shouldAutoRefundOnFailed(rc, message);
      const refunded = autoRefund ? await refundUserForOrder(orderId, `REQ_FAIL_RC_${rc}`) : false;
      return ctx.reply(
        `❌ ${nice}` +
          (autoRefund
            ? (refunded ? "\n💰 Saldo kamu sudah dikembalikan." : "\n⚠️ Saldo belum bisa direfund otomatis, hubungi admin.")
            : "\n🚫 Gagal karena *target/nomor* tidak valid, saldo *tidak direfund*."),
        { parse_mode: "Markdown" }
      );
    }

    const d = res.data;
    const st = mapDigiStatus(d.status);

    // --- SUCCESS LANGSUNG ---
    if (st === "SUCCESS") {
      await updateOrder(orderId, {
        status: "SUCCESS",
        sn: d.sn || "",
        message: d.message || "",
        last_check_at: nowIso(),
      });

      markProductStatus(p.sku, "normal").catch(() => {});

      return ctx.reply(
        "✅ *TRANSAKSI SUKSES*\n" +
          `• ID: *${displayOrderId(orderId)}*\n` +
          `• Produk: *${p.name}*\n` +
          `• Target: \`${draft.target}\`\n` +
          (d.sn ? `• SN: \`${d.sn}\`\n` : "") +
          (d.message ? `• Info: _${d.message}_\n` : ""),
        { parse_mode: "Markdown" }
      );
    }

    // --- FAILED LANGSUNG ---
    if (st === "FAILED") {
      const rc = d.rc || "-";
      const nice = niceDigiMsg(rc, d.message);

      await updateOrder(orderId, {
        status: "FAILED",
        sn: d.sn || "",
        message: `RC ${rc}: ${d.message || "Gagal"}`.slice(0, 250),
        last_check_at: nowIso(),
      });

      // Auto-tandai gangguan kalau RC pusat
      const _rcStr = String(rc || "").replace(/[^\d]/g, "").padStart(2, "0");
      const _msg = String(d.message || "").toLowerCase();
      if (["43", "67", "94"].includes(_rcStr) || 
          /kosong|maintenance/i.test(_msg) || 
          (_msg.includes("gangguan") && !_msg.includes("tujuan") && !_msg.includes("nomor"))) {
        markProductStatus(p.sku, "gangguan").catch(() => {});
      }

      const autoRefund = shouldAutoRefundOnFailed(rc, d.message);
      const refunded = autoRefund ? await refundUserForOrder(orderId, `DIGI_FAILED_RC_${rc}`) : false;
      return ctx.reply(
        `❌ ${nice}` +
          (autoRefund
            ? (refunded ? "\n💰 Saldo kamu sudah dikembalikan." : "\n⚠️ Saldo belum bisa direfund otomatis, hubungi admin.")
            : "\n🚫 Gagal karena *target/nomor* tidak valid, saldo *tidak direfund*."),
        { parse_mode: "Markdown" }
      );
    }

    // --- PENDING → BIARKAN WORKER ---
    await updateOrder(orderId, {
      status: "PENDING",
      sn: d.sn || "",
      message: d.message || "Pending",
      last_check_at: nowIso(),
    });

    // stop di sini (notif final dari pendingWorker)
    return;

  } catch (e) {
    console.error("confirm_buy error:", e);
    try {
      return ctx.reply("❌ Terjadi error saat memproses. Coba lagi.");
    } catch {}
  }
});

async function handleTopupNominal(ctx, nominal) {
  if (ctx.session?.kuota) ctx.session.kuota = null;
  ctx.session.step = null;

  const sendMd = async (text) => {
    const extra = { parse_mode: "Markdown" };
    if (ctx.updateType === "callback_query") return editOrReplace(ctx, text, extra);
    return ctx.reply(text, extra);
  };

  const topupWindow = Number(QRIS_EXPIRE_MIN_TOPUP || 5);
  const topupLimit = Number(process.env.QRIS_LIMIT_PER_5MIN || 2);
  const recentTopup = await countRecentPendingQris(ctx.from.id, "TOPUP", topupWindow);
  if (recentTopup >= topupLimit) {
    return sendMd(`⚠️  Kamu sudah membuat *${topupLimit}* QRIS TopUp dalam *${humanExpire(topupWindow)}* terakhir. Tunggu QRIS sebelumnya *dibayar / expired* dulu ya.`);
  }

  if (!nominal || nominal < 1000) {
    ctx.session.step = "input_topup_nominal";
    return sendMd(`❌  Nominal tidak valid.\nMinimal *Rp 1.000*\nContoh: \`10000\``);
  }

  try {
    const { finalAmount, adminFee, qrBuffer } = await createQrisPayment(nominal, QRIS_EXPIRE_MIN_TOPUP);
    const depId = await insertPendingDeposit(ctx.from.id, nominal, adminFee, finalAmount, "TOPUP");

    const caption =
      "<b>────────────────────</b>\n" +
      "ㅤ  <b>QRIS TOP UP DIBUAT</b>\n" +
      "<b>────────────────────</b>\n" +
      `<code>ID Transaksi  : <b>DEP-${depId}</b></code>\n` +
       `<code>Kode Unik: <b>${adminFee}</b></code>\n` +
      `<code>Total Bayar: <b>${formatRupiah(finalAmount)}</b></code>\n` +
      `<code>Waktu Berlaku: ${humanExpire(QRIS_EXPIRE_MIN_TOPUP)}</code>\n` +
      "<b>────────────────────</b>\n" +
      `📌 Setelah bayar, tunggu beberapa saat\nsaldo akan masuk otomatis.`;

    if (ctx.updateType === "callback_query") {
      await ctx.deleteMessage().catch(() => {});
    }

        // KIRIM DAN SIMPAN ID PESAN (DENGAN TOMBOL BATAL)
    const sentMsg = await ctx.replyWithPhoto(
      { source: qrBuffer },
      { 
        caption, 
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[{ text: "❌ Batal Top Up", callback_data: `qris_cancel:${depId}` }]],
        }
      }
    );

    await run(`UPDATE deposits SET msg_id = ? WHERE id = ?`, [sentMsg.message_id, depId]).catch(() => {});
    return sentMsg;

  } catch (e) {
    console.error("[TOPUP_QRIS] error:", e);
    return sendMd(`❌ Gagal membuat QRIS topup.`);
  }
}

bot.on("text", async (ctx, next) => {
  const text = clean(ctx.message?.text || "");
  if (!text) return next();
  if (text.startsWith("/")) return next();

  // WIZARD ADDPRODUK (ADMIN) - PRIORITAS PALING ATAS
  const handledAddProduk = await handleAddProdukWizardText(ctx);
  if (handledAddProduk) return; 
  
  // INPUT NOMINAL TOPUP QRIS (PRIORITAS)
  if (ctx.session.step === "input_topup_nominal") {
    const angka = text.replace(/[^\d]/g, "");
    const nominal = Number(angka);
    return handleTopupNominal(ctx, nominal);
  }

  // INPUT TARGET (BELI) (PRIORITAS DI ATAS CEK KUOTA)
  if (ctx.session.buy?.step === "WAIT_TARGET") {
    // Matikan mode cek kuota biar tidak nyasar
    if (ctx.session.kuota) ctx.session.kuota = null;

    const sku = ctx.session.buy.sku;
    const lastMsgId = ctx.session.buy.lastMsgId;

    // Ambil data produk
    const p = await getProduct(sku);
    if (!p || !p.active) {
      ctx.session.buy = null;
      return ctx.reply("❌ Produk tidak tersedia/gangguan.");
    }

    let target = text.trim();
    const cat = (p.category || "").toUpperCase();
    const brand = (p.brand || "").toUpperCase();

    // 1. DETEKSI APAKAH INI GAME?
    // Keyword umum untuk kategori game di Digiflazz/PPOB
    const isGame = 
        cat.includes("GAME") || 
        cat.includes("VOUCHER") || 
        brand.includes("LEGEND") ||     // Mobile Legends
        brand.includes("FREE") ||       // Free Fire
        brand.includes("PUBG") ||
        brand.includes("HIGGS") ||
        brand.includes("DOMINO") ||
        brand.includes("VALORANT") ||
        brand.includes("STEAM") ||
        brand.includes("GARENA") ||
        brand.includes("GROWTOPIA");

    if (isGame) {
       
        // Cek kata terlarang aja biar gak diisi sampah
        const junk = ["TEST", "TES", "ASAL", "CEK", "ADMIN", "KOSONG", "NULL"];
        if (junk.includes(target.toUpperCase())) {
             return ctx.reply("❌ ID Game tidak valid. Masukkan ID yang benar.");
        }

        // Minimal 4 karakter (ID Game jarang banget di bawah 4 digit)
        if (target.length < 4) {
             return ctx.reply("❌ ID Game terlalu pendek. Pastikan ID benar.");
        }

    } else {
        // 1. Cek Haram Huruf: Kalau ada a-z, langsung tolak
        if (/[a-zA-Z]/.test(target)) {
            return ctx.reply(
                "❌ *Format Salah!*\n\n" +
                "Produk ini hanya menerima **ANGKA** (Nomor HP/PLN).\n" +
                "Jangan masukkan huruf.\n\n" +
                "Contoh benar: `081234567890`",
                { parse_mode: "Markdown" }
            );
        }

        // 2. Bersihkan simbol (spasi, strip, +62 jadi 08, dll)
        target = target.replace(/[^0-9]/g, ""); // Hapus yg bukan angka
        if (target.startsWith("62")) target = "0" + target.slice(2); // Ubah 628xx jadi 08xx

        // 3. Validasi Panjang (HP normal: 10-13, PLN: 11-12)
        // Kita set range aman 9 - 20 digit
        if (target.length < 9 || target.length > 20) {
             return ctx.reply("❌ Nomor terlalu pendek atau panjang (9-20 digit).\nCek kembali nomor tujuan.");
        }
    }

    if (lastMsgId) {
       ctx.telegram.deleteMessage(ctx.chat.id, lastMsgId).catch(() => {});
    }

    // Update session
    ctx.session.buy = { step: "WAIT_CONFIRM", sku, target };

    return ctx.reply(
      "*────────────────────*\n" +
      "ㅤ 💴 *Methode Pembayaran*\n" +
      `*────────────────────*\n` +
      `\`Produkㅤ: ${p.name}\`\n` +
      `\`Tujuanㅤ: \`${target}\`\n` +
      `\`Hargaㅤ : \`${formatRupiah(p.sell_price)}\`\n` +
      `*────────────────────*\n` +
      "Silahkan Pilih Metode Pembayaran:",
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback("💰 Saldo Bot", "confirm_buy_ask"),
            Markup.button.callback("💳 QRIS", "confirm_buy_qris"),
          ],
          [
            Markup.button.callback("⬅️ Kembali", "buy_back_pick"),
          ],
        ]),
      }
    );
  }

  if (ctx.session.kuota?.step === "WAIT_MSISDN") {
    const textTarget = text.trim();
    const msisdn = normalizeMsisdn(textTarget);

    if (!isValidMsisdn(msisdn)) {
      return ctx.reply("❌ Nomor tidak valid. Contoh: 0878xxxx atau 62878xxxx");
    }

    // Deteksi Cerdas Provider
    const isIndosat = ["6281", "6285", "6282"].some(p => msisdn.startsWith(p)) && 
                      ["62814","62815","62816","62855","62856","62857","62858"].includes(msisdn.substring(0,5));
    const isXL = ["6281", "6285", "6287", "6283"].some(p => msisdn.startsWith(p)) && 
                 ["62817","62818","62819","62859","62877","62878","62831","62832","62833","62838"].includes(msisdn.substring(0,5));

    if (!isIndosat && !isXL) {
      return ctx.reply("❌ Bot saat ini hanya mendukung pengecekan nomor XL, AXIS, dan INDOSAT.");
    }

    const lim = await consumeKuotaLimit(msisdn);
    if (!lim.ok) {
      return ctx.reply(`⛔ Nomor ini sudah dicek <b>${KUOTA_LIMIT_MAX}x</b>.\nTunggu <b>${msToReadable(lim.waitMs)}</b> lagi.`, { parse_mode: "HTML" });
    }

    const waitMsg = await ctx.reply(`⏳ Mengecek kuota ${isIndosat ? 'Indosat' : 'XL/AXIS'}...`);
    ctx.session.kuota = null;

    // --- EKSEKUSI CEK KUOTA ---
    const res = isIndosat ? await kmspCekIndosat(msisdn) : await sidompulCekKuota(msisdn);
    await ctx.deleteMessage(waitMsg.message_id).catch(() => {});

    if (!res.ok) {
      return ctx.reply(`❌ <b>Gagal cek kuota.</b>\nAlasan: ${res.message}`, { parse_mode: "HTML" });
    }

    // Format tampilan jika pakai Sidompul lama
    if (isXL) {
      let hasilXL = res.text
        .replace(/MSISDN:.*\n/i, "").replace(/📃 RESULT:\s*/i, "").replace(/=+/g, "━━━━━━━━━━━━━━━━━━") 
        .replace(/🎁/g, "📦").replace(/🍂/g, "⏳").replace(/🌲/g, "📊").replace("Tipe Kartu:", "💳 Tipe:") 
        .replace("Status Volte Device:", "📱 Volte HP:").replace("Status Volte Area:", "📡 Volte Area:")
        .replace("Status Volte Simcard:", "💾 Volte Sim:").replace("Status 4G:", "📶 4G:")
        .replace("Status Dukcapil:", "✅ Dukcapil:").replace("Umur Kartu:", "🎂 Umur:")
        .replace("Masa Aktif:", "📅 Aktif:").replace("Masa Berakhir Tenggang:", "⚠️ Tenggang:")
        .replace(/\n\s*\n/g, "\n").trim();
      const headXL = `╭──────────────────╮\n│  🔵 <b>CEK KUOTA XL/AXIS</b>\n╰──────────────────╯\n📞 <b>Nomor:</b> <code>${msisdn}</code>\n`;
      return ctx.reply(headXL + "\n" + hasilXL, { parse_mode: "HTML" }); 
    }

    // Jika Indosat, teks sudah dirapikan dari file indosat.js
    return ctx.reply(res.text, { parse_mode: "HTML" });
  }

  return next();
});


function resetAddProdukWizard(ctx) {
  if (!ctx.session) ctx.session = {};
  delete ctx.session.addproduk_wiz;
}

bot.command("batalproduk", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("❌   Admin only");
  resetAddProdukWizard(ctx);
  return ctx.reply("✅ Proses tambah produk dibatalkan.");
});

const ADDPRODUK_STEPS = [
  {
    key: "sku",
    ask: "1) Masukkan SKU:",
    parse: (t) => clean(t),
    validate: (v) => !!v,
    err: "❌ SKU tidak boleh kosong.\nMasukkan SKU:",
  },
  {
    key: "name",
    ask: "2) Masukkan Nama Produk:",
    parse: (t) => clean(t),
    validate: (v) => !!v,
    err: "❌ Nama tidak boleh kosong.\nMasukkan Nama Produk:",
  },
  {
    key: "brand",
    ask: "3) Masukkan Brand (contoh: XL/Telkomsel):",
    parse: (t) => clean(t),
    validate: (v) => !!v,
    err: "❌ Brand tidak boleh kosong.\nMasukkan Brand:",
  },
  {
    key: "category",
    ask: "4) Masukkan Kategori (contoh: Paket Data):",
    parse: (t) => clean(t),
    validate: (v) => !!v,
    err: "❌ Kategori tidak boleh kosong.\nMasukkan Kategori:",
  },
  {
    key: "subcat",
    ask: "5) Masukkan SubKategori (opsional). Ketik '-' untuk skip:",
    parse: (t) => {
      const x = clean(t);
      return x === "-" ? "" : x;
    },
    validate: () => true,
  },
  {
    key: "buy_price",
    ask: "6) Masukkan Harga Beli (angka saja, boleh 0):",
    parse: (t) => parseInt(String(t).replace(/[^\d]/g, ""), 10) || 0,
    validate: () => true,
  },
  {
    key: "sell_price",
    ask: "7) Masukkan Harga Jual (wajib angka & > 0):",
    parse: (t) => parseInt(String(t).replace(/[^\d]/g, ""), 10) || 0,
    validate: (v) => Number(v) > 0,
    err: "❌ Harga jual wajib angka & > 0.\nMasukkan Harga Jual:",
  },
  {
    key: "description",
    ask: "8) Masukkan Deskripsi (opsional). Ketik '-' untuk skip:",
    parse: (t) => {
      const x = clean(t);
      return x === "-" ? "" : x;
    },
    validate: () => true,
  },
];

bot.command("addproduk", async (ctx) => {
  try {
    if (!isAdmin(ctx)) return ctx.reply("❌   Admin only");
    if (!ctx.session) ctx.session = {};

    ctx.session.addproduk_wiz = {
      step_index: 0,
      data: {
        sku: "",
        name: "",
        brand: "",
        category: "",
        subcat: "",
        buy_price: 0,
        sell_price: 0,
        description: "",
      },
    };

    return ctx.reply(
      "🧩 Tambah Produk (step-by-step)\n" +
        "Ketik /batalproduk untuk membatalkan.\n\n" +
        ADDPRODUK_STEPS[0].ask
    );
  } catch (e) {
    console.error("[ADDPRODUK WIZ START] error:", e);
    resetAddProdukWizard(ctx);
    return ctx.reply("❌ Error. Cek log VPS.");
  }
});

async function detectPaymentMethod(order) {
  if (!order) return "-";

  // kalau kamu sudah punya kolom ini (opsional), pakai langsung
  const m = String(order.payment_method || order.kind || "").toLowerCase();
  if (m.includes("qris")) return "QRIS";
  if (m.includes("saldo")) return "SALDO BOT";

  // cara paling akurat: cek deposits apakah ada DIRECT untuk order ini
  try {
    if (order.id) {
      const dep = await get(
        `SELECT kind FROM deposits
         WHERE order_id=? AND COALESCE(kind,'TOPUP')='DIRECT'
         ORDER BY id DESC LIMIT 1`,
        [order.id]
      );
      if (dep) return "QRIS";
    }
  } catch {}

  // fallback: asumsi default saldo
  return "SALDO BOT";
}


// created_at sqlite: "YYYY-MM-DD HH:MM:SS" dari datetime('now') (UTC)
// FIX: Tambahkan helper function normText yang hilang
function normText(s) {
  return String(s || "").trim();
}

function parseSqliteUtcToMs(s) {
  const t = normText(s);
  const m = t.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, Y, Mo, D, h, mi, se] = m;
  return Date.UTC(+Y, +Mo - 1, +D, +h, +mi, +se);
}

function makeTrxKey(parts) {
  const canon = [
    normText(parts.tanggal),
    String(parts.kredit || 0),
    normText(parts.keterangan || "").toUpperCase(),
    normText(parts.brand || "").toUpperCase(),
    normText(parts.status || "IN").toUpperCase(),
  ].join("|");

  // md5hex sudah ada di bot Anda
  return md5hex(canon);
}

// lockAndMarkDepositPaid sudah didefinisikan di atas (anti-duplikat).



// ======================
// DIRECT QRIS PAYMENT → PROSES ORDER (tanpa topup saldo)
// ======================
async function markOrderChargedExternal(orderId, amount) {
  const amt = Number(amount || 0);
  if (!amt || amt <= 0) return;
  try {
    await updateOrder(orderId, { charged: 1, charged_amount: amt });
  } catch {}
}

async function processOrderAfterDirectPayment(orderId) {
  try {
    // ─── ENHANCED ATOMIC LOCK (FIX CRITICAL: Double-execution QRIS) ──────────
    // STEP 1: Tambahkan processing_lock timestamp untuk mencegah race condition
    // STEP 2: Lock hanya valid jika belum ada lock atau lock sudah expired (>30 detik)
    const lockTimestamp = Date.now();
    const lockExpiry = 30000; // 30 detik

    const lockResult = await run(
      `UPDATE orders
         SET status='PROCESSING',
             message='Memproses pembayaran QRIS...',
             processing_lock=?,
             updated_at=datetime('now')
       WHERE id=?
         AND status NOT IN ('SUCCESS','FAILED','PROCESSING','CANCELED')
         AND (processing_lock IS NULL OR processing_lock < ?)`,
      [lockTimestamp, orderId, lockTimestamp - lockExpiry]
    );

    if (!lockResult || lockResult.changes === 0) {
      console.log(`[processOrderAfterDirectPayment] Order #${orderId} sudah diklaim/final atau sedang diproses, skip (cegah double-eksekusi).`);
      return;
    }
    // ─────────────────────────────────────────────────────────────────────────

    const o = await getOrderById(orderId);
    if (!o) return;

    // tandai metode bayar untuk notif
    await updateOrder(orderId, { payment_method: "QRIS" }).catch(() => {});

    // pastikan charged supaya refund bisa balik ke saldo kalau gagal
    const p = await getProduct(o.sku).catch(() => null);
    const sellPrice = Number(o.price || 0) || Number(p?.sell_price || 0);
    if (sellPrice > 0) await markOrderChargedExternal(orderId, sellPrice).catch(() => {});

    // validasi produk
    if (!p) {
      await updateOrder(orderId, {
        status: "FAILED",
        message: "Produk tidak ditemukan/disabled.",
        last_check_at: nowIso(),
      }).catch(() => {});
      await refundUserForOrder(orderId, "PRODUK_TIDAK_TERSEDIA_QRIS").catch(() => {});
      return;
    }

    // cek config
    if (!DIGI_USERNAME || !DIGI_APIKEY) {
      await updateOrder(orderId, { status: "FAILED", message: "Provider belum dikonfigurasi.", last_check_at: nowIso() }).catch(() => {});
      await refundUserForOrder(orderId, "DIGI_MISSING_QRIS").catch(() => {});
      await bot.telegram.sendMessage(
        o.user_id,
        "❌ Provider belum dikonfigurasi.\n💰 Dana dikembalikan ke saldo.",
        { parse_mode: "Markdown" }
      ).catch(() => {});
      return;
    }

    // kirim transaksi ke Digiflazz
    const res = await digiflazzTopup({
      buyer_sku_code: p.sku,
      customer_no: o.target,
      ref_id: o.ref_id,
    });

    if (!res.ok) {
      const { rc, message } = extractDigiErr(res.error);
      const nice = niceDigiMsg(rc, message);
      await updateOrder(orderId, {
        status: "FAILED",
        message: (`RC ${rc}: ${message}`).slice(0, 250),
        last_check_at: nowIso(),
      }).catch(() => {});
      await refundUserForOrder(orderId, `REQ_FAIL_RC_${rc}_QRIS`).catch(() => {});
      await bot.telegram.sendMessage(
        o.user_id,
        `❌ ${nice}\n💰 Dana dikembalikan ke saldo.`,
        { parse_mode: "Markdown" }
      ).catch(() => {});
      return;
    }

    const d = res.data || {};
    const st = mapDigiStatus(d.status);

    // kalau API langsung final → serahkan ke handleDigiflazzWebhook.
    // FIX: JANGAN updateOrder ke status final di sini dulu.
    // Kalau status diset SUCCESS/FAILED SEBELUM handleDigiflazzWebhook,
    // handler melihat order sudah final → idempotency check → SKIP notifikasi user!
    if (st === "SUCCESS" || st === "FAILED") {
      await handleDigiflazzWebhook(
        { ref_id: o.ref_id, status: st, sn: d.sn || "", message: d.message || "", rc: d.rc || "" },
        { "x-local-fastpath": "1" }
      );
      return;
    }

    // selain itu: set PROCESSING & tunggu webhook final
    await updateOrder(orderId, {
      status: "PROCESSING",
      sn: d.sn || "",
      message: d.message || "Pending",
      last_check_at: nowIso(),
    }).catch(() => {});

  } catch (e) {
    console.log("[processOrderAfterDirectPayment] error:", e?.message || e);
  }
}

function mapDigiStatusToLocal(status) {
  const s = String(status || "").toLowerCase();
  if (s.includes("sukses") || s === "success") return "SUCCESS";
  if (s.includes("gagal") || s === "failed") return "FAILED";
  if (s.includes("pending")) return "PENDING";
  return "PENDING";
}

async function handleDigiflazzWebhook(payload, headers = {}) {
  const refId = payload?.ref_id || payload?.data?.ref_id || payload?.clientid || null;
  const statusRaw = payload?.status || payload?.data?.status || payload?.statuscode || null;
  const message = payload?.message || payload?.data?.message || payload?.msg || null;
  const sn = payload?.sn || payload?.data?.sn || null;
  const rc = payload?.rc || payload?.data?.rc || null;

  if (!refId) return { ok: false, reason: "no_ref_id" };

  const order = await get(`SELECT * FROM orders WHERE ref_id=? LIMIT 1`, [String(refId)]);
  if (!order) return { ok: false, reason: "order_not_found" };

  const newStatus = mapDigiStatusToLocal(statusRaw);

  // idempotent: kalau sudah final, stop
  const cur = String(order.status || "").toUpperCase();
  if (cur === "SUCCESS" || cur === "FAILED") {
    return { ok: true, already_final: true, status: cur };
  }

  await updateOrder(order.id, {
    status: newStatus,
    message: [message, rc ? `rc:${rc}` : null].filter(Boolean).join(" | ").slice(0, 500),
    sn: sn ? String(sn).slice(0, 120) : null,
    last_check_at: nowIso(),
  });

  // ambil order terbaru (biar perubahan ikut)
  const o2 = await getOrderById(order.id).catch(() => order);

  // payment method
  const paymentMethod = await detectPaymentMethod(o2);

  const harga = formatRupiah(o2.price || 0);
  const waktu = fmtDateTimeID(new Date());
  const masked = maskTarget(o2.target);
  const sisaSaldo = formatRupiah(await getUserSaldo(o2.user_id));

  // SUCCESS: notif user + grup
  if (newStatus === "SUCCESS") {
    // Auto-set status produk -> normal kalau berhasil
    markProductStatus(o2.sku, "normal").catch(() => {});

    const fullCopyText = [
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      "      ✅ PEMBELIAN BERHASIL",
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      `📦 Produk     : ${o2.product_name || o2.sku || "-"}`,
      `🎯 Tujuan     : ${o2.target || "-"}`,
      `💳 Metode pay : ${paymentMethod}`,
      `💰 Harga      : ${harga}`,
      `🪙 Sisa Saldo : ${sisaSaldo}`,
      `🕒 Waktu      : ${waktu}`,
      "",
      "🆔 ID Reff    :",
      `${refId}`,
      "🔑 SN/Token   :",
      `${sn || "-"}`,
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      `📌 Status     : ${message || "Transaksi Sukses"}`,
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    ].join("\n");

    await safeSendMessage(
      o2.user_id,
      "```\n" + fullCopyText + "\n```",
      { parse_mode: "Markdown" }
    );

    const unamePlain = await getTgUserLabel(o2.user_id, "plain", o2.username);
    const msgGroup =
      `<pre>` +
      `<b>📡 NEW TRANSAKSI PPOB!</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 User    : ${escapeHtml(unamePlain.replace('@', ''))}\n` +  
      `🆔 User ID : ${o2.user_id}\n` +
      `📞 Target  : ${escapeHtml(masked)}\n` +
      `🛒 Produk  : ${escapeHtml(o2.product_name || o2.sku || "-")}\n` +
      `💵 Harga   : ${harga}\n` +
      `💳 Metode  : ${paymentMethod}\n` +
      `🪙 Saldo   : ${sisaSaldo}\n` +
      `📅 Tanggal : ${waktu}\n` +
      `━━━━━━━━━━━━━━━━━━━━` +
      `</pre>\n`;

    await sendToGroup(msgGroup, { parse_mode: "HTML" });

    return { ok: true, status: newStatus };
   }

  if (newStatus === "FAILED") {
    // Auto-tandai produk gangguan kalau RC menunjukkan gangguan/kosong di pusat
    const rcStr = String(rc || "").replace(/[^\d]/g, "").padStart(2, "0");
    const msgLower = String(message || "").toLowerCase();
    if (
      ["43", "67", "94"].includes(rcStr) ||
      msgLower.includes("kosong") ||
      msgLower.includes("maintenance") ||
      (msgLower.includes("gangguan") && !msgLower.includes("tujuan") && !msgLower.includes("nomor"))
    ) {
      markProductStatus(o2.sku, "gangguan").catch(() => {});
    }

    const autoRefund = shouldAutoRefundOnFailed(rc, message);

    const refunded = autoRefund
      ? await refundUserForOrder(o2.id, `DIGI_FAILED_RC_${rc || "-"}`).catch(() => false)
      : false;

        const rcText = rc ? String(rc) : "-";
    // Gunakan niceDigiMsg untuk menerjemahkan alasan gagalnya
    const alasanGagal = niceDigiMsg(rcText, message, sn); 

    const refundText = autoRefund
      ? (refunded ? "Dikembalikan ke saldo" : "Gagal refund otomatis (hubungi admin)")
      : "Tidak direfund";

    const fullCopyText = [
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      "        ❌  PEMBELIAN GAGAL",
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      `📦 Produk   : ${o2.product_name || o2.sku || "-"}`,
      `🎯 Tujuan   : ${o2.target || "-"}`,
      `💰 Harga    : ${harga}`,
      `💳 Metode   : ${paymentMethod}`,
      `🕒 Waktu    : ${waktu}`,
      "",
      "🆔 ID Reff  :",
      `${refId}`,
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      `📌 Status   : Gagal`,
      `💬 Alasan   : ${alasanGagal}`,
      `💰 Refund   : ${refundText}`,
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    ].join("\n");

    await safeSendMessage(
      o2.user_id,
      "```\n" + fullCopyText + "\n```",
      { parse_mode: "Markdown" }
    );

    return { ok: true, status: newStatus, refunded };
  }

  return { ok: true, status: newStatus };
}

function msUntilNextLocal(hour, minute) {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next - now;
}

function startDbMaintenanceDaily() {
  const runOnce = async () => {
    console.log("[DB] maintenance start");
    await pruneDatabase().catch(() => {});
  };
  const waitMs = msUntilNextLocal(12, 0);
  setTimeout(() => {
    runOnce();
    setInterval(runOnce, 24 * 60 * 60 * 1000);
  }, waitMs);
}

// WORKER PENGECEKAN QRIS EXPIRED (AUTO DELETE)
setInterval(async () => {
    try {
        // 1. Ubah status deposit yang waktunya lewat menjadi EXPIRED
        await expireOldDeposits();
        
        // 2. Hapus pesannya dan kirim notifikasi ke user
        await notifyExpiredDeposits();
    } catch (e) {
        console.error("[WORKER EXPIRED] Error:", e.message);
    }
}, 30 * 1000); // Mengecek setiap 30 detik

// 👇 BLOK STARTUP BOT (PPOB MODULE) 👇
// Tidak lagi memanggil bot.launch() / signal handler — itu tugas master entry.
// Tetap inisialisasi DB, webhook, sync sebagaimana asli.
(async () => {
  try {
    console.log("🔄 [PPOB] Menyiapkan database...");
    await initDb(); 
    
    try {
        await run(`ALTER TABLE deposits ADD COLUMN msg_id INTEGER`);
        console.log("✅ [PPOB] Berhasil menambahkan kolom msg_id ke database!");
    } catch (err) {
        // Abaikan error jika kolom ternyata sudah ada
        if (!err.message.includes("duplicate column name")) {
            console.log("[PPOB] Info DB:", err.message);
        }
    }

    // Mulai Panggil Server Webhook Baru — sekarang menumpang `app` master
    const setupWebhook = require("./server/webhook");
    setupWebhook(bot, app, {
      handleDigiflazzWebhook,
      processOrderAfterDirectPayment,
      lockAndMarkDepositPaid,
      creditSaldoUser,
      getUserSaldo,
      getTgUserLabel,
      safeSendMessage,
      sendToGroup,
    });
    
    startDbMaintenanceDaily();

    const intervalMenit = Number(process.env.SYNC_INTERVAL_MENIT) || 30;
    const { runSync } = require("./sync");
    const _ms = Math.max(1, intervalMenit) * 60 * 1000;
    // sync awal 10 detik setelah start
    setTimeout(async () => {
      const r = await runSync({ silent: true }).catch(() => null);
      if (r?.ok) clearProductCache();
    }, 10_000);
    setInterval(async () => {
      const r = await runSync({ silent: true, isAuto: true }).catch(() => null);
      if (r?.ok) {
        clearProductCache();
        // Log ringkas satu baris
        console.log(`🔄 [${new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' })}] AutoSync Selesai | Harga Berubah: ${r.hargaUpdate || 0} produk`);
      }
    }, _ms);
    console.log(`⏱️  [PPOB] Auto-sync Digiflazz aktif tiap ${intervalMenit} menit (cache produk auto-clear setelah sync)`);

    console.log("✅ [PPOB] Module siap.");
  } catch (e) {
    console.error("❌ [PPOB] Gagal saat startup:", e);
  }
})();

// ============================================================
// EKSPOR ENTRY POINTS — dipanggil dari master entry untuk
// pindah dari picker ke menu utama PPOB.
// ============================================================
return {
  sendPpobHome,
  sendStartMenu,
};

}; // end module.exports = function setupPpob


