const fs = require('fs');
const { fetchMaimaiMusicBest } = require('../utils/scraper');
const { findSong, getCurrentVersion } = require('../utils/music');
const { calcSongRating } = require('../utils/rating');
const { dataPath } = require('../utils/paths');

// In-memory cache of B50 results per user
const topSessions = new Map();

const DIFF_LABEL = {
    expert:   'EXP',
    master:   'MAS',
    remaster: 'REM'
};

/**
 * Formats a B50 song list into a compact 2-line text block suitable for mobile display.
 * @param {Array} songs Sorted array of scored songs
 * @param {number} startRank 1-based rank of the first song in this slice
 */
function formatSongList(songs, startRank = 1) {
    let out = '';
    for (let i = 0; i < songs.length; i++) {
        const s = songs[i];
        const rank = startRank + i;
        
        // Difficulty abbreviation
        const diffMap = { basic: 'BAS', advanced: 'ADV', expert: 'EXP', master: 'MAS', remaster: 'REM' };
        const diff = diffMap[s.difficulty] || s.difficulty.toUpperCase().slice(0, 3);
        
        // Line 1: Rank. Title (Diff Type)
        out += `*${rank}.* ${s.title} (${diff} ${s.type})\n`;
        
        // Line 2: Achievement | Const -> Rating
        const ach = s.achievement.toFixed(4) + '%';
        const constant = s.constant !== null ? s.constant.toFixed(1) : '?.?';
        out += `   ${ach} | Const: ${constant} → *${s.songRating}*`;
        
        if (i < songs.length - 1) {
            out += '\n\n';
        }
    }
    return out;
}

module.exports = {
    name: 'top',
    aliases: ['b50'],
    needsPrefix: true,
    description: 'Menampilkan Best 50 (B50) Maimai DX — 15 lagu terbaru + 35 lagu lama terbaik.',
    async execute(sock, from, args, msg) {
        const dbPath = dataPath('players.json');
        const senderJid = msg.key.participant || msg.key.remoteJid;

        // Load player data
        let players = {};
        if (fs.existsSync(dbPath)) {
            try { players = JSON.parse(fs.readFileSync(dbPath, 'utf-8') || '{}'); } catch (e) { players = {}; }
        }

        const profile = players[senderJid];
        if (!profile || !profile.clal) {
            await sock.sendMessage(from, {
                text: '*Akun Maimai DX NET belum terhubung.*\n\nSilakan hubungkan akun dengan mengetik perintah:\n*.login*'
            });
            return;
        }

        // Subcommand routing:
        //   .top         → show B15 (new songs)
        //   .top old     → show B35 page 1 (old songs 1-17)
        //   .top old 2   → show B35 page 2 (old songs 18-35)
        //   .top refresh → force-refresh the cache

        const sub = (args[0] || '').toLowerCase();
        const forceRefresh = sub === 'refresh';

        if (forceRefresh) {
            topSessions.delete(senderJid);
        }

        // ─── Load or refresh B50 data ───────────────────────────────────────
        let b50 = topSessions.get(senderJid);

        // Force refresh if cached data is empty/zero
        if (b50 && b50.total === 0) {
            b50 = null;
        }

        if (!b50) {
            await sock.sendMessage(from, {
                text: '_Mengambil data Best 50 dari Maimai DX NET. Proses ini memerlukan waktu sekitar 10–20 detik._'
            });

            try {
                const result = await fetchMaimaiMusicBest(
                    profile.clal,
                    profile.sessionCookie,
                    profile.userAgent,
                    profile.domain
                );

                // Persist refreshed session cookie
                if (result.newSessionCookie) {
                    players[senderJid].sessionCookie = result.newSessionCookie;
                    fs.writeFileSync(dbPath, JSON.stringify(players, null, 2), 'utf-8');
                }

                // Determine current version for B15/B35 split
                const currentVersion = await getCurrentVersion();

                // Enrich each score with constant, song rating, and version info
                const enriched = [];
                for (const score of result.scores) {
                    if (score.constant !== undefined && score.constant > 0 && score.songRating !== undefined && score.isNew !== undefined) {
                        enriched.push(score);
                        continue;
                    }

                    const songData = await findSong(score.title, score.type);
                    if (!songData) {
                        console.log(`[Top Command] WARNING: Song not found in database: "${score.title}" (Type: ${score.type})`);
                        continue;
                    }

                    const diffMap = { basic: 0, advanced: 1, expert: 2, master: 3, remaster: 4 };
                    const diffIdx = diffMap[score.difficulty] ?? -1;
                    const constant = (diffIdx >= 0 && songData.ds && songData.ds[diffIdx]) ? songData.ds[diffIdx] : null;
                    if (!constant) continue; // Skip if constant unknown

                    const songRating = calcSongRating(constant, score.achievement);
                    if (!songRating) continue;

                    const isNew = score.isNew !== undefined ? score.isNew : (songData.version === currentVersion);

                    enriched.push({
                        title: score.title,
                        type: score.type,
                        difficulty: score.difficulty,
                        achievement: score.achievement,
                        rank: score.rank,
                        constant,
                        songRating,
                        isNew
                    });
                }

                // Sort each pool by song rating descending, take B15 + B35
                const newPool = enriched.filter(s => s.isNew).sort((a, b) => b.songRating - a.songRating);
                const oldPool = enriched.filter(s => !s.isNew).sort((a, b) => b.songRating - a.songRating);

                const b15 = newPool.slice(0, 15);
                const b35 = oldPool.slice(0, 35);

                const b15sum = b15.reduce((acc, s) => acc + s.songRating, 0);
                const b35sum = b35.reduce((acc, s) => acc + s.songRating, 0);

                b50 = {
                    nickname: profile.nickname || 'Player',
                    rating: profile.rating || 0,
                    b15,
                    b35,
                    b15sum,
                    b35sum,
                    total: b15sum + b35sum
                };

                topSessions.set(senderJid, b50);

            } catch (err) {
                console.error('[Command Top] Error:', err);
                await sock.sendMessage(from, {
                    text: `*Gagal mengambil data Best 50:*\n_${err.message}_`
                });
                return;
            }
        }

        // ─── Display ────────────────────────────────────────────────────────

        const header =
            `*BEST 50 — ${b50.nickname}*\n` +
            `Rating: *${b50.total}*  (B15: ${b50.b15sum} | B35: ${b50.b35sum})\n` +
            `━━━━━━━━━━━━━━━━━━━━━\n`;

        if (sub === 'old') {
            // B35 — old songs, paginated: page 1 = songs 1-17, page 2 = songs 18-35
            const pageNum = parseInt(args[1], 10) || 1;
            const perPage = 17;
            const startIdx = (pageNum - 1) * perPage;
            const slice = b50.b35.slice(startIdx, startIdx + perPage);
            const totalPages = Math.ceil(b50.b35.length / perPage);

            if (slice.length === 0) {
                await sock.sendMessage(from, { text: `Halaman ${pageNum} tidak ditemukan (total ${totalPages} halaman).` });
                return;
            }

            let text = header;
            text += `*OTHERS (Best 35) — Halaman ${pageNum}/${totalPages}*\n\n`;
            text += formatSongList(slice, startIdx + 1);
            if (pageNum < totalPages) {
                text += `\n\nKetik *.top old ${pageNum + 1}* untuk halaman berikutnya.`;
            }
            await sock.sendMessage(from, { text });

        } else {
            // Default: B15 — new songs
            let text = header;
            text += `*NEW (Best 15)*\n\n`;
            text += formatSongList(b50.b15, 1);
            text += `\n\nKetik *.top old* untuk melihat Best 35 (lagu lama).`;
            text += `\nKetik *.top refresh* untuk memperbarui data.`;
            await sock.sendMessage(from, { text });
        }
    }
};
