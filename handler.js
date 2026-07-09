const fs = require('fs');
const path = require('path');
const {
    DEFAULT_OFFSETS,
    buildReminderPlan,
    createRemindersFromPlan,
    parseEventDate,
    parseAbsoluteReminderTimes,
    parseHour,
    parseNaturalReminder,
    parseOffsets,
    parseRecurringReminder,
    parseReminderDraft
} = require('./utils/naturalReminder');
const {
    findReminderByText,
    formatDateTime,
    getNextReminder,
    listReminders,
    removeReminder,
    updateReminder
} = require('./utils/reminders');
const {
    aiResultToPartialSession,
    aiResultToPlan,
    parseWithAI
} = require('./utils/aiReminder');
const { isOwner, normalizePhoneNumber } = require('./utils/owner');

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

function isExactReminderAnswer(text) {
    return /\b(tepat waktu|pas waktunya|pas di jam(?:nya| acara(?:nya)?)?|saat mulai|waktu acara)\b/i.test(text);
}

function isCancelAnswer(text) {
    return /\b(batal|cancel|ga jadi|nggak jadi|tidak jadi)\b/i.test(text);
}

function isConfirmAnswer(text) {
    return /\b(iya|ya|yes|y|benar|bener|oke|ok|sip|gas|setuju|lanjut|betul)\b/i.test(text);
}

function pendingEventIso(session) {
    if (!session?.dateParts || !session?.timeParts) return null;
    const { year, month, day } = session.dateParts;
    const { hour, minute } = session.timeParts;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`;
}

function explicitlyChangesEventTime(text) {
    return /\b(?:acara(?:nya)?|event(?:nya)?|jadwal(?:nya)?|waktu(?:nya)?|mulai(?:nya)?)\b.*\b(?:jadi|jam|pukul|pk|pkl|tanggal|tgl|besok|lusa)\b/i.test(text)
        || /\b(?:jadi|(?:di)?ganti|(?:di)?ubah)\s+(?:ke\s+|jadi\s+)?(?:tanggal|tgl|jam|pukul|pk|pkl|besok|lusa)\b/i.test(text);
}

function normalizeAiPendingEvent(aiResult, text, pendingSession) {
    const eventDatetime = pendingEventIso(pendingSession);
    if (!aiResult || !eventDatetime || explicitlyChangesEventTime(text)) return aiResult;

    const originalAiEventDatetime = aiResult.event_datetime;
    const reminders = [...(aiResult.reminders || [])];

    if (originalAiEventDatetime && originalAiEventDatetime !== eventDatetime) {
        const exists = reminders.some(r => r.datetime === originalAiEventDatetime);
        if (!exists) {
            reminders.push({
                type: 'fixed_time',
                datetime: originalAiEventDatetime,
                minutes_before: null
            });
        }
    }

    return {
        ...aiResult,
        event_datetime: eventDatetime,
        event_title: aiResult.event_title || pendingSession.eventMessage || null,
        reminders
    };
}

function isDirectReminderText(text) {
    return /\b\d+\s*(?:hari|jam|menit|mnt|min|m|detik|dtk|sec|s)\s+lagi\b/i.test(text);
}

function cleanupExpiredPending() {
    const now = Date.now();
    for (const [key, session] of pendingReminderSessions.entries()) {
        if (now - session.updatedAt > PENDING_TTL_MS) {
            pendingReminderSessions.delete(key);
        }
    }
}

function formatReminderDateTime(value) {
    const date = new Date(value);
    const hasSeconds = date.getUTCSeconds() !== 0;
    return date.toLocaleString('id-ID', {
        timeZone: 'Asia/Makassar',
        weekday: 'short',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        ...(hasSeconds ? { second: '2-digit' } : {})
    });
}

function buildNaturalReminderResponse(naturalReminder) {
    if (naturalReminder.isDirectReminder) {
        let responseText = `Siap, aku set reminder:\n`;
        responseText += `*${naturalReminder.eventMessage}*\n`;
        responseText += `Waktu reminder: ${formatReminderDateTime(naturalReminder.created[0].remindAt)}\n`;
        responseText += `ID: *${naturalReminder.created[0].id}*`;
        return responseText;
    }

    let responseText = `Siap, aku set ${naturalReminder.created.length} reminder untuk:\n`;
    responseText += `*${naturalReminder.eventMessage}*\n`;
    responseText += `Waktu acara: ${formatDateTime(naturalReminder.eventAt.toISOString())}\n\n`;
    responseText += naturalReminder.created
        .map(reminder => `• ${formatReminderDateTime(reminder.remindAt)} (*${reminder.id}*)`)
        .join('\n');
    return responseText;
}

function buildReminderPlanSummary(plan) {
    let responseText = `Aku tangkap begini:\n`;
    if (plan.isDirectReminder) {
        responseText += `Reminder: *${plan.eventMessage}*\n`;
        responseText += `Waktu: ${formatReminderDateTime(plan.reminders[0].remindAt.toISOString())} WITA`;
    } else {
        responseText += `Acara: *${plan.eventMessage}*\n`;
        responseText += `Waktu acara: ${formatDateTime(plan.eventAt.toISOString())} WITA\n`;
        responseText += `Reminder:\n`;
        responseText += plan.reminders
            .map(item => `• ${formatReminderDateTime(item.remindAt.toISOString())}${item.repeat ? ` (${item.repeat.label})` : ''}`)
            .join('\n');
    }
    responseText += `\n\nKalau sudah benar, balas *iya*. Kalau mau batal, balas *batal*.`;
    return responseText;
}

function reminderExampleText(reason) {
    let response = reason ? `${reason}\n\n` : '';
    response += `Contoh yang bisa aku pahami:\n`;
    response += `• tolong reminder tanggal 10 jam 9 pagi ada UAS\n`;
    response += `• ingatkan aku 5 menit lagi untuk bangun\n`;
    response += `• ingatkan aku besok jam 19:00 ada latihan, 1 hari dan 3 jam sebelumnya\n`;
    response += `• tolong reminder 10/07 jam 9 pagi ada UAS, ingetin jam 6 pagi\n\n`;
    response += `Kalau aku sudah tanya pilihan reminder, kamu bisa jawab:\n`;
    response += `• iya boleh pakai yang tadi\n`;
    response += `• tepat waktu\n`;
    response += `• jam 6 pagi\n`;
    response += `• di jam 9:35\n`;
    response += `• 5 menit sebelumnya`;
    return response;
}

function isFeatureQuestion(text) {
    return /\b(fitur|bisa apa|bisa ngapain|bot ini apa|kemampuan|cara pakai|help reminder|bantuan reminder)\b/i.test(text);
}

function reminderFeatureText() {
    return `Aku punya fitur reminder pribadi yang bisa kamu pakai lewat chat natural.\n\n` +
        `*Bikin reminder sekali jalan*\n` +
        `• "tolong reminder tanggal 10 jam 9 pagi ada UAS, 1 hari sebelumnya"\n` +
        `• "ingatkan aku besok jam 19:00 ada latihan, 3 jam sebelumnya"\n` +
        `• "ingatkan aku 5 menit lagi untuk bangun"\n\n` +
        `*Kalau informasinya kurang, aku akan tanya lanjut*\n` +
        `Misalnya kamu tulis "tolong reminder tanggal 10 ada UAS", aku akan tanya jam acaranya, lalu tanya kapan kamu mau diingetin.\n\n` +
        `*Pilihan waktu reminder fleksibel*\n` +
        `• Countdown: "1 hari, 12 jam, 30 menit sebelumnya"\n` +
        `• Jam tertentu: "jam 6 pagi"\n` +
        `• Tepat saat acara: "tepat waktu"\n` +
        `• Hari sebelumnya: "malam sebelumnya jam 8"\n` +
        `• Paket standar: 1 hari, 12 jam, 6 jam, 3 jam, 1 jam, 30 menit sebelumnya\n\n` +
        `*Aku konfirmasi dulu sebelum menyimpan*\n` +
        `Aku akan merangkum acara, waktu, dan reminder. Balas "iya" untuk simpan, atau "batal" untuk membatalkan.\n\n` +
        `*Kelola reminder aktif*\n` +
        `• "reminderku apa aja?"\n` +
        `• "ubah reminder UAS jadi jam 7 pagi"\n` +
        `• "hapus reminder UAS"\n` +
        `• "tunda 10 menit"\n\n` +
        `*Reminder berulang*\n` +
        `• "ingatkan aku tiap hari jam 8 malam minum obat"\n` +
        `• "ingatkan aku setiap minggu jam 7 pagi latihan"\n\n` +
        `Catatan: fitur reminder ini cuma aktif di chat pribadi dan memakai waktu WITA.`;
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
        text: `Mau aku ingetin kapan?\n\nPilihan cepat:\n${defaultOffsetText()}\n• tepat waktu\n\nKalau cocok pakai paket standar, balas *pakai itu* atau *terserah*.\nKalau mau jam tertentu, jawab seperti *jam 6 pagi*, *di jam 9:35*, atau *malam sebelumnya jam 8*.\nKalau mau countdown custom, tulis seperti *5 menit sebelumnya* atau *2 hari, 6 jam sebelumnya*.`
    });
}

async function askForConfirmation(sock, from, key, session, plan) {
    pendingReminderSessions.set(key, {
        ...session,
        stage: 'confirm',
        plan,
        updatedAt: Date.now()
    });

    await sock.sendMessage(from, { text: buildReminderPlanSummary(plan) });
}

async function saveConfirmedReminder(sock, from, senderJid, key, session) {
    const naturalReminder = createRemindersFromPlan({
        chatJid: from,
        creatorJid: senderJid,
        eventAt: new Date(session.plan.eventAt),
        eventMessage: session.plan.eventMessage,
        reminders: session.plan.reminders.map(item => ({
            ...item,
            remindAt: new Date(item.remindAt)
        })),
        isDirectReminder: session.plan.isDirectReminder
    });

    pendingReminderSessions.delete(key);
    await sock.sendMessage(from, { text: buildNaturalReminderResponse(naturalReminder) });
}

async function getAiReminderIntent(text, pendingSession) {
    try {
        return await parseWithAI({ text, pendingSession });
    } catch (err) {
        console.warn('[AIReminder] Parser gagal, fallback ke parser lokal:', err.message);
        return null;
    }
}

function formatReminderList(reminders) {
    if (reminders.length === 0) return 'Belum ada reminder aktif.';

    let responseText = `Reminder aktif:\n\n`;
    for (const reminder of reminders) {
        responseText += `• *${reminder.id}* - ${formatReminderDateTime(reminder.remindAt)}\n`;
        responseText += `  ${reminder.message.replace(/\n/g, ' | ')}\n`;
        if (reminder.repeat) responseText += `  Berulang: ${reminder.repeat.label || reminder.repeat.unit}\n`;
        responseText += `\n`;
    }
    return responseText.trim();
}

function parseSnoozeMinutes(text) {
    const offset = parseOffsets(text, { includeDefault: false })[0];
    if (offset) return offset.minutes;

    const minuteMatch = text.match(/\b(\d+)\b/);
    return minuteMatch ? Number(minuteMatch[1]) : null;
}

function parseReminderQuery(text) {
    return text
        .replace(/\b(?:hapus|delete|buang|cancel|batalkan|ubah|edit|ganti|reminder|pengingat|yang|tentang|jadi|ke)\b/gi, ' ')
        .replace(/\b(?:jam|pukul|pk|pkl)\s*\d{1,2}(?:[.:]\d{1,2})?\s*(?:pagi|siang|sore|malam|am|pm|wita)?\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

async function handleNaturalReminderManagement(sock, from, senderJid, text) {
    if (/\b(reminderku|reminder aktif|jadwalku|ada reminder|list reminder|daftar reminder)\b/i.test(text)) {
        await sock.sendMessage(from, { text: formatReminderList(listReminders(senderJid, from)) });
        return true;
    }

    if (/\b(tunda|snooze)\b/i.test(text)) {
        const minutes = parseSnoozeMinutes(text);
        const target = getNextReminder(senderJid, from);

        if (!minutes || !target) {
            await sock.sendMessage(from, { text: 'Aku belum bisa tunda. Contoh: *tunda 10 menit*.' });
            return true;
        }

        const remindAt = new Date(Date.now() + minutes * 60 * 1000).toISOString();
        const updated = updateReminder(senderJid, target.id, { remindAt });
        await sock.sendMessage(from, {
            text: `Oke, reminder *${updated.id}* aku tunda ke ${formatDateTime(updated.remindAt)}.`
        });
        return true;
    }

    if (/\b(hapus|delete|buang|cancel|batalkan)\b/i.test(text) && /\b(reminder|pengingat)\b/i.test(text)) {
        const query = parseReminderQuery(text);
        const target = findReminderByText(senderJid, from, query) || getNextReminder(senderJid, from);

        if (!target) {
            await sock.sendMessage(from, { text: 'Aku tidak menemukan reminder aktif yang cocok.' });
            return true;
        }

        removeReminder(senderJid, target.id);
        await sock.sendMessage(from, { text: `Oke, reminder *${target.id}* aku hapus.` });
        return true;
    }

    if (/\b(ubah|edit|ganti)\b/i.test(text) && /\b(reminder|pengingat)\b/i.test(text)) {
        const timeParts = parseHour(text);
        const target = findReminderByText(senderJid, from, parseReminderQuery(text)) || getNextReminder(senderJid, from);

        if (!target || !timeParts) {
            await sock.sendMessage(from, { text: 'Aku belum bisa ubah. Contoh: *ubah reminder UAS jadi jam 7 pagi*.' });
            return true;
        }

        const current = new Date(target.remindAt);
        const wita = new Date(current.getTime() + 8 * 60 * 60 * 1000);
        const remindAt = new Date(Date.UTC(
            wita.getUTCFullYear(),
            wita.getUTCMonth(),
            wita.getUTCDate(),
            timeParts.hour,
            timeParts.minute
        ) - 8 * 60 * 60 * 1000).toISOString();
        const updated = updateReminder(senderJid, target.id, { remindAt });
        await sock.sendMessage(from, { text: `Oke, reminder *${updated.id}* aku ubah ke ${formatDateTime(updated.remindAt)}.` });
        return true;
    }

    return false;
}

async function handleAiReminderIntent(sock, from, senderJid, text, aiResult, pendingSession = null) {
    if (!aiResult || aiResult.intent === 'none') return false;
    aiResult = normalizeAiPendingEvent(aiResult, text, pendingSession);

    const key = getPendingKey(from, senderJid);

    if (aiResult.intent === 'feature_help') {
        await sock.sendMessage(from, { text: reminderFeatureText() });
        return true;
    }

    if (aiResult.intent === 'list_reminders') {
        await sock.sendMessage(from, { text: formatReminderList(listReminders(senderJid, from)) });
        return true;
    }

    if (aiResult.intent === 'cancel') {
        pendingReminderSessions.delete(key);
        await sock.sendMessage(from, { text: 'Oke, reminder-nya aku batalin.' });
        return true;
    }

    if (aiResult.intent === 'confirm' && pendingSession?.stage === 'confirm') {
        await saveConfirmedReminder(sock, from, senderJid, key, pendingSession);
        return true;
    }

    if (aiResult.intent === 'delete_reminder') {
        const target = findReminderByText(senderJid, from, aiResult.target_query || '') || getNextReminder(senderJid, from);
        if (!target) {
            await sock.sendMessage(from, { text: 'Aku tidak menemukan reminder aktif yang cocok.' });
            return true;
        }

        removeReminder(senderJid, target.id);
        await sock.sendMessage(from, { text: `Oke, reminder *${target.id}* aku hapus.` });
        return true;
    }

    if (aiResult.intent === 'snooze_reminder') {
        const target = getNextReminder(senderJid, from);
        const minutes = aiResult.snooze_minutes;

        if (!target || !minutes) {
            await sock.sendMessage(from, { text: 'Aku belum bisa tunda. Contoh: *tunda 10 menit*.' });
            return true;
        }

        const updated = updateReminder(senderJid, target.id, {
            remindAt: new Date(Date.now() + minutes * 60 * 1000).toISOString()
        });
        await sock.sendMessage(from, {
            text: `Oke, reminder *${updated.id}* aku tunda ke ${formatDateTime(updated.remindAt)}.`
        });
        return true;
    }

    if (aiResult.intent === 'edit_reminder') {
        const plan = aiResultToPlan(aiResult);
        const target = findReminderByText(senderJid, from, aiResult.target_query || aiResult.event_title || '') || getNextReminder(senderJid, from);

        if (!target || !plan) {
            await sock.sendMessage(from, { text: 'Aku belum bisa ubah. Contoh: *ubah reminder UAS jadi jam 7 pagi*.' });
            return true;
        }

        const firstReminder = plan.reminders[0];
        const updated = updateReminder(senderJid, target.id, {
            message: `Pengingat ${firstReminder.offset.label}: ${plan.eventMessage}\nWaktu acara: ${formatDateTime(plan.eventAt.toISOString())}`,
            remindAt: firstReminder.remindAt.toISOString(),
            repeat: firstReminder.repeat || null
        });
        await sock.sendMessage(from, { text: `Oke, reminder *${updated.id}* aku ubah ke ${formatDateTime(updated.remindAt)}.` });
        return true;
    }

    if (['create_reminder', 'revise_pending'].includes(aiResult.intent)) {
        if (aiResult.needs_clarification) {
            const partialSession = aiResultToPartialSession(aiResult) || pendingSession || {
                eventMessage: aiResult.event_title || 'acara',
                offsets: [],
                absoluteReminders: []
            };
            pendingReminderSessions.set(key, {
                ...partialSession,
                updatedAt: Date.now()
            });
            await sock.sendMessage(from, {
                text: aiResult.clarifying_question || reminderExampleText('Aku butuh sedikit info lagi supaya reminder-nya tepat.')
            });
            return true;
        }

        const plan = aiResultToPlan(aiResult);
        if (plan) {
            if (isDirectReminderText(text)) {
                plan.isDirectReminder = true;
            }

            await askForConfirmation(sock, from, key, {
                ...(pendingSession || {}),
                eventMessage: plan.eventMessage,
                updatedAt: Date.now()
            }, plan);
            return true;
        }
    }

    return false;
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

    if (session.stage === 'confirm') {
        if (!isConfirmAnswer(text)) {
            const aiResult = await getAiReminderIntent(text, session);
            if (await handleAiReminderIntent(sock, from, senderJid, text, aiResult, session)) {
                return true;
            }

            await sock.sendMessage(from, {
                text: `Aku belum simpan. Balas *iya* kalau ringkasannya sudah benar, atau *batal* untuk membatalkan.`
            });
            session.updatedAt = Date.now();
            pendingReminderSessions.set(key, session);
            return true;
        }

        await saveConfirmedReminder(sock, from, senderJid, key, session);
        return true;
    }

    const directPendingPlan = parseNaturalReminder(`ingatkan aku ${text} untuk ${session.eventMessage || 'acara'}`);
    if (directPendingPlan?.isDirectReminder) {
        await askForConfirmation(sock, from, key, {
            ...session,
            updatedAt: Date.now()
        }, directPendingPlan);
        return true;
    }

    const dateParts = parseEventDate(text);
    if (dateParts) session.dateParts = dateParts;

    const wasMissingTime = !session.timeParts;
    const timeParts = parseHour(text);
    if (timeParts && !session.timeParts) session.timeParts = timeParts;

    if (wasMissingTime && timeParts && session.dateParts && !session.offsets.length && !(session.absoluteReminders || []).length) {
        await askForMissingReminderInfo(sock, from, key, session);
        return true;
    }

    const aiResult = await getAiReminderIntent(text, session);
    if (await handleAiReminderIntent(sock, from, senderJid, text, aiResult, session)) {
        return true;
    }

    const explicitOffsets = parseOffsets(text, { includeDefault: false });
    const absoluteReminders = parseAbsoluteReminderTimes(text, session.dateParts, session.timeParts);
    if (explicitOffsets.length) {
        session.offsets = explicitOffsets;
        session.absoluteReminders = [];
    } else if (absoluteReminders.length) {
        session.absoluteReminders = absoluteReminders;
        session.offsets = [];
    } else if (session.dateParts && session.timeParts && isExactReminderAnswer(text)) {
        session.offsets = [{ minutes: 0, label: 'tepat waktu' }];
        session.absoluteReminders = [];
    } else if (session.dateParts && session.timeParts && isDefaultOffsetAnswer(text)) {
        session.offsets = DEFAULT_OFFSETS;
        session.absoluteReminders = [];
    }

    if (!session.dateParts || !session.timeParts || (!session.offsets.length && !(session.absoluteReminders || []).length)) {
        if (session.dateParts && session.timeParts && !session.offsets.length && !(session.absoluteReminders || []).length) {
            await sock.sendMessage(from, {
                text: reminderExampleText('Aku belum nangkep kapan kamu mau diingetin.')
            });
            session.updatedAt = Date.now();
            pendingReminderSessions.set(key, session);
            return true;
        }

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

    await askForConfirmation(sock, from, key, session, plan);
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
        const isGroupChat = from.endsWith('@g.us');

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

        if (isGroupChat) {
            return;
        }

        if (!isOwner(senderJid)) {
            if (isFeatureQuestion(text) || parseReminderDraft(text)) {
                console.warn(`[ReminderOwner] Mengabaikan sender ${normalizePhoneNumber(senderJid)} karena tidak ada di REMINDER_OWNER_JIDS.`);
            }
            return;
        }

        if (isFeatureQuestion(text)) {
            await sock.sendMessage(from, { text: reminderFeatureText() });
            return;
        }

        if (await handlePendingReminder(sock, from, senderJid, text)) {
            return;
        }

        const aiResult = await getAiReminderIntent(text, null);
        if (await handleAiReminderIntent(sock, from, senderJid, text, aiResult)) {
            return;
        }

        if (await handleNaturalReminderManagement(sock, from, senderJid, text)) {
            return;
        }

        let naturalReminder = null;

        try {
            const draft = parseReminderDraft(text);
            const recurring = parseRecurringReminder(text);

            if (recurring) {
                await askForConfirmation(sock, from, getPendingKey(from, senderJid), {
                    stage: 'confirm',
                    updatedAt: Date.now()
                }, recurring);
                return;
            }

            const parsed = parseNaturalReminder(text);
            if (parsed) {
                await askForConfirmation(sock, from, getPendingKey(from, senderJid), {
                    ...parsed,
                    updatedAt: Date.now()
                }, parsed);
                return;
            }

            if (draft && !draft.dateParts && !draft.timeParts && !draft.offsets.length && !draft.absoluteReminders.length) {
                await sock.sendMessage(from, {
                    text: reminderExampleText('Aku paham kamu mau bikin reminder, tapi format tanggal/jamnya belum kebaca.')
                });
                return;
            }

            if (draft && (!draft.dateParts || !draft.timeParts || (!draft.offsets.length && !draft.absoluteReminders.length))) {
                await askForMissingReminderInfo(sock, from, getPendingKey(from, senderJid), {
                    ...draft,
                    offsets: draft.offsets || [],
                    absoluteReminders: draft.absoluteReminders || [],
                    updatedAt: Date.now()
                });
                return;
            }

            naturalReminder = null;
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
