/**
 * ============================================================
 *  MERGED BOT — XYZSTORE
 *  Gabungan BotPPOB + BotVPN dalam 1 process Telegraf.
 *  Strategi: 1 token, 1 Express server, 2 DB & 2 saldo pisah.
 * ============================================================
 *
 *  Folder layout:
 *    /index.js         <- entry (file ini)
 *    /ppob/bot.js      <- module PPOB (export setupPpob)
 *    /vpn/app.js       <- module VPN (export setupVpn)
 *    /.env             <- konfigurasi PPOB + master
 *    /vpn/.vars.json   <- konfigurasi VPN (tetap pakai format lama)
 *
 *  Alur:
 *    1) Master init Telegraf + Express.
 *    2) Master daftarkan picker /start /menu /main.
 *    3) Master mount setupPpob({bot, app}) dan setupVpn({bot, app}).
 *    4) Master listen Express + bot.launch dengan auto-reconnect.
 */

require('dotenv').config({
  path: require('path').join(__dirname, '.env'),
  override: true,
  quiet: true,
});

const path = require('path');
const express = require('express');
const { Telegraf } = require('telegraf');

const setupPpob = require('./ppob/bot');
const setupVpn = require('./vpn/app');

// ------------------------------------------------------------
// Konfigurasi master
// ------------------------------------------------------------
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN belum di-set di .env');
  process.exit(1);
}

// Port utama Express. Default 6969 mengikuti VPN lama; PPOB webhook
// (Digiflazz, AutoGoPay) tinggal nempel ke server yang sama.
const PORT = Number(process.env.PORT || 6969);

// ------------------------------------------------------------
// Inisialisasi shared bot & express
// ------------------------------------------------------------
const bot = new Telegraf(BOT_TOKEN);
const app = express();

// ------------------------------------------------------------
// PICKER MENU — root /start, /menu, /main
// Tampilkan tombol "PPOB" dan "VPN" supaya user bisa pilih layanan.
// Kedua tombol re-use callback action existing milik tiap modul,
// jadi tidak perlu refactor handler internal modul.
// ------------------------------------------------------------
function pickerKeyboard() {
  return {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '🛒 Layanan PPOB', callback_data: 'go_ppob' },
          { text: '🌐 Layanan VPN', callback_data: 'send_main_menu' },
        ],
      ],
    },
  };
}

async function sendPicker(ctx) {
  const username = ctx.from?.username
    ? `@${ctx.from.username}`
    : ctx.from?.first_name || 'kak';

  const text =
    `👋 <b>Halo ${username}!</b>\n\n` +
    `Selamat datang di <b>XYZSTORE Bot</b>.\n` +
    `Silakan pilih layanan yang ingin kamu gunakan:\n\n` +
    `🛒 <b>PPOB</b> — Pulsa, Paket Data, Game, dll\n` +
    `🌐 <b>VPN</b> — SSH, VMess, VLess, Trojan, ZIVPN\n\n` +
    `<i>Tip: ketik /ppob atau /vpn untuk shortcut.</i>`;

  // Bersihkan pesan command dari user supaya chat rapi
  if (ctx.updateType === 'message') {
    await ctx.deleteMessage().catch(() => {});
  }

  return ctx.reply(text, pickerKeyboard());
}

// Daftar handler picker DULUAN supaya menang dari handler /start
// modul PPOB/VPN (yang sudah dinonaktifkan, tapi defensive saja).
bot.start((ctx) => sendPicker(ctx));
bot.command('main', (ctx) => sendPicker(ctx));
bot.command('menu', (ctx) => sendPicker(ctx));

// ------------------------------------------------------------
// MOUNT MODUL — urutan: PPOB dulu (text handler-nya cascade dengan
// next()), lalu VPN (text handler-nya juga cascade setelah refactor).
// ------------------------------------------------------------
console.log('🔧 Mounting modul PPOB...');
const ppob = setupPpob({ bot, app });

console.log('🔧 Mounting modul VPN...');
const vpn = setupVpn({ bot, app });

// ------------------------------------------------------------
// SHORTCUT COMMANDS — langsung ke menu utama tiap modul.
// Didaftarkan SETELAH modul supaya menang vs handler internal.
// (Telegraf composer: handler pertama yang match akan dieksekusi
//  lebih dulu, lalu kalau panggil next() handler berikut jalan.)
// ------------------------------------------------------------
bot.command('ppob', async (ctx) => {
  if (ctx.updateType === 'message') {
    await ctx.deleteMessage().catch(() => {});
  }
  if (ppob && typeof ppob.sendPpobHome === 'function') {
    return ppob.sendPpobHome(ctx);
  }
  return sendPicker(ctx);
});

bot.command('vpn', async (ctx) => {
  if (ctx.updateType === 'message') {
    await ctx.deleteMessage().catch(() => {});
  }
  if (vpn && typeof vpn.sendMainMenu === 'function') {
    return vpn.sendMainMenu(ctx);
  }
  return sendPicker(ctx);
});

// Tombol "kembali ke picker" — bisa dipakai di mana saja kalau perlu
bot.action('back_picker', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  return sendPicker(ctx);
});

// ------------------------------------------------------------
// EXPRESS — health check master + listen
// ------------------------------------------------------------
app.get('/', (_req, res) => {
  res.status(200).json({
    ok: true,
    name: 'xyzstore-merged-bot',
    modules: ['ppob', 'vpn'],
    ts: Date.now(),
  });
});

app.get('/health', (_req, res) => res.status(200).json({ ok: true, ts: Date.now() }));

app.listen(PORT, () => {
  console.log(`🌐 Express server listen :${PORT}`);
});

// ------------------------------------------------------------
// LAUNCH BOT dengan auto-reconnect (mengikuti pola VPN lama)
// ------------------------------------------------------------
function launchBot() {
  bot
    .launch({ dropPendingUpdates: true })
    .then(() => {
      console.log('🤖 Telegram bot terhubung & siap menerima update.');
    })
    .catch((err) => {
      console.error('❌ Bot launch error:', err.message);
      console.log('🔄 Retry koneksi Telegram dalam 10 detik...');
      setTimeout(launchBot, 10_000);
    });
}
launchBot();

// ------------------------------------------------------------
// GRACEFUL SHUTDOWN
// ------------------------------------------------------------
const safeStop = (sig) => {
  console.log(`\n⏹  Menerima ${sig}, shutdown...`);
  try { bot.stop(sig); } catch (_) {}
  process.exit(0);
};
process.once('SIGINT', () => safeStop('SIGINT'));
process.once('SIGTERM', () => safeStop('SIGTERM'));

// Catch unhandled errors supaya proses tidak crash diam-diam
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});
