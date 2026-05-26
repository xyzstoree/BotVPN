// modules/digiflazz.js
const axios = require("axios");
const crypto = require("crypto");

// Ambil config dari env
const USERNAME = process.env.DIGIFLAZZ_USERNAME || "";
const APIKEY = process.env.DIGIFLAZZ_APIKEY || "";
const ENDPOINT = "https://api.digiflazz.com/v1/transaction";
const ENDPOINT_SALDO = "https://api.digiflazz.com/v1/cek-saldo";
const TESTING = /^true$/i.test(String(process.env.DIGIFLAZZ_TESTING || "").trim());

function md5hex(s) {
  return crypto.createHash("md5").update(String(s), "utf8").digest("hex");
}

// Fungsi Topup / Transaksi
async function digiflazzTopup({ buyer_sku_code, customer_no, ref_id }) {
  if (!USERNAME || !APIKEY) {
    return { ok: false, error: "DIGIFLAZZ env belum diset" };
  }

  const sign = md5hex(USERNAME + APIKEY + String(ref_id));
  const payload = {
    username: USERNAME,
    buyer_sku_code,
    customer_no,
    ref_id,
    sign,
  };

  if (TESTING) payload.testing = true;

  try {
    const { data } = await axios.post(ENDPOINT, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: 45000, // Timeout agak lama biar aman
    });
    return { ok: true, data: data?.data || data };
  } catch (e) {
    return { ok: false, error: e?.response?.data || e.message };
  }
}

// Fungsi Cek Saldo
async function digiflazzCekSaldo() {
  if (!USERNAME || !APIKEY) {
    return { ok: false, error: "DIGIFLAZZ env belum diset" };
  }

  const sign = md5hex(USERNAME + APIKEY + "depo");
  try {
    const { data } = await axios.post(
      ENDPOINT_SALDO,
      { cmd: "deposit", username: USERNAME, sign },
      { headers: { "Content-Type": "application/json" }, timeout: 30000 }
    );
    return { ok: true, deposit: Number(data?.data?.deposit || 0), raw: data };
  } catch (e) {
    return { ok: false, error: e?.response?.data || e.message };
  }
}
// Tambahkan di modules/digiflazz.js
async function digiflazzTiketDeposit(amount, bank, ownerName) {
  try {
    const username = process.env.DIGIFLAZZ_USERNAME;
    const apiKey = process.env.DIGIFLAZZ_APIKEY;
    const crypto = require("crypto");
    const sign = crypto.createHash("md5").update(username + apiKey + "deposit").digest("hex");

    const resp = await axios.post("https://api.digiflazz.com/v1/deposit", {
      username: username,
      amount: Number(amount),
      bank: bank,
      owner_name: ownerName,
      sign: sign
    });

    return { ok: true, data: resp.data.data };
  } catch (e) {
    return { ok: false, message: e.response?.data?.data?.message || e.message };
  }
}

// Export fungsinya
module.exports = { digiflazzTopup, digiflazzCekSaldo, digiflazzTiketDeposit };

