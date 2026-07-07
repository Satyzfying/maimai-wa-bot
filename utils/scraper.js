/**
 * CookieJar class untuk menangani cookies lintas request secara dinamis.
 */
class CookieJar {
    constructor() {
        this.cookies = new Map();
    }

    addCookies(setCookieHeader) {
        if (!setCookieHeader) return;
        const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
        for (const header of headers) {
            const parts = header.split(';')[0].split('=');
            if (parts.length >= 2) {
                const key = parts[0].trim();
                const value = parts.slice(1).join('=').trim();
                this.cookies.set(key, value);
            }
        }
    }

    getCookieHeader() {
        return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    }
}

/**
 * Helper untuk melakukan proses tukar token (login exchange) dengan Aime Gateway.
 * Mengembalikan session cookie header yang siap dipakai.
 */
async function getSessionCookies(domain, clal, userAgent) {
    const jar = new CookieJar();

    // Step 1: Hit Maimai Mobile utama untuk memicu redirect ke Aime Gateway
    let response = await fetch(`https://${domain}/maimai-mobile/`, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'User-Agent': userAgent }
    });
    jar.addCookies(response.headers.getSetCookie ? response.headers.getSetCookie() : response.headers.get('set-cookie'));

    let gatewayUrl = response.headers.get('location');
    if (!gatewayUrl) {
        throw new Error('Gagal mendapatkan URL login SEGA Aime.');
    }

    // Step 2: Kirim cookie clal ke SEGA Aime Gateway untuk mendapatkan tiket redirect balik
    response = await fetch(gatewayUrl, {
        method: 'GET',
        redirect: 'manual',
        headers: {
            'Cookie': `clal=${clal}`,
            'User-Agent': userAgent
        }
    });

    let callbackUrl = response.headers.get('location');
    if (!callbackUrl) {
        throw new Error('Cookie clal ditolak oleh Gateway (Sesi salah atau expired).');
    }

    // Step 3: Hit callback url untuk mendapatkan cookie session awal (_t dan userId)
    response = await fetch(callbackUrl, {
        method: 'GET',
        redirect: 'manual',
        headers: {
            'Cookie': jar.getCookieHeader(),
            'User-Agent': userAgent
        }
    });
    jar.addCookies(response.headers.getSetCookie ? response.headers.getSetCookie() : response.headers.get('set-cookie'));

    // Step 4: Hit Home Page untuk memastikan sesi ter-bind penuh di server SEGA
    response = await fetch(`https://${domain}/maimai-mobile/home/`, {
        method: 'GET',
        headers: {
            'Cookie': jar.getCookieHeader(),
            'User-Agent': userAgent
        }
    });
    if (response.ok) {
        jar.addCookies(response.headers.getSetCookie ? response.headers.getSetCookie() : response.headers.get('set-cookie'));
    }

    return jar.getCookieHeader();
}

/**
 * Mengambil profil Maimai DX NET (Nickname dan Rating).
 * 
 * @param {string} clal 
 * @returns {Promise<{nickname: string, rating: number, domain: string}>}
 */
async function fetchMaimaiProfile(clal) {
    const domains = ['maimaidx-eng.com', 'maimaidx.jp'];
    const userAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';
    const errors = [];

    for (const domain of domains) {
        try {
            console.log(`[Scraper] [Profile] Mencoba domain: ${domain}`);
            const sessionCookieHeader = await getSessionCookies(domain, clal, userAgent);

            const response = await fetch(`https://${domain}/maimai-mobile/home/`, {
                method: 'GET',
                headers: {
                    'Cookie': sessionCookieHeader,
                    'User-Agent': userAgent
                }
            });

            if (!response.ok) {
                errors.push(`${domain}: Gagal fetch Home Page (Status ${response.status})`);
                continue;
            }

            const html = await response.text();
            if (html.includes('login') || html.includes('aime')) {
                errors.push(`${domain}: Sesi expired setelah login exchange`);
                continue;
            }

            // Ekstraksi Nickname
            const nameMatch = html.match(/<div[^>]*class="[^"]*name_block[^"]*"[^>]*>([\s\S]*?)<\/div>/);
            let nickname = '';
            if (nameMatch) {
                nickname = nameMatch[1].replace(/<[^>]*>/g, '').trim();
            }

            // Ekstraksi Rating
            const ratingBlockMatch = html.match(/<div[^>]*class="[^"]*rating_block[^"]*"[^>]*>([\s\S]*?)<\/div>/);
            let rating = 0;
            if (ratingBlockMatch) {
                const ratingContent = ratingBlockMatch[1];
                const rawText = ratingContent.replace(/<[^>]*>/g, '').trim();
                const digits = rawText.match(/\d+/);
                if (digits) {
                    rating = parseInt(digits[0], 10);
                } else {
                    const imgMatches = ratingContent.matchAll(/rating_(?:val|num)_(\d+)\.png/gi);
                    let ratingStr = '';
                    for (const match of imgMatches) {
                        ratingStr += match[1];
                    }
                    if (ratingStr) {
                        rating = parseInt(ratingStr, 10);
                    }
                }
            }

            if (nickname) {
                return { nickname, rating, domain };
            } else {
                errors.push(`${domain}: Gagal parsing nickname dari HTML`);
            }
        } catch (err) {
            errors.push(`${domain}: Error (${err.message})`);
        }
    }

    console.warn('[Scraper] [Profile] Gagal mengambil profil:', errors.join(' | '));
    throw new Error('Sesi Maimai DX NET tidak valid atau kedaluwarsa. Silakan login ulang via .login.');
}

/**
 * Mengambil daftar 5 riwayat lagu terakhir yang dimainkan.
 * 
 * @param {string} clal 
 * @returns {Promise<Array<{title: string, difficulty: string, type: string, achievement: string, rank: string, date: string, track: string, idx: string}>>}
 */
async function fetchMaimaiRecent(clal) {
    const domains = ['maimaidx-eng.com', 'maimaidx.jp'];
    const userAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';
    const errors = [];

    for (const domain of domains) {
        try {
            console.log(`[Scraper] [Recent] Mencoba domain: ${domain}`);
            const sessionCookieHeader = await getSessionCookies(domain, clal, userAgent);

            // Pada Maimai DX NET, halaman record utama (/record/) adalah daftar playlog (riwayat bermain)
            const response = await fetch(`https://${domain}/maimai-mobile/record/`, {
                method: 'GET',
                headers: {
                    'Cookie': sessionCookieHeader,
                    'User-Agent': userAgent
                }
            });

            if (!response.ok) {
                errors.push(`${domain}: Gagal fetch playlog page (Status ${response.status})`);
                continue;
            }

            const html = await response.text();
            if (html.includes('login') || html.includes('aime')) {
                errors.push(`${domain}: Sesi expired di halaman playlog`);
                continue;
            }

            // Split HTML berdasarkan container lagu
            const blocks = html.split('class="playlog_top_container');
            if (blocks.length <= 1) {
                return []; // Riwayat bermain kosong
            }

            const playlogs = [];
            // Ambil maksimal 5 lagu terakhir
            for (let i = 1; i < Math.min(blocks.length, 6); i++) {
                const block = blocks[i];

                // 1. Difficulty
                let difficulty = 'expert';
                if (block.includes('diff_basic.png')) difficulty = 'basic';
                else if (block.includes('diff_advanced.png')) difficulty = 'advanced';
                else if (block.includes('diff_expert.png')) difficulty = 'expert';
                else if (block.includes('diff_master.png')) difficulty = 'master';
                else if (block.includes('diff_remaster.png')) difficulty = 'remaster';

                // 2. Level Text (misal: 12+)
                let level = '';
                const lvMatch = block.match(/class="[^"]*playlog_level_icon[^"]*">([^<]+)<\/div>/);
                if (lvMatch) level = lvMatch[1].trim();

                // 3. Track & Date
                let track = '';
                const trackMatch = block.match(/class="[^"]*red[^"]*">([^<]+)<\/span>/);
                if (trackMatch) track = trackMatch[1].trim();

                let date = '';
                const dateMatch = block.match(/class="v_b">([^<]+)<\/span>/);
                if (dateMatch) date = dateMatch[1].trim();

                // 3. Song Title
                let title = '';
                const titleMatch = block.match(/class="[^"]*music_lv_back[^"]*"[^>]*>[^<]*<\/div>\s*<\/div>\s*<\/div>\s*([\s\S]*?)\s*<\/div>/);
                if (titleMatch) {
                    title = titleMatch[1].replace(/<[^>]*>/g, '').trim();
                }

                // 4. Type (SD / DX)
                const type = block.includes('music_dx.png') ? 'DX' : 'SD';

                // 5. Achievement
                let achievement = '';
                const achMatch = block.match(/class="playlog_achievement_txt[^"]*">(\d+)<span[^>]*>([^<]+)<\/span>/);
                if (achMatch) {
                    achievement = achMatch[1] + achMatch[2];
                }

                // 6. Score Rank
                let rank = '';
                const rankMatch = block.match(/playlog\/([a-zA-Z0-9_]+)\.png[^"]*"[^>]*class="playlog_scorerank"/);
                if (rankMatch) {
                    rank = rankMatch[1].toUpperCase().replace('PLUS', '+');
                }

                // 7. Idx parameter untuk detail
                let idx = '';
                const idxMatch = block.match(/name="idx"\s+value="([^"]+)"/);
                if (idxMatch) idx = idxMatch[1];

                playlogs.push({
                    title,
                    difficulty,
                    level,
                    type,
                    achievement,
                    rank,
                    date,
                    track,
                    idx
                });
            }

            return playlogs;
        } catch (err) {
            errors.push(`${domain}: Error (${err.message})`);
        }
    }

    throw new Error('Gagal mengambil riwayat bermain Maimai DX NET: ' + errors.join(' | '));
}

/**
 * Mengambil rincian detail judgement dari suatu track bermain.
 * 
 * @param {string} clal 
 * @param {string} idx 
 * @returns {Promise<{title: string, difficulty: string, type: string, achievement: string, rank: string, fast: number, late: number, rating: number, ratingChange: string, combo: string, sync: string, track: string, date: string, judgements: Object}>}
 */
async function fetchMaimaiRecentDetail(clal, idx) {
    const domains = ['maimaidx-eng.com', 'maimaidx.jp'];
    const userAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';
    const errors = [];

    for (const domain of domains) {
        try {
            console.log(`[Scraper] [Detail] Mencoba domain: ${domain}`);
            const sessionCookieHeader = await getSessionCookies(domain, clal, userAgent);

            const detailUrl = `https://${domain}/maimai-mobile/record/playlogDetail/?idx=${idx}`;
            const response = await fetch(detailUrl, {
                method: 'GET',
                headers: {
                    'Cookie': sessionCookieHeader,
                    'User-Agent': userAgent,
                    'Referer': `https://${domain}/maimai-mobile/record/`
                }
            });

            if (!response.ok) {
                errors.push(`${domain}: Gagal fetch detail playlog (Status ${response.status})`);
                continue;
            }

            const html = await response.text();
            if (html.includes('login') || html.includes('aime')) {
                errors.push(`${domain}: Sesi expired di halaman detail`);
                continue;
            }

            // 1. Song Title
            let title = '';
            const titleMatch = html.match(/class="[^"]*music_lv_back[^"]*"[^>]*>[^<]*<\/div>\s*<\/div>\s*<\/div>\s*([\s\S]*?)\s*<\/div>/);
            if (titleMatch) {
                title = titleMatch[1].replace(/<[^>]*>/g, '').trim();
            }

            // 2. Difficulty
            let difficulty = 'expert';
            if (html.includes('diff_basic.png')) difficulty = 'basic';
            else if (html.includes('diff_advanced.png')) difficulty = 'advanced';
            else if (html.includes('diff_expert.png')) difficulty = 'expert';
            else if (html.includes('diff_master.png')) difficulty = 'master';
            else if (html.includes('diff_remaster.png')) difficulty = 'remaster';

            // Level Text
            let level = '';
            const lvMatch = html.match(/class="[^"]*playlog_level_icon[^"]*">([^<]+)<\/div>/);
            if (lvMatch) level = lvMatch[1].trim();

            // 3. Type (SD / DX)
            const type = html.includes('music_dx.png') ? 'DX' : 'SD';

            // 4. Achievement
            let achievement = '';
            const achMatch = html.match(/class="playlog_achievement_txt[^"]*">(\d+)<span[^>]*>([^<]+)<\/span>/);
            if (achMatch) {
                achievement = achMatch[1] + achMatch[2];
            }

            // 5. Rank
            let rank = '';
            const rankMatch = html.match(/playlog\/([a-zA-Z0-9_]+)\.png[^"]*"[^>]*class="playlog_scorerank"/);
            if (rankMatch) {
                rank = rankMatch[1].toUpperCase().replace('PLUS', '+');
            }

            // 6. Fast & Late
            let fast = 0, late = 0;
            const fastMatch = html.match(/fast\.png[^>]*>[\s\S]*?<div[^>]*>(\d+)<\/div>/);
            if (fastMatch) fast = parseInt(fastMatch[1], 10);
            const lateMatch = html.match(/late\.png[^>]*>[\s\S]*?<div[^>]*>(\d+)<\/div>/);
            if (lateMatch) late = parseInt(lateMatch[1], 10);

            // 7. Rating & Perubahan Rating
            let rating = 0;
            const ratingMatch = html.match(/class="rating_block">(\d+)<\/div>/);
            if (ratingMatch) rating = parseInt(ratingMatch[1], 10);

            let ratingChange = '';
            const changeMatch = html.match(/class="playlog_rating_detail_block[^>]*>[\s\S]*?<span[^>]*>\(([^)]+)\)<\/span>/);
            if (changeMatch) ratingChange = changeMatch[1].trim();

            // 8. Max Combo & Sync
            let combo = '';
            const comboMatch = html.match(/maxcombo\.png[^>]*>[\s\S]*?<div[^>]*>([^<]+)<\/div>/);
            if (comboMatch) combo = comboMatch[1].trim();

            let sync = '';
            const syncMatch = html.match(/maxsync\.png[^>]*>[\s\S]*?<div[^>]*>([^<]+)<\/div>/);
            if (syncMatch) sync = syncMatch[1].trim();

            // 9. Track & Date
            let track = '';
            const trackMatch = html.match(/class="[^"]*red[^"]*">([^<]+)<\/span>/);
            if (trackMatch) track = trackMatch[1].trim();

            let date = '';
            const dateMatch = html.match(/class="v_b">([^<]+)<\/span>/);
            if (dateMatch) date = dateMatch[1].trim();

            // 10. Judgements grid (Tap, Hold, Slide, Touch, Break)
            const noteTypes = ['tap', 'hold', 'slide', 'touch', 'break'];
            const judgements = {};
            for (const note of noteTypes) {
                judgements[note] = [0, 0, 0, 0, 0];
                
                const rowRegex = new RegExp(`<tr[^>]*>\\s*<th[^>]*>\\s*<img[^>]*playlog/${note}\\.png[^>]*>[\\s\\S]*?<\\/tr>`);
                const rowMatch = html.match(rowRegex);
                if (rowMatch) {
                    const tds = rowMatch[0].match(/<td>([\s\S]*?)<\/td>/g);
                    if (tds && tds.length >= 5) {
                        judgements[note] = tds.slice(0, 5).map(td => {
                            const clean = td.replace(/<[^>]*>/g, '').replace(/[\s　]/g, '');
                            return clean === '' ? 0 : (parseInt(clean, 10) || 0);
                        });
                    }
                }
            }

            return {
                title,
                difficulty,
                level,
                type,
                achievement,
                rank,
                fast,
                late,
                rating,
                ratingChange,
                combo,
                sync,
                track,
                date,
                judgements
            };
        } catch (err) {
            errors.push(`${domain}: Error (${err.message})`);
        }
    }

    throw new Error('Gagal mengambil rincian detail Maimai DX NET: ' + errors.join(' | '));
}

module.exports = { fetchMaimaiProfile, fetchMaimaiRecent, fetchMaimaiRecentDetail };
