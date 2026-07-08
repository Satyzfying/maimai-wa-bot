const { addReminder, formatDateTime, canAddReminders, MAX_REMINDERS_PER_USER } = require('./reminders');

const WITA_OFFSET_MS = 8 * 60 * 60 * 1000;
const DEFAULT_OFFSETS = [
    { minutes: 24 * 60, label: '1 hari sebelumnya' },
    { minutes: 12 * 60, label: '12 jam sebelumnya' },
    { minutes: 6 * 60, label: '6 jam sebelumnya' },
    { minutes: 3 * 60, label: '3 jam sebelumnya' },
    { minutes: 60, label: '1 jam sebelumnya' },
    { minutes: 30, label: '30 menit sebelumnya' }
];
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
    const date = witaDateToUtcDate(parts.year, parts.month, parts.day, parts.hour || 0, parts.minute || 0);
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
        .replace(/\bsetengah\s+jam\b/g, '30 menit')
        .replace(/\bseperempat\s+jam\b/g, '15 menit')
        .replace(/\bsejam\b/g, '1 jam')
        .replace(/\bsehari\b/g, '1 hari')
        .replace(/\bbesok pagi\b/g, 'besok')
        .replace(/\bbesok siang\b/g, 'besok')
        .replace(/\bbesok sore\b/g, 'besok')
        .replace(/\bbesok malam\b/g, 'besok')
        .replace(/\s+/g, ' ')
        .trim();
}

function parseHour(text) {
    const prefixPeriodMatch = text.match(/\b(pagi|siang|sore|malam)\s*(?:jam|pukul|pk|pkl)?\s*(\d{1,2})(?:[.:](\d{1,2}))?\b/i);
    const candidates = prefixPeriodMatch
        ? [[prefixPeriodMatch[0], prefixPeriodMatch[2], prefixPeriodMatch[3], prefixPeriodMatch[1]]]
        : [...text.matchAll(/\b(?:(?:jam|pukul|pk|pkl)\s*)?(\d{1,2})(?:[.:](\d{1,2}))?\s*(pagi|siang|sore|malam|am|pm|wita)?\b/gi)];

    for (const match of candidates) {
        const hasTimePrefix = /\b(?:jam|pukul|pk|pkl)\b/i.test(match[0]);
        const hasMinute = match[2] !== undefined;
        const hasPeriod = match[3] !== undefined;
        if (!hasTimePrefix && !hasMinute && !hasPeriod) continue;

        let hour = Number(match[1]);
        const minute = Number(match[2] || 0);
        const period = (match[3] || '').toLowerCase();

        if (period === 'pagi') {
            if (hour === 12) hour = 0;
        } else if (period === 'siang') {
            if (hour < 11) hour += 12;
        } else if (period === 'sore' || period === 'malam' || period === 'pm') {
            if (hour < 12) hour += 12;
        } else if (period === 'am') {
            if (hour === 12) hour = 0;
        }

        if (hour <= 23 && minute <= 59) return { hour, minute };
    }

    return null;
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

    const slashDate = text.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/);
    if (slashDate) {
        const day = Number(slashDate[1]);
        const month = Number(slashDate[2]);
        let year = slashDate[3] ? Number(slashDate[3]) : now.year;
        if (year < 100) year += 2000;
        let eventDate = witaDateToUtcDate(year, month, day, 23, 59);

        if (!slashDate[3] && eventDate.getTime() < Date.now()) {
            year += 1;
        }

        return { year, month, day };
    }

    const namedDate = text.match(/\b(?:tanggal|tgl)\s*(\d{1,2})\s+([a-z]+)(?:\s+(\d{4}))?\b/i);
    if (namedDate && MONTHS[namedDate[2].toLowerCase()]) {
        const day = Number(namedDate[1]);
        const month = MONTHS[namedDate[2].toLowerCase()];

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
        .replace(/\b(?:reminder|remind|ingatkan|ingetin|ingetim|ingat|jadwalin|jadwalkan)\s+(?:aku|saya|gua|gue|gw|ku)?\b/gi, ' ')
        .replace(/\b(?:di|pada)?\s*(?:tanggal|tgl)\s*\d{1,2}(?:[-/\s]+\d{1,2})?(?:[-/\s]+\d{4})?\b/gi, ' ')
        .replace(/\b(?:besok|lusa|hari ini|hariini)\b/gi, ' ')
        .replace(/\b(?:(?:jam|pukul|pk|pkl)\s*)?\d{1,2}(?:[.:]\d{1,2})?\s*(?:pagi|siang|sore|malam|am|pm|wita)\b/gi, ' ')
        .replace(/\b\d+\s*(?:hari|jam|menit|mnt|min|m)\s*(?:sebelumnya|sebelum|sebelom)?\b/gi, ' ')
        .replace(/\b(?:sebelumnya|sebelum)\b/gi, ' ')
        .replace(/\b(?:setengah jam|seperempat jam|sejam|sehari)\b/gi, ' ')
        .replace(/[,.;]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const adaMatch = text.match(/\bada\s+(.+?)(?:,\s*(?:tolong\s*)?(?:reminder|remind|ingatkan|ingetin|ingetim|ingat)|$)/i);
    if (adaMatch && adaMatch[1].trim()) {
        return adaMatch[1]
            .replace(/\b\d+\s*(?:hari|jam|menit|mnt|min|m)\s*(?:sebelumnya|sebelum|sebelom)?\b/gi, ' ')
            .replace(/\b(?:sebelumnya|sebelum|sebelom)\b/gi, ' ')
            .replace(/\b(?:setengah jam|seperempat jam|sejam|sehari)\b/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .replace(/[,.;]+$/g, '');
    }

    return cleaned || 'acara';
}

function parseOffsets(text, options = {}) {
    const includeDefault = options.includeDefault !== false;
    const offsets = [];
    const seen = new Set();
    const matches = text.matchAll(/\b(\d+)\s*(hari|jam|menit|mnt|min|m)\s*(?:sebelumnya|sebelum|sebelom)?\b/gi);

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

    const phraseOffsets = [
        { pattern: /\b30 menit\b|\bsetengah jam\b/i, minutes: 30, label: '30 menit sebelumnya' },
        { pattern: /\b15 menit\b|\bseperempat jam\b/i, minutes: 15, label: '15 menit sebelumnya' },
        { pattern: /\b1 jam\b|\bsejam\b/i, minutes: 60, label: '1 jam sebelumnya' },
        { pattern: /\b1 hari\b|\bsehari\b/i, minutes: 24 * 60, label: '1 hari sebelumnya' }
    ];

    for (const phrase of phraseOffsets) {
        if (phrase.pattern.test(text) && !seen.has(phrase.minutes)) {
            seen.add(phrase.minutes);
            offsets.push({ minutes: phrase.minutes, label: phrase.label });
        }
    }

    if (offsets.length === 0 && includeDefault) {
        offsets.push({ minutes: 0, label: 'tepat waktu' });
    }

    return offsets.sort((a, b) => b.minutes - a.minutes);
}

function stripEventDateTime(text) {
    return text
        .replace(/\b(?:tanggal|tgl)\s*\d{1,2}\s+[a-z]+(?:\s+\d{4})?\b/gi, ' ')
        .replace(/\b(?:tanggal|tgl)\s*\d{1,2}(?:[-/\s]+\d{1,2})?(?:[-/\s]+\d{2,4})?\b/gi, ' ')
        .replace(/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g, ' ')
        .replace(/\b(?:besok|lusa|hari ini|hariini)\b/gi, ' ')
        .replace(/\b(pagi|siang|sore|malam)\s*(?:jam|pukul|pk|pkl)?\s*\d{1,2}(?:[.:]\d{1,2})?\b/gi, ' ')
        .replace(/\b(?:jam|pukul|pk|pkl)\s*\d{1,2}(?:[.:]\d{1,2})?\s*(?:pagi|siang|sore|malam|am|pm|wita)?\b/gi, ' ')
        .replace(/\b\d{1,2}(?:[.:]\d{1,2})\s*(?:pagi|siang|sore|malam|am|pm|wita)?\b/gi, ' ');
}

function offsetLabelFromDate(remindAt, eventAt) {
    const diffMinutes = Math.round((eventAt.getTime() - remindAt.getTime()) / 60000);
    if (diffMinutes <= 0) return 'di waktu yang dipilih';
    if (diffMinutes % (24 * 60) === 0) return `${diffMinutes / (24 * 60)} hari sebelumnya`;
    if (diffMinutes % 60 === 0) return `${diffMinutes / 60} jam sebelumnya`;
    return `${diffMinutes} menit sebelumnya`;
}

function parseAbsoluteTimeCandidates(text) {
    const candidates = [];
    const normalized = normalizeText(text);

    for (const match of normalized.matchAll(/\bsetengah\s+(\d{1,2})\s*(pagi|siang|sore|malam|am|pm)?\b/gi)) {
        let hour = Number(match[1]) - 1;
        const period = (match[2] || '').toLowerCase();

        if (period === 'siang') {
            if (hour < 11) hour += 12;
        } else if (period === 'sore' || period === 'malam' || period === 'pm') {
            if (hour < 12) hour += 12;
        } else if (period === 'am' || period === 'pagi') {
            if (hour === 12) hour = 0;
        }

        if (hour >= 0 && hour <= 23) {
            candidates.push({ hour, minute: 30 });
        }
    }

    for (const match of normalized.matchAll(/\b(?:jam|pukul|pk|pkl)\s*(\d{1,2})(?:[.:](\d{1,2}))?\s*(pagi|siang|sore|malam|am|pm|wita)?\b/gi)) {
        const parsed = parseHour(match[0]);
        if (parsed) candidates.push(parsed);
    }

    const seen = new Set();
    return candidates.filter(item => {
        const key = `${item.hour}:${item.minute}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function parseAbsoluteReminderTimes(text, eventDateParts, eventTimeParts) {
    if (!eventDateParts || !eventTimeParts) return [];

    const normalized = normalizeText(text);
    const previousPeriodTime = normalized.match(/\b(pagi|siang|sore|malam)\s*(?:sebelumnya|sebelum|sebelom)\s*(?:jam|pukul|pk|pkl)?\s*(\d{1,2})(?:[.:](\d{1,2}))?\b/i);
    const timeCandidates = previousPeriodTime
        ? parseHour(`${previousPeriodTime[1]} jam ${previousPeriodTime[2]}${previousPeriodTime[3] ? `.${previousPeriodTime[3]}` : ''}`)
        : parseAbsoluteTimeCandidates(normalized);
    const candidates = Array.isArray(timeCandidates) ? timeCandidates : [timeCandidates].filter(Boolean);
    if (!candidates.length) return [];

    const eventAt = buildEventDate(eventDateParts, eventTimeParts);
    if (!eventAt) return [];

    let targetDateParts = eventDateParts;
    const previousDay = /\b(?:malam|sore|siang|pagi)?\s*(?:sebelumnya|sebelum|sebelom)\b/i.test(normalized);

    if (previousDay) {
        targetDateParts = addDaysInWita(eventDateParts, -1);
    } else {
        const explicitDateParts = parseEventDate(normalized);
        if (explicitDateParts) {
            targetDateParts = explicitDateParts;
        }
    }

    return candidates
        .map(timeParts => {
            let remindAt = witaDateToUtcDate(
                targetDateParts.year,
                targetDateParts.month,
                targetDateParts.day,
                timeParts.hour,
                timeParts.minute
            );

            if (!previousDay && remindAt.getTime() >= eventAt.getTime()) {
                remindAt = new Date(remindAt.getTime() - 24 * 60 * 60 * 1000);
            }

            if (remindAt.getTime() <= Date.now() || remindAt.getTime() >= eventAt.getTime()) {
                return null;
            }

            return {
                remindAt,
                label: offsetLabelFromDate(remindAt, eventAt)
            };
        })
        .filter(Boolean);
}

function hasReminderIntent(text) {
    const normalized = normalizeText(text);
    return /\b(reminder|remind|ingatkan|ingetin|ingetim|ingat|pengingat|jadwalin|jadwalkan)\b/i.test(normalized);
}

function parseReminderDraft(text) {
    const normalized = normalizeText(text);
    if (!hasReminderIntent(normalized)) {
        return null;
    }

    const dateParts = parseEventDate(normalized);
    const timeParts = parseHour(normalized);
    const offsets = parseOffsets(stripEventDateTime(normalized), { includeDefault: false });

    return {
        dateParts,
        timeParts,
        eventMessage: extractEventMessage(text),
        offsets,
        absoluteReminders: []
    };
}

function buildEventDate(dateParts, timeParts) {
    if (!dateParts || !timeParts) return null;
    return witaDateToUtcDate(dateParts.year, dateParts.month, dateParts.day, timeParts.hour, timeParts.minute);
}

function buildReminderPlan({ dateParts, timeParts, eventMessage, offsets, absoluteReminders }) {
    const eventAt = buildEventDate(dateParts, timeParts);
    if (!eventAt) return null;

    if (eventAt.getTime() <= Date.now()) {
        return null;
    }

    const chosenOffsets = offsets && offsets.length ? offsets : [];
    const countdownReminders = chosenOffsets
        .map(offset => ({
            offset,
            remindAt: new Date(eventAt.getTime() - offset.minutes * 60 * 1000)
        }))
        .filter(item => item.remindAt.getTime() > Date.now());
    const fixedTimeReminders = (absoluteReminders || [])
        .map(item => ({
            offset: { minutes: null, label: item.label },
            remindAt: item.remindAt
        }))
        .filter(item => item.remindAt.getTime() > Date.now() && item.remindAt.getTime() < eventAt.getTime());
    const reminders = [...countdownReminders, ...fixedTimeReminders]
        .sort((a, b) => a.remindAt.getTime() - b.remindAt.getTime());

    if (reminders.length === 0) {
        return null;
    }

    return {
        eventAt,
        eventMessage,
        reminders
    };
}

function nextDateForTime(timeParts, dayOffset = 0) {
    const now = nowInWitaParts();
    let candidate = witaDateToUtcDate(now.year, now.month, now.day, timeParts.hour, timeParts.minute);
    candidate.setUTCDate(candidate.getUTCDate() + dayOffset);

    if (candidate.getTime() <= Date.now()) {
        candidate.setUTCDate(candidate.getUTCDate() + 1);
    }

    return candidate;
}

function parseRecurringReminder(text) {
    const normalized = normalizeText(text);
    if (!hasReminderIntent(normalized) || !/\b(tiap|setiap)\b/i.test(normalized)) {
        return null;
    }

    const timeParts = parseHour(normalized);
    if (!timeParts) return null;

    let repeat = null;
    if (/\b(tiap|setiap)\s+hari\b/i.test(normalized)) {
        repeat = { unit: 'day', value: 1, label: 'setiap hari' };
    } else if (/\b(tiap|setiap)\s+minggu\b/i.test(normalized)) {
        repeat = { unit: 'week', value: 1, label: 'setiap minggu' };
    }

    if (!repeat) return null;

    const message = extractEventMessage(text)
        .replace(/\b(?:tiap|setiap)\s+(?:hari|minggu)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim() || 'rutinitas';

    const remindAt = nextDateForTime(timeParts).toISOString();
    return {
        eventAt: new Date(remindAt),
        eventMessage: message,
        reminders: [{
            offset: { minutes: null, label: repeat.label },
            remindAt: new Date(remindAt),
            repeat
        }],
        repeat
    };
}

function parseNaturalReminder(text) {
    const recurring = parseRecurringReminder(text);
    if (recurring) return recurring;

    const draft = parseReminderDraft(text);
    if (!draft || !draft.dateParts || !draft.timeParts) return null;
    return buildReminderPlan(draft);
}

function createRemindersFromPlan({ chatJid, creatorJid, eventAt, eventMessage, reminders }) {
    if (!canAddReminders(creatorJid, reminders.length)) {
        throw new Error(`Gagal menyimpan. Batas maksimal ${MAX_REMINDERS_PER_USER} reminder aktif per pengguna akan terlampaui.`);
    }

    const created = reminders.map(item => {
        const message = `Pengingat ${item.offset.label}: ${eventMessage}\nWaktu acara: ${formatDateTime(eventAt.toISOString())}`;
        return addReminder({
            chatJid,
            creatorJid,
            message,
            remindAt: item.remindAt.toISOString(),
            repeat: item.repeat || null
        });
    });

    return {
        eventAt,
        eventMessage,
        created
    };
}

function createNaturalReminders({ chatJid, creatorJid, text }) {
    const parsed = parseNaturalReminder(text);
    if (!parsed) return null;

    return createRemindersFromPlan({
        chatJid,
        creatorJid,
        eventAt: parsed.eventAt,
        eventMessage: parsed.eventMessage,
        reminders: parsed.reminders
    });
}

module.exports = {
    DEFAULT_OFFSETS,
    buildReminderPlan,
    createRemindersFromPlan,
    parseNaturalReminder,
    parseRecurringReminder,
    parseReminderDraft,
    parseEventDate,
    parseAbsoluteReminderTimes,
    parseHour,
    parseOffsets,
    createNaturalReminders
};
