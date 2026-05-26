// Webhook router untuk PPOB.
// SUDAH DIREFAKTOR untuk merged bot:
// - Tidak lagi membuat express server sendiri.
// - Mendaftarkan route ke `app` Express yang dishare oleh master entry.
// - express.raw() dipasang per-route supaya TIDAK konflik dengan
//   express.json()/middleware lain yang dipakai modul VPN.

const express = require("express");
const crypto = require("crypto");
const { get } = require("../modules/database");
const { formatRupiah, fmtDateTimeID, escapeHtml } = require("../modules/helpers");

module.exports = function (bot, app, callbacks) {
  // Ekstrak fungsi-fungsi yang di-passing dari bot.js
  const {
    handleDigiflazzWebhook,
    processOrderAfterDirectPayment,
    lockAndMarkDepositPaid,
    creditSaldoUser,
    getUserSaldo,
    getTgUserLabel,
    safeSendMessage,
    sendToGroup,
  } = callbacks;

  // Raw parser khusus untuk webhook (perlu HMAC verification atas raw body)
  const rawJsonParser = express.raw({ type: "application/json" });

  // ─── ENHANCED WEBHOOK SIGNATURE VERIFICATION (FIX: Security) ─────────────
  function digiflazzVerifySignature(rawBody, signature) {
    try {
      if (!signature) {
        console.error("[WEBHOOK SECURITY] Missing signature header");
        return false;
      }

      const secret = (process.env.DIGIFLAZZ_WEBHOOK_SECRET || "").trim();
      if (!secret) {
        console.error("[WEBHOOK SECURITY] CRITICAL - DIGIFLAZZ_WEBHOOK_SECRET not configured!");
        // SECURITY: Jangan terima webhook jika secret tidak diset
        throw new Error("Webhook secret not configured");
      }

      const bodyBuf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody || "", "utf8");
      const hmacHex = crypto.createHmac("sha1", secret).update(bodyBuf).digest("hex");
      const expected = `sha1=${hmacHex}`;
      const a = Buffer.from(String(signature));
      const b = Buffer.from(String(expected));

      if (a.length !== b.length) {
        console.error("[WEBHOOK SECURITY] Signature length mismatch");
        return false;
      }

      const isValid = crypto.timingSafeEqual(a, b);
      if (!isValid) {
        console.error("[WEBHOOK SECURITY] Invalid signature detected - possible attack!");
      }

      return isValid;
    } catch (e) {
      console.error("[WEBHOOK SECURITY] Verification error:", e.message);
      return false;
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  // ==========================================
  // WEBHOOK DIGIFLAZZ
  // ==========================================
  app.post("/digiflazz/webhook", rawJsonParser, async (req, res) => {
    try {
      const sig = req.headers["x-hub-signature"] || req.get("x-hub-signature");
      if (!digiflazzVerifySignature(req.body, sig)) return res.status(401).send("invalid signature");
      const payload = JSON.parse(req.body.toString());
      await handleDigiflazzWebhook(payload.data || payload, req.headers);
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).send("error");
    }
  });

  // ==========================================
  // WEBHOOK AUTOGOPAY (ENHANCED SECURITY)
  // ==========================================
  app.post("/webhook/gopay", rawJsonParser, async (req, res) => {
    try {
      const signature = req.headers["x-signature"] || req.headers["X-Signature"];
      const apiKey = (process.env.AUTOGOPAY_TOKEN || process.env.AUTOGOPAY_API_KEY || "").trim();

      // ─── SECURITY: Validate API Key exists ───────────────────────────────────
      if (!apiKey) {
        console.error("[WEBHOOK GOPAY] CRITICAL - API Key not configured!");
        return res.status(500).json({ error: "Server misconfigured" });
      }
      // ─────────────────────────────────────────────────────────────────────────

      let rawPayload = "";
      if (Buffer.isBuffer(req.body)) rawPayload = req.body.toString("utf8");
      else if (typeof req.body === "object") rawPayload = JSON.stringify(req.body);
      else rawPayload = String(req.body);

      const expectedSignature = crypto.createHmac("sha256", apiKey).update(rawPayload).digest("hex");

      if (signature !== expectedSignature) {
        console.error("[WEBHOOK GOPAY] Invalid signature - possible attack!");
        return res.status(401).json({ error: "Invalid" });
      }

      const data = JSON.parse(rawPayload);
      if (data.event === "verification.challenge") return res.status(200).json({ success: true });

      if (data.event === "transaction.received") {
        const trx = data.transaction || data.data || data || {};
        const status = String(trx.status || trx.transaction_status || "").toLowerCase();
        const amount = Number(trx.amount || data.amount || 0);
        const transactionId = String(trx.id || trx.transaction_id || trx.reference || `trx_${Date.now()}`);

        if (["settlement", "paid", "success", "settled"].includes(status)) {
          if (amount <= 0) return res.status(200).json({ success: true });

          // ─── IDEMPOTENCY CHECK (FIX: Prevent Double Processing) ──────────────
          const isExist = await get(`SELECT id FROM deposits WHERE trx_key=? LIMIT 1`, [transactionId]);
          if (isExist) {
            console.log(`[WEBHOOK GOPAY] Transaction ${transactionId} already processed (idempotency)`);
            return res.status(200).json({ success: true });
          }
          // ─────────────────────────────────────────────────────────────────────

          const pending = await get(
            `SELECT * FROM deposits WHERE status='PENDING' AND amount_final=? ORDER BY id ASC LIMIT 1`,
            [amount]
          );

          if (pending) {
            const locked = await lockAndMarkDepositPaid(pending.id, transactionId);
            if (locked) {
              if (pending.msg_id) {
                await bot.telegram.deleteMessage(pending.user_id, pending.msg_id).catch(() => {});
              }

              if (String(pending.kind || "").toUpperCase() === "DIRECT") {
                await processOrderAfterDirectPayment(pending.order_id);
              } else {
                await creditSaldoUser(pending.user_id, pending.amount_base);
                const saldoBaru = await getUserSaldo(pending.user_id);
                const unamePlain = await getTgUserLabel(pending.user_id, "plain");
                const tgl = fmtDateTimeID(new Date());

                const msgUser =
                  `✅ <b>Pembayaran Terdeteksi!</b>\n` +
                  `━━━━━━━━━━━━━━━━━━━━\n` +
                  `💵 <b>Nominal :</b> ${formatRupiah(pending.amount_base)}\n` +
                  `💰 <b>Saldo Akhir :</b> ${formatRupiah(saldoBaru)}\n` +
                  `📅 <b>Waktu :</b> ${tgl}\n` +
                  `━━━━━━━━━━━━━━━━━━━━\n` +
                  `<i>Saldo otomatis ditambahkan.\nKlik /menu untuk transaksi!</i>`;

                await safeSendMessage(pending.user_id, msgUser, { parse_mode: "HTML" }).catch(() => {});

                const msgGroup =
                  `<pre>💰 TOP UP PPOB BERHASIL\n` +
                  `━━━━━━━━━━━━━━━━━━━━\n` +
                  `👤 User       : ${escapeHtml(unamePlain.replace("@", ""))}\n` +
                  `🆔 User ID    : ${pending.user_id}\n` +
                  `💵 Nominal    : ${formatRupiah(pending.amount_base)}\n` +
                  `💰 Saldo Baru : ${formatRupiah(saldoBaru)}\n` +
                  `📅 Waktu      : ${tgl}\n` +
                  `━━━━━━━━━━━━━━━━━━━━</pre>`;

                await sendToGroup(msgGroup, { parse_mode: "HTML" }).catch(() => {});
              }
            }
          }
        }
      }
      return res.status(200).json({ success: true });
    } catch (e) {
      console.error("[WEBHOOK GOPAY] Error:", e.message);
      return res.status(200).json({ success: true });
    }
  });

  app.get("/ppob/health", (_req, res) => res.status(200).json({ ok: true, module: "ppob", ts: Date.now() }));

  console.log("✅ PPOB webhook routes terpasang: /digiflazz/webhook, /webhook/gopay, /ppob/health");
};
