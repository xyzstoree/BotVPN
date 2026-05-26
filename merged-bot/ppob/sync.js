require("dotenv").config();
const sqlite3 = require("sqlite3").verbose();
const axios = require("axios");
const crypto = require("crypto");
const path = require("path");

// Memanggil fungsi kasir otomatis dari file markup.js
const { hitungHargaJual } = require("./markup");

const USER = process.env.DIGIFLAZZ_USERNAME;
const KEY = process.env.DIGIFLAZZ_APIKEY || process.env.DIGIFLAZZ_KEY;

const getSign = (cmd) =>
  crypto.createHash("md5").update((USER || "") + (KEY || "") + cmd).digest("hex");

function openDb() {
  return new sqlite3.Database(path.join(__dirname, "ppob.db"));
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

async function ensureSchema(db) {
  await run(db, `
    CREATE TABLE IF NOT EXISTS products (
      sku TEXT PRIMARY KEY,
      name TEXT,
      brand TEXT,
      category TEXT,
      subcat TEXT,
      buy_price INTEGER DEFAULT 0,
      sell_price INTEGER DEFAULT 0,
      description TEXT,
      active INTEGER DEFAULT 1,
      status TEXT DEFAULT 'normal',
      manual_price INTEGER DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
    try { await run(db, `ALTER TABLE products ADD COLUMN status TEXT DEFAULT 'normal'`); } catch (e) {}
    try { await run(db, `ALTER TABLE products ADD COLUMN manual_price INTEGER DEFAULT 0`); } catch (e) {}
    try { await run(db, `ALTER TABLE products ADD COLUMN custom_markup INTEGER DEFAULT 0`); } catch (e) {}
}

let lastSyncTime = 0;
const SYNC_COOLDOWN_MS = 90 * 1000;

async function runSync(opts = {}) {
  const silent = !!opts.silent;
  const isAuto = !!opts.isAuto; 
  const force = !!opts.force;   
  
  if (!force && !isAuto) {
    const now = Date.now();
    const diff = now - lastSyncTime;
    if (diff < SYNC_COOLDOWN_MS) {
      const sisaDetik = Math.ceil((SYNC_COOLDOWN_MS - diff) / 1000);
      return { ok: false, cooldown: true, error: `Sistem sedang cooldown. Tunggu ${sisaDetik} detik lagi.` };
    }
  }
  
  if (!isAuto) lastSyncTime = Date.now();

  const log = silent ? () => {} : (...a) => console.log(...a);
  const errLog = silent ? () => {} : (...a) => console.error(...a);

  if (!USER || !KEY) {
    const msg = "❌ DIGIFLAZZ_USERNAME / DIGIFLAZZ_APIKEY belum diset di .env";
    errLog(msg);
    if (!silent) throw new Error(msg);
    return { ok: false, error: msg };
  }

  const db = openDb();
  try {
    log(`🔄 SYNC DIGIFLAZZ dimulai... (Mode: ${isAuto ? 'AUTO' : 'MANUAL'})`);
    await ensureSchema(db);

    const payload = {
      cmd: "prepaid",
      username: USER,
      sign: getSign("pricelist"),
    };

    const res = await axios.post(
      "https://api.digiflazz.com/v1/price-list",
      payload,
      { timeout: 60000 }
    );

    if (!res.data || !Array.isArray(res.data.data)) {
      const errBody = res.data?.data;
      const errMsg = (errBody && typeof errBody === "object")
        ? `${errBody.rc || "-"}: ${errBody.message || JSON.stringify(errBody)}`
        : JSON.stringify(res.data);
      errLog("❌ Digiflazz error:", errMsg);
      return { ok: false, error: errMsg };
    }

    const data = res.data.data;
    log(`✅ Dapat ${data.length} produk dari Digiflazz`);

    const MIN_MARGIN = Number(process.env.MIN_MARGIN || 0);

    const existing = {};
        const exRows = await new Promise((res, rej) =>
      db.all(`SELECT sku, sell_price, custom_markup FROM products`, [], (e, r) => e ? rej(e) : res(r))
    );
    for (const r of exRows) {
      existing[r.sku] = {
        sell: Number(r.sell_price) || 0,
        markup: Number(r.custom_markup) || 0, // Ambil data margin khusus
      };
    }

    await run(db, "BEGIN TRANSACTION");

    let masuk = 0, normal = 0, gangguan = 0, marginHabis = 0, hargaUpdate = 0;
    let newProducts = []; 

    for (const p of data) {
      const sku = p.buyer_sku_code;
      const name = p.product_name;
      const brand = p.brand;
      const category = p.category;
      const buyPrice = Number(p.price) || 0;

      const ex = existing[sku];
      let sellPrice;
      
      // Jika ada margin khusus, pakai itu. Jika 0, balik ke kasir otomatis bertingkat
      if (ex && ex.markup > 0) {
        sellPrice = buyPrice + ex.markup; 
      } else {
        sellPrice = hitungHargaJual(buyPrice);
      }

      const digiNormal = !!(p.buyer_product_status && p.seller_product_status);
      const marginCukup = (sellPrice - buyPrice) >= MIN_MARGIN;
      const isNormal = digiNormal && marginCukup;
      const status = isNormal ? "normal" : "gangguan";

      if (digiNormal && !marginCukup) marginHabis++;

      if (ex) {
        if (ex.sell !== sellPrice) hargaUpdate++;
                await run(db,
          `UPDATE products 
           SET category=?, 
               brand=?, 
               buy_price=?, 
               sell_price=?, 
               status=?, 
               updated_at=datetime('now') 
           WHERE sku=?`,
          [category, brand, buyPrice, sellPrice, status, sku]
        );
        masuk++;
        if (isNormal) normal++; else gangguan++;

      } else {
        if (isAuto) {
          continue;
        } else {
          await run(db,
            `INSERT INTO products (sku, name, brand, category, subcat, buy_price, sell_price, status, active, updated_at)
             VALUES (?, ?, ?, ?, 'Produk Baru', ?, ?, ?, 0, datetime('now'))`,
            [sku, name, brand, category, buyPrice, sellPrice, status]
          );
          
          newProducts.push({ sku, name, brand, category });
          masuk++;
          if (isNormal) normal++; else gangguan++;
        }
      }
    }

    await run(db, "COMMIT");

    log(`🎉 SYNC SELESAI — total:${masuk} | produk baru:${newProducts.length}`);
    return { ok: true, masuk, normal, gangguan, marginHabis, hargaUpdate, newProducts };
  } catch (e) {
    try { await run(db, "ROLLBACK"); } catch (_) {}
    const detail = e.response ? `HTTP ${e.response.status} ${JSON.stringify(e.response.data)}` : e.message;
    errLog("❌ SYNC ERROR:", detail);
    return { ok: false, error: detail };
  } finally {
    try { db.close(); } catch (_) {}
  }
}

let _timer = null;
function startAutoSync(menit = 30) {
  const ms = Math.max(1, Number(menit) || 30) * 60 * 1000;

  setTimeout(() => {
    runSync({ silent: true, isAuto: true }).catch(() => {});
  }, 10_000);

  if (_timer) clearInterval(_timer);
  _timer = setInterval(() => {
    runSync({ silent: true, isAuto: true }).catch(() => {});
  }, ms);

  console.log(`⏱️  Auto-sync Digiflazz aktif tiap ${menit} menit (Mode Auto)`);
  return _timer;
}

function stopAutoSync() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { runSync, startAutoSync, stopAutoSync };

if (require.main === module) {
  runSync({ force: true, isAuto: false })
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}


