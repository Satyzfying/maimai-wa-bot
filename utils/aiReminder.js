const OpenAI = require('openai');
const { parseHour } = require('./naturalReminder');

const WITA_OFFSET_MS = 8 * 60 * 60 * 1000;
const DEFAULT_MODEL = process.env.OPENAI_REMINDER_MODEL || 'gpt-4.1-mini';

let client = null;

function getClient() {
    if (!process.env.OPENAI_API_KEY || process.env.AI_REMINDER_ENABLED === 'false') {
        return null;
    }

    if (!client) {
        client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }

    return client;
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
        additionalProperties: false,
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
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            event_title: { type: ['string', 'null'] },
            event_datetime: { type: ['string', 'null'] },
            reminders: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['type', 'datetime', 'minutes_before'],
                    properties: {
                        type: { type: 'string', enum: ['fixed_time', 'relative'] },
                        datetime: { type: ['string', 'null'] },
                        minutes_before: { type: ['number', 'null'] }
                    }
                }
            },
            repeat: {
                type: ['object', 'null'],
                additionalProperties: false,
                required: ['unit', 'value', 'label'],
                properties: {
                    unit: { type: 'string', enum: ['day', 'week'] },
                    value: { type: 'number' },
                    label: { type: 'string' }
                }
            },
            needs_clarification: { type: 'boolean' },
            clarifying_question: { type: ['string', 'null'] },
            target_query: { type: ['string', 'null'] },
            snooze_minutes: { type: ['number', 'null'] }
        }
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
    const api = getClient();
    if (!api) return null;

    const response = await api.responses.create({
        model: DEFAULT_MODEL,
        input: [
            {
                role: 'system',
                content:
                    `Kamu adalah parser reminder pribadi Bahasa Indonesia.\n` +
                    `Balas hanya JSON sesuai schema.\n` +
                    `Timezone default Asia/Makassar/WITA (+08:00). Tanggal sekarang WITA: ${getCurrentWitaIso()}.\n` +
                    `Pahami typo dan bahasa santai: ingetim, ingetin, ingatkan, remind, reminder, jadwalin.\n` +
                    `Pahami waktu natural: setengah 5 sore = 16:30, jam 3 sore = 15:00, besok = tanggal besok WITA.\n` +
                    `Jika user mengoreksi pending reminder seperti "salah", "bukan", "maksudku", gunakan intent revise_pending dan minta klarifikasi jika belum jelas.\n` +
                    `Jangan mengarang tanggal/jam kalau ambigu; gunakan needs_clarification.\n` +
                    `Untuk beberapa reminder sekaligus, isi array reminders lebih dari satu.\n` +
                    `Jika user bertanya fitur bot/reminder, intent feature_help.\n`
            },
            {
                role: 'user',
                content: JSON.stringify({
                    text,
                    pending: compactPending(pendingSession)
                })
            }
        ],
        text: {
            format: {
                type: 'json_schema',
                name: 'reminder_intent',
                strict: true,
                schema: schema()
            }
        },
        temperature: 0.1
    });

    const raw = response.output_text;
    if (!raw) return null;

    return JSON.parse(raw);
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
