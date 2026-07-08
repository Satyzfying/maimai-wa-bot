const { parseHour } = require('./naturalReminder');

const WITA_OFFSET_MS = 8 * 60 * 60 * 1000;
const DEFAULT_MODEL = process.env.GEMINI_REMINDER_MODEL || 'gemini-3.5-flash';

function getApiKey() {
    if (process.env.AI_REMINDER_ENABLED === 'false') return null;
    return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || null;
}

function getCurrentWitaIso() {
    return new Date(Date.now() + WITA_OFFSET_MS).toISOString().replace('Z', '+08:00');
}

function parseWitaIso(value) {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date;
}

function inferLabel(remindAt, eventAt) {
    const diffMinutes = Math.round((eventAt.getTime() - remindAt.getTime()) / 60000);
    if (diffMinutes <= 0) return 'di waktu yang dipilih';
    if (diffMinutes % (24 * 60) === 0) return `${diffMinutes / (24 * 60)} hari sebelumnya`;
    if (diffMinutes % 60 === 0) return `${diffMinutes / 60} jam sebelumnya`;
    return `${diffMinutes} menit sebelumnya`;
}

function schema() {
    return {
        type: 'object',
        required: [
            'intent',
            'confidence',
            'event_title',
            'event_datetime',
            'reminders',
            'repeat',
            'needs_clarification',
            'clarifying_question',
            'target_query',
            'snooze_minutes'
        ],
        properties: {
            intent: {
                type: 'string',
                enum: [
                    'none',
                    'create_reminder',
                    'revise_pending',
                    'confirm',
                    'cancel',
                    'list_reminders',
                    'delete_reminder',
                    'edit_reminder',
                    'snooze_reminder',
                    'feature_help'
                ]
            },
            confidence: { type: 'number' },
            event_title: nullable({ type: 'string' }),
            event_datetime: nullable({ type: 'string' }),
            reminders: {
                type: 'array',
                items: {
                    type: 'object',
                    required: ['type', 'datetime', 'minutes_before'],
                    properties: {
                        type: { type: 'string', enum: ['fixed_time', 'relative'] },
                        datetime: nullable({ type: 'string' }),
                        minutes_before: nullable({ type: 'number' })
                    }
                }
            },
            repeat: nullable({
                type: 'object',
                required: ['unit', 'value', 'label'],
                properties: {
                    unit: { type: 'string', enum: ['day', 'week'] },
                    value: { type: 'number' },
                    label: { type: 'string' }
                }
            }),
            needs_clarification: { type: 'boolean' },
            clarifying_question: nullable({ type: 'string' }),
            target_query: nullable({ type: 'string' }),
            snooze_minutes: nullable({ type: 'number' })
        }
    };
}

function nullable(schemaPart) {
    return {
        anyOf: [
            schemaPart,
            { type: 'null' }
        ]
    };
}

function compactPending(session) {
    if (!session) return null;

    return {
        stage: session.stage || null,
        event_title: session.eventMessage || session.plan?.eventMessage || null,
        event_datetime: session.plan?.eventAt || null,
        reminders: session.plan?.reminders?.map(item => ({
            remind_at: item.remindAt,
            label: item.offset?.label || item.label || null
        })) || null
    };
}

async function parseWithAI({ text, pendingSession }) {
    const apiKey = getApiKey();
    if (!apiKey) return null;

    const prompt =
        `Kamu adalah parser reminder pribadi Bahasa Indonesia.\n` +
        `Balas hanya JSON valid sesuai schema.\n` +
        `Timezone default Asia/Makassar/WITA (+08:00). Tanggal sekarang WITA: ${getCurrentWitaIso()}.\n` +
        `Pahami typo dan bahasa santai: ingetim, ingetin, ingatkan, remind, reminder, jadwalin.\n` +
        `Pahami waktu natural: setengah 5 sore = 16:30, jam 3 sore = 15:00, besok = tanggal besok WITA.\n` +
        `Jika user mengoreksi pending reminder seperti "salah", "bukan", "maksudku", gunakan intent revise_pending dan minta klarifikasi jika belum jelas.\n` +
        `Jangan mengarang tanggal/jam kalau ambigu; gunakan needs_clarification.\n` +
        `Untuk beberapa reminder sekaligus, isi array reminders lebih dari satu.\n` +
        `Jika user bertanya fitur bot/reminder, intent feature_help.\n\n` +
        `Input:\n${JSON.stringify({ text, pending: compactPending(pendingSession) })}`;

    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey
        },
        body: JSON.stringify({
            model: DEFAULT_MODEL,
            input: prompt,
            response_format: {
                type: 'text',
                mime_type: 'application/json',
                schema: schema()
            }
        })
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gemini API ${response.status}: ${errorText.slice(0, 200)}`);
    }

    const data = await response.json();
    const raw = extractGeminiText(data);
    if (!raw) return null;

    return typeof raw === 'string' ? JSON.parse(stripJsonFence(raw)) : raw;
}

function extractGeminiText(data) {
    if (!data) return null;
    if (data.intent) return data;
    if (typeof data.output_text === 'string') return data.output_text;

    const steps = Array.isArray(data.steps) ? data.steps : [];
    for (let i = steps.length - 1; i >= 0; i--) {
        const content = steps[i].content;
        if (!Array.isArray(content)) continue;

        const textPart = content.find(item => typeof item.text === 'string');
        if (textPart) return textPart.text;
    }

    const candidate = data.candidates?.[0]?.content?.parts?.find(part => typeof part.text === 'string');
    return candidate?.text || null;
}

function stripJsonFence(value) {
    return value
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '');
}

function aiResultToPlan(result) {
    if (!result || !['create_reminder', 'revise_pending'].includes(result.intent)) return null;
    if (result.needs_clarification || result.confidence < 0.7) return null;

    const eventAt = parseWitaIso(result.event_datetime);
    if (!eventAt || eventAt.getTime() <= Date.now()) return null;

    const reminders = [];

    for (const reminder of result.reminders || []) {
        if (reminder.type === 'relative' && reminder.minutes_before !== null) {
            const minutes = Number(reminder.minutes_before);
            if (minutes <= 0) continue;

            const remindAt = new Date(eventAt.getTime() - minutes * 60 * 1000);
            if (remindAt.getTime() > Date.now()) {
                reminders.push({
                    offset: {
                        minutes,
                        label: minutes % (24 * 60) === 0
                            ? `${minutes / (24 * 60)} hari sebelumnya`
                            : minutes % 60 === 0
                                ? `${minutes / 60} jam sebelumnya`
                                : `${minutes} menit sebelumnya`
                    },
                    remindAt,
                    repeat: result.repeat || null
                });
            }
        } else if (reminder.type === 'fixed_time' && reminder.datetime) {
            const remindAt = parseWitaIso(reminder.datetime);
            if (remindAt && remindAt.getTime() > Date.now() && remindAt.getTime() < eventAt.getTime()) {
                reminders.push({
                    offset: { minutes: null, label: inferLabel(remindAt, eventAt) },
                    remindAt,
                    repeat: result.repeat || null
                });
            }
        }
    }

    if (result.repeat && reminders.length === 0) {
        reminders.push({
            offset: { minutes: null, label: result.repeat.label },
            remindAt: eventAt,
            repeat: result.repeat
        });
    }

    if (reminders.length === 0) return null;

    return {
        eventAt,
        eventMessage: result.event_title || 'acara',
        reminders: reminders.sort((a, b) => a.remindAt.getTime() - b.remindAt.getTime())
    };
}

function aiResultToPartialSession(result) {
    if (!result || !['create_reminder', 'revise_pending'].includes(result.intent)) return null;

    const eventAt = parseWitaIso(result.event_datetime);
    const dateParts = eventAt
        ? {
            year: Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Makassar', year: 'numeric' }).format(eventAt)),
            month: Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Makassar', month: '2-digit' }).format(eventAt)),
            day: Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Makassar', day: '2-digit' }).format(eventAt))
        }
        : null;
    const timeParts = eventAt ? parseHour(new Intl.DateTimeFormat('id-ID', {
        timeZone: 'Asia/Makassar',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
    }).format(eventAt)) : null;

    return {
        dateParts,
        timeParts,
        eventMessage: result.event_title || 'acara',
        offsets: [],
        absoluteReminders: [],
        updatedAt: Date.now()
    };
}

module.exports = {
    aiResultToPartialSession,
    aiResultToPlan,
    parseWithAI
};
