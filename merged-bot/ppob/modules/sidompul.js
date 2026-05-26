// modules/sidompul.js
const axios = require("axios");
require("dotenv").config();
const { run, get } = require("./database"); // Panggil database
const { htmlToText } = require("./helpers"); // Panggil helper yg tadi kita buat

// CONFIG SIDOMPUL
const SIDOMPUL_API_KEY = process.env.SIDOMPUL_API_KEY || "";
const SIDOMPUL_URL = "https://apigw.kmsp-store.com/sidompul/v4/cek_kuota";
const SIDOMPUL_AUTH = "Basic c2lkb21wbXNw"; // Auth dari bot.js

// CONFIG LIMIT
const KUOTA_LIMIT_MAX = 3;
const KUOTA_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 jam

async function sidompulCekKuota(msisdn) {
  if (!SIDOMPUL_API_KEY) {
    return { ok: false, message: "SIDOMPUL_API_KEY belum di-set" };
  }

  try {
    const { data } = await axios.get(SIDOMPUL_URL, {
      params: { msisdn, isJSON: "true" },
      headers: {
        Authorization: "Basic c2lkb21wdWxhcGk6YXBpZ3drbXNw", // Header sesuai bot.js lama
        "X-API-Key": SIDOMPUL_API_KEY,
        "X-App-Version": "4.0.0",
        Accept: "application/json",
      },
      timeout: 30000,
    });

    const hasilHtml = data?.data?.hasil || data?.hasil || "";
    const hasilText = htmlToText(hasilHtml);

    if (!hasilText) {
      return { ok: false, message: "Hasil kosong dari API. Coba lagi." };
    }

    const lower = hasilText.toLowerCase();
    const isXlAxis = lower.includes("xl") || lower.includes("axis");

    if (!isXlAxis) {
      return {
        ok: false,
        message: "Nomor ini terdeteksi bukan XL/AXIS (atau format hasil tidak sesuai).",
      };
    }

    return { ok: true, text: hasilText, raw: data };
  } catch (e) {
    const msg = e?.response?.data
      ? JSON.stringify(e.response.data).slice(0, 300)
      : (e?.message || "Request gagal");
    return { ok: false, message: msg };
  }
}

async function consumeKuotaLimit(msisdn) {
  const now = Date.now();

  const row = await get(
    `SELECT msisdn, count, reset_at
     FROM kuota_limits
     WHERE msisdn = ?
     LIMIT 1`,
    [msisdn]
  );

  if (!row || now >= Number(row.reset_at || 0)) {
    const resetAt = now + KUOTA_LIMIT_WINDOW_MS;

    await run(
      `INSERT INTO kuota_limits (msisdn, count, reset_at)
       VALUES (?, 1, ?)
       ON CONFLICT(msisdn) DO UPDATE SET count = 1, reset_at = excluded.reset_at`,
      [msisdn, resetAt]
    );

    return { ok: true, remaining: KUOTA_LIMIT_MAX - 1, resetAt };
  }

  const count = Number(row.count || 0);
  const resetAt = Number(row.reset_at || 0);

  if (count >= KUOTA_LIMIT_MAX) {
    return { ok: false, waitMs: resetAt - now, resetAt };
  }

  await run(
    `UPDATE kuota_limits
     SET count = count + 1
     WHERE msisdn = ?`,
    [msisdn]
  );

  return { ok: true, remaining: KUOTA_LIMIT_MAX - (count + 1), resetAt };
}

module.exports = {
  sidompulCekKuota,
  consumeKuotaLimit,
  KUOTA_LIMIT_MAX // Export konstanta kalau butuh ditampilkan di teks bot
};

