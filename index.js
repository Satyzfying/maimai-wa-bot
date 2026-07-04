const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode-terminal');
const { Boom } = require('@hapi/boom');

async function startBot() {
    // Menyimpan sesi login agar tidak perlu scan QR terus-menerus
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false // Kita matikan bawaannya agar bisa diatur custom lewat qrcode-terminal
    });

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
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return; // Abaikan jika pesan kosong atau dari bot sendiri

        const from = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

        console.log(`Pesan masuk dari ${from}: ${text}`);

        // Logika sederhana untuk testing (Fase Personal)
        if (text.toLowerCase() === 'ping') {
            await sock.sendMessage(from, { text: 'Pong! Bot aktif 🚀' });
        }
    });
}

startBot();