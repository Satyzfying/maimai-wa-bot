const { addReminder, formatDateTime } = require('./reminders');

const WITA_OFFSET_MS = 8 * 60 * 60 * 1000;
const MONTHS = {
    januari: 1,
    jan: 1,
    februari: 2,
    feb: 2,
    maret: 3,
    mar: 3,
    april: 4,
    apr: 4,
    mei: 5,
    juni: 6,
    jun: 6,
    juli: 7,
    jul: 7,
    agustus: 8,
    agu: 8,
    ags: 8,
    september: 9,
    sep: 9,
    oktober: 10,
    okt: 10,
    november: 11,
    nov: 11,
    desember: 12,
    des: 12
};

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

function addDaysInWita(parts, days) {
    const date = witaDateToUtcDate(parts.year, parts.month, parts.day, parts.hour, parts.minute);
    date.setUTCDate(date.getUTCDate() + days);
    const wita = new Date(date.getTime() + WITA_OFFSET_MS);
    return {
        year: wita.getUTCFullYear(),
        month: wita.getUTCMonth() + 1,
        day: wita.getUTCDate(),
        hour: wita.getUTCHours(),
        minute: wita.getUTCMinutes()
    };
}

function normalizeText(text) {
    return text
        .toLowerCase()
        .replace(/[，]/g, ',')
        .replace(/\s+/g, ' ')
        .trim();
}

function parseHour(text) {
    const match = text.match(/\b(?:jam|pukul)\s*(\d{1,2})(?:[.:](\d{1,2}))?\s*(pagi|siang|sore|malam)?\b/i);
    if (!match) return null;

    let hour = Number(match[1]);
    const minute = Number(match[2] || 0);
    const period = (match[3] || '').toLowerCase();

    if (period === 'pagi') {
        if (hour === 12) hour = 0;
    } else if (period === 'siang') {
        if (hour < 11) hour += 12;
    } else if (period === 'sore' || period === 'malam') {
        if (hour < 12) hour += 12;
    }

    if (hour > 23 || minute > 59) return null;
    return { hour, minute };
}

function parseEventDate(text) {
    const now = nowInWitaParts();

    if (/\bbesok\b/i.test(text)) {
        return addDaysInWita(now, 1);
    }

    if (/\blusa\b/i.test(text)) {
        return addDaysInWita(now, 2);
    }

    if (/\bhari ini\b|\bhariini\b/i.test(text)) {
        return now;
    }

    const namedDate = text.match(/\b(?:tanggal|tgl)\s*(\d{1,2})\s+([a-z]+)(?:\s+(\d{4}))?\b/i);
    if (namedDate) {
        const day = Number(namedDate[1]);
        const month = MONTHS[namedDate[2].toLowerCase()];
        if (!month) return null;

        let year = namedDate[3] ? Number(namedDate[3]) : now.year;
        let eventDate = witaDateToUtcDate(year, month, day, 23, 59);

        if (!namedDate[3] && eventDate.getTime() < Date.now()) {
            year += 1;
        }

        return { year, month, day };
    }

    const numericDate = text.match(/\b(?:tanggal|tgl)\s*(\d{1,2})(?:[-/\s]+(\d{1,2}))?(?:[-/\s]+(\d{4}))?\b/i);
    if (numericDate) {
        const day = Number(numericDate[1]);
        const month = numericDate[2] ? Number(numericDate[2]) : now.month;
        let year = numericDate[3] ? Number(numericDate[3]) : now.year;
        let eventDate = witaDateToUtcDate(year, month, day, 23, 59);

        if (!numericDate[3] && eventDate.getTime() < Date.now()) {
            year += 1;
        }

        return { year, month, day };
    }

    return null;
}

function extractEventMessage(text) {
    const cleaned = text
        .replace(/\b(?:tolong|pls|please)\b/gi, ' ')
        .replace(/\b(?:set|buat|bikin|pasang)\s+(?:reminder|pengingat)\b/gi, ' ')
        .replace(/\b(?:reminder|ingatkan)\s+(?:aku|saya|gua|gue|gw|ku)\b/gi, ' ')
        .replace(/\b(?:di|pada)?\s*(?:tanggal|tgl)\s*\d{1,2}(?:[-/\s]+\d{1,2})?(?:[-/\s]+\d{4})?\b/gi, ' ')
        .replace(/\b(?:besok|lusa|hari ini|hariini)\b/gi, ' ')
        .replace(/\b(?:jam|pukul)\s*\d{1,2}(?:[.:]\d{1,2})?\s*(?:pagi|siang|sore|malam)?\b/gi, ' ')
        .replace(/\b\d+\s*(?:hari|jam|menit|min|m)\s*(?:sebelumnya|sebelum)?\b/gi, ' ')
        .replace(/\b(?:sebelumnya|sebelum)\b/gi, ' ')
        .replace(/[,.;]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const adaMatch = text.match(/\bada\s+(.+?)(?:,\s*(?:tolong\s*)?(?:reminder|ingatkan)|$)/i);
    if (adaMatch && adaMatch[1].trim()) {
        return adaMatch[1].replace(/[,.;]+$/g, '').trim();
    }

    return cleaned || 'acara';
}

function parseOffsets(text) {
    const offsets = [];
    const seen = new Set();
    const matches = text.matchAll(/\b(\d+)\s*(hari|jam|menit|min|m)\s*(?:sebelumnya|sebelum)?\b/gi);

    for (const match of matches) {
        const value = Number(match[1]);
        const unit = match[2].toLowerCase();
        const minutes = unit === 'hari' ? value * 24 * 60 : unit === 'jam' ? value * 60 : value;
        if (minutes <= 0 || seen.has(minutes)) continue;

        seen.add(minutes);
        offsets.push({
            minutes,
            label: unit === 'hari'
                ? `${value} hari sebelumnya`
                : unit === 'jam'
                    ? `${value} jam sebelumnya`
                    : `${value} menit sebelumnya`
        });
    }

    if (offsets.length === 0) {
        offsets.push({ minutes: 0, label: 'tepat waktu' });
    }

    return offsets.sort((a, b) => b.minutes - a.minutes);
}

function parseNaturalReminder(text) {
    const normalized = normalizeText(text);
    if (!/\b(reminder|ingatkan|pengingat)\b/i.test(normalized)) {
        return null;
    }

    const dateParts = parseEventDate(normalized);
    const timeParts = parseHour(normalized);

    if (!dateParts || !timeParts) {
        return null;
    }

    const eventAt = witaDateToUtcDate(dateParts.year, dateParts.month, dateParts.day, timeParts.hour, timeParts.minute);
    const eventMessage = extractEventMessage(text);
    const offsets = parseOffsets(normalized);
    const reminders = offsets
        .map(offset => ({
            offset,
            remindAt: new Date(eventAt.getTime() - offset.minutes * 60 * 1000)
        }))
        .filter(item => item.remindAt.getTime() > Date.now());

    if (eventAt.getTime() <= Date.now() || reminders.length === 0) {
        return null;
    }

    return {
        eventAt,
        eventMessage,
        reminders
    };
}

function createNaturalReminders({ chatJid, creatorJid, text }) {
    const parsed = parseNaturalReminder(text);
    if (!parsed) return null;

    const created = parsed.reminders.map(item => {
        const message = `Pengingat ${item.offset.label}: ${parsed.eventMessage}\nWaktu acara: ${formatDateTime(parsed.eventAt.toISOString())}`;
        return addReminder({
            chatJid,
            creatorJid,
            message,
            remindAt: item.remindAt.toISOString()
        });
    });

    return {
        eventAt: parsed.eventAt,
        eventMessage: parsed.eventMessage,
        created
    };
}

module.exports = {
    parseNaturalReminder,
    createNaturalReminders
};
