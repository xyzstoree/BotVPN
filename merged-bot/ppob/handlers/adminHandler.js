// handlers/adminHandler.js
const { Markup } = require("telegraf");
const { exec } = require("child_process");
const fs = require("fs");
const { digiflazzCekSaldo } = require("../modules/digiflazz");

// ============================================
// 1. IMPORT DATABASE (Dibersihkan dari getMarkup & setMarkup)
// ============================================
const {
  run,
  all,
  get,
  ensureUser,
  getUserSaldo,
  debitSaldoUser,
  creditSaldoUser,
  deleteProduct,
  setProductActive,
  getAdminStats,
} = require("../modules/database");

// --- Helper Kecil ---
const formatRupiah = (n) => "Rp " + (Number(n) || 0).toLocaleString("id-ID");
const clean = (s) => String(s || "").trim();

const ADMIN_IDS = (process.env.ADMIN_IDS || "")
  .split(",")
  .map((x) => Number(x.trim()))
  .filter((x) => Number.isFinite(x) && x > 0);

function isAdmin(ctx) {
  return ADMIN_IDS.includes(ctx.from?.id);
}

// ============================================
// 2. MODUL ADMIN
// ============================================
module.exports = (bot) => {

  function parseSkuValue(ctx, cmdName) {
    const text = (ctx.message?.text || "")
      .replace(new RegExp(`^\\/${cmdName}\\s*`, "i"), "")
      .trim();
    const [sku, value] = text.split("|").map(v => (v ?? "").trim());
    return { sku, value };
  }

  async function ensureProductExists(sku) {
    if (!sku) return null;
    return await get("SELECT sku FROM products WHERE sku=?", [sku]);
  }

  async function updateProductField(ctx, { sku, field, value }) {
    const exists = await ensureProductExists(sku);
    if (!exists) {
      await ctx.reply("❌ Produk tidak ditemukan.");
      return false;
    }
    await run(`UPDATE products SET ${field}=?, updated_at=datetime('now') WHERE sku=?`, [value, sku]);
    globalThis.clearProductCache?.(); 
    return true;
  }

  function getAdminMenuView() {
    const text =
      "⚙️ *ADMIN PANEL*\n" + "Halo bos! Silakan pilih menu manajemen:";

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback("💰 Statistik", "adm_stats"),
        Markup.button.callback("⚙️ Menu Produk", "menu_produk"),
      ],
      [
        Markup.button.callback("📦 List Produk", "adm_prod"),
        Markup.button.callback("💳 Saldo", "adm_saldo"),
      ],
      [
        Markup.button.callback("📑 History", "adm_hist"),
        Markup.button.callback("📢 Broadcast", "adm_bc"),
      ],
      [
        Markup.button.callback("🔧 Maint & Log", "adm_maint"),
        Markup.button.callback("📂 Backup", "adm_backup"),
      ],
      [
        Markup.button.callback("💰 Cek Markup/Harga", "adm_markup"),
      ],
      [
        Markup.button.callback("🏦 Cek Saldo Server", "cek_saldo_server"),
        Markup.button.callback("💳 Top Up Server", "topup_server_info"),
      ],
      [
        Markup.button.callback("❌   Tutup", "adm_close")
      ],
    ]);

    return { text, extra: { parse_mode: "Markdown", ...keyboard } };
  }

  async function editOrReplyAdminMenu(ctx) {
    const { text, extra } = getAdminMenuView();
    await ctx.answerCbQuery().catch(() => {});
    const ok = await ctx
      .editMessageText(text, extra)
      .then(() => true)
      .catch(() => false);

    if (!ok) {
      return ctx.reply(text, extra).catch(() => {});
    }
  }

  bot.command("admin", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("❌  Kamu bukan Admin.");
    const { text, extra } = getAdminMenuView();
    return ctx.reply(text, extra);
  });

  bot.action("adm_stats", async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery().catch(() => {});
    const stats = await getAdminStats();

    const text =
      "📊 *LAPORAN KEUANGAN*\n" +
      "━━━━━━━━━━━━━━━━━━━\n" +
      "📆 *PERFORMA HARI INI:*\n" +
      `🛒 Trx Sukses: *${stats.count_today || 0}*\n` +
      `💰 Omset: *${formatRupiah(stats.omset_today)}*\n` +
      `📈 Profit: *${formatRupiah(stats.profit_today)}*\n` +
      "\n" +
      "♾️ *TOTAL KESELURUHAN:*\n" +
      `🛒 Trx Sukses: *${stats.count_all || 0}*\n` +
      `💰 Omset: *${formatRupiah(stats.omset_all)}*\n` +
      `📈 Profit: *${formatRupiah(stats.profit_all)}*\n` +
      "━━━━━━━━━━━━━━━━━━━\n" +
      `👥 Total User: ${stats.total_user}\n` +
      `🏦 Saldo Mengendap: ${formatRupiah(stats.user_balance)}`;

    await ctx
      .editMessageText(text, {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🔄 Refresh Data", "adm_stats")],
          [Markup.button.callback("⬅️ Kembali", "adm_back")],
        ]),
      })
      .catch(() => {});
  });

  bot.action("menu_produk", async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery().catch(() => {});
    const text =
      "📦 *MANAJEMEN PRODUK*\n\n" +
      "👇 *Command Manual*\n" +
      "• /addproduk (Wizard)\n" +
      "• /editproduk (Menu Edit)\n" +
      "• /offproduk SKU\n" +
      "• /onproduk SKU\n" +
      "• /delproduk SKU\n" +
      "• /sync (Update Produk Digiflazz)\n\n" +
      "💰 *Markup Harga*\n" +
      "Buka file `markup.js` di VPS untuk mengatur nominal keuntungan.";

    await ctx
      .editMessageText(text, {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([[Markup.button.callback("⬅️ Kembali", "adm_back")]]),
      })
      .catch(() => {});
  });

  bot.command("editproduk", async (ctx) => {
    if (!isAdmin(ctx)) return;
    return ctx.reply(
      "🛠️ Menu Edit Produk (Admin)\n\n" +
      "1. /editnama\n" +
      "2. /editbrand\n" +
      "3. /editsubkat\n" +
      "4. /editmargin\n" +
      "5. /hapusmargin\n" +
      "6. /listmargin\n" +
      "7. /editdesk\n" +
      "8. /changesku"
    );
  });

  bot.command("editnama", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const { sku, value: name } = parseSkuValue(ctx, "editnama");
    if (!sku || !name) return ctx.reply("Format:\n/editnama SKU|NamaBaru");
    const ok = await updateProductField(ctx, { sku, field: "name", value: name });
    if (ok) return ctx.reply(`✅ Nama produk \`${sku}\` berhasil diubah.`, { parse_mode: "Markdown" });
  });

  bot.command("editbrand", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const raw = (ctx.message?.text || "").replace(/^\/editbrand\s*/i, "").trim();
    if (!raw) return ctx.reply("Format:\n/editbrand ProviderLama|ProviderBaru\n\nContoh:\n/editbrand TELKOMSEL|Telkomsel");
    
    const [oldBrand, newBrand] = raw.split("|").map(s => s.trim());
    if (!oldBrand || !newBrand) return ctx.reply("❌ Format salah.\nHarus: /editbrand ProviderLama|ProviderBaru");

    const exists = await get("SELECT sku FROM products WHERE brand=? LIMIT 1", [oldBrand]);
    if (!exists) return ctx.reply(`❌ Tidak ada produk dengan provider "${oldBrand}".`);

    await run(`UPDATE products SET brand=?, updated_at=datetime('now') WHERE brand=?`, [newBrand, oldBrand]);
    globalThis.clearProductCache?.();
    return ctx.reply(`✅ Provider "${oldBrand}" → "${newBrand}" berhasil diubah (semua produk).`);
  });

  bot.command("editsubkat", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const raw = (ctx.message?.text || "").replace(/^\/editsubkat\s*/i, "").trim();
    if (!raw) return ctx.reply("Format:\n/editsubkat SubLama|SubBaru|Provider");
    
    const [oldSub, newSub, provider] = raw.split("|").map(s => s.trim());
    if (!oldSub || !newSub || !provider) return ctx.reply("❌ Format salah.\nGunakan:\n/editsubkat SubLama|SubBaru|Provider");

    const exists = await get(
      `SELECT sku FROM products WHERE LOWER(TRIM(subcat)) = LOWER(TRIM(?)) AND LOWER(TRIM(brand)) = LOWER(TRIM(?)) LIMIT 1`,
      [oldSub, provider]
    );
    if (!exists) return ctx.reply(`❌ Tidak ketemu "${oldSub}" untuk provider "${provider}".`);

    await run(
      `UPDATE products SET subcat=?, active=1, updated_at=datetime('now') WHERE LOWER(TRIM(subcat)) = LOWER(TRIM(?)) AND LOWER(TRIM(brand)) = LOWER(TRIM(?))`,
      [newSub, oldSub, provider]
    );
    globalThis.clearProductCache?.();
    return ctx.reply(`✅ Subkategori "${oldSub}" → "${newSub}" (provider ${provider}) berhasil diubah.`);
  });

  bot.command("setsubkat", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const text = (ctx.message?.text || "").replace(/^\/setsubkat\s*/i, "").trim();
    const [sku, subBaru] = text.split("|").map(s => (s || "").trim());

    if (!sku || !subBaru) return ctx.reply("❌ *Format Salah!*\nGunakan format: `/setsubkat SKU|SubkategoriBaru`", { parse_mode: "Markdown" });

    try {
      const exists = await get("SELECT sku, name, brand FROM products WHERE sku=?", [sku]);
      if (!exists) return ctx.reply(`❌ Produk dengan SKU \`${sku}\` tidak ditemukan.`);

      await run(`UPDATE products SET subcat = ?, active = 1, updated_at = datetime('now') WHERE sku = ?`, [subBaru, sku]);
      globalThis.clearProductCache?.();

      return ctx.reply(`✅ *Subkategori Berhasil Diatur!*\n• Produk: ${exists.name}\n• Provider: *${exists.brand}*\n• SKU: \`${sku}\`\n• Subkategori: *${subBaru}*`, { parse_mode: "Markdown" });
    } catch (e) {
      console.error("[SETSUBKAT ERROR]", e);
      return ctx.reply("❌ Terjadi error saat menjalankan /setsubkat.");
    }
  });

  bot.command("editmargin", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const text = (ctx.message?.text || "").trim();
    const args = text.replace(/^\/editmargin(@\w+)?\s*/i, ""); 
    const parts = args.split("|").map(s => String(s || "").trim());
    const sku = parts[0];
    const marginStr = parts[1];

    if (!sku || !marginStr) return ctx.reply("💡 Format: `/editmargin SKU|Untung`\n\nContoh: `/editmargin TELKOMSEL10|1500`", { parse_mode: "Markdown" });

    const margin = Number(marginStr.replace(/[^\d]/g, ""));
    if (!Number.isFinite(margin) || margin < 0) return ctx.reply("❌ Nominal untung harus berupa angka.");

    try {
      const exists = await get("SELECT sku, name FROM products WHERE sku=?", [sku]);
      if (!exists) return ctx.reply(`❌ Produk dengan SKU \`${sku}\` tidak ditemukan.`);

      try { await run(`ALTER TABLE products ADD COLUMN custom_markup INTEGER DEFAULT 0`); } catch (_) {}
      
      await run(`UPDATE products SET custom_markup = ?, updated_at = datetime('now') WHERE sku = ?`, [margin, sku]);
      globalThis.clearProductCache?.();

      return ctx.reply(
        `✅ *Margin Produk Berhasil Diset!*\n` +
        `• Produk: ${exists.name}\n` +
        `• SKU: \`${sku}\`\n` +
        `• Keuntungan: *Rp ${margin.toLocaleString('id-ID')}*\n\n` +
        `_Jalankan_ \`/sync force\` _agar harga jual langsung di-update mengikuti modal Digiflazz._`, 
        { parse_mode: "Markdown" }
      );
    } catch (e) {
      console.error("[editmargin error]", e);
      return ctx.reply("❌ Terjadi kesalahan pada database.");
    }
  });

  bot.command("hapusmargin", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const sku = (ctx.message?.text || "").replace(/^\/hapusmargin(@\w+)?\s*/i, "").trim();

    if (!sku) return ctx.reply("💡 Format: `/hapusmargin SKU`\nFungsi: Mengembalikan produk ke hitungan harga otomatis bertingkat.", { parse_mode: "Markdown" });

    try {
      await run(`UPDATE products SET custom_markup = 0, updated_at = datetime('now') WHERE sku = ?`, [sku]);
      globalThis.clearProductCache?.();
      return ctx.reply(`✅ Aturan margin khusus untuk \`${sku}\` dihapus.\nHarga sekarang mengikuti sistem otomatis bertingkat dari file \`markup.js\`. Jangan lupa \`/sync force\`.`, { parse_mode: "Markdown" });
    } catch (e) {
      return ctx.reply("❌ Gagal menghapus margin.");
    }
  });

  bot.command("listmargin", async (ctx) => {
    if (!isAdmin(ctx)) return;

    try {
      // Mengambil data produk yang memiliki margin di atas 0
      const rows = await all(
        `SELECT sku, name, buy_price, sell_price, custom_markup 
         FROM products 
         WHERE custom_markup > 0 
         ORDER BY sku ASC LIMIT 50`
      );
      
      if (!rows || rows.length === 0) {
        return ctx.reply("📭 *Belum ada produk margin khusus.*\n\nSemua produk masih mengikuti hitungan harga otomatis dari `markup.js`.", { parse_mode: "Markdown" });
      }

      let msg = `📋 *DAFTAR PRODUK MARGIN KHUSUS*\nTotal: ${rows.length} produk (Max 50 ditampilkan)\n━━━━━━━━━━━━━━━━━━━\n\n`;
      
      rows.forEach((p, i) => {
        msg += `*${i + 1}. ${p.sku}*\n`;
        msg += `└ ${p.name}\n`;
        msg += `└ Jual: ${formatRupiah(p.sell_price)} (Modal: ${formatRupiah(p.buy_price)})\n`;
        msg += `└ Margin: *${formatRupiah(p.custom_markup)}*\n\n`;
      });

      msg += `_Hapus margin ketik:_ \`/hapusmargin SKU\``;

      return ctx.reply(msg, { parse_mode: "Markdown" });
    } catch (e) {
      console.error("[listmargin error]", e);
      return ctx.reply("❌ Gagal mengambil data margin dari database.");
    }
  });

  bot.command("editdesk", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const text = (ctx.message?.text || "").replace(/^\/editdesk\s*/i, "").trim();
    const [sku, ...rest] = text.split("|");
    const skuFix = (sku ?? "").trim();
    const desc = rest.join("|").trim(); 
    if (!skuFix) return ctx.reply("Format:\n/editdesk SKU|DeskripsiBaru");
    const ok = await updateProductField(ctx, { sku: skuFix, field: "description", value: desc || "" });
    if (ok) return ctx.reply(`✅ Deskripsi \`${skuFix}\` berhasil diubah.`, { parse_mode: "Markdown" });
  });

  bot.command("changesku", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const args = (ctx.message?.text || "").trim().split(/\s+/);
    const oldSku = (args[1] || "").trim();
    const newSku = (args[2] || "").trim();

    if (!oldSku || !newSku) return ctx.reply("Format:\n/changesku OLD_SKU NEW_SKU");
    if (oldSku === newSku) return ctx.reply("❌ OLD dan NEW sama.");

    const oldP = await get(`SELECT sku,name FROM products WHERE sku=?`, [oldSku]);
    if (!oldP) return ctx.reply("❌ SKU lama tidak ditemukan di products.");
    const newP = await get(`SELECT sku FROM products WHERE sku=?`, [newSku]);
    if (newP) return ctx.reply("❌ SKU baru sudah ada. Pilih SKU lain.");

    try {
      await run("BEGIN IMMEDIATE");
      await run(`UPDATE products SET sku=?, updated_at=datetime('now') WHERE sku=?`, [newSku, oldSku]);
      const rOrders = await run(`UPDATE orders SET sku=?, updated_at=datetime('now') WHERE sku=? AND status IN ('DRAFT','PENDING')`, [newSku, oldSku]);
      await run("COMMIT");
      globalThis.clearProductCache?.();
      
      return ctx.reply(`✅ SKU berhasil diganti!\nOLD: \`${oldSku}\`\nNEW: \`${newSku}\`\nProduk: ${oldP.name}\nOrders DRAFT/PENDING ikut diupdate: ${rOrders?.changes || 0}`, { parse_mode: "Markdown" });
    } catch (e) {
      try { await run("ROLLBACK"); } catch {}
      console.error("[changesku] error:", e);
      return ctx.reply("❌ Gagal ganti SKU. Cek log VPS.");
    }
  });

  bot.action("adm_prod", async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery().catch(() => {});
    const text =
      "📦 *MANAJEMEN PRODUK*\n" + "Silakan pilih metode pencarian produk:";
    await ctx
      .editMessageText(text, {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("📂 Cari per Provider (Kategori)", "browse_brands")],
          [Markup.button.callback("🔍 Cari via Kode/Nama", "search_manual_info")],
          [Markup.button.callback("⬅️ Kembali", "adm_back")],
        ]),
      })
      .catch(() => {});
  });

  bot.action("search_manual_info", async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery().catch(() => {});
    const text =
      "🔍 *PENCARIAN MANUAL*\n\n" +
      "Ketik command berikut di chat:\n" +
      "• `/listproduk katakata`\n" +
      "  (Contoh: `/listproduk axis`)\n\n";

    await ctx
      .editMessageText(text, {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("⬅️ Kembali ke Menu Produk", "adm_prod")],
        ]),
      })
      .catch(() => {});
  });

  bot.action("browse_brands", async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery().catch(() => {});
    const rows = await all("SELECT DISTINCT brand FROM products ORDER BY brand ASC");

    if (!rows.length) {
      return ctx.answerCbQuery("📭 Belum ada produk sama sekali.").catch(() => {});
    }

    const buttons = [];
    let row = [];
    rows.forEach((r) => {
      const b = String(r.brand || "").trim();
      if (!b) return;
      row.push(Markup.button.callback(b.toUpperCase(), `open_brand:${b}`));
      if (row.length === 2) {
        buttons.push(row);
        row = [];
      }
    });
    if (row.length) buttons.push(row);

    buttons.push([Markup.button.callback("⬅️ Kembali", "adm_prod")]);

    await ctx
      .editMessageText("📂 *PILIH PROVIDER/KATEGORI:*", {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard(buttons),
      })
      .catch(() => {});
  });

  bot.action(/^open_brand:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery().catch(() => {});
    const brandName = ctx.match[1];

    const rows = await all(
      "SELECT sku, name, sell_price, active FROM products WHERE brand = ? ORDER BY sell_price ASC",
      [brandName]
    );

    if (!rows.length) return ctx.answerCbQuery("Produk kosong.").catch(() => {});

    const list = rows
      .map(
        (p, i) =>
          `${i + 1}. *${p.sku}* ${p.active ? "✅ " : "🔴"}\n` +
          `   └ ${p.name}\n` +
          `   💰 *${formatRupiah(p.sell_price)}*`
      )
      .join("\n\n");

    const text =
      `📂 Kategori: *${String(brandName).toUpperCase()}*\n` +
      `Total: ${rows.length} Produk\n` +
      `━━━━━━━━━━━━━━━━━━━\n\n` +
      list;

    await ctx
      .editMessageText(text, {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🔙 Pilih Provider Lain", "browse_brands")],
          [Markup.button.callback("⚙️ Menu Admin", "adm_back")],
        ]),
      })
      .catch(() => {});
  });

  bot.command("listproduk", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const q = clean(ctx.message.text.replace("/listproduk", ""));
    if (!q)
      return ctx.reply(
        "💡 Untuk melihat semua, gunakan tombol menu *Admin > Produk > Cari per Provider*.",
        { parse_mode: "Markdown" }
      );

    const sql =
      "SELECT sku, name, brand, sell_price, active FROM products WHERE sku LIKE ? OR name LIKE ? OR brand LIKE ? ORDER BY sell_price ASC LIMIT 20";
    const params = [`%${q}%`, `%${q}%`, `%${q}%`];

    const rows = await all(sql, params);
    if (!rows.length) return ctx.reply("📭 Produk tidak ditemukan.");

    const list = rows
      .map(
        (p, i) =>
          `${i + 1}. *${p.sku}* (${p.brand})\n   └ ${p.name} | 💰 ${formatRupiah(
            p.sell_price
          )}`
      )
      .join("\n");

    return ctx.reply(`🔍 Hasil Cari: "${q}"\n\n${list}`, { parse_mode: "Markdown" });
  });

  bot.command("delproduk", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const sku = clean(ctx.message.text.split(" ")[1]);
    if (!sku) return ctx.reply("❌  Format: `/delproduk SKU`", { parse_mode: "Markdown" });
    await deleteProduct(sku);
    globalThis.clearProductCache?.();
    return ctx.reply(`✅  Produk \`${sku}\` dihapus.`, { parse_mode: "Markdown" });
  });

  bot.command("offproduk", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const sku = clean(ctx.message.text.split(" ")[1]);
    if (!sku) return ctx.reply("❌  Format: `/offproduk SKU`", { parse_mode: "Markdown" });
    await setProductActive(sku, false);
    globalThis.clearProductCache?.();
    return ctx.reply(`✅  Produk \`${sku}\` dimatikan (OFF).`, { parse_mode: "Markdown" });
  });

  bot.command("onproduk", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const sku = clean(ctx.message.text.split(" ")[1]);
    if (!sku) return ctx.reply("❌  Format: `/onproduk SKU`", { parse_mode: "Markdown" });
    await setProductActive(sku, true);
    globalThis.clearProductCache?.();
    return ctx.reply(`✅  Produk \`${sku}\` diaktifkan (ON).`, { parse_mode: "Markdown" });
  });

  // ==========================================
  // MARKUP HARGA INFO (Kini Terpusat di File)
  // ==========================================
  bot.command("cekmarkup", async (ctx) => {
    if (!isAdmin(ctx)) return;
    return ctx.reply("💡 *Info:* Aturan harga sekarang menggunakan sistem otomatis yang diatur melalui file `markup.js`. Silakan buka file tersebut di server untuk melihat atau mengubah nominal keuntungan.", { parse_mode: "Markdown" });
  });

  bot.command("setmarkup", async (ctx) => {
    if (!isAdmin(ctx)) return;
    return ctx.reply("❌ Command `/setmarkup` sudah dinonaktifkan.\n\n💡 Silakan edit file `markup.js` untuk mengatur harga bertingkat, simpan, lalu jalankan perintah `/sync force`.", { parse_mode: "Markdown" });
  });

  bot.action("adm_markup", async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery().catch(() => {});
    const text =
      `💰 *PENGATURAN HARGA AKTIF*\n\n` +
      `Sistem harga PPOB saat ini diatur menggunakan **Sistem Markup Bertingkat Otomatis** melalui file.\n\n` +
      `🔧 *Cara Mengubah Keuntungan:*\n` +
      `1. Buka file \`markup.js\` di VPS atau Editor Anda.\n` +
      `2. Ubah nominal keuntungan sesuai rentang modal yang diinginkan.\n` +
      `3. Simpan perubahan file.\n` +
      `4. Kembali ke bot dan ketik \`/sync force\` untuk menerapkan harga baru.\n\n` +
      `_Catatan: Pengaturan ini berlaku untuk semua produk kecuali yang harganya sudah dikunci manual via /editmargin._`;
    await ctx.editMessageText(text, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([[Markup.button.callback("⬅️ Kembali", "adm_back")]]),
    }).catch(() => {});
  });

  bot.action("adm_saldo", async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery().catch(() => {});
    const text =
      "💳 *SALDO USER*\nCommand:\n• `/ceksaldo ID`\n• `/addsaldo ID NOMINAL`\n• `/delsaldo ID NOMINAL`";
    await ctx
      .editMessageText(text, {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([[Markup.button.callback("⬅️ Kembali", "adm_back")]]),
      })
      .catch(() => {});
  });

  bot.command("ceksaldo", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const raw = clean(ctx.message.text.replace("/ceksaldo", ""));
    const targetId = raw
      ? Number(raw.split(" ")[0])
      : ctx.message.reply_to_message?.from?.id || ctx.from.id;

    const saldo = await getUserSaldo(targetId);
    return ctx.reply(`💰 Saldo ID \`${targetId}\`: *${formatRupiah(saldo)}*`, {
      parse_mode: "Markdown",
    });
  });

  bot.command("addsaldo", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const parts = ctx.message.text.trim().split(/\s+/);
    const target = Number(parts[1]);
    const nominal = Number(parts[2]);
    if (!target || !nominal)
      return ctx.reply("❌  Format: `/addsaldo ID NOMINAL`", { parse_mode: "Markdown" });

    await ensureUser(target);
    await creditSaldoUser(target, nominal);
    const now = await getUserSaldo(target);

    return ctx.reply(
      `✅  Add Saldo Sukses\nUser: \`${target}\`\n+ ${formatRupiah(nominal)}\nTotal: ${formatRupiah(
        now
      )}`,
      { parse_mode: "Markdown" }
    );
  });

  bot.command("delsaldo", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const parts = ctx.message.text.trim().split(/\s+/);
    const target = Number(parts[1]);
    const nominal = Number(parts[2]);
    if (!target || !nominal)
      return ctx.reply("❌  Format: `/delsaldo ID NOMINAL`", { parse_mode: "Markdown" });

    await ensureUser(target);
    const ok = await debitSaldoUser(target, nominal);
    const now = await getUserSaldo(target);

    if (!ok) return ctx.reply(`❌  Gagal. Saldo user: ${formatRupiah(now)}`);
    return ctx.reply(
      `✅  Potong Saldo Sukses\nUser: \`${target}\`\n- ${formatRupiah(nominal)}\nTotal: ${formatRupiah(
        now
      )}`,
      { parse_mode: "Markdown" }
    );
  });

  bot.action("adm_hist", async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery().catch(() => {});
    const text =
      "📑 HISTORY\nCommand:\n• /historitrx (opsional: ID)\n(Menampilkan riwayat pembelian & top up sekaligus)";
    await ctx
      .editMessageText(text, {
        ...Markup.inlineKeyboard([[Markup.button.callback("⬅️ Kembali", "adm_back")]]),
      })
      .catch(() => {});
  });

  bot.command("historitrx", async (ctx) => {
    if (!isAdmin(ctx)) return;

    const textInput = (ctx.message?.text || "").trim();
    const args = textInput.split(/\s+/);
    const targetUserId = args[1] ? Number(args[1]) : null;

    try {
      let orders, deposits;

      if (targetUserId) {
        orders = await all(`SELECT id, user_id, username, product_name as nama, target, price as nominal, status, created_at, 'ORDER' as tipe FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT 10`, [targetUserId]);
        deposits = await all(`SELECT id, user_id, '-' as username, 'Top Up Saldo' as nama, '-' as target, amount_base as nominal, status, created_at, 'TOPUP' as tipe FROM deposits WHERE user_id = ? ORDER BY id DESC LIMIT 10`, [targetUserId]);
      } else {
        orders = await all(`SELECT id, user_id, username, product_name as nama, target, price as nominal, status, created_at, 'ORDER' as tipe FROM orders ORDER BY id DESC LIMIT 10`);
        deposits = await all(`SELECT id, user_id, '-' as username, 'Top Up Saldo' as nama, '-' as target, amount_base as nominal, status, created_at, 'TOPUP' as tipe FROM deposits ORDER BY id DESC LIMIT 10`);
      }

      const gabungan = [...orders, ...deposits].sort((a, b) => {
        return new Date(b.created_at + "Z").getTime() - new Date(a.created_at + "Z").getTime();
      });

      if (!gabungan.length) return ctx.reply("📭 Data Kosong");

      const formatWIB = (dateStr) => {
        if (!dateStr) return "-";
        try {
          let raw = dateStr.replace(" ", "T");
          if (!raw.endsWith("Z")) raw += "Z";
          return new Date(raw).toLocaleString("id-ID", {
            timeZone: "Asia/Jakarta",
            day: "2-digit", month: "2-digit", year: "2-digit",
            hour: "2-digit", minute: "2-digit", hour12: false
          }).replace(/\./g, ':');
        } catch (e) { return dateStr; }
      };

      let headerUname = "";
      if (targetUserId) {
        const found = orders.find(o => o.username && o.username !== '-');
        headerUname = found ? ` (${found.username})` : " (Tanpa Username)";
      }

      const targetInfo = targetUserId ? `\n👤 User ID: <code>${targetUserId}</code>${headerUname}` : `\n🌐 Semua User`;
      let pesan = `📜 <b>MUTASI TRANSAKSI</b>${targetInfo}\n━━━━━━━━━━━━━━━━━━\n\n`;

      gabungan.slice(0, 15).forEach((trx) => {
        const waktu = formatWIB(trx.created_at);
        const isSukses = trx.status === 'SUCCESS' || trx.status === 'PAID';
        const isGagal = trx.status === 'FAILED' || trx.status === 'EXPIRED' || trx.status === 'CANCELED';
        
        const icon = isSukses ? '✅' : (isGagal ? '❌' : '⏳');
        const simbol = trx.tipe === 'TOPUP' ? '➕' : '➖';
        const namaAman = (trx.nama || "Produk").substring(0, 22);

        pesan += `${icon} <b>${namaAman}</b>\n`;
        
        if (!targetUserId) {
          const uText = trx.username && trx.username !== '-' ? ` | ${trx.username}` : '';
          pesan += `      👤 User: <code>${trx.user_id}</code>${uText}\n`;
        }
        
        if (trx.tipe === 'ORDER' && trx.target) {
            pesan += `      🎯 Target: <code>${trx.target}</code>\n`;
        }

        pesan += `      ${simbol} Rp ${trx.nominal.toLocaleString('id-ID')}\n`;
        pesan += `      📅 ${waktu} | Sts: <b>${trx.status}</b>\n\n`;
      });

      return ctx.reply(pesan, { parse_mode: "HTML" });
    } catch (e) {
      console.error("[HISTORITRX ERROR]", e);
      return ctx.reply("❌ Error menarik data riwayat.");
    }
  });

  bot.action("adm_maint", async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery().catch(() => {});
    await ctx
      .editMessageText("🔧 *MAINTENANCE*", {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🔴 ON", "mt_on"), Markup.button.callback("🟢 OFF", "mt_off")],
          [Markup.button.callback("🧹 Clear Log", "adm_clear_btn")],
          [Markup.button.callback("⬅️ Kembali", "adm_back")],
        ]),
      })
      .catch(() => {});
  });

  bot.command("maintenance", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const arg = (ctx.message.text || "").toLowerCase().split(" ")[1];
    if (arg === "on") {
      global.MAINTENANCE_MODE = true;
      return ctx.reply("✅  Maintenance ON");
    } else if (arg === "off") {
      global.MAINTENANCE_MODE = false;
      return ctx.reply("✅  Maintenance OFF");
    }
    return ctx.reply("❌  Format: `/maintenance on` atau `off`", { parse_mode: "Markdown" });
  });

  bot.command("maintxt", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const msg = (ctx.message.text || "").replace("/maintxt", "").trim();
    if (!msg) return ctx.reply("❌  Isi pesan maintenance.");
    global.MAINTENANCE_MESSAGE = msg;
    return ctx.reply("✅  Pesan maintenance diupdate.");
  });

  const doClearLog = (replyFn) => {
    exec("pm2 flush", (err) => {
      if (err) replyFn("❌  Gagal membersihkan log");
      else replyFn("✅  Log dibersihkan!");
    });
  };

  bot.command("clearlog", (ctx) => isAdmin(ctx) && doClearLog((t) => ctx.reply(t)));

  bot.action("adm_clear_btn", async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery().catch(() => {});
    doClearLog((t) => ctx.answerCbQuery(t, { show_alert: true }).catch(() => {}));
  });

  bot.action("mt_on", async (ctx) => {
    if (!isAdmin(ctx)) return;
    global.MAINTENANCE_MODE = true;
    await ctx.answerCbQuery("Maintenance ON").catch(() => {});
  });

  bot.action("mt_off", async (ctx) => {
    if (!isAdmin(ctx)) return;
    global.MAINTENANCE_MODE = false;
    await ctx.answerCbQuery("Maintenance OFF").catch(() => {});
  });

  bot.action("adm_bc", async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery().catch(() => {});
    await ctx.reply("📢 *Info Broadcast*\nReply pesan chat, lalu ketik `/broadcast`", {
      parse_mode: "Markdown",
    });
  });

  bot.command("broadcast", async (ctx) => {
    if (!isAdmin(ctx)) return;
    if (!ctx.message.reply_to_message) return ctx.reply("❌  Reply pesan dulu!");

    const users = await all("SELECT user_id FROM users");
    const msg = ctx.message.reply_to_message;

    let success = 0;
    await ctx.reply(`🚀 Mengirim ke ${users.length} user...`);

    const CHUNK = 20;
    for (let i = 0; i < users.length; i += CHUNK) {
      const batch = users.slice(i, i + CHUNK);
      await Promise.all(
        batch.map((u) =>
          bot.telegram
            .copyMessage(u.user_id, msg.chat.id, msg.message_id)
            .then(() => success++)
            .catch((err) => console.log(`Gagal kirim ke ${u.user_id}:`, err.message))
        )
      );
      await new Promise((r) => setTimeout(r, 1000));
    }

    return ctx.reply(`✅  Broadcast Selesai. Sukses: ${success}`);
  });

  async function sendBackup(ctx) {
    try {
      const fileName = `backup-${Date.now()}.db`;
      const dbPath = require("path").join(__dirname, "..", "ppob.db");
      await ctx.replyWithDocument({ source: dbPath, filename: fileName }, { caption: "📂 Backup Database" });
      
      const dirPath = require("path").join(__dirname, "..");
      const files = fs.readdirSync(dirPath);
      const zipFiles = files.filter(f => f.endsWith(".zip"));
      for (const zip of zipFiles) {
         await ctx.replyWithDocument({ source: require("path").join(dirPath, zip), filename: zip }, { caption: "📦 Backup ZIP (Source Code)" });
      }
    } catch (e) {
      await ctx.reply("❌  Gagal backup: " + (e?.message || e));
    }
  }

  bot.action("adm_backup", async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery("Mengumpulkan data backup...").catch(() => {});
    return sendBackup(ctx);
  });

  bot.command("backup", async (ctx) => {
    if (!isAdmin(ctx)) return;
    return sendBackup(ctx);
  });

  bot.action("adm_back", async (ctx) => {
    if (!isAdmin(ctx)) return;
    return editOrReplyAdminMenu(ctx);
  });
  
  bot.action("cek_saldo_server", async (ctx) => {
    if (!isAdmin(ctx)) return;
    
    await ctx.answerCbQuery("⏳ Menghubungi Digiflazz...").catch(() => {});
    const waitMsg = await ctx.reply("⏳ Sedang mengambil data saldo dari pusat...");
    
    try {
        const res = await digiflazzCekSaldo();
        
        if (res.ok) {
            const sisaSaldo = Number(res.deposit || 0);
            const pesan = 
              `🏦 *INFO SALDO SERVER*\n\n` +
              `💰 *Saldo Digiflazz:* ${formatRupiah(sisaSaldo)}\n\n` +
              `_Cek terakhir: ${new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })} WIB_`;

            await ctx.telegram.editMessageText(
                ctx.chat.id, waitMsg.message_id, undefined, pesan, { parse_mode: "Markdown" }
            ).catch(() => {});
        } else {
            await ctx.telegram.editMessageText(
                ctx.chat.id, waitMsg.message_id, undefined, `❌ Gagal cek saldo server.\nRespon: ${res.message || "Error pusat"}`
            ).catch(() => {});
        }
    } catch (e) {
        console.error("[CEK SERVER] Error:", e);
        await ctx.telegram.editMessageText(
            ctx.chat.id, waitMsg.message_id, undefined, "❌ Kesalahan sistem saat cek saldo server."
        ).catch(() => {});
    }
  });
  
  bot.action("topup_server_info", async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery().catch(() => {});
    const text = 
      "💳 *TOP UP SALDO SERVER*\n\n" +
      "Caranya gampang bos:\n" +
      "Ketik command: `/tiket NOMINAL BANK NAMA` \n\n" +
      "Contoh: `/tiket 500000 BCA XYZ-STORE` \n\n" +
      "*Pilihan Bank:* BCA, MANDIRI, BRI, BNI";
    
    return ctx.reply(text, { parse_mode: "Markdown" });
  });

  bot.command("tiket", async (ctx) => {
    if (!isAdmin(ctx)) return;
    
    const args = ctx.message.text.split(" ");
    if (args.length < 4) {
      return ctx.reply("❌ Format salah! \nContoh: `/tiket 500000 BCA NAMA_PEMILIK`", { parse_mode: "Markdown" });
    }

    const amount = args[1];
    const bank = args[2].toUpperCase();
    const owner = args.slice(3).join(" "); 

    const waitMsg = await ctx.reply(`⏳ Sedang merequest tiket deposit ${bank}...`);

    try {
      const { digiflazzTiketDeposit } = require("../modules/digiflazz"); 
      const res = await digiflazzTiketDeposit(amount, bank, owner);

      if (res.ok && res.data.rc === "00") {
        const d = res.data;
        const norek = d.account_no ? d.account_no : "Cek catatan di bawah";
        const instruksi = d.notes ? d.notes : "Silakan transfer ke nomor Rekening/VA di atas.";

        const pesan = 
          "✅ *TIKET DEPOSIT BERHASIL*\n" +
          "━━━━━━━━━━━━━━━━━━━\n" +
          `💰 Nominal: *${formatRupiah(d.amount)}*\n` +
          `🏦 Metode: *${d.bank}*\n` +
          `🔢 No. Rek/VA: \`${norek}\`\n\n` +
          `📝 *Catatan:*\n_${instruksi}_\n` +
          "━━━━━━━━━━━━━━━━━━━\n" +
          `⚠️ *PENTING:* Transfer harus *PERSIS* sesuai nominal di atas agar saldo masuk otomatis!`;

        await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, pesan, { parse_mode: "Markdown" });
      } else {
        await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, `❌ Gagal: ${res.data?.message || res.message}`);
      }
    } catch (e) {
      console.error(e);
      await ctx.reply("❌ Terjadi kesalahan sistem.");
    }
  });

  bot.action("adm_close", async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery().catch(() => {});
    return ctx.deleteMessage().catch(() => {});
  });
};

