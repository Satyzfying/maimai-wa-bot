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

// Helper to decode HTML entities including double-encoded variants (e.g. &amp;#039; → ')
function decodeHtmlEntities(str) {
    if (!str) return '';
    // Run twice to handle double-encoded entities (e.g. &amp;#039; → &#039; → ')
    let result = str;
    for (let pass = 0; pass < 2; pass++) {
        result = result
            .replace(/&amp;/g, '&')
            .replace(/&#039;/g, "'")
            .replace(/&apos;/g, "'")
            .replace(/&quot;/g, '"')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&nbsp;/g, ' ');
    }
    return result;
}

// Helper untuk melakukan fetch dengan timeout agar tidak menggantung selamanya (default 15 detik)
async function fetchWithTimeout(resource, options = {}) {
    const { timeout = 15000 } = options;
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(resource, {
            ...options,
            signal: controller.signal
        });
        clearTimeout(id);
        return response;
    } catch (err) {
        clearTimeout(id);
        if (err.name === 'AbortError') {
            throw new Error(`Koneksi ke SEGA timeout setelah ${timeout / 1000} detik.`);
        }
        throw err;
    }
}

// Fallback User-Agent jika tidak disediakan
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';

/**
 * Helper untuk melakukan proses tukar token (login exchange) dengan Aime Gateway.
 * Mengembalikan session cookie header yang siap dipakai.
 */
async function getSessionCookies(domain, clal, userAgent) {
    const jar = new CookieJar();
    const ua = userAgent || DEFAULT_USER_AGENT;

    // Step 1: Hit Maimai Mobile utama untuk memicu redirect ke Aime Gateway
    let response = await fetchWithTimeout(`https://${domain}/maimai-mobile/`, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'User-Agent': ua }
    });
    jar.addCookies(response.headers.getSetCookie ? response.headers.getSetCookie() : response.headers.get('set-cookie'));

    let gatewayUrl = response.headers.get('location');
    if (!gatewayUrl) {
        throw new Error('Gagal mendapatkan URL login SEGA Aime.');
    }

    // Step 2: Kirim cookie clal ke SEGA Aime Gateway untuk mendapatkan tiket redirect balik
    response = await fetchWithTimeout(gatewayUrl, {
        method: 'GET',
        redirect: 'manual',
        headers: {
            'Cookie': `clal=${clal}`,
            'User-Agent': ua
        }
    });

    let callbackUrl = response.headers.get('location');
    if (!callbackUrl) {
        throw new Error('Cookie clal ditolak oleh Gateway (Sesi salah atau expired).');
    }

    // Step 3: Hit callback url untuk mendapatkan cookie session awal (_t dan userId)
    response = await fetchWithTimeout(callbackUrl, {
        method: 'GET',
        redirect: 'manual',
        headers: {
            'Cookie': jar.getCookieHeader(),
            'User-Agent': ua
        }
    });
    jar.addCookies(response.headers.getSetCookie ? response.headers.getSetCookie() : response.headers.get('set-cookie'));

    // Step 4: Hit Home Page untuk memastikan sesi ter-bind penuh di server SEGA
    response = await fetchWithTimeout(`https://${domain}/maimai-mobile/home/`, {
        method: 'GET',
        headers: {
            'Cookie': jar.getCookieHeader(),
            'User-Agent': ua
        }
    });
    if (response.ok) {
        jar.addCookies(response.headers.getSetCookie ? response.headers.getSetCookie() : response.headers.get('set-cookie'));
    }

    return jar.getCookieHeader();
}

/**
 * Mengakses halaman target di Maimai DX NET secara efisien menggunakan session cookie tersimpan.
 * Jika session cookie kosong atau kedaluwarsa, otomatis memicu getSessionCookies menggunakan clal.
 */
async function fetchMaimaiPage(domain, clal, savedSessionCookie, url, referer, userAgent) {
    let sessionCookieHeader = savedSessionCookie;
    let newSessionCookie = null;
    const ua = userAgent || DEFAULT_USER_AGENT;

    if (sessionCookieHeader) {
        try {
            console.log(`[Scraper] [Direct Fetch] Mencoba memuat ${url} dengan session cookie tersimpan`);
            const response = await fetchWithTimeout(url, {
                method: 'GET',
                redirect: 'manual',
                headers: {
                    'Cookie': sessionCookieHeader,
                    'User-Agent': ua,
                    'Referer': referer || `https://${domain}/maimai-mobile/home/`
                }
            });

             if (response.status === 200) {
                const html = await response.text();
                const isError = html.includes('lng-tgk-aime-gw.am-all.net') || 
                                html.includes('An error has occurred') || 
                                html.includes('エラーが発生しました') ||
                                html.includes('black red bold');
                if (!isError) {
                    console.log(`[Scraper] [Direct Fetch] Sesi valid.`);
                    return { html, newSessionCookie: null };
                }
            }
            console.log(`[Scraper] [Direct Fetch] Sesi tersimpan kedaluwarsa, dialihkan, atau halaman error (Status ${response.status}).`);
        } catch (err) {
            console.warn(`[Scraper] [Direct Fetch] Gagal melakukan request langsung:`, err.message);
        }
    }

    // Jika sesi kosong atau expired, lakukan login exchange penuh menggunakan clal
    if (!clal) {
        throw new Error('Sesi Maimai DX NET kedaluwarsa and tidak ada cookie clal untuk melakukan auto-login.');
    }

    console.log(`[Scraper] [Login Exchange] Melakukan pertukaran token menggunakan cookie clal`);
    sessionCookieHeader = await getSessionCookies(domain, clal, ua);
    newSessionCookie = sessionCookieHeader;

    // Ambil halaman target dengan session cookie yang baru dibuat
    const response = await fetchWithTimeout(url, {
        method: 'GET',
        redirect: 'manual',
        headers: {
            'Cookie': sessionCookieHeader,
            'User-Agent': ua,
            'Referer': referer || `https://${domain}/maimai-mobile/home/`
        }
    });

    if (!response.ok && response.status !== 302) {
        throw new Error(`Gagal memuat halaman target (Status ${response.status})`);
    }

    let html = await response.text();
    
    // Follow internal redirect after login if needed
    if (response.status === 302) {
        const rawLoc = response.headers.get('location');
        const redirectLoc = new URL(rawLoc, `https://${domain}`).href;
        const followResponse = await fetchWithTimeout(redirectLoc, {
            method: 'GET',
            headers: {
                'Cookie': sessionCookieHeader,
                'User-Agent': ua,
                'Referer': url
            }
        });
        html = await followResponse.text();
    }

    const isError = html.includes('lng-tgk-aime-gw.am-all.net') || 
                    html.includes('An error has occurred') || 
                    html.includes('エラーが発生しました') ||
                    html.includes('black red bold');
    if (isError) {
        throw new Error('Sesi Maimai DX NET tidak valid atau kedaluwarsa (Mendapatkan halaman error).');
    }

    return { html, newSessionCookie };
}

/**
 * Mengambil profil Maimai DX NET (Nickname dan Rating) dengan optimasi sesi.
 * 
 * @param {string} clal 
 * @param {string} savedSessionCookie
 * @param {string} userAgent
 * @param {string} preferredDomain
 * @returns {Promise<{nickname: string, rating: number, domain: string, newSessionCookie: string|null}>}
 */
async function fetchMaimaiProfile(clal, savedSessionCookie, userAgent, preferredDomain) {
    const domains = preferredDomain ? [preferredDomain] : ['maimaidx-eng.com', 'maimaidx.jp'];
    const ua = userAgent || DEFAULT_USER_AGENT;
    const errors = [];

    for (const domain of domains) {
        try {
            console.log(`[Scraper] [Profile] Mencoba domain: ${domain}`);
            
            const targetUrl = `https://${domain}/maimai-mobile/home/`;
            const referer = `https://${domain}/maimai-mobile/`;
            const { html, newSessionCookie } = await fetchMaimaiPage(domain, clal, savedSessionCookie, targetUrl, referer, ua);

            // Ekstraksi Nickname
            const nameMatch = html.match(/<div[^>]*class="[^"]*name_block[^"]*"[^>]*>([\s\S]*?)<\/div>/);
            let nickname = '';
            if (nameMatch) {
                nickname = decodeHtmlEntities(nameMatch[1].replace(/<[^>]*>/g, '').trim());
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
                return { nickname, rating, domain, newSessionCookie };
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
 * Mengambil daftar 5 riwayat lagu terakhir yang dimainkan dengan optimasi sesi.
 * 
 * @param {string} clal 
 * @param {string} savedSessionCookie
 * @param {string} userAgent
 * @param {string} preferredDomain
 * @returns {Promise<{playlogs: Array<Object>, newSessionCookie: string|null}>}
 */
async function fetchMaimaiRecent(clal, savedSessionCookie, userAgent, preferredDomain) {
    const domains = preferredDomain ? [preferredDomain] : ['maimaidx-eng.com', 'maimaidx.jp'];
    const ua = userAgent || DEFAULT_USER_AGENT;
    const errors = [];

    for (const domain of domains) {
        try {
            console.log(`[Scraper] [Recent] Mencoba domain: ${domain}`);
            
            const targetUrl = `https://${domain}/maimai-mobile/record/`;
            const referer = `https://${domain}/maimai-mobile/home/`;
            const { html, newSessionCookie } = await fetchMaimaiPage(domain, clal, savedSessionCookie, targetUrl, referer, ua);

            // Split HTML berdasarkan container lagu
            const blocks = html.split('class="playlog_top_container');
            if (blocks.length <= 1) {
                return { playlogs: [], newSessionCookie };
            }

            const playlogs = [];
            for (let i = 1; i < blocks.length; i++) {
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

                // 4. Song Title
                let title = '';
                const titleMatch = block.match(/class="[^"]*basic_block[^"]*break[^"]*"[^>]*>[\s\S]*?<\/div>\s*<\/div>\s*([\s\S]*?)\s*<\/div>/);
                if (titleMatch) {
                    title = decodeHtmlEntities(titleMatch[1].replace(/<[^>]*>/g, '').trim());
                }

                // 5. Type (SD / DX)
                const type = block.includes('music_dx.png') ? 'DX' : 'SD';

                // 6. Achievement
                let achievement = '';
                const achMatch = block.match(/class="playlog_achievement_txt[^"]*">(\d+)<span[^>]*>([^<]+)<\/span>/);
                if (achMatch) {
                    achievement = achMatch[1] + achMatch[2];
                }

                // 7. Score Rank
                let rank = '';
                const rankMatch = block.match(/playlog\/([a-zA-Z0-9_]+)\.png[^"]*"[^>]*class="playlog_scorerank"/);
                if (rankMatch) {
                    rank = rankMatch[1].toUpperCase().replace('PLUS', '+');
                }

                // 8. Idx parameter untuk detail
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

            return { playlogs, newSessionCookie };
        } catch (err) {
            errors.push(`${domain}: Error (${err.message})`);
        }
    }

    throw new Error('Gagal mengambil riwayat bermain Maimai DX NET: ' + errors.join(' | '));
}

/**
 * Mengambil rincian detail judgement dari suatu track bermain dengan optimasi sesi.
 * 
 * @param {string} clal 
 * @param {string} idx 
 * @param {string} savedSessionCookie
 * @param {string} userAgent
 * @param {string} preferredDomain
 * @returns {Promise<{detail: Object, newSessionCookie: string|null}>}
 */
async function fetchMaimaiRecentDetail(clal, idx, savedSessionCookie, userAgent, preferredDomain) {
    const domains = preferredDomain ? [preferredDomain] : ['maimaidx-eng.com', 'maimaidx.jp'];
    const ua = userAgent || DEFAULT_USER_AGENT;
    const errors = [];

    for (const domain of domains) {
        try {
            console.log(`[Scraper] [Detail] Mencoba domain: ${domain}`);
            
            const detailUrl = `https://${domain}/maimai-mobile/record/playlogDetail/?idx=${idx}`;
            const referer = `https://${domain}/maimai-mobile/record/`;
            const { html, newSessionCookie } = await fetchMaimaiPage(domain, clal, savedSessionCookie, detailUrl, referer, ua);

            // 1. Song Title
            let title = '';
            const titleMatch = html.match(/class="[^"]*basic_block[^"]*break[^"]*"[^>]*>[\s\S]*?<\/div>\s*<\/div>\s*([\s\S]*?)\s*<\/div>/);
            if (titleMatch) {
                title = decodeHtmlEntities(titleMatch[1].replace(/<[^>]*>/g, '').trim());
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

            // 10. Judgements grid
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

            const detail = {
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

            return { detail, newSessionCookie };
        } catch (err) {
            errors.push(`${domain}: Error (${err.message})`);
        }
    }

    throw new Error('Gagal mengambil rincian detail Maimai DX NET: ' + errors.join(' | '));
}

/**
 * Fetches all best scores for Expert, Master, and Re:Master charts from maimai DX NET.
 * Used to build the B50 (Best 50) calculation.
 *
 * @param {string} clal
 * @param {string} savedSessionCookie
 * @param {string} userAgent
 * @param {string} preferredDomain
 * @returns {Promise<{scores: Array<Object>, newSessionCookie: string|null}>}
 */
async function fetchMaimaiMusicBest(clal, savedSessionCookie, userAgent, preferredDomain) {
    const domains = preferredDomain ? [preferredDomain] : ['maimaidx-eng.com', 'maimaidx.jp'];
    const ua = userAgent || DEFAULT_USER_AGENT;
    const errors = [];

    // Difficulty indices: 2=Expert, 3=Master, 4=Re:Master
    const DIFFS = [
        { id: 2, name: 'expert' },
        { id: 3, name: 'master' },
        { id: 4, name: 'remaster' }
    ];

    for (const domain of domains) {
        try {
            const allScores = [];
            let validSessionCookie = savedSessionCookie;

            // 1. Fetch the first difficulty (Expert) sequentially to validate/refresh session
            const firstDiff = DIFFS[0];
            console.log(`[Scraper] [MusicBest] Fetching diff=${firstDiff.id} (${firstDiff.name}) from ${domain}`);
            const firstUrl = `https://${domain}/maimai-mobile/record/musicGenre/search/?genre=99&diff=${firstDiff.id}`;
            const referer = `https://${domain}/maimai-mobile/record/`;
            
            const firstResult = await fetchMaimaiPage(
                domain, clal, validSessionCookie, firstUrl, referer, ua
            );
            
            let latestNewSessionCookie = firstResult.newSessionCookie || null;
            if (latestNewSessionCookie) {
                validSessionCookie = latestNewSessionCookie;
            }

            // Parse first difficulty
            const firstBlocks = firstResult.html.split('class="w_450 m_15 p_r f_0"');
            console.log(`[Scraper] [MusicBest] diff=${firstDiff.name}: found ${firstBlocks.length - 1} cards.`);
            for (let i = 1; i < firstBlocks.length; i++) {
                const block = firstBlocks[i];
                let title = '';
                const titleMatch = block.match(/class="[^"]*music_name_block[^"]*"[^>]*>([\s\S]*?)<\/div>/);
                if (titleMatch) title = decodeHtmlEntities(titleMatch[1].replace(/<[^>]*>/g, '').trim());
                if (!title) continue;

                let type = (block.includes('music_standard.png') || block.includes('_standard')) ? 'SD' : 'DX';
                let achievement = 0;
                const achMatch = block.match(/class="[^"]*music_achievement_txt[^"]*"[^>]*>([\s\S]*?)<\/div>/);
                if (achMatch) {
                    const rawAch = achMatch[1].replace(/<[^>]*>/g, '').replace(/%/g, '').trim();
                    achievement = parseFloat(rawAch);
                }
                if (isNaN(achievement) || achievement === 0) continue;

                let rank = '';
                const rankMatch = block.match(/music_icon_([a-zA-Z0-9_]+)\.png/);
                if (rankMatch) rank = rankMatch[1].toUpperCase().replace('PLUS', '+').replace('P', '+');

                allScores.push({ title, type, difficulty: firstDiff.name, achievement, rank });
            }

            // 2. Fetch the remaining difficulties (Master, Re:Master) in parallel since session is validated
            const remainingDiffs = DIFFS.slice(1);
            const fetchPromises = remainingDiffs.map(async (diff) => {
                console.log(`[Scraper] [MusicBest] Fetching diff=${diff.id} (${diff.name}) in parallel from ${domain}`);
                const diffUrl = `https://${domain}/maimai-mobile/record/musicGenre/search/?genre=99&diff=${diff.id}`;
                const { html } = await fetchMaimaiPage(
                    domain, clal, validSessionCookie, diffUrl, referer, ua
                );
                return { diff, html };
            });

            const remainingResults = await Promise.all(fetchPromises);

            // Parse remaining difficulties
            for (const { diff, html } of remainingResults) {
                const blocks = html.split('class="w_450 m_15 p_r f_0"');
                console.log(`[Scraper] [MusicBest] diff=${diff.name}: found ${blocks.length - 1} cards.`);
                
                for (let i = 1; i < blocks.length; i++) {
                    const block = blocks[i];
                    let title = '';
                    const titleMatch = block.match(/class="[^"]*music_name_block[^"]*"[^>]*>([\s\S]*?)<\/div>/);
                    if (titleMatch) title = decodeHtmlEntities(titleMatch[1].replace(/<[^>]*>/g, '').trim());
                    if (!title) continue;

                    let type = (block.includes('music_standard.png') || block.includes('_standard')) ? 'SD' : 'DX';
                    let achievement = 0;
                    const achMatch = block.match(/class="[^"]*music_achievement_txt[^"]*"[^>]*>([\s\S]*?)<\/div>/);
                    if (achMatch) {
                        const rawAch = achMatch[1].replace(/<[^>]*>/g, '').replace(/%/g, '').trim();
                        achievement = parseFloat(rawAch);
                    }
                    if (isNaN(achievement) || achievement === 0) continue;

                    let rank = '';
                    const rankMatch = block.match(/music_icon_([a-zA-Z0-9_]+)\.png/);
                    if (rankMatch) rank = rankMatch[1].toUpperCase().replace('PLUS', '+').replace('P', '+');

                    allScores.push({ title, type, difficulty: diff.name, achievement, rank });
                }
            }

            return { scores: allScores, newSessionCookie: latestNewSessionCookie };
        } catch (err) {
            errors.push(`${domain}: ${err.message}`);
        }
    }

    throw new Error('Failed to fetch music best scores: ' + errors.join(' | '));
}

module.exports = { fetchMaimaiProfile, fetchMaimaiRecent, fetchMaimaiRecentDetail, fetchMaimaiMusicBest };


