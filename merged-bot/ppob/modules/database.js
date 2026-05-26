const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, '../ppob.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) console.error("❌ Error membuka database:", err.message);
  else console.log("✅ Terhubung ke database SQLite.");
});

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) { reject(err); } else { resolve(this); }
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) { reject(err); } else { resolve(row); }
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) { reject(err); } else { resolve(rows); }
    });
  });
}

async function initDb() {
  await run(`CREATE TABLE IF NOT EXISTS users (user_id INTEGER PRIMARY KEY, username TEXT, saldo INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  await run(`CREATE TABLE IF NOT EXISTS products (sku TEXT PRIMARY KEY, name TEXT, brand TEXT, category TEXT, subcat TEXT, buy_price INTEGER DEFAULT 0, sell_price INTEGER DEFAULT 0, description TEXT, active INTEGER DEFAULT 1, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  
  // Update tabel orders (tambah kolom buy_price jika belum ada)
  await run(`CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY AUTOINCREMENT, trx_id TEXT, user_id INTEGER, sku TEXT, price INTEGER, buy_price INTEGER DEFAULT 0, status TEXT, sn TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  
  // Migrasi otomatis: Tambah kolom buy_price ke orders lama jika belum ada
  try {
    await run(`ALTER TABLE orders ADD COLUMN buy_price INTEGER DEFAULT 0`);
    console.log("✅ Kolom 'buy_price' berhasil ditambahkan ke tabel orders.");
  } catch (e) {
    // Error diabaikan jika kolom sudah ada (normal)
  }

  // Migrasi: Tambah kolom 'status' ke products (normal | gangguan)
  try {
    await run(`ALTER TABLE products ADD COLUMN status TEXT DEFAULT 'normal'`);
    console.log("✅ Kolom 'status' berhasil ditambahkan ke tabel products.");
  } catch (e) {
    // Kolom sudah ada
  }

  await run(`CREATE TABLE IF NOT EXISTS deposits (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, amount_request INTEGER, amount_final INTEGER, status TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);

  // === SETTINGS (markup global, dll) ===
  await run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  // Migrasi: kolom manual_price (penanda harga dikunci admin per produk)
  try {
    await run(`ALTER TABLE products ADD COLUMN manual_price INTEGER DEFAULT 0`);
    console.log("✅ Kolom 'manual_price' berhasil ditambahkan ke tabel products.");
  } catch (e) { /* sudah ada */ }

  // Migrasi: kolom processing_lock untuk mencegah race condition di webhook QRIS
  try {
    await run(`ALTER TABLE orders ADD COLUMN processing_lock INTEGER DEFAULT NULL`);
    console.log("✅ Kolom 'processing_lock' berhasil ditambahkan ke tabel orders.");
  } catch (e) { /* sudah ada */ }

  // Migrasi: kolom trx_key untuk idempotency check di webhook deposits
  try {
    await run(`ALTER TABLE deposits ADD COLUMN trx_key TEXT DEFAULT NULL`);
    console.log("✅ Kolom 'trx_key' berhasil ditambahkan ke tabel deposits.");
  } catch (e) { /* sudah ada */ }

  // Migrasi: tambahkan index unique untuk trx_key (prevent duplicate processing)
  try {
    await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_deposits_trx_key ON deposits(trx_key) WHERE trx_key IS NOT NULL`);
    console.log("✅ Index unique 'idx_deposits_trx_key' berhasil ditambahkan.");
  } catch (e) { /* sudah ada */ }

  // Seed markup_harga dari .env kalau settings masih kosong (sekali saja)
  const cur = await get(`SELECT value FROM settings WHERE key='markup_harga'`);
  if (!cur) {
    const initial = String(Number(process.env.MARKUP_HARGA || 1000));
    await run(`INSERT INTO settings (key, value) VALUES ('markup_harga', ?)`, [initial]);
    console.log(`✅ Settings markup_harga di-seed dari .env: ${initial}`);
  }

  console.log("✅ Database tables siap.");
}

// === MARKUP HELPERS ===
async function getMarkup() {
  try {
    const row = await get(`SELECT value FROM settings WHERE key='markup_harga'`);
    const n = Number(row?.value);
    if (Number.isFinite(n) && n >= 0) return n;
  } catch (_) {}
  return Number(process.env.MARKUP_HARGA || 1000);
}

async function setMarkup(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error("Markup harus angka >= 0");
  await run(
    `INSERT INTO settings (key, value, updated_at) VALUES ('markup_harga', ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')`,
    [String(n)]
  );
  // Update sell_price semua produk yang TIDAK dikunci manual
  const res = await run(
    `UPDATE products
        SET sell_price = buy_price + ?, updated_at = datetime('now')
      WHERE COALESCE(manual_price,0) = 0`,
    [n]
  );
  return { markup: n, updated: res?.changes || 0 };
}

// --- FUNGSI HELPER ---

async function ensureUser(user_id) {
  try { await run(`INSERT OR IGNORE INTO users (user_id, saldo, updated_at) VALUES (?, 0, datetime('now'))`, [user_id]); } catch (e) {}
}

async function getUserSaldo(user_id) {
  try {
    await ensureUser(user_id);
    const row = await get(`SELECT saldo FROM users WHERE user_id=?`, [user_id]);
    return Number(row?.saldo || 0);
  } catch (e) { return 0; }
}

async function creditSaldoUser(user_id, amount) {
  const amt = Number(amount || 0);
  if (amt <= 0) return false;
  try {
    await ensureUser(user_id);
    await run(`UPDATE users SET saldo = saldo + ?, updated_at = datetime('now') WHERE user_id = ?`, [amt, user_id]);
    return true;
  } catch (e) { return false; }
}

async function debitSaldoUser(user_id, amount) {
  const amt = Number(amount || 0);
  if (amt <= 0) return false;
  try {
    await ensureUser(user_id);
    const res = await run(`UPDATE users SET saldo = saldo - ?, updated_at = datetime('now') WHERE user_id = ? AND saldo >= ?`, [amt, user_id, amt]);
    return (res?.changes || 0) > 0;
  } catch (e) { return false; }
}

async function deleteProduct(sku) { await run("DELETE FROM products WHERE sku=?", [sku]); }
async function setProductActive(sku, active) { await run("UPDATE products SET active=?, updated_at=datetime('now') WHERE sku=?", [active?1:0, sku]); }

// --- STATISTIK (UPDATE: MENGGUNAKAN BUY_PRICE DARI HISTORY) ---
async function getAdminStats() {
  try {
    // 1. TOTAL KESELURUHAN
    // IFNULL(o.buy_price, p.buy_price) -> Jika history lama blm punya modal, ambil dari harga modal produk skrg
    const rowAll = await get(`
      SELECT 
        COUNT(o.id) as count,
        SUM(o.price) as omset,
        SUM( IFNULL(NULLIF(o.buy_price, 0), IFNULL(p.buy_price, 0)) ) as modal,
        SUM( o.price - IFNULL(NULLIF(o.buy_price, 0), IFNULL(p.buy_price, 0)) ) as profit
      FROM orders o
      LEFT JOIN products p ON o.sku = p.sku
      WHERE o.status = 'SUCCESS'
    `);

    // 2. HARI INI
    const rowToday = await get(`
      SELECT 
        COUNT(o.id) as count,
        SUM(o.price) as omset,
        SUM( IFNULL(NULLIF(o.buy_price, 0), IFNULL(p.buy_price, 0)) ) as modal,
        SUM( o.price - IFNULL(NULLIF(o.buy_price, 0), IFNULL(p.buy_price, 0)) ) as profit
      FROM orders o
      LEFT JOIN products p ON o.sku = p.sku
      WHERE o.status = 'SUCCESS' 
      AND date(o.created_at, 'localtime') = date('now', 'localtime')
    `);

    const rowUser = await get(`SELECT COUNT(*) as c FROM users`);
    const rowSaldo = await get(`SELECT SUM(saldo) as s FROM users`);

    return {
      count_all: rowAll?.count || 0, omset_all: rowAll?.omset || 0, modal_all: rowAll?.modal || 0, profit_all: rowAll?.profit || 0,
      count_today: rowToday?.count || 0, omset_today: rowToday?.omset || 0, modal_today: rowToday?.modal || 0, profit_today: rowToday?.profit || 0,
      total_user: rowUser?.c || 0, user_balance: rowSaldo?.s || 0
    };
  } catch (e) { console.error("Error stats:", e); return {}; }
}

module.exports = {
  db, run, all, get, initDb,
  ensureUser, getUserSaldo, creditSaldoUser, debitSaldoUser,
  deleteProduct, setProductActive, getAdminStats,
  getMarkup, setMarkup,
};




