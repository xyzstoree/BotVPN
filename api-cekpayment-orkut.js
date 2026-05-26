// api-cekpayment-orkut.js
const qs = require('qs');

// Function agar tetap kompatibel dengan app.js
function buildPayload() {
  return qs.stringify({
    'username': 'xyuzstores',
    'token': '2396055:Xy64VS2siuonxbj9ZQPUcgvkTFBM0',
    'jenis': 'masuk'
  });
}

// Header tetap sama agar tidak error di app.js
const headers = {
  'Content-Type': 'application/x-www-form-urlencoded',
  'Accept-Encoding': 'gzip',
  'User-Agent': 'okhttp/4.12.0'
};

// URL baru sesuai curl-mu
const API_URL = 'https://orkutapi.andyyuda41.workers.dev/api/qris-history';

// ─────────────────────────────────────────────────────────────────────
// Helper: parse tanggal Indonesia ("DD/MM/YYYY HH:MM") atau ISO
// ─────────────────────────────────────────────────────────────────────
function parseTanggalID(str) {
  if (!str) return null;
  const s = String(str).trim();

  // dd/mm/yyyy hh:mm[:ss]
  let m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    return new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0), 0).getTime();
  }

  // yyyy-mm-dd hh:mm[:ss]  atau  yyyy-mm-ddTHH:mm:ss
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0), 0).getTime();
  }

  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

// ─────────────────────────────────────────────────────────────────────
// Normalisasi response API ke array { tanggal, ts, kredit, brand }
// Mendukung 2 format:
//   1) Format teks lama  : blok dipisah "------------------------"
//                          + label "Kredit:" / "Tanggal:" / "Brand:"
//   2) Format JSON baru  : { status, data:[...] } / { data:{ data:[...] } }
//                          / [...] langsung. Field fleksibel:
//                          amount|jumlah|kredit|credit|nominal,
//                          date|tanggal|datetime|created_at|time,
//                          brand|brand_name|issuer|sender_name|merchant
// ─────────────────────────────────────────────────────────────────────
function parseTransactions(responseData) {
  const list = [];
  if (responseData == null) return list;

  // 1) Object / Array (JSON)
  if (typeof responseData === 'object') {
    let arr = null;
    if (Array.isArray(responseData)) arr = responseData;
    else if (Array.isArray(responseData.data)) arr = responseData.data;
    else if (responseData.data && Array.isArray(responseData.data.data)) arr = responseData.data.data;
    else if (Array.isArray(responseData.result)) arr = responseData.result;
    else if (responseData.result && Array.isArray(responseData.result.data)) arr = responseData.result.data;
    else if (Array.isArray(responseData.history)) arr = responseData.history;
    else if (Array.isArray(responseData.transactions)) arr = responseData.transactions;
    else if (Array.isArray(responseData.mutasi)) arr = responseData.mutasi;

    if (arr) {
      for (const t of arr) {
        if (!t || typeof t !== 'object') continue;

        // Hanya proses transaksi MASUK / kredit (skip debit / keluar)
        const jenis = String(t.jenis || t.type || t.tipe || '').toLowerCase();
        if (jenis && /(keluar|debit|out|debet)/.test(jenis)) continue;

        const kreditRaw = t.kredit ?? t.amount ?? t.jumlah ?? t.credit ?? t.nominal ?? t.in;
        if (kreditRaw == null) continue;
        const kredit = Number(String(kreditRaw).replace(/[^\d-]/g, ''));
        if (!kredit || kredit <= 0) continue;

        const tanggalStr = String(
          t.tanggal ?? t.date ?? t.datetime ?? t.created_at ?? t.time ?? '-'
        ).trim();
        const brand = String(
          t.brand ?? t.brand_name ?? t.issuer ?? t.sender_name ?? t.merchant ?? '-'
        ).trim();

        list.push({
          tanggal: tanggalStr,
          ts: parseTanggalID(tanggalStr),
          kredit,
          brand
        });
      }
      return list;
    }
  }

  // 2) String — coba JSON dulu, fallback ke format teks lama
  const text = String(responseData);
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return parseTransactions(JSON.parse(trimmed));
    } catch (_) { /* lanjut ke parser teks */ }
  }

  const blocks = text.split('------------------------').filter(Boolean);
  for (const block of blocks) {
    const kreditMatch = block.match(/Kredit\s*:\s*([\d.,]+)/i);
    const tanggalMatch = block.match(/Tanggal\s*:\s*(.+)/i);
    const brandMatch = block.match(/Brand\s*:\s*(.+)/i);
    if (!kreditMatch) continue;

    const tanggalStr = tanggalMatch ? tanggalMatch[1].trim() : '-';
    list.push({
      tanggal: tanggalStr,
      ts: parseTanggalID(tanggalStr),
      kredit: Number(kreditMatch[1].replace(/\./g, '').replace(/,/g, '')),
      brand: brandMatch ? brandMatch[1].trim() : '-'
    });
  }

  return list;
}

// Ekspor agar app.js tetap bisa require dengan struktur lama,
// + tambahan helper parser baru
module.exports = { buildPayload, headers, API_URL, parseTransactions, parseTanggalID };

