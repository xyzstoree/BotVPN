const { Markup } = require("telegraf");

// Daftar Kategori (Key WAJIB sama persis dengan Digiflazz, Label bebas untuk tampilan di bot)
const CATEGORIES = [
  { key: "Data", label: "📦 Paket Data" },
  { key: "Pulsa", label: "📞 Pulsa" },
  { key: "PLN", label: "⚡ Token PLN" },
  { key: "E-Money", label: "💳 E-Wallet" },
  { key: "Aktivasi Voucher", label: "🎫 Aktivasi" },
  { key: "Masa Aktif", label: "⌛ Masa Aktif" },
  { key: "Games", label: "🎮 Games" },
  { key: "Paket SMS & Telpon", label: "📨 SMS & Tlp" },
];

function kbStartMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("MENU UTAMA", "go_ppob")],
  ]);
}

function kbPpobMenu() {
  const rows = [];
  // Loop 2 kolom
  for (let i = 0; i < CATEGORIES.length; i += 2) {
    const left = CATEGORIES[i];
    const right = CATEGORIES[i + 1];
    const row = [Markup.button.callback(left.label, `cat:${left.key}`)];
    if (right) row.push(Markup.button.callback(right.label, `cat:${right.key}`));
    rows.push(row);
  }

  rows.push([Markup.button.callback("💰 ISI SALDO", "menu_topup")]);
  rows.push([
    Markup.button.callback("⭐ Favorit", "fav_menu"),
    Markup.button.callback("📦 Riwayat", "history_menu")
  ]);
  rows.push([
    Markup.button.callback("📱 Cek Kuota", "cek_kuota"),
    Markup.button.url("📘 Panduan", "https://t.me/chnlxyz/97")
  ]);
  rows.push([
    Markup.button.url("👤 Hub. Admin", "https://t.me/xyztunnn"),
    Markup.button.url("👤 Bot VPN", "https://t.me/xyzstorevpnbot?start=from_ppob"),
  ]);

  return Markup.inlineKeyboard(rows);
}

function kbQuickTopup() {
  const presets = [
    { label: "2k", amount: 2000 },
    { label: "3k", amount: 3000 },
    { label: "4k", amount: 4000 },
    { label: "5k", amount: 5000 },
    { label: "10k", amount: 10000 },
    { label: "20k", amount: 20000 },
    { label: "30k", amount: 30000 },
    { label: "40k", amount: 40000 },
  ];

  const buttons = presets.map((p) =>
    Markup.button.callback(p.label, `topup_amt:${p.amount}`)
  );

  // Bagi jadi 2 baris (4 tombol per baris)
  const row1 = buttons.slice(0, 4);
  const row2 = buttons.slice(4, 8);

  return Markup.inlineKeyboard([
    row1,
    row2,
    [Markup.button.callback("✍️ Nominal Lain", "topup_manual")],
    [Markup.button.callback("❌ Batal", "cancel_topup")],
  ]);
}

// Export fungsinya + CATEGORIES
module.exports = {
  CATEGORIES,
  kbStartMenu,
  kbPpobMenu,
  kbQuickTopup
};

