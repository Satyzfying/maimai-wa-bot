const { getPublicUrl } = require('../utils/config');

module.exports = {
    name: 'login',
    aliases: ['in'],
    needsPrefix: true,
    description: 'Memulai alur masuk akun Maimai DX menggunakan bookmarklet.',
    async execute(sock, from, args, msg, otps) {
        const publicUrl = getPublicUrl();

        if (!publicUrl || publicUrl.includes('ganti-dengan-url-ngrok')) {
            await sock.sendMessage(from, { 
                text: '*Konfigurasi bot belum lengkap.*\n\nAdministrator harus mengisi `PUBLIC_URL` di environment Zeabur atau `publicUrl` di `config.json` terlebih dahulu.' 
            });
            return;
        }

        // Cek jika perintah dijalankan di dalam grup
        const isGroup = from.endsWith('@g.us');
        if (isGroup) {
            await sock.sendMessage(from, {
                text: '*Akses Ditolak.*\n\nPerintah *.login* hanya dapat dijalankan melalui *Chat Pribadi (PC/PM)* demi keamanan data kredensial.\nSilakan kirim perintah *.login* langsung ke chat pribadi bot ini.'
            });
            return;
        }

        // Generate 6-digit OTP acak
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const sender = msg.key.participant || msg.key.remoteJid;

        // Simpan OTP ke map memori (berlaku selama 5 menit)
        otps.set(otp, {
            jid: sender,
            createdAt: Date.now()
        });

        // Hapus otomatis OTP setelah 5 menit
        setTimeout(() => {
            if (otps.has(otp)) {
                otps.delete(otp);
            }
        }, 5 * 60 * 1000);

        const cleanUrl = publicUrl.replace(/\/$/, '');
        
        // Link autentikasi khusus dengan hash OTP dan server target
        const authLink = `https://lng-tgk-aime-gw.am-all.net/common_auth/#otp=${otp}&server=${cleanUrl}`;

        // Bookmarklet loader standar komunitas (memanggil login.js dari Gist)
        const jsCode = `javascript:void(function(d){var s=d.createElement('script');s.src='https://gistcdn.githack.com/beer-psi/0eb8d3e50ae753388a6d4a4af5678a2e/raw/ede9859c40741d4dad49a035857b30a3e21c5dce/login.js';d.body.append(s)})(document)`;

        let responseText = `*PANDUAN MENGHUBUNGKAN AKUN MAIMAI DX*\n\n`;
        responseText += `*Step 1:*\n`;
        responseText += `Buka website *Maimai DX NET* di browser dalam *Incognito Mode (Tab Samaran)*, lalu login menggunakan SEGA ID Anda.\n\n`;
        responseText += `*Step 2:*\n`;
        responseText += `Salin tautan di bawah ini, lalu tempel (*paste*) dan buka di tab Incognito yang sama (Halaman akan menampilkan tulisan 'Not Found', abaikan saja):\n`;
        responseText += `\`\`\`${authLink}\`\`\`\n\n`;
        responseText += `*Step 3:*\n`;
        responseText += `Salin kode JavaScript (Bookmarklet) di bawah ini sepenuhnya, lalu jalankan di halaman 'Not Found' tersebut (bisa lewat Developer Console F12 di PC, atau lewat Bookmark di HP):\n\n`;
        responseText += `\`\`\`${jsCode}\`\`\`\n\n`;
        responseText += `_Setelah sukses, bot ini akan langsung mengirimkan profil rating Anda di WhatsApp!_`;

        await sock.sendMessage(from, { text: responseText });
    }
};
