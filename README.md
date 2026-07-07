# 🎵 Maimai DX WhatsApp Bot

Bot WhatsApp berbasis Node.js yang berfungsi untuk menarik data profil, rating, dan riwayat bermain (playlog) langsung dari situs resmi **Maimai DX NET** (International & Japan) secara cepat dan efisien.

---

## ✨ Fitur Utama

- 🔒 **Login Aman via Bookmarklet (PC Only):** Mengintegrasikan akun Maimai DX NET menggunakan Bookmarklet JavaScript melalui Chat Pribadi (PC/PM) demi keamanan sesi pengguna.
- ⚡ **Optimasi Sesi & Auto-Login:** Menyimpan session cookies secara lokal (`players.json`) untuk penarikan data instan (hanya 1 request HTTP) dan melakukan auto-relogin transparan jika sesi kedaluwarsa.
- 📊 **Cari Rating Lengkap (`.rating`):** Menampilkan rating terbaru serta nama panggilan (nickname) pemain.
- 🎵 **Paginasi Riwayat Bermain (`.recent`):** 
  - Navigasi interaktif sampai 5 halaman (total 25 lagu terakhir) dengan perintah `.recent page [1-5]`.
  - Menggunakan cache memori lokal sehingga perpindahan halaman berjalan secara instan (<0.1 detik).
- ⏱️ **Statistik Detail Judgement (`.recent [1-25]`):**
  - Menampilkan jumlah Fast/Late, Max Combo, Sync, dan perubahan rating.
  - Menyajikan tabel detail judgements (Tap, Hold, Slide, Touch, Break) dalam bentuk grid teks monospaced yang rapi.
- 🎵 **Song Constant Database:** Mendownload database musik resmi dari API Diving Fish untuk menyelaraskan nama lagu dan menampilkan konstanta tingkat kesulitan secara presisi (contoh: `12.8` menggantikan level `12+`).
- 👥 **Mendukung Grup (Multi-User):** Mendukung penggunaan di dalam grup chat. Data pelacakan diikat berdasarkan nomor WhatsApp unik masing-masing pengirim.

---

## 🛠️ Prasyarat & Teknologi

- **Node.js** (versi 18 ke atas)
- **Library WA:** `@whiskeysockets/baileys` (untuk integrasi WhatsApp Web API)
- **Terowongan Lokal:** **Ngrok** (diperlukan untuk menerima callback data login dari browser secara lokal)

---

## 🚀 Panduan Instalasi & Pengaturan

### 1. Kloning Repositori & Instal Dependensi
Masuk ke direktori proyek dan jalankan perintah:
```bash
npm install
```

### 2. Jalankan Terowongan Ngrok
Jalankan ngrok pada port lokal 3000 untuk mendapatkan URL publik HTTPS:
```bash
ngrok http 3000
```
Salin URL HTTPS yang dihasilkan oleh ngrok (contoh: `https://abcd-123-45.ngrok-free.dev`).

### 3. Konfigurasi Bot
Buka berkas `config.json` di root folder dan sesuaikan isinya:
```json
{
  "publicUrl": "https://ganti-dengan-url-ngrok-kamu.ngrok-free.dev",
  "port": 3000
}
```

---

## 🔌 Cara Menjalankan Bot

1. Jalankan bot melalui terminal:
   ```bash
   node index.js
   ```
2. Terminal akan menampilkan **QR Code**. Pindai (scan) QR Code tersebut menggunakan fitur **Linked Devices / Perangkat Tertaut** pada aplikasi WhatsApp di ponselmu.
3. Setelah muncul pesan `Bot WhatsApp Berhasil Terhubung!`, bot siap digunakan.

---

## 📖 Panduan Penggunaan Perintah (Commands)

| Perintah | Tempat Jalankan | Deskripsi |
| :--- | :--- | :--- |
| `.login` | **Chat Pribadi saja** | Memulai proses integrasi akun Maimai DX NET dan menghasilkan OTP & link bookmarklet. |
| `.rating` | Chat Pribadi / Grup | Menampilkan data rating Maimai DX NET milikmu saat ini. |
| `.recent` | Chat Pribadi / Grup | Menampilkan daftar 5 riwayat lagu terbaru (Halaman 1). |
| `.recent page [1-5]` | Chat Pribadi / Grup | Navigasi berpindah halaman riwayat lagu (maksimal 25 lagu). |
| `.recent [1-25]` | Chat Pribadi / Grup | Menampilkan rincian detail judgement & statistik timing dari lagu pada indeks tersebut. |
| `.ping` | Chat Pribadi / Grup | Mengecek status aktif (uptime) bot. |

---

## 🔒 Catatan Keamanan Sesi

- Perintah `.login` sengaja dibatasi hanya bisa dijalankan di **Chat Pribadi** bot. Hal ini demi menjaga privasi tautan login dan mencegah nomor WhatsApp bot terkena pemblokiran (*banned*) akibat menyebarkan tautan JavaScript di dalam grup.
- Semua cookie sensitif dienkripsi dan disimpan secara lokal pada mesin hosting bot ini dan tidak dibagikan ke server luar.
