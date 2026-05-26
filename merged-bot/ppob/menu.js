// menus.js
const { Markup } = require("telegraf");
const CATEGORIES = require("./categories");
const { all } = require("./db");

// 1) Menu kategori: fixed list, tapi tampil kalau ada produk aktif
async function categoryKeyboard() {
  const rows = await all(`SELECT DISTINCT category FROM products WHERE active=1`);
  const exist = new Set(rows.map(r => r.category));

  const btns = CATEGORIES
    .filter(c => exist.has(c.key))
    .map(c => [Markup.button.callback(c.label, `cat:${c.key}`)]);

  btns.push([Markup.button.callback("🔎 Cari Produk", "search")]);
  return Markup.inlineKeyboard(btns);
}

// 2) Menu brand berdasarkan kategori
async function brandKeyboard(category) {
  const rows = await all(
    `SELECT DISTINCT brand FROM products WHERE active=1 AND category=? ORDER BY brand`,
    [category]
  );

  const btns = rows.map(r => [Markup.button.callback(r.brand, `brand:${category}:${r.brand}`)]);
  btns.push([Markup.button.callback("⬅️ Kembali", "buy")]);
  return Markup.inlineKeyboard(btns);
}

// 3) Menu produk berdasarkan kategori + brand, pakai paging biar rapi
async function productKeyboard({ category, brand, page=0, pageSize=8 }) {
  const offset = page * pageSize;

  const items = await all(
    `SELECT sku,name,sell_price
     FROM products
     WHERE active=1 AND category=? AND brand=?
     ORDER BY name
     LIMIT ? OFFSET ?`,
    [category, brand, pageSize, offset]
  );

  const totalRow = await all(
    `SELECT COUNT(*) as c
     FROM products
     WHERE active=1 AND category=? AND brand=?`,
    [category, brand]
  );
  const total = totalRow[0]?.c || 0;

  const btns = items.map(p => [
    Markup.button.callback(`${p.name} • Rp${p.sell_price}`, `sku:${p.sku}`)
  ]);

  // tombol navigasi page
  const nav = [];
  if (page > 0) nav.push(Markup.button.callback("⬅️ Prev", `prodpage:${category}:${brand}:${page-1}`));
  if (offset + pageSize < total) nav.push(Markup.button.callback("Next ➡️", `prodpage:${category}:${brand}:${page+1}`));
  if (nav.length) btns.push(nav);

  btns.push([Markup.button.callback("⬅️ Kembali", `cat:${category}`)]);
  return Markup.inlineKeyboard(btns);
}

module.exports = { categoryKeyboard, brandKeyboard, productKeyboard };
