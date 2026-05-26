const axios = require("axios");

async function kmspCekIndosat(msisdn) {
  try {
    // Pastikan awalan nomor adalah 62
    let target = msisdn;
    if (target.startsWith("0")) target = "62" + target.slice(1);

    const res = await axios.post(
      "https://misc-api.kmsp-store.com/simple-api/quota/v1/check",
      { msisdn: target },
      {
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        timeout: 15000 // Batas waktu 15 detik
      }
    );

    if (!res.data || !res.data.status) {
      return { ok: false, message: res.data?.message || "Gagal mengambil data dari KMSP" };
    }

    const cust = res.data.data?.customer || {};
    const pkgs = res.data.data?.packages || [];

    // --- RAKIT TAMPILAN HTML DI SINI BIAR BOT.JS BERSIH ---
    let hasil = `╭──────────────────╮\n`;
    hasil += `│  🟡 <b>CEK KUOTA INDOSAT</b>\n`;
    hasil += `╰──────────────────╯\n`;
    hasil += `📞 <b>Nomor:</b> <code>${cust.msisdn || msisdn}</code>\n`;
    hasil += `💳 <b>Status:</b> ${cust.status || "-"}\n`;
    hasil += `💰 <b>Pulsa:</b> ${cust.balance?.text || "Rp 0"}\n`;
    hasil += `━━━━━━━━━━━━━━━━━━\n\n`;

    if (pkgs.length === 0) {
      hasil += `📭 <i>Tidak ada paket aktif.</i>`;
    } else {
      pkgs.forEach((p, i) => {
        hasil += `📦 <b>${p.title || "Paket Data"}</b>\n`;
        hasil += `📅 Aktif: ${p.activated_at || "-"}\n`;
        hasil += `⚠️ Exp: ${p.ended_at || "-"}\n`;
        
        if (p.items && p.items.length > 0) {
          p.items.forEach(item => {
            hasil += `   ├ <b>${item.name || "-"}</b>\n`;
            hasil += `   └ Sisa: <code>${item.remaining_text || "-"}</code>\n`;
          });
        }
        if (i !== pkgs.length - 1) hasil += `\n`;
      });
    }

    return { ok: true, text: hasil };
  } catch (e) {
    console.error("[KMSP INDOSAT ERROR]", e.message);
    return { ok: false, message: "Sistem Pengecekan Indosat Sedang Gangguan." };
  }
}

module.exports = { kmspCekIndosat };

