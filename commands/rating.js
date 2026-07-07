const fs = require('fs');
const path = require('path');
const { fetchMaimaiProfile } = require('../utils/scraper');

module.exports = {
    name: 'rating',
    aliases: ['rt'],
    needsPrefix: true, // Wajib menggunakan prefix, contoh: .rating
    description: 'Mencari data rating pemain Maimai DX dari database lokal dengan auto-update dari SEGA.',
    async execute(sock, from, args, msg) {
        const dbPath = path.join(__dirname, '..', 'players.json');
        
        // 1. Membaca database lokal players.json
        let players = {};
        try {
            if (fs.existsSync(dbPath)) {
                const rawData = fs.readFileSync(dbPath, 'utf-8');
                players = JSON.parse(rawData || '{}');
            }
        } catch (err) {
            console.error('[Command Rating] Error membaca database:', err);
        }

        let targetJid = '';
        let isSelf = false;

        // Mendapatkan mentionedJid dari metadata pesan Baileys
        const mentionedJids = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];

        if (args.length === 0) {
            // Skenario 1: Cek rating diri sendiri (.rating)
            targetJid = msg.key.participant || msg.key.remoteJid;
            isSelf = true;
        } else if (mentionedJids.length > 0) {
            // Skenario 2: Cek rating orang lain via tag/mention (.rating @tag)
            targetJid = mentionedJids[0];
            isSelf = false;
        } else {
            // Skenario 3: Input teks biasa/username langsung (misal: .rating Satyz)
            await sock.sendMessage(from, { 
                text: '*Format Salah.*\n\nUntuk melihat rating sendiri, ketik:\n*.rating*\nUntuk melihat rating orang lain, silakan tag/mention:\n*.rating @NamaTeman*\n\n_Catatan: Pengguna wajib sudah menghubungkan akun lewat perintah .login_' 
            });
            return;
        }

        // 2. Cari data profil berdasarkan WhatsApp JID di database
        const profile = players[targetJid];

        if (!profile) {
            if (isSelf) {
                await sock.sendMessage(from, { 
                    text: '*Akun Maimai DX NET belum terhubung.*\n\nSilakan hubungkan akun dengan mengetik perintah:\n*.login*' 
                });
            } else {
                const cleanNumber = targetJid.split('@')[0];
                await sock.sendMessage(from, { 
                    text: `Pengguna *@${cleanNumber}* belum menghubungkan akun Maimai DX NET.`,
                    mentions: [targetJid]
                });
            }
            return;
        }

        // Mengambil data awal dari database
        let nickname = profile.nickname || 'Player';
        let rating = profile.rating || 0;
        let updatedAt = profile.updatedAt;
        let sessionExpired = false;

        // 3. Coba lakukan auto-update langsung dari SEGA jika cookie clal tersedia
        if (profile.clal) {
            try {
                const result = await fetchMaimaiProfile(profile.clal, profile.sessionCookie, profile.userAgent, profile.domain);
                
                nickname = result.nickname;
                rating = result.rating;
                updatedAt = new Date().toISOString();

                // Simpan rating terupdate ke players.json
                players[targetJid] = {
                    nickname: nickname,
                    rating: rating,
                    clal: profile.clal,
                    sessionCookie: result.newSessionCookie || profile.sessionCookie,
                    userAgent: profile.userAgent,
                    domain: result.domain || profile.domain,
                    updatedAt: updatedAt
                };
                fs.writeFileSync(dbPath, JSON.stringify(players, null, 2), 'utf-8');
            } catch (err) {
                console.warn('[Command Rating] Auto-update gagal, menggunakan data simpanan:', err.message);
                sessionExpired = true;
            }
        }

        // Format tanggal update
        let formattedDate = 'Tidak diketahui';
        if (updatedAt) {
            try {
                formattedDate = new Date(updatedAt).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
            } catch (e) {
                formattedDate = updatedAt;
            }
        }

        // 4. Kirim respon profil rating
        let responseText = `*PROFIL PEMAIN MAIMAI DX*\n\n`;
        responseText += `• *Nickname:* ${nickname}\n`;
        responseText += `• *DX Rating:* ${rating}\n\n`;
        responseText += `_Terakhir diperbarui: ${formattedDate}_\n`;
        responseText += `_Data disinkronkan langsung dari Maimai DX NET_\n`;
        
        if (sessionExpired && isSelf) {
            responseText += `\n*Sesi login kedaluwarsa.*\n_Ketik *.login* untuk memperbarui sesi agar data tersinkronisasi otomatis._`;
        }

        await sock.sendMessage(from, { text: responseText });
    }
};
