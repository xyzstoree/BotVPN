// File: handlers/historyHandler.js

const { Markup } = require("telegraf");
const { get, all } = require("../modules/database");
const { formatRupiah, displayOrderId } = require("../modules/helpers");

module.exports = function (bot) {
  
  // ==========================================
  // HELPER FORMAT WAKTU & EDIT
  // ==========================================
  const formatTimeWIB = (dateStr) => {
    if (!dateStr) return "-";
    try {
      let raw = dateStr.replace(" ", "T");
      if (!raw.endsWith("Z")) raw += "Z";
      return new Date(raw).toLocaleString("id-ID", {
        timeZone: "Asia/Jakarta",
        day: "2-digit", month: "2-digit", year: "numeric",
        hour: "2-digit", minute: "2-digit", hour12: false
      }).replace(/\./g, ':');
    } catch (e) { return dateStr; }
  };

  const formatJamWIB = (dateStr) => {
    if (!dateStr) return "-";
    try {
      let raw = dateStr.replace(" ", "T");
      if (!raw.endsWith("Z")) raw += "Z";
      return new Date(raw).toLocaleTimeString("id-ID", {
        timeZone: "Asia/Jakarta",
        hour: "2-digit", minute: "2-digit", hour12: false
      }).replace(/\./g, ':');
    } catch (e) { return "00:00"; }
  };

  async function editOrReplace(ctx, text, extra) {
    try {
      return await ctx.editMessageText(text, extra);
    } catch (e) {
      const msg = (e?.description || "").toLowerCase();
      if (msg.includes("message is not modified")) {
        return ctx.answerCbQuery().catch(() => {});
      }
      return ctx.reply(text, extra).catch(() => {});
    }
  }

  function displayDepositId(id) {
    return `DEP-${id}`;
  }

  // ==========================================
  // 1. MENU UTAMA RIWAYAT
  // ==========================================
  bot.action(["last_orders", "history_menu"], async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const rows = [
      [
        Markup.button.callback("Pemesanan", "history_orders"),
        Markup.button.callback("Deposit", "history_topup"),
      ],
      [Markup.button.callback("⬅️ Kembali", "go_ppob")],
    ];

    const text = "*📜 RIWAYAT!*\n\nPilih riwayat yang mau kamu lihat:";
    return editOrReplace(ctx, text, { parse_mode: "Markdown", ...Markup.inlineKeyboard(rows) });
  });

  // ==========================================
  // 2. DAFTAR TRANSAKSI (10 TERAKHIR)
  // ==========================================
  bot.action("history_orders", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const userId = ctx.from.id;

    // Ambil data langsung pakai query
    const rowsData = await all(
      `SELECT id,status,product_name,sku,target,price,sn,message,updated_at,created_at
       FROM orders WHERE user_id=? ORDER BY id DESC LIMIT 10`,
      [userId]
    );

    if (!rowsData || rowsData.length === 0) {
      return editOrReplace(ctx, "🧾 *Riwayat Transaksi*\n\nBelum ada transaksi.", {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([[Markup.button.callback("⬅️ Kembali", "history_menu")]]),
      });
    }

    const rows = rowsData.map((o) => {
      let pName = o.product_name || o.sku || "Item";
      if (pName.length > 18) pName = pName.substring(0, 16) + "..";
      
      const st = String(o.status || "-").toUpperCase();
      let icon = "⏳";
      if (st === "SUCCESS") icon = "✅";
      if (st === "FAILED" || st === "CANCELED") icon = "❌";

      const jam = formatJamWIB(o.created_at);
      return [Markup.button.callback(`${jam} • ${pName} ${icon}`, `hist_order:${o.id}`)];
    });

    rows.push([Markup.button.callback("⬅️ Menu Riwayat", "history_menu")]);
    const text = "🧾 *Riwayat Transaksi (10 Terakhir)*\nKlik tombol untuk detail:";

    return editOrReplace(ctx, text, { parse_mode: "Markdown", ...Markup.inlineKeyboard(rows) });
  });

  // ==========================================
  // 3. DETAIL TRANSAKSI PPOB (RESI)
  // ==========================================
  bot.action(/^hist_order:(\d+)$/i, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const orderId = Number(ctx.match[1]);
    const userId = ctx.from.id;

    const o = await get(`SELECT * FROM orders WHERE id=? AND user_id=? LIMIT 1`, [orderId, userId]);

    if (!o) {
      return editOrReplace(ctx, "❌ Transaksi tidak ditemukan.", {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([[Markup.button.callback("⬅️ Kembali", "history_orders")]]),
      });
    }

    const prodName = (o.product_name || o.sku || "-").slice(0, 20);
    const trg = o.target || "-";
    const prc = formatRupiah(o.price);
    const time = formatTimeWIB(o.created_at);
    const ref = o.ref_id || displayOrderId(o.id);
    const snToken = o.sn || "-";
    const msgProvider = o.message ? `Info: ${o.message.slice(0, 50)}` : "";

    let stIcon = "⏳";
    let statusStr = String(o.status || "PENDING").toUpperCase();
    if (statusStr === "SUCCESS") { stIcon = "✅"; statusStr = "SUKSES"; }
    else if (statusStr === "FAILED") { stIcon = "❌"; statusStr = "GAGAL"; }
    else { statusStr = "PENDING / PROSES"; }

    const receiptLines = [
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      "      🧾 DETAIL TRANSAKSI",
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      `📦 Produk     : ${prodName}`,
      `🎯 Tujuan     : ${trg}`,
      `💰 Harga      : ${prc}`,
      `🕒 Waktu      : ${time}`,
      "",
      "🆔 ID Reff    :",
      `${ref}`,
      "🔑 SN/Token   :",
      `${snToken}`,
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      `${stIcon} Status     : ${statusStr}`,
      (msgProvider ? `📝 ${msgProvider}` : ""),
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    ];

    const finalMsg = "```\n" + receiptLines.join("\n") + "\n```";

    return editOrReplace(ctx, finalMsg, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
          [
            Markup.button.callback("⬅️ Kembali", "history_orders"),
            Markup.button.callback("🏠 Menu PPOB", "go_ppob")
          ]
      ]),
    });
  });

  // ==========================================
  // 4. DETAIL DEPOSIT / TOP UP (RESI)
  // ==========================================
  bot.action(/^hist_dep:(\d+)$/i, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const depId = Number(ctx.match[1]);
    const userId = ctx.from.id;
    
    const d = await get(`SELECT * FROM deposits WHERE id=? AND user_id=? LIMIT 1`, [depId, userId]);

    if (!d) {
      return editOrReplace(ctx, "❌ Top up tidak ditemukan.", {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([[Markup.button.callback("⬅️ Kembali", "history_topup")]]),
      });
    }

    const idTopup = displayDepositId(d.id);
    const nominal = formatRupiah(d.amount_base);
    const kodeUnik = d.kode_unik || d.admin_fee || 0;
    const totalBayar = formatRupiah(d.amount_final);
    const waktuBuat = formatTimeWIB(d.created_at);
    const waktuBayar = d.paid_at ? formatTimeWIB(d.paid_at) : "-";

    let stIcon = "⏳";
    let statusStr = String(d.status || "-").toUpperCase();
    if (statusStr === "PAID" || statusStr === "SUCCESS") { 
        stIcon = "✅"; statusStr = "BERHASIL"; 
    } else if (statusStr === "EXPIRED" || statusStr === "CANCELED") { 
        stIcon = "❌"; statusStr = "KADALUARSA"; 
    } else {
        statusStr = "MENUNGGU BAYAR";
    }

    const receiptLines = [
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      "      💳 DETAIL DEPOSIT",
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      `🧾 ID TopUp   : ${idTopup}`,
      `💵 Nominal    : ${nominal}`,
      `🔢 Kode Unik  : ${kodeUnik}`,
      `💰 Total Bayar: ${totalBayar}`,
      `🕒 Dibuat     : ${waktuBuat}`,
      `🕒 Dibayar    : ${waktuBayar}`,
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      `${stIcon} Status     : ${statusStr}`,
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    ];

    const finalMsg = "```\n" + receiptLines.join("\n") + "\n```";

    return editOrReplace(ctx, finalMsg, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("⬅️ Kembali", "history_topup")],
        [Markup.button.callback("🏠 Menu PPOB", "go_ppob")],
      ]),
    });
  });

};

