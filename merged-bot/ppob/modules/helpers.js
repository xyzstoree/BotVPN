// modules/helpers.js
const crypto = require("crypto");

const STORE_NAME = "XYZSTORE"; // Ganti nama toko jika perlu

function md5hex(s) {
  return crypto.createHash("md5").update(String(s), "utf8").digest("hex");
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);

  const parts = [];
  if (d) parts.push(`${d}h`);
  if (h) parts.push(`${h}j`);
  if (m) parts.push(`${m}m`);
  return parts.join(" ") || "0m";
}

function normalizeMsisdn(input) {
  let s = String(input || "").trim().replace(/\s+/g, "").replace(/[^\d+]/g, "");
  if (s.startsWith("+")) s = s.slice(1);
  if (s.startsWith("08")) s = "62" + s.slice(1);
  return s;
}

function isValidMsisdn(msisdn) {
  return /^62\d{8,13}$/.test(msisdn);
}

function htmlToText(html) {
  return String(html || "")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/?[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function msToReadable(ms) {
  const m = Math.ceil(ms / 60000);
  if (m <= 1) return "1 menit";
  if (m < 60) return `${m} menit`;
  const h = Math.ceil(m / 60);
  return `${h} jam`;
}

function parseAmount(v) {
  const n = String(v ?? "").replace(/[^\d]/g, "");
  return parseInt(n, 10) || 0;
}

function maskTarget(t) {
  const s = String(t || "").replace(/\s+/g, "");
  if (!s) return "-";
  if (s.length <= 4) return "****";
  return s.slice(0, -4) + "****";
}

function fmtDateTimeID(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}.${pad(d.getMinutes())}`;
}

function fmtDateOnlyID(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

function formatRupiah(n) {
  const num = Number(n) || 0;
  return "Rp " + num.toLocaleString("id-ID");
}

function clean(s) {
  return String(s || "").trim();
}

function safeLabel(s, max = 42) {
  const t = clean(s).replace(/\s+/g, " ");
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

function b64uEncode(s) {
  return Buffer.from(String(s || ""), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function b64uDecode(s) {
  let t = String(s || "").replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  return Buffer.from(t, "base64").toString("utf8");
}

function displayOrderId(orderId) {
  return `${STORE_NAME}-${orderId}`;
}

function mapDigiStatus(s) {
  const t = String(s || "").toLowerCase();
  if (t.includes("sukses") || t.includes("success")) return "SUCCESS";
  if (t.includes("pending")) return "PENDING";
  if (t.includes("gagal") || t.includes("failed")) return "FAILED";
  return "PENDING";
}

function escapeMd(s) {
  return String(s || "").replace(/([\[\]\(\)_*`])/g, "\\$1");
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function timingSafeEq(a, b) {
  try {
    const ab = Buffer.from(String(a || ""), "utf8");
    const bb = Buffer.from(String(b || ""), "utf8");
    if (ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
  } catch { return false; }
}

function statusIcon(status) {
  return String(status || "").toLowerCase() === "gangguan" ? "🔴" : "🟢";
}

function humanExpire(min) {
  const m = Number(min);
  if (!Number.isFinite(m) || m <= 0) return "Tidak dibatasi";
  if (m < 60) return `${m} Menit`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r === 0 ? `${h} Jam` : `${h} Jam ${r} Menit`;
}

module.exports = {
  md5hex, formatUptime, normalizeMsisdn, isValidMsisdn, htmlToText,
  msToReadable, parseAmount, maskTarget, fmtDateTimeID, fmtDateOnlyID,
  formatRupiah, clean, safeLabel, b64uEncode, b64uDecode,
  displayOrderId, mapDigiStatus, escapeMd, escapeHtml, chunk, timingSafeEq,
  humanExpire, // <--- PASTIKAN INI ADA (pakai koma di depannya)
  statusIcon
};


