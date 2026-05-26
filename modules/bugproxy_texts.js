// modules/bugproxy_texts.js

// 📂 DAFTAR KATEGORI BUG & PROXY (STATIC / DASAR)
// - id          : dipakai di callback_data (bugcat_view_<id>, bugcat_edit_<id>)
// - key         : dipakai untuk penyimpanan teks (override JSON, getBugText(key))
// - userLabel   : nama tombol di menu reseller (BUG & PROXY)
// - adminLabel  : nama tombol di menu /admin → Edit BUG
// - defaultText : isi BUG default (boleh kosong, nanti bisa diisi via /admin)

const bugCategories = [
  {
    id: 'sushiroll',
    key: 'bugAxisXl', // pakai key lama biar override lama tetap kepakai
    userLabel: 'BUG Sushiroll',
    adminLabel: 'BUG Sushiroll',
    defaultText: `Isi default BUG Sushiroll di sini...
Contoh:
sushiroll1.com
sushiroll2.com`
  },
  {
    id: 'edukasi',
    key: 'bugEdukasi',
    userLabel: 'BUG Edukasi',
    adminLabel: 'BUG Edukasi',
    defaultText: `Isi default BUG Edukasi di sini...
Contoh:
edukasi1.com
edukasi2.com`
  },
  {
    id: 'conference',
    key: 'bugTelkomsel', // pakai key lama buat Conference
    userLabel: 'BUG Conference',
    adminLabel: 'BUG Conference',
    defaultText: `Isi default BUG Conference di sini...
Contoh:
zoom.us
teams.microsoft.com`
  },
  {
    id: 'gamemax',
    key: 'bugIndosatTri', // pakai key lama buat Gamemax/Sosmed
    userLabel: 'BUG Gamemax',
    adminLabel: 'BUG Gamemax',
    defaultText: `Isi default BUG Gamemax di sini...
Contoh:
gamemax1.com
gamemax2.com`
  },
  {
    id: 'game',
    key: 'bugGame',
    userLabel: 'BUG Game',
    adminLabel: 'BUG Game',
    defaultText: `Isi default BUG Game di sini...
Contoh:
game1.com
game2.com`
  },
  {
    id: 'spotify_music',
    key: 'bugSpotifyMusic',
    userLabel: 'BUG Spotify/Music',
    adminLabel: 'BUG Spotify/Music',
    defaultText: `Isi default BUG Spotify/Music di sini...
Contoh:
spotify.com
music1.com`
  },
  {
    id: 'tsel0p0k',
    key: 'bugTsel0p0k',
    userLabel: 'BUG Tsel 0p0k',
    adminLabel: 'BUG Tsel 0p0k',
    defaultText: `Isi default BUG Tsel 0p0k di sini...
Contoh:
tsel0p0k1.com
tsel0p0k2.com`
  },
  {
    id: 'iflix',
    key: 'bugIflix',
    userLabel: 'BUG Iflix',
    adminLabel: 'BUG Iflix',
    defaultText: `Isi default BUG Iflix di sini...
Contoh:
iflix.com
iflix1.com`
  },
];

// 🔁 Bikin map key → text (biar kompatibel dengan getBugText() di app.js)
const bugProxyTexts = {};
for (const cat of bugCategories) {
  bugProxyTexts[cat.key] = cat.defaultText;
}

// Export:
// - bugCategories  → dipakai buat bikin tombol & handler dinamis di app.js
// - masing-masing key tetap ada untuk fallback getBugText()
module.exports = {
  bugCategories,
  ...bugProxyTexts,
};
