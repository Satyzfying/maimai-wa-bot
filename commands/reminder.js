const {
    addReminder,
    listReminders,
    removeReminder,
    formatDateTime,
    parseReminderArgs
} = require('../utils/reminders');
const { isOwner } = require('../utils/owner');

function usageText() {
    return `*REMINDER*\n\n` +
        `• *.reminder add 30m latihan maimai*\n` +
        `• *.reminder add 2h cek stamina*\n` +
        `• *.reminder add besok 19:30 main cab*\n` +
        `• *.reminder add 2026-07-09 19:30 booking mesin*\n` +
        `• *.reminder list*\n` +
        `• *.reminder delete [ID]*\n\n` +
        `_Waktu ditampilkan dalam WITA._`;
}

module.exports = {
    name: 'reminder',
    aliases: ['remind', 'ingatkan'],
    needsPrefix: true,
    description: 'Membuat dan mengelola reminder WhatsApp.',
    async execute(sock, from, args, msg) {
        if (from.endsWith('@g.us')) {
            await sock.sendMessage(from, {
                text: 'Fitur reminder hanya tersedia melalui chat pribadi.'
            });
            return;
        }

        const senderJid = msg.key.participant || msg.key.remoteJid;
        if (!isOwner(senderJid)) {
            return;
        }

        const subCommand = (args[0] || '').toLowerCase();

        if (!subCommand || subCommand === 'help') {
            await sock.sendMessage(from, { text: usageText() });
            return;
        }

        if (subCommand === 'list' || subCommand === 'ls') {
            const reminders = listReminders(senderJid, from);

            if (reminders.length === 0) {
                await sock.sendMessage(from, { text: 'Belum ada reminder aktif di chat ini.' });
                return;
            }

            let responseText = `*REMINDER AKTIF*\n\n`;
            for (const reminder of reminders) {
                responseText += `• *${reminder.id}* - ${formatDateTime(reminder.remindAt)}\n`;
                responseText += `  ${reminder.message}\n\n`;
            }
            responseText += `Hapus dengan *.reminder delete [ID]*`;

            await sock.sendMessage(from, { text: responseText.trim() });
            return;
        }

        if (['delete', 'del', 'hapus', 'remove', 'rm', 'done'].includes(subCommand)) {
            const id = args[1];
            if (!id) {
                await sock.sendMessage(from, { text: '*ID reminder belum diisi.*\n\nContoh: *.reminder delete ABC123*' });
                return;
            }

            const removed = removeReminder(senderJid, id);
            if (!removed) {
                await sock.sendMessage(from, { text: `Reminder dengan ID *${id.toUpperCase()}* tidak ditemukan.` });
                return;
            }

            await sock.sendMessage(from, { text: `Reminder *${removed.id}* berhasil dihapus.` });
            return;
        }

        const addArgs = subCommand === 'add' || subCommand === 'set' || subCommand === 'buat'
            ? args.slice(1)
            : args;
        const parsed = parseReminderArgs(addArgs);

        if (!parsed || !parsed.message) {
            await sock.sendMessage(from, { text: usageText() });
            return;
        }

        if (Number.isNaN(parsed.remindAt.getTime())) {
            await sock.sendMessage(from, { text: '*Format waktu tidak valid.*\n\nContoh: *.reminder add 30m latihan maimai*' });
            return;
        }

        if (parsed.remindAt.getTime() <= Date.now()) {
            await sock.sendMessage(from, { text: '*Waktu reminder harus berada di masa depan.*' });
            return;
        }

        try {
            const reminder = addReminder({
                chatJid: from,
                creatorJid: senderJid,
                message: parsed.message,
                remindAt: parsed.remindAt.toISOString()
            });

            await sock.sendMessage(from, {
                text: `Reminder *${reminder.id}* tersimpan.\n\n` +
                    `Waktu: ${formatDateTime(reminder.remindAt)}\n` +
                    `Isi: ${reminder.message}`
            });
        } catch (err) {
            await sock.sendMessage(from, { text: `*Gagal menyimpan reminder:*\n_${err.message}_` });
        }
    }
};
