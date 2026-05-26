// File: modules/redisSession.js
const Redis = require("ioredis");

// Koneksi ke Redis (Default localhost:6379)
const redis = new Redis(); 

/**
 * Middleware Session Redis Sederhana & Cepat
 */
const redisSession = async (ctx, next) => {
  const key = `session:${ctx.from.id}:${ctx.chat.id}`; // Key unik per user+chat
  
  let session = {};
  
  try {
    // 1. BACA session dari Redis sebelum proses pesan
    const raw = await redis.get(key);
    if (raw) {
      session = JSON.parse(raw);
    }
  } catch (e) {
    console.error('Redis Read Error:', e);
  }

  // Assign ke ctx agar bisa dipakai di logic bot (ctx.session)
  ctx.session = session;

  // 2. LANJUT ke logic bot (command handler, wizard, dll)
  await next();

  // 3. SIMPAN balik ke Redis setelah logic selesai
  try {
    if (ctx.session === null || ctx.session === undefined) {
      // Kalau diset null, hapus session (reset)
      await redis.del(key);
    } else {
      // Simpan session (TTL 24 jam = 86400 detik) biar RAM tidak penuh sampah
      await redis.set(key, JSON.stringify(ctx.session), 'EX', 86400);
    }
  } catch (e) {
    console.error('Redis Write Error:', e);
  }
};

module.exports = redisSession;

