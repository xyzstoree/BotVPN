// ==========================================
// PENGATURAN HARGA MARKUP PPOB
// Anda cukup mengedit angka-angka di file ini
// ==========================================

// Harga default (jika modal di atas 500k atau tidak masuk kriteria)
const DEFAULT_MARKUP = 3000;

function hitungHargaJual(buyPrice) {
  const modal = Number(buyPrice) || 0;

  if (modal < 500) return modal + 100;         // Modal di bawah Rp 500 -> untung Rp 100
  if (modal < 1000) return modal + 500;        // Modal di bawah Rp 1.000 -> untung Rp 500
  if (modal < 5000) return modal + 1000;       // Modal di bawah Rp 5.000 -> untung Rp 1.000
  if (modal < 15000) return modal + 1500;      // Modal di bawah Rp 15.000 -> untung Rp 1.500
  if (modal < 50000) return modal + 2000;      // Modal di bawah Rp 50.000 -> untung Rp 2.000
  if (modal < 100000) return modal + 3500;     // Modal di bawah Rp 100.000 -> untung Rp 3.000
  if (modal < 500000) return modal + 5000;     // Modal di bawah Rp 500.000 -> untung Rp 3.000

  return modal + DEFAULT_MARKUP; 
}

module.exports = { hitungHargaJual };

