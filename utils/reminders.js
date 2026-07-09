const fs = require('fs');
const { dataPath, writeJsonAtomic } = require('./paths');

const DB_PATH = dataPath('reminders.json');
const CHECK_INTERVAL_MS = 15 * 1000;
const MAX_REMINDERS_PER_USER = 20;

let schedulerStarted = false;
let isTickRunning = false;

function readDb() {
    if (!fs.existsSync(DB_PATH)) {
        return { items: [] };
    }

    try {
        const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8') || '{}');
        const rawItems = Array.isArray(data.items) ? data.items : [];
        
        // Sanitasi: Buang data yang rusak atau tidak valid (NaN)
        const cleanItems = rawItems.filter(item => {
            if (!item || !item.id || !item.remindAt) return false;
            const time = new Date(item.remindAt).getTime();
            return !Number.isNaN(time);
        });

        return { items: cleanItems };
    } catch (err) {
        console.error('[Reminder] Gagal membaca reminders.json:', err.message);
        return { items: [] };
    }
}

function writeDb(db) {
    writeJsonAtomic(DB_PATH, db);
}

function createId() {
    return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function canAddReminders(creatorJid, count = 1) {
    const db = readDb();
    const activeCount = db.items.filter(item => item.creatorJid === creatorJid).length;
    return activeCount + count <= MAX_REMINDERS_PER_USER;
}

function addReminder({ chatJid, creatorJid, message, remindAt, repeat }) {
    if (!canAddReminders(creatorJid, 1)) {
        throw new Error(`Batas maksimal ${MAX_REMINDERS_PER_USER} reminder aktif per pengguna sudah tercapai.`);
    }

    const db = readDb();
    let id = createId();
    while (db.items.some(item => item.id === id)) {
        id = createId();
    }

    const reminder = {
        id,
        chatJid,
        creatorJid,
        message,
        remindAt,
        repeat: repeat || null,
        createdAt: new Date().toISOString()
    };

    db.items.push(reminder);
    db.items.sort((a, b) => new Date(a.remindAt).getTime() - new Date(b.remindAt).getTime());
    writeDb(db);

    return reminder;
}

function listReminders(creatorJid, chatJid) {
    return readDb().items
        .filter(item => item.creatorJid === creatorJid && (!chatJid || item.chatJid === chatJid))
        .sort((a, b) => new Date(a.remindAt).getTime() - new Date(b.remindAt).getTime());
}

function updateReminder(creatorJid, id, updates) {
    const normalizedId = id.toUpperCase();
    const db = readDb();
    const reminder = db.items.find(item => item.creatorJid === creatorJid && item.id === normalizedId);

    if (!reminder) {
        return null;
    }

    Object.assign(reminder, updates, { updatedAt: new Date().toISOString() });
    db.items.sort((a, b) => new Date(a.remindAt).getTime() - new Date(b.remindAt).getTime());
    writeDb(db);
    return reminder;
}

function findReminderByText(creatorJid, chatJid, query) {
    const needle = query.trim().toLowerCase();
    if (!needle) return null;

    const list = listReminders(creatorJid, chatJid);
    
    // 1. Prioritaskan ID exact match
    const exactId = list.find(item => item.id.toLowerCase() === needle);
    if (exactId) return exactId;

    // 2. Prioritaskan pesan exact match
    const exactMsg = list.find(item => item.message.toLowerCase() === needle);
    if (exactMsg) return exactMsg;

    // 3. Fallback ke substring matching hanya jika kueri minimal 3 karakter
    if (needle.length >= 3) {
        return list.find(item => item.message.toLowerCase().includes(needle)) || null;
    }

    return null;
}

function getNextReminder(creatorJid, chatJid) {
    return listReminders(creatorJid, chatJid)[0] || null;
}

function removeReminder(creatorJid, id) {
    const normalizedId = id.toUpperCase();
    const db = readDb();
    const index = db.items.findIndex(item => item.creatorJid === creatorJid && item.id === normalizedId);

    if (index === -1) {
        return null;
    }

    const [removed] = db.items.splice(index, 1);
    writeDb(db);
    return removed;
}

function removeReminders(creatorJid, chatJid, predicate = () => true) {
    const db = readDb();
    const removed = [];
    const kept = [];

    for (const item of db.items) {
        const belongsToUser = item.creatorJid === creatorJid && (!chatJid || item.chatJid === chatJid);
        if (belongsToUser && predicate(item)) {
            removed.push(item);
        } else {
            kept.push(item);
        }
    }

    if (removed.length) {
        db.items = kept;
        writeDb(db);
    }

    return removed;
}

function advanceRepeat(reminder) {
    if (!reminder.repeat) return null;

    const nextDate = new Date(reminder.remindAt);
    const value = Number(reminder.repeat.value || 1);

    if (reminder.repeat.unit === 'day') {
        nextDate.setUTCDate(nextDate.getUTCDate() + value);
    } else if (reminder.repeat.unit === 'week') {
        nextDate.setUTCDate(nextDate.getUTCDate() + value * 7);
    } else {
        return null;
    }

    while (nextDate.getTime() <= Date.now()) {
        if (reminder.repeat.unit === 'day') {
            nextDate.setUTCDate(nextDate.getUTCDate() + value);
        } else if (reminder.repeat.unit === 'week') {
            nextDate.setUTCDate(nextDate.getUTCDate() + value * 7);
        }
    }

    return nextDate.toISOString();
}

function formatDateTime(isoString) {
    return new Date(isoString).toLocaleString('id-ID', {
        timeZone: 'Asia/Makassar',
        weekday: 'short',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function parseDuration(token) {
    const match = token.match(/^(\d+)(m|h|d)$/i);
    if (!match) return null;

    const value = Number(match[1]);
    const unit = match[2].toLowerCase();
    const multiplier = unit === 'm' ? 60 * 1000 : unit === 'h' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;

    return new Date(Date.now() + value * multiplier);
}

const WITA_OFFSET_MS = 8 * 60 * 60 * 1000;

function nowInWitaParts() {
    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Makassar',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23'
    });

    const parts = Object.fromEntries(formatter.formatToParts(new Date()).map(part => [part.type, part.value]));
    return {
        year: Number(parts.year),
        month: Number(parts.month),
        day: Number(parts.day),
        hour: Number(parts.hour),
        minute: Number(parts.minute),
        second: Number(parts.second)
    };
}

function witaDateToUtcDate(year, month, day, hour, minute) {
    return new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0) - WITA_OFFSET_MS);
}

function parseAbsoluteDate(tokens) {
    const first = tokens[0];
    const second = tokens[1];

    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(first)) {
        const match = first.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
        if (match) {
            const [_, y, m, d, h, min] = match;
            return { date: witaDateToUtcDate(Number(y), Number(m), Number(d), Number(h), Number(min)), consumed: 1 };
        }
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(first) && /^\d{2}:\d{2}$/.test(second || '')) {
        const matchDate = first.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        const matchTime = second.match(/^(\d{2}):(\d{2})$/);
        if (matchDate && matchTime) {
            return {
                date: witaDateToUtcDate(Number(matchDate[1]), Number(matchDate[2]), Number(matchDate[3]), Number(matchTime[1]), Number(matchTime[2])),
                consumed: 2
            };
        }
    }

    if (/^besok$/i.test(first) && /^\d{2}:\d{2}$/.test(second || '')) {
        const [hour, minute] = second.split(':').map(Number);
        const witaNow = nowInWitaParts();
        const tomorrow = new Date(witaDateToUtcDate(witaNow.year, witaNow.month, witaNow.day, hour, minute).getTime() + 24 * 60 * 60 * 1000);
        return { date: tomorrow, consumed: 2 };
    }

    if (/^hariini$/i.test(first) && /^\d{2}:\d{2}$/.test(second || '')) {
        const [hour, minute] = second.split(':').map(Number);
        const witaNow = nowInWitaParts();
        return { date: witaDateToUtcDate(witaNow.year, witaNow.month, witaNow.day, hour, minute), consumed: 2 };
    }

    if (/^hari$/i.test(first) && /^ini$/i.test(second || '') && /^\d{2}:\d{2}$/.test(tokens[2] || '')) {
        const [hour, minute] = tokens[2].split(':').map(Number);
        const witaNow = nowInWitaParts();
        return { date: witaDateToUtcDate(witaNow.year, witaNow.month, witaNow.day, hour, minute), consumed: 3 };
    }

    return null;
}

function parseReminderArgs(args) {
    if (args.length < 2) {
        return null;
    }

    const durationDate = parseDuration(args[0]);
    if (durationDate) {
        return {
            remindAt: durationDate,
            message: args.slice(1).join(' ').trim()
        };
    }

    const absolute = parseAbsoluteDate(args);
    if (absolute) {
        return {
            remindAt: absolute.date,
            message: args.slice(absolute.consumed).join(' ').trim()
        };
    }

    return null;
}

async function sendDueReminders(sock) {
    if (!sock || isTickRunning) return;

    isTickRunning = true;

    try {
        const db = readDb();
        const now = Date.now();
        const dueItems = db.items.filter(item => new Date(item.remindAt).getTime() <= now);

        for (const item of dueItems) {
            try {
                const isGroup = item.chatJid.endsWith('@g.us');
                const mentionText = isGroup ? `@${item.creatorJid.split('@')[0]}\n` : '';
                await sock.sendMessage(item.chatJid, {
                    text: `${mentionText}*REMINDER*\n\n${item.message}`,
                    mentions: isGroup ? [item.creatorJid] : []
                });

                const latestDb = readDb();
                const latestItem = latestDb.items.find(reminder => reminder.id === item.id);
                
                if (latestItem) {
                    // Cek jika waktu remindAt sudah diubah oleh pengguna (di-snooze/reschedule) saat proses kirim berjalan
                    if (latestItem.remindAt !== item.remindAt) {
                        console.log(`[Reminder] Mengabaikan penghapusan/repeat untuk ${item.id} karena telah dijadwalkan ulang oleh user.`);
                    } else {
                        const nextRepeatAt = advanceRepeat(latestItem);
                        if (nextRepeatAt) {
                            latestItem.remindAt = nextRepeatAt;
                            latestItem.updatedAt = new Date().toISOString();
                        } else {
                            latestDb.items = latestDb.items.filter(reminder => reminder.id !== item.id);
                        }
                        latestDb.items.sort((a, b) => new Date(a.remindAt).getTime() - new Date(b.remindAt).getTime());
                        writeDb(latestDb);
                    }
                }
            } catch (err) {
                console.error(`[Reminder] Gagal mengirim reminder ${item.id}:`, err.message);
                
                // Cegah loop retry tanpa batas jika ada masalah koneksi/nomor tidak valid
                try {
                    const latestDb = readDb();
                    const latestItem = latestDb.items.find(reminder => reminder.id === item.id);
                    if (latestItem) {
                        latestItem.retryCount = (latestItem.retryCount || 0) + 1;
                        if (latestItem.retryCount >= 3) {
                            console.warn(`[Reminder] Menghapus reminder ${item.id} karena gagal dikirim sebanyak 3 kali.`);
                            latestDb.items = latestDb.items.filter(reminder => reminder.id !== item.id);
                        } else {
                            // Coba lagi dalam 5 menit
                            latestItem.remindAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
                            latestItem.updatedAt = new Date().toISOString();
                        }
                        latestDb.items.sort((a, b) => new Date(a.remindAt).getTime() - new Date(b.remindAt).getTime());
                        writeDb(latestDb);
                    }
                } catch (dbErr) {
                    console.error(`[Reminder] Gagal memperbarui status retry reminder ${item.id}:`, dbErr.message);
                }
            }
        }
    } finally {
        isTickRunning = false;
    }
}

function startReminderScheduler(getSock) {
    if (schedulerStarted) return;

    schedulerStarted = true;
    console.log('[Reminder] Scheduler aktif.');

    setInterval(() => {
        sendDueReminders(getSock()).catch(err => {
            console.error('[Reminder] Error scheduler:', err);
        });
    }, CHECK_INTERVAL_MS);
}

module.exports = {
    addReminder,
    findReminderByText,
    getNextReminder,
    listReminders,
    removeReminder,
    removeReminders,
    updateReminder,
    formatDateTime,
    parseReminderArgs,
    startReminderScheduler,
    canAddReminders,
    MAX_REMINDERS_PER_USER
};
