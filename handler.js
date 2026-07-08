const fs = require('fs');
const path = require('path');
const {
    DEFAULT_OFFSETS,
    buildReminderPlan,
    createNaturalReminders,
    createRemindersFromPlan,
    parseEventDate,
    parseHour,
    parseOffsets,
    parseReminderDraft
} = require('./utils/naturalReminder');
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
const pendingReminderSessions = new Map();
const PENDING_TTL_MS = 10 * 60 * 1000;

function getPendingKey(from, senderJid) {
    return `${from}:${senderJid}`;
}

function defaultOffsetText() {
    return DEFAULT_OFFSETS.map(offset => `• ${offset.label}`).join('\n');
}

function isDefaultOffsetAnswer(text) {
    return /\b(standar|default|iya|ya|boleh|oke|ok|sip|gas|bebas|terserah|yang tadi|pakai itu|pake itu|pakai aja|pake aja|ikutin aja|rekomendasi)\b/i.test(text);
}

function isCancelAnswer(text) {
    return /\b(batal|cancel|ga jadi|nggak jadi|tidak jadi)\b/i.test(text);
}

function cleanupExpiredPending() {
    const now = Date.now();
    for (const [key, session] of pendingReminderSessions.entries()) {
        if (now - session.updatedAt > PENDING_TTL_MS) {
            pendingReminderSessions.delete(key);
        }
    }
}

function buildNaturalReminderResponse(naturalReminder) {
    let responseText = `Siap, aku set ${naturalReminder.created.length} reminder untuk:\n`;
    responseText += `*${naturalReminder.eventMessage}*\n`;
    responseText += `Waktu acara: ${formatDateTime(naturalReminder.eventAt.toISOString())}\n\n`;
    responseText += naturalReminder.created
        .map(reminder => `• ${formatDateTime(reminder.remindAt)} (*${reminder.id}*)`)
        .join('\n');
    return responseText;
}

async function askForMissingReminderInfo(sock, from, key, session) {
    session.updatedAt = Date.now();
    pendingReminderSessions.set(key, session);

    if (!session.dateParts) {
        await sock.sendMessage(from, {
            text: `Mau aku reminder untuk tanggal berapa?\nContoh: *besok*, *tanggal 10*, atau *tanggal 10 Juli*.`
        });
        return;
    }

    if (!session.timeParts) {
        await sock.sendMessage(from, {
            text: `Untuk *${session.eventMessage}*, acaranya jam berapa?\nBisa jawab santai, misalnya *9.30 pagi*, *jam 19:00*, atau *malam jam 8*.`
        });
        return;
    }

    await sock.sendMessage(from, {
        text: `Mau aku ingetin kapan aja?\n\nBiasanya aku pakai ini:\n${defaultOffsetText()}\n\nKalau cocok, balas aja seperti *iya boleh*, *pakai itu*, atau *terserah*. Kalau mau beda, tulis aja misalnya *2 hari, 6 jam, setengah jam sebelumnya*.`
    });
}

async function handlePendingReminder(sock, from, senderJid, text) {
    cleanupExpiredPending();

    const key = getPendingKey(from, senderJid);
    const session = pendingReminderSessions.get(key);
    if (!session) return false;

    if (isCancelAnswer(text)) {
        pendingReminderSessions.delete(key);
        await sock.sendMessage(from, { text: 'Oke, reminder-nya aku batalin.' });
        return true;
    }

    const dateParts = parseEventDate(text);
    if (dateParts) session.dateParts = dateParts;

    const timeParts = parseHour(text);
    if (timeParts) session.timeParts = timeParts;

    const explicitOffsets = parseOffsets(text, { includeDefault: false });
    if (explicitOffsets.length) {
        session.offsets = explicitOffsets;
    } else if (session.dateParts && session.timeParts && isDefaultOffsetAnswer(text)) {
        session.offsets = DEFAULT_OFFSETS;
    }

    if (!session.dateParts || !session.timeParts || !session.offsets.length) {
        await askForMissingReminderInfo(sock, from, key, session);
        return true;
    }

    const plan = buildReminderPlan(session);
    if (!plan) {
        pendingReminderSessions.delete(key);
        await sock.sendMessage(from, {
            text: 'Waktu reminder-nya sudah lewat atau tidak valid. Coba set ulang dengan waktu yang masih di masa depan.'
        });
        return true;
    }

    const naturalReminder = createRemindersFromPlan({
        chatJid: from,
        creatorJid: senderJid,
        eventAt: plan.eventAt,
        eventMessage: plan.eventMessage,
        reminders: plan.reminders
    });

    pendingReminderSessions.delete(key);
    await sock.sendMessage(from, { text: buildNaturalReminderResponse(naturalReminder) });
    return true;
}

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
        cleanupExpiredPending();

        const senderJid = msg.key.participant || msg.key.remoteJid;

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

        if (await handlePendingReminder(sock, from, senderJid, text)) {
            return;
        }

        let naturalReminder = null;

        try {
            const draft = parseReminderDraft(text);

            if (draft && (!draft.dateParts || !draft.timeParts || !draft.offsets.length)) {
                await askForMissingReminderInfo(sock, from, getPendingKey(from, senderJid), {
                    ...draft,
                    offsets: draft.offsets || [],
                    updatedAt: Date.now()
                });
                return;
            }

            naturalReminder = createNaturalReminders({ chatJid: from, creatorJid: senderJid, text });
        } catch (reminderError) {
            console.error('[NaturalReminder] Gagal membuat reminder:', reminderError);
            await sock.sendMessage(from, {
                text: `Aku paham kamu mau set reminder, tapi gagal menyimpannya:\n_${reminderError.message}_`
            });
            return;
        }

        if (naturalReminder) {
            await sock.sendMessage(from, { text: buildNaturalReminderResponse(naturalReminder) });
        }
    } catch (err) {
        console.error('[CommandHandler] Error fatal di handler:', err);
    }
}

module.exports = { handleMessage };
