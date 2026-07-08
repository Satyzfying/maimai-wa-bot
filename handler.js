const fs = require('fs');
const path = require('path');
const { createNaturalReminders } = require('./utils/naturalReminder');
const { formatDateTime } = require('./utils/reminders');

const commands = new Map();

// Membaca dan mendaftarkan semua file command di dalam folder /commands
const commandsPath = path.join(__dirname, 'commands');
if (fs.existsSync(commandsPath)) {
    const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

    for (const file of commandFiles) {
        try {
            const command = require(path.join(commandsPath, file));
            if (command.name) {
                commands.set(command.name.toLowerCase(), command);
                if (command.aliases && Array.isArray(command.aliases)) {
                    for (const alias of command.aliases) {
                        commands.set(alias.toLowerCase(), command);
                    }
                }
                console.log(`[CommandHandler] Berhasil memuat command: ${command.name}`);
            }
        } catch (error) {
            console.error(`[CommandHandler] Gagal memuat file command ${file}:`, error);
        }
    }
} else {
    console.warn(`[CommandHandler] Folder commands tidak ditemukan di: ${commandsPath}`);
}

const PREFIX = '.';

/**
 * Memproses pesan masuk dan mencocokkannya ke command yang terdaftar.
 * @param {import('@whiskeysockets/baileys').WASocket} sock 
 * @param {{messages: import('@whiskeysockets/baileys').proto.IWebMessageInfo[]}} m 
 * @param {Map} otps
 */
async function handleMessage(sock, m, otps) {
    try {
        if (m.type !== 'notify') return; // Abaikan event selain pesan baru (reaksi, polling, status, dll)
        const msg = m.messages[0];
        if (!msg || !msg.message || msg.key.fromMe) return; // Abaikan jika pesan kosong atau dari bot sendiri

        const from = msg.key.remoteJid;
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();

        if (!text) return;

        console.log(`[Pesan Masuk] ${from}: ${text}`);

        let isCommand = false;
        let commandName = '';
        let args = [];

        // Deteksi Command dengan Prefix
        if (text.startsWith(PREFIX)) {
            args = text.slice(PREFIX.length).trim().split(/ +/);
            commandName = args.shift().toLowerCase();
            isCommand = true;
        } else {
            // Deteksi Command tanpa Prefix (misal: 'ping')
            const words = text.split(/ +/);
            const firstWord = words[0].toLowerCase();
            const cmd = commands.get(firstWord);

            if (cmd && cmd.needsPrefix === false) {
                commandName = firstWord;
                args = words.slice(1);
                isCommand = true;
            }
        }

        // Jalankan command jika cocok
        if (isCommand && commandName) {
            const command = commands.get(commandName);
            if (command) {
                try {
                    await command.execute(sock, from, args, msg, otps);
                } catch (cmdError) {
                    console.error(`[CommandHandler] Error saat mengeksekusi command "${commandName}":`, cmdError);
                    await sock.sendMessage(from, { 
                        text: `Terjadi kesalahan saat mengeksekusi perintah *${commandName}*:\n_${cmdError.message}_` 
                    });
                }
            }
            return;
        }

        const senderJid = msg.key.participant || msg.key.remoteJid;
        let naturalReminder = null;

        try {
            naturalReminder = createNaturalReminders({
                chatJid: from,
                creatorJid: senderJid,
                text
            });
        } catch (reminderError) {
            console.error('[NaturalReminder] Gagal membuat reminder:', reminderError);
            await sock.sendMessage(from, {
                text: `Aku paham kamu mau set reminder, tapi gagal menyimpannya:\n_${reminderError.message}_`
            });
            return;
        }

        if (naturalReminder) {
            let responseText = `Siap, aku set ${naturalReminder.created.length} reminder untuk:\n`;
            responseText += `*${naturalReminder.eventMessage}*\n`;
            responseText += `Waktu acara: ${formatDateTime(naturalReminder.eventAt.toISOString())}\n\n`;
            responseText += naturalReminder.created
                .map(reminder => `• ${formatDateTime(reminder.remindAt)} (*${reminder.id}*)`)
                .join('\n');

            await sock.sendMessage(from, { text: responseText });
        }
    } catch (err) {
        console.error('[CommandHandler] Error fatal di handler:', err);
    }
}

module.exports = { handleMessage };
