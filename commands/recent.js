const fs = require('fs');
const { fetchMaimaiRecent, fetchMaimaiRecentDetail } = require('../utils/scraper');
const { getSongConstant } = require('../utils/music');
const { dataPath, writeJsonAtomic } = require('../utils/paths');

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
        const dbPath = dataPath('players.json');
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
                text: '*Akun Maimai DX NET belum terhubung.*\n\nSilakan hubungkan akun dengan mengetik perintah:\n*.login*'
            });
            return;
        }

        const clal = profile.clal;

        // 2. Deteksi apakah ini request halaman daftar lagu (.recent atau .recent page [angka])
        let pageNum = 1;
        let isPageRequest = false;

        if (args.length === 0) {
            isPageRequest = true;
            pageNum = 1;
        } else if (args[0].toLowerCase() === 'page' || args[0].toLowerCase() === 'p') {
            isPageRequest = true;
            pageNum = parseInt(args[1], 10);
            if (isNaN(pageNum) || pageNum < 1 || pageNum > 5) {
                await sock.sendMessage(from, { text: '*Halaman tidak valid.*\n\nMasukkan halaman 1 sampai 5.\nContoh: *.recent page 2* atau *.recent p 2*' });
                return;
            }
        }

        // Skenario A: Request Halaman Daftar Lagu
        if (isPageRequest) {
            try {
                let playlogs = recentSessions.get(senderJid);

                // Jika data cache di memori kosong, ambil langsung dari SEGA
                if (!playlogs) {
                    await sock.sendMessage(from, { text: '_Mengambil riwayat bermain dari Maimai DX NET..._' });
                    const result = await fetchMaimaiRecent(clal, profile.sessionCookie, profile.userAgent, profile.domain);
                    playlogs = result.playlogs;

                    if (playlogs.length === 0) {
                        await sock.sendMessage(from, { text: 'Riwayat bermain tidak ditemukan.' });
                        return;
                    }

                    // Update sessionCookie jika diperbarui
                    if (result.newSessionCookie) {
                        players[senderJid].sessionCookie = result.newSessionCookie;
                        writeJsonAtomic(dbPath, players);
                    }

                    // Simpan daftar playlogs di memori
                    recentSessions.set(senderJid, playlogs);
                }

                const itemsPerPage = 5;
                const startIndex = (pageNum - 1) * itemsPerPage;
                const endIndex = Math.min(startIndex + itemsPerPage, playlogs.length);

                if (startIndex >= playlogs.length) {
                    await sock.sendMessage(from, { text: `Halaman ${pageNum} tidak ditemukan (maksimal ${Math.ceil(playlogs.length / itemsPerPage)} halaman).` });
                    return;
                }

                let responseText = `*RIWAYAT BERMAIN MAIMAI DX (Halaman ${pageNum}/5)*\n`;
                responseText += `━━━━━━━━━━━━━━━━━━━━━\n\n`;

                for (let i = startIndex; i < endIndex; i++) {
                    const log = playlogs[i];
                    // Cari konstanta lagu dari database musik lokal
                    const constant = await getSongConstant(log.title, log.type, log.difficulty);
                    const difficultyDisplay = formatDiff(log.difficulty);
                    const constantDisplay = constant ? constant.toFixed(1) : log.level;

                    responseText += `${i + 1}. *${log.title}* - ${difficultyDisplay} ${constantDisplay} (${log.achievement})\n`;
                }

                responseText += `\nKetik ".recent page [2-5]" untuk berpindah halaman.`;
                responseText += `\nKetik ".recent [1-25]" untuk melihat detail rincian skor.`;
                
                await sock.sendMessage(from, { text: responseText });

            } catch (err) {
                console.error('[Command Recent] Error mengambil recent list:', err);
                await sock.sendMessage(from, { text: `*Gagal mengambil riwayat bermain:*\n_${err.message}_` });
            }
            return;
        }

        // Skenario B: Request Detail Judgement Lagu (.recent [indeks 1-25])
        const indexInput = parseInt(args[0], 10);
        
        let userPlays = recentSessions.get(senderJid);
        const maxLimit = userPlays ? userPlays.length : 25;

        if (isNaN(indexInput) || indexInput < 1 || indexInput > maxLimit) {
            await sock.sendMessage(from, { 
                text: `*Indeks tidak valid.*\n\nMasukkan indeks lagu yang terdaftar (1 sampai ${maxLimit}).\nContoh: *.recent 1*` 
            });
            return;
        }

        // Jika sesi memori kosong (misal bot baru restart), trigger penarikan list otomatis terlebih dahulu
        if (!userPlays) {
            try {
                console.log(`[Command Recent] Sesi memori kosong untuk ${senderJid}, mengambil list...`);
                const result = await fetchMaimaiRecent(clal, profile.sessionCookie, profile.userAgent, profile.domain);
                userPlays = result.playlogs;
                recentSessions.set(senderJid, userPlays);

                if (result.newSessionCookie) {
                    players[senderJid].sessionCookie = result.newSessionCookie;
                    writeJsonAtomic(dbPath, players);
                }
            } catch (err) {
                await sock.sendMessage(from, { text: `*Gagal mengambil rincian detail:*\n_${err.message}_` });
                return;
            }
        }

        const targetPlay = userPlays[indexInput - 1];
        if (!targetPlay || !targetPlay.idx) {
            await sock.sendMessage(from, { text: `Data riwayat lagu ke-${indexInput} tidak ditemukan.` });
            return;
        }

        try {
            await sock.sendMessage(from, { text: `_Mengambil rincian skor untuk lagu ${targetPlay.title}..._` });

            const result = await fetchMaimaiRecentDetail(clal, targetPlay.idx, profile.sessionCookie, profile.userAgent, profile.domain);
            const detail = result.detail;

            if (result.newSessionCookie) {
                players[senderJid].sessionCookie = result.newSessionCookie;
                writeJsonAtomic(dbPath, players);
            }

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

            let responseText = `*DETAIL RIWAYAT BERMAIN MAIMAI DX*\n`;
            responseText += `━━━━━━━━━━━━━━━━━━━━━\n\n`;
            responseText += `*${detail.title}*\n`;
            responseText += `Tanggal: ${detail.date}\n\n`;
            
            responseText += `• *Difficulty:* ${diffDisplay} ${detail.level} (${constantDisplay})\n`;
            responseText += `• *Accuracy:* ${rankEmoji} ${detail.achievement}\n\n`;
            
            responseText += `*Timing:* Fast ${detail.fast} | Late ${detail.late}\n`;
            
            const ratingChangeDisplay = detail.ratingChange ? ` (${detail.ratingChange})` : '';
            responseText += `*Rating:* ${detail.rating}${ratingChangeDisplay}\n\n`;

            responseText += `*Total Judgements:*\n`;
            responseText += `• Critical Perfect: ${cpSum}\n`;
            responseText += `• Perfect: ${pSum}\n`;
            responseText += `• Great: ${grSum}\n`;
            responseText += `• Good: ${gdSum}\n`;
            responseText += `• Miss: ${msSum}\n\n`;

            responseText += `*Tabel Judgements:*\n`;
            responseText += `\`\`\`${formatGrid(detail.judgements)}\`\`\`\n`;
            
            responseText += `*Track:* ${detail.type} | ${detail.track}`;

            await sock.sendMessage(from, { text: responseText });

        } catch (err) {
            console.error('[Command Recent] Error mengambil detail playlog:', err);
            await sock.sendMessage(from, { text: `*Gagal mengambil detail riwayat:*\n_${err.message}_` });
        }
    }
};
