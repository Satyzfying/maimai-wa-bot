const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode-terminal');
const { Boom } = require('@hapi/boom');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { handleMessage } = require('./handler');
const { fetchMaimaiProfile } = require('./utils/scraper');

const otps = new Map();
let activeSock = null;

// Membaca konfigurasi port dari config.json
let PORT = 3000;
try {
    const configPath = path.join(__dirname, 'config.json');
    if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        PORT = config.port || 3000;
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
    // Menyimpan sesi login agar tidak perlu scan QR terus-menerus
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false // Kita matikan bawaannya agar bisa diatur custom lewat qrcode-terminal
    });

    activeSock = sock;

    // Event ketika QR Code muncul
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('--- SILAKAN SCAN QR CODE DI BAWAH INI ---');
            QRCode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Koneksi terputus karena: ', lastDisconnect.error, ', mencoba menghubungkan kembali...', shouldReconnect);
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
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

    if (req.method === 'POST' && req.url === '/login') {
        let body = '';
        req.on('data', chunk => {
            body += chunk;
        });

        req.on('end', async () => {
            try {
                // Membaca form url-encoded data dari bookmarklet form submit
                const params = new URLSearchParams(body);
                const otp = params.get('otp');
                const clal = params.get('clal');

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

                // Scraping profil Maimai di background menggunakan helper scraper.js
                const jid = otpData.jid;
                try {
                    const profile = await fetchMaimaiProfile(clal);

                    // Memperbarui database lokal players.json
                    const dbPath = path.join(__dirname, 'players.json');
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
                        updatedAt: new Date().toISOString()
                    };

                    fs.writeFileSync(dbPath, JSON.stringify(players, null, 2), 'utf-8');

                    // Kirim notifikasi sukses langsung di chat WhatsApp user
                    if (activeSock) {
                        let msgText = `✅ *LOGIN & INTEGRASI AKUN BERHASIL!*\n\n`;
                        msgText += `• *Nickname:* ${profile.nickname}\n`;
                        msgText += `• *DX Rating:* ${profile.rating}\n`;
                        msgText += `• *Server Region:* ${profile.domain}\n\n`;
                        msgText += `Akun Anda telah terhubung secara aman. Silakan ketik *.rating* untuk melihat statistik Anda!`;

                        await activeSock.sendMessage(jid, { text: msgText });
                    }
                } catch (scrapeErr) {
                    console.error('[HTTP Server] Scraper Error:', scrapeErr);
                    if (activeSock) {
                        await activeSock.sendMessage(jid, {
                            text: `❌ *Gagal Menghubungkan Akun Maimai:*\n_${scrapeErr.message}_`
                        });
                    }
                }
            } catch (err) {
                console.error('[HTTP Server] Parser Error:', err);
                sendHtmlResponse(res, 500, false, 'Gagal memproses data dari browser.');
            }
        });
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    }
});

server.listen(PORT, () => {
    console.log(`[HTTP Server] Berjalan lancar di port ${PORT}`);
});

startBot();