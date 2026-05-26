/**
 * RECALC MARKUP — sekali jalan
 * Update sell_price semua produk di ppob.db jadi: buy_price + MARKUP_HARGA (.env)
 *
 * Cara pakai:
 *   node recalc-markup.js          # update semua produk (kecuali yang manual_price=1)
 *   node recalc-markup.js --force  # update SEMUA termasuk yang manual_price=1
 *   node recalc-markup.js --dry    # cuma tampilkan, tidak ubah DB
 */

require("dotenv").config();
const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const DRY = args.includes("--dry");

const MARKUP = Number(process.env.MARKUP_HARGA || 1000);
const DB_FILE = process.env.DATABASE_FILE || "ppob.db";

console.log(`?? MARKUP_HARGA   : ${MARKUP}`);
console.log(`?? DATABASE_FILE  : ${DB_FILE}`);
console.log(`?? FORCE override : ${FORCE ? "YES" : "no"}`);
console.log(`?? DRY RUN        : ${DRY ? "YES (DB tidak diubah)" : "no"}`);
console.log("");

const db = new sqlite3.Database(path.join(__dirname, DB_FILE));

function all(sql, params = []) {
  return new Promise((res, rej) =>
    db.all(sql, params, (e, r) => (e ? rej(e) : res(r)))
  );
}
function run(sql, params = []) {
  return new Promise((res, rej) =>
    db.run(sql, params, function (e) { e ? rej(e) : res(this); })
  );
}

(async () => {
  try {
    // pastikan kolom manual_price ada
    try { await run(`ALTER TABLE products ADD COLUMN manual_price INTEGER DEFAULT 0`); } catch (_) {}

    const rows = await all(
      `SELECT sku, name, buy_price, sell_price, COALESCE(manual_price,0) AS manual_price
         FROM products`
    );

    let updated = 0, skipManual = 0, sama = 0;
    if (!DRY) await run("BEGIN TRANSACTION");

    for (const r of rows) {
      const target = (Number(r.buy_price) || 0) + MARKUP;
      if (!FORCE && r.manual_price === 1) { skipManual++; continue; }
      if (Number(r.sell_price) === target) { sama++; continue; }

      if (!DRY) {
        await run(
          `UPDATE products
              SET sell_price = ?, manual_price = 0, updated_at = datetime('now')
            WHERE sku = ?`,
          [target, r.sku]
        );
      }
      updated++;
      if (updated <= 20) {
        console.log(`  • ${r.sku.padEnd(18)} ${String(r.sell_price).padStart(7)} → ${String(target).padStart(7)}  ${r.name}`);
      }
    }

    if (!DRY) await run("COMMIT");

    console.log("");
    console.log(`✅ Selesai. total:${rows.length}  updated:${updated}  sudah-sesuai:${sama}  skip-manual:${skipManual}`);
    if (DRY) console.log("ℹ️  DRY RUN — tidak ada perubahan disimpan.");
  } catch (e) {
    try { await run("ROLLBACK"); } catch (_) {}
    console.error("❌ ERROR:", e.message);
    process.exitCode = 1;
  } finally {
    db.close();
  }
})();

