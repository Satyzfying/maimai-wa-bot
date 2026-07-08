const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { handleMessage } = require('./handler');
const { fetchMaimaiProfile } = require('./utils/scraper');
const { startReminderScheduler } = require('./utils/reminders');
const { dataPath, ensureDataDir, writeJsonAtomic } = require('./utils/paths');

const otps = new Map();
let activeSock = null;
let reconnectDelay = 1000; // starts at 1s, doubles each attempt up to 30s
let pairingCodeRequested = false;

ensureDataDir();

// Membaca konfigurasi port dari environment Zeabur atau config.json
let PORT = Number(process.env.PORT) || 3000;
try {
    const configPath = path.join(__dirname, 'config.json');
    if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        PORT = Number(process.env.PORT) || config.port || 3000;
    }
} catch (err) {
    console.error('Error loading config for port:', err);
}

// Helper untuk mengirim respon HTML bernuansa gelap premium
function sendHtmlResponse(res, statusCode, isSuccess, message) {
    res.writeHead(statusCode, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>${isSuccess ? 'Login Sukses' : 'Login Gagal'}</title>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                body {
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                    text-align: center;
                    padding: 50px 20px;
                    background-color: #0d1117;
                    color: #c9d1d9;
                }
                .card {
                    max-width: 420px;
                    margin: 0 auto;
                    background: #161b22;
                    border: 1px solid #30363d;
                    border-radius: 12px;
                    padding: 40px 30px;
                    box-shadow: 0 8px 24px rgba(0,0,0,0.4);
                }
                .icon {
                    font-size: 72px;
                    margin-bottom: 20px;
                }
                .success { color: #58a6ff; }
                .error { color: #f85149; }
                h1 {
                    font-size: 26px;
                    margin-bottom: 12px;
                    color: #f0f6fc;
                }
                p {
                    font-size: 16px;
                    line-height: 1.6;
                    color: #8b949e;
                }
            </style>
        </head>
        <body>
            <div class="card">
                <div class="icon ${isSuccess ? 'success' : 'error'}">
                    ${isSuccess ? '✓' : '✗'}
                </div>
                <h1>${isSuccess ? 'Koneksi Berhasil!' : 'Terjadi Kesalahan'}</h1>
                <p>${message}</p>
            </div>
        </body>
        </html>
    `);
}

async function startBot() {
    // Menyimpan sesi login agar tidak perlu pairing ulang terus-menerus
    const { state, saveCreds } = await useMultiFileAuthState(dataPath('auth_info_baileys'));

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false
    });

    activeSock = sock;

    // Event koneksi WhatsApp
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && !state.creds.registered && !pairingCodeRequested) {
            pairingCodeRequested = true;
            const phoneNumber = (process.env.PAIRING_PHONE_NUMBER || '').replace(/\D/g, '');

            if (phoneNumber) {
                try {
                    const code = await sock.requestPairingCode(phoneNumber);
                    console.log('--- WHATSAPP PAIRING CODE ---');
                    console.log(code.match(/.{1,4}/g)?.join('-') || code);
                    console.log('Buka WhatsApp > Linked Devices > Link with phone number, lalu masukkan kode di atas.');
                } catch (err) {
                    pairingCodeRequested = false;
                    console.error('[Bot] Gagal meminta pairing code:', err.message);
                }
            } else {
                console.warn('[Bot] Session belum terdaftar. Isi PAIRING_PHONE_NUMBER dengan nomor WhatsApp bot, format kode negara tanpa plus. Contoh: 6281234567890');
            }
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Koneksi terputus karena: ', lastDisconnect?.error?.message, '— reconnect:', shouldReconnect);
            if (shouldReconnect) {
                console.log(`[Bot] Mencoba menghubungkan kembali dalam ${reconnectDelay / 1000}s...`);
                setTimeout(() => {
                    reconnectDelay = Math.min(reconnectDelay * 2, 30000); // cap at 30s
                    startBot();
                }, reconnectDelay);
            }
        } else if (connection === 'open') {
            reconnectDelay = 1000; // reset backoff on successful connection
            pairingCodeRequested = false;
            console.log('Bot WhatsApp Berhasil Terhubung!');
        }
    });

    // Menyimpan kredensial saat berhasil login
    sock.ev.on('creds.update', saveCreds);

    // Event ketika ada pesan masuk
    sock.ev.on('messages.upsert', async (m) => {
        await handleMessage(sock, m, otps);
    });
}

// Menjalankan HTTP Server untuk menerima data cookie clal dari bookmarklet
const server = http.createServer((req, res) => {
    // Tangani headers CORS agar diizinkan request lintas origin dari browser user
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('maimai-wa-bot is running');
        return;
    }

    if (req.method === 'POST' && req.url === '/login') {
        let body = '';
        req.on('data', chunk => {
            body += chunk;
        });

        req.on('end', async () => {
            try {
                console.log(`[HTTP Server] Menerima request POST /login dengan body: ${body}`);
                // Membaca form url-encoded data dari bookmarklet form submit
                const params = new URLSearchParams(body);
                const otp = params.get('otp');
                const clal = params.get('clal');

                console.log(`[HTTP Server] Parsed OTP: "${otp}", Clal length: ${clal ? clal.length : 0}`);
                console.log(`[HTTP Server] Daftar OTP aktif di memori bot:`, [...otps.keys()]);

                if (!otp || !clal) {
                    sendHtmlResponse(res, 400, false, 'Data OTP atau Cookie clal tidak ditemukan dalam request.');
                    return;
                }

                // Cari data OTP di database memori
                const otpData = otps.get(otp.toString().trim());
                if (!otpData) {
                    sendHtmlResponse(res, 400, false, 'Kode OTP salah, tidak ditemukan, atau sudah kedaluwarsa (berlaku 5 menit).');
                    return;
                }

                // Hapus OTP agar sekali pakai (one-time passcode)
                otps.delete(otp.toString().trim());

                // Kirim respons sukses awal ke browser berupa halaman HTML premium
                sendHtmlResponse(res, 200, true, 'OTP berhasil diverifikasi! Bot sedang membaca data profil Anda dari Maimai DX NET. Silakan kembali ke WhatsApp.');

                const jid = otpData.jid;
                const userAgent = req.headers['user-agent'] || '';
                try {
                    const profile = await fetchMaimaiProfile(clal, null, userAgent);

                    // Memperbarui database lokal players.json
                    const dbPath = dataPath('players.json');
                    let players = {};
                    if (fs.existsSync(dbPath)) {
                        try {
                            players = JSON.parse(fs.readFileSync(dbPath, 'utf-8') || '{}');
                        } catch (e) {
                            players = {};
                        }
                    }

                    players[jid] = {
                        nickname: profile.nickname,
                        rating: profile.rating,
                        clal: clal,
                        sessionCookie: profile.newSessionCookie,
                        userAgent: userAgent,
                        domain: profile.domain,
                        updatedAt: new Date().toISOString()
                    };

                    writeJsonAtomic(dbPath, players);

                    // Kirim notifikasi sukses langsung di chat WhatsApp user
                    if (activeSock) {
                        let msgText = `✅ *LOGIN & INTEGRASI AKUN BERHASIL!*\n\n`;
                        msgText += `• *Nickname:* ${profile.nickname}\n`;
                        msgText += `• *DX Rating:* ${profile.rating}\n`;
                        msgText += `• *Server Region:* ${profile.domain}\n\n`;
                        msgText += `Akun Anda telah terhubung secara aman. Silakan ketik *.rating* untuk melihat statistik Anda!`;

                        try {
                            await activeSock.sendMessage(jid, { text: msgText });
                        } catch (sendErr) {
                            console.error('[HTTP Server] Gagal mengirim pesan sukses ke WA:', sendErr.message);
                        }
                    }
                } catch (scrapeErr) {
                    console.error('[HTTP Server] Scraper Error:', scrapeErr);
                    if (activeSock) {
                        try {
                            await activeSock.sendMessage(jid, {
                                text: `❌ *Gagal Menghubungkan Akun Maimai:*\n_${scrapeErr.message}_`
                            });
                        } catch (sendErr) {
                            console.error('[HTTP Server] Gagal mengirim pesan error ke WA:', sendErr.message);
                        }
                    }
                }
            } catch (err) {
                console.error('[HTTP Server] Parser Error:', err);
                if (!res.headersSent) {
                    sendHtmlResponse(res, 500, false, 'Gagal memproses data dari browser.');
                }
            }
        });
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    }
});

server.on('error', (err) => {
    console.error(`[HTTP Server] Gagal listen di port ${PORT}:`, err);
    process.exit(1);
});

server.listen(PORT, () => {
    console.log(`[HTTP Server] Berjalan lancar di port ${PORT}`);
});

startReminderScheduler(() => activeSock);
startBot();
