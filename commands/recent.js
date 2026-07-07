const fs = require('fs');
const path = require('path');
const { fetchMaimaiRecent, fetchMaimaiRecentDetail } = require('../utils/scraper');
const { getSongConstant } = require('../utils/music');

// Menyimpan sesi data playlog terakhir per user di memori
const recentSessions = new Map();

// Helper untuk format difficulty name
function formatDiff(diff) {
    const mapping = {
        'basic': 'BASIC',
        'advanced': 'ADVANCED',
        'expert': 'EXPERT',
        'master': 'MASTER',
        'remaster': 'Re:MASTER'
    };
    return mapping[diff.toLowerCase()] || diff.toUpperCase();
}

// Helper untuk memformat tabel detailed judgements
function formatGrid(judgements) {
    const rows = ['tap', 'hold', 'slide', 'touch', 'break'];
    let grid = '      C-P   P   G   G   M\n';
    for (const row of rows) {
        const rowLabel = row.toUpperCase().slice(0, 3).padEnd(4, ' ');
        const vals = judgements[row] || [0, 0, 0, 0, 0];
        const cp = vals[0].toString().padStart(4, ' ');
        const p  = vals[1].toString().padStart(4, ' ');
        const gr = vals[2].toString().padStart(4, ' ');
        const gd = vals[3].toString().padStart(4, ' ');
        const ms = vals[4].toString().padStart(4, ' ');
        grid += `${rowLabel} ${cp} ${p} ${gr} ${gd} ${ms}\n`;
    }
    return grid;
}

module.exports = {
    name: 'recent',
    aliases: ['rc'],
    needsPrefix: true,
    description: 'Menampilkan riwayat bermain Maimai DX NET.',
    async execute(sock, from, args, msg) {
        const dbPath = path.join(__dirname, '..', 'players.json');
        const senderJid = msg.key.participant || msg.key.remoteJid;

        // 1. Membaca database lokal players.json untuk mencari clal cookie
        let players = {};
        if (fs.existsSync(dbPath)) {
            try {
                players = JSON.parse(fs.readFileSync(dbPath, 'utf-8') || '{}');
            } catch (e) {
                players = {};
            }
        }

        const profile = players[senderJid];
        if (!profile || !profile.clal) {
            await sock.sendMessage(from, {
                text: '⚠️ *Kamu belum menghubungkan akun Maimai DX NET!*\n\nSilakan login terlebih dahulu untuk menghubungkan akun.\nKetik perintah:\n*.login*'
            });
            return;
        }

        const clal = profile.clal;

        // Skenario A: Hanya mengetik `.recent` (Menampilkan daftar 5 lagu terakhir)
        if (args.length === 0) {
            try {
                await sock.sendMessage(from, { text: '🔍 _Mengambil riwayat bermain terbaru Anda dari Maimai DX NET..._' });
                
                const playlogs = await fetchMaimaiRecent(clal);
                if (playlogs.length === 0) {
                    await sock.sendMessage(from, { text: '📭 Riwayat bermain Anda kosong di Maimai DX NET.' });
                    return;
                }

                // Simpan daftar playlogs di memori
                recentSessions.set(senderJid, playlogs);

                let responseText = `🎵 *RIWAYAT BERMAIN MAIMAI DX (5 Terakhir)*\n\n`;
                
                for (let i = 0; i < playlogs.length; i++) {
                    const log = playlogs[i];
                    // Cari konstanta lagu dari database musik lokal
                    const constant = await getSongConstant(log.title, log.type, log.difficulty);
                    const difficultyDisplay = formatDiff(log.difficulty);
                    const constantDisplay = constant ? constant.toFixed(1) : log.level;

                    responseText += `${i + 1}. *${log.title}* - ${difficultyDisplay} ${constantDisplay} (${log.achievement})\n`;
                }

                responseText += `\n💡 *Ketik ".recent [1-5]" untuk melihat detail rincian skor!*`;
                await sock.sendMessage(from, { text: responseText });

            } catch (err) {
                console.error('[Command Recent] Error mengambil recent list:', err);
                await sock.sendMessage(from, { text: `❌ *Gagal mengambil riwayat bermain:*\n_${err.message}_` });
            }
            return;
        }

        // Skenario B: Mengetik `.recent [1-5]` (Menampilkan detail lagu)
        const indexInput = parseInt(args[0], 10);
        if (isNaN(indexInput) || indexInput < 1 || indexInput > 5) {
            await sock.sendMessage(from, { text: '⚠️ *Indeks Tidak Valid!*\n\nMasukkan angka 1 sampai 5.\nContoh: *.recent 1*' });
            return;
        }

        let userPlays = recentSessions.get(senderJid);

        // Jika sesi memori kosong (misal bot baru restart), trigger penarikan list otomatis terlebih dahulu
        if (!userPlays) {
            try {
                console.log(`[Command Recent] Sesi memori kosong untuk ${senderJid}, mengambil list...`);
                userPlays = await fetchMaimaiRecent(clal);
                recentSessions.set(senderJid, userPlays);
            } catch (err) {
                await sock.sendMessage(from, { text: `❌ *Gagal mengambil rincian detail:*\n_${err.message}_` });
                return;
            }
        }

        const targetPlay = userPlays[indexInput - 1];
        if (!targetPlay || !targetPlay.idx) {
            await sock.sendMessage(from, { text: `❌ Data riwayat lagu ke-${indexInput} tidak ditemukan.` });
            return;
        }

        try {
            await sock.sendMessage(from, { text: `🔍 _Mengambil rincian skor untuk lagu *${targetPlay.title}*..._` });

            const detail = await fetchMaimaiRecentDetail(clal, targetPlay.idx);

            // Hitung total Judgements
            const cpSum = Object.values(detail.judgements).reduce((sum, val) => sum + (val[0] || 0), 0);
            const pSum  = Object.values(detail.judgements).reduce((sum, val) => sum + (val[1] || 0), 0);
            const grSum = Object.values(detail.judgements).reduce((sum, val) => sum + (val[2] || 0), 0);
            const gdSum = Object.values(detail.judgements).reduce((sum, val) => sum + (val[3] || 0), 0);
            const msSum = Object.values(detail.judgements).reduce((sum, val) => sum + (val[4] || 0), 0);

            // Dapatkan konstanta lagu
            const constant = await getSongConstant(detail.title, detail.type, detail.difficulty);
            const diffDisplay = formatDiff(detail.difficulty);
            const constantDisplay = constant ? constant.toFixed(1) : detail.level;

            // Dapatkan Emoji Score Rank
            const rankEmoji = detail.rank ? `*[${detail.rank}]*` : '';

            let responseText = `🏁 *MAIMAI DX RECORD DETAIL*\n`;
            responseText += `━━━━━━━━━━━━━━━━━━━━━\n\n`;
            responseText += `🎵 *${detail.title}*\n`;
            responseText += `📅 ${detail.date}\n\n`;
            
            responseText += `• *Difficulty:* ${diffDisplay} ${detail.level} (${constantDisplay})\n`;
            responseText += `• *Accuracy:* ${rankEmoji} ${detail.achievement}\n\n`;
            
            responseText += `⏱️ *Timing:* Fast ${detail.fast} | Late ${detail.late}\n`;
            
            const ratingChangeDisplay = detail.ratingChange ? ` (${detail.ratingChange})` : '';
            responseText += `👤 *Rating:* ${detail.rating}${ratingChangeDisplay}\n\n`;

            responseText += `📈 *Judgements Total:*\n`;
            responseText += `• Critical Perfect: ${cpSum}\n`;
            responseText += `• Perfect: ${pSum}\n`;
            responseText += `• Great: ${grSum}\n`;
            responseText += `• Good: ${gdSum}\n`;
            responseText += `• Miss: ${msSum}\n\n`;

            responseText += `📊 *Judgements Table:*\n`;
            responseText += `\`\`\`${formatGrid(detail.judgements)}\`\`\`\n`;
            
            responseText += `⚙️ *Track:* ${detail.type} | ${detail.track}`;

            await sock.sendMessage(from, { text: responseText });

        } catch (err) {
            console.error('[Command Recent] Error mengambil detail playlog:', err);
            await sock.sendMessage(from, { text: `❌ *Gagal mengambil detail riwayat:*\n_${err.message}_` });
        }
    }
};
