const fs = require('fs');
const { dataPath } = require('./paths');

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
        return {
            items: Array.isArray(data.items) ? data.items : []
        };
    } catch (err) {
        console.error('[Reminder] Gagal membaca reminders.json:', err.message);
        return { items: [] };
    }
}

function writeDb(db) {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf-8');
}

function createId() {
    return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function addReminder({ chatJid, creatorJid, message, remindAt, repeat }) {
    const db = readDb();
    const activeCount = db.items.filter(item => item.creatorJid === creatorJid).length;

    if (activeCount >= MAX_REMINDERS_PER_USER) {
        throw new Error(`Batas maksimal ${MAX_REMINDERS_PER_USER} reminder aktif per pengguna sudah tercapai.`);
    }

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

    return listReminders(creatorJid, chatJid)
        .find(item => item.id.toLowerCase() === needle || item.message.toLowerCase().includes(needle)) || null;
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

function parseAbsoluteDate(tokens) {
    const first = tokens[0];
    const second = tokens[1];

    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(first)) {
        return { date: new Date(first), consumed: 1 };
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(first) && /^\d{2}:\d{2}$/.test(second || '')) {
        return { date: new Date(`${first}T${second}`), consumed: 2 };
    }

    if (/^besok$/i.test(first) && /^\d{2}:\d{2}$/.test(second || '')) {
        const [hour, minute] = second.split(':').map(Number);
        const date = new Date();
        date.setDate(date.getDate() + 1);
        date.setHours(hour, minute, 0, 0);
        return { date, consumed: 2 };
    }

    if (/^hariini$/i.test(first) && /^\d{2}:\d{2}$/.test(second || '')) {
        const [hour, minute] = second.split(':').map(Number);
        const date = new Date();
        date.setHours(hour, minute, 0, 0);
        return { date, consumed: 2 };
    }

    if (/^hari$/i.test(first) && /^ini$/i.test(second || '') && /^\d{2}:\d{2}$/.test(tokens[2] || '')) {
        const [hour, minute] = tokens[2].split(':').map(Number);
        const date = new Date();
        date.setHours(hour, minute, 0, 0);
        return { date, consumed: 3 };
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
                const nextRepeatAt = latestItem ? advanceRepeat(latestItem) : null;

                if (latestItem && nextRepeatAt) {
                    latestItem.remindAt = nextRepeatAt;
                    latestItem.updatedAt = new Date().toISOString();
                } else {
                    latestDb.items = latestDb.items.filter(reminder => reminder.id !== item.id);
                }

                latestDb.items.sort((a, b) => new Date(a.remindAt).getTime() - new Date(b.remindAt).getTime());
                writeDb(latestDb);
            } catch (err) {
                console.error(`[Reminder] Gagal mengirim reminder ${item.id}:`, err.message);
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
    updateReminder,
    formatDateTime,
    parseReminderArgs,
    startReminderScheduler
};
