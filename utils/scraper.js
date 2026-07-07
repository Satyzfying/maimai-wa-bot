/**
 * Mengambil profil Maimai DX NET (Nickname dan Rating) menggunakan cookie session clal.
 * Melakukan proses tukar token (redirect chain) dengan server SEGA Aime Gateway
 * untuk mendapatkan cookie session asli (_t dan userId) dari Maimai DX NET.
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
            console.log(`[Scraper] Mencoba melakukan login exchange ke domain: ${domain}`);
            
            // Step 1: Hit Halaman Utama Maimai Mobile untuk memicu redirect ke Aime Gateway
            let response = await fetch(`https://${domain}/maimai-mobile/`, {
                method: 'GET',
                redirect: 'manual',
                headers: {
                    'User-Agent': userAgent
                }
            });

            let gatewayUrl = response.headers.get('location');
            if (!gatewayUrl) {
                errors.push(`${domain}: Gagal mendapatkan URL Gateway SEGA Aime`);
                continue;
            }

            console.log(`[Scraper] Didapatkan URL Gateway. Mengirim cookie clal ke: ${gatewayUrl}`);

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
                errors.push(`${domain}: Cookie clal ditolak oleh Gateway (Sesi salah/expired)`);
                continue;
            }

            console.log(`[Scraper] Gateway menyetujui cookie. Mengikuti redirect callback: ${callbackUrl}`);

            // Step 3: Hit callback url untuk mendapatkan cookie session asli (_t dan userId)
            response = await fetch(callbackUrl, {
                method: 'GET',
                redirect: 'manual',
                headers: {
                    'User-Agent': userAgent
                }
            });

            // Mengambil semua set-cookie headers (Node 18+ mendukung getSetCookie)
            const setCookies = response.headers.getSetCookie ? response.headers.getSetCookie() : response.headers.get('set-cookie');
            let cookiesList = [];

            if (Array.isArray(setCookies)) {
                cookiesList = setCookies.map(c => c.split(';')[0]);
            } else if (setCookies) {
                cookiesList = [setCookies.split(';')[0]];
            }

            if (cookiesList.length === 0) {
                errors.push(`${domain}: Callback tidak mengembalikan cookie session (_t/userId)`);
                continue;
            }

            const sessionCookieHeader = cookiesList.join('; ');
            console.log(`[Scraper] Session Cookie berhasil didapatkan. Melakukan fetch ke Home Page.`);

            // Step 4: Fetch halaman Home menggunakan session cookie asli
            response = await fetch(`https://${domain}/maimai-mobile/home/`, {
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

            // 1. Ekstraksi Nickname
            const nameMatch = html.match(/<div[^>]*class="[^"]*name_block[^"]*"[^>]*>([\s\S]*?)<\/div>/);
            let nickname = '';
            if (nameMatch) {
                nickname = nameMatch[1].replace(/<[^>]*>/g, '').trim();
            }

            // 2. Ekstraksi Rating
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
                errors.push(`${domain}: Gagal mem-parsing nickname dari HTML`);
            }
        } catch (err) {
            errors.push(`${domain}: Error (${err.message})`);
        }
    }

    console.warn('[Scraper] Gagal login exchange:', errors.join(' | '));
    throw new Error('Sesi Maimai DX NET tidak valid atau kedaluwarsa. Silakan log out dan login ulang ke situs Maimai DX NET sebelum menjalankan bookmarklet.');
}

module.exports = { fetchMaimaiProfile };
