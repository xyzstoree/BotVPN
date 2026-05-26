const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const db = new sqlite3.Database(path.join(__dirname, "ppob.db"));

function run(sql, params=[]) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err){
      if (err) return reject(err);
      resolve(this);
    });
  });
}
function all(sql, params=[]) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
  });
}
function get(sql, params=[]) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
  });
}

async function initDb() {
  await run(`
    CREATE TABLE IF NOT EXISTS products (
      sku TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      brand TEXT NOT NULL,
      category TEXT NOT NULL,
      buy_price INTEGER DEFAULT 0,
      sell_price INTEGER NOT NULL,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      sku TEXT NOT NULL,
      target TEXT NOT NULL,
      price INTEGER NOT NULL,
      status TEXT DEFAULT 'PENDING',
      sn TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
}

// --- Produk: add/update/delete ---
async function upsertProduct(p) {
  // p: {sku,name,brand,category,buy_price,sell_price,active}
  await run(`
    INSERT INTO products (sku,name,brand,category,buy_price,sell_price,active,updated_at)
    VALUES (?,?,?,?,?,?,?, datetime('now'))
    ON CONFLICT(sku) DO UPDATE SET
      name=excluded.name,
      brand=excluded.brand,
      category=excluded.category,
      buy_price=excluded.buy_price,
      sell_price=excluded.sell_price,
      active=excluded.active,
      updated_at=datetime('now')
  `, [p.sku, p.name, p.brand, p.category, p.buy_price||0, p.sell_price, p.active ?? 1]);
}

async function setProductActive(sku, active) {
  await run(`UPDATE products SET active=?, updated_at=datetime('now') WHERE sku=?`, [active ? 1 : 0, sku]);
}

async function deleteProduct(sku) {
  await run(`DELETE FROM products WHERE sku=?`, [sku]);
}

async function listCategories() {
  return all(`SELECT DISTINCT category FROM products WHERE active=1 ORDER BY category`);
}

async function listBrandsByCategory(category) {
  return all(`SELECT DISTINCT brand FROM products WHERE active=1 AND category=? ORDER BY brand`, [category]);
}

async function listProducts({ category, brand, q, limit=10, offset=0 }) {
  const where = ["active=1"];
  const params = [];

  if (category) { where.push("category=?"); params.push(category); }
  if (brand)    { where.push("brand=?");    params.push(brand); }
  if (q)        { where.push("(name LIKE ? OR sku LIKE ?)"); params.push(`%${q}%`, `%${q}%`); }

  const sql = `
    SELECT sku,name,brand,category,buy_price,sell_price
    FROM products
    WHERE ${where.join(" AND ")}
    ORDER BY category, brand, name
    LIMIT ? OFFSET ?
  `;
  params.push(limit, offset);
  return all(sql, params);
}

async function getProduct(sku) {
  return get(`SELECT * FROM products WHERE sku=?`, [sku]);
}

module.exports = {
  db,
  run, all, get,
  initDb,
  upsertProduct, setProductActive, deleteProduct,
  listCategories, listBrandsByCategory, listProducts, getProduct
};
