function normalizePhoneNumber(value) {
    let number = String(value || '')
        .split('@')[0]
        .replace(/\D/g, '');

    if (number.startsWith('0')) {
        number = `62${number.slice(1)}`;
    } else if (number.startsWith('8')) {
        number = `62${number}`;
    }

    return number;
}

function getOwnerNumbers() {
    return (process.env.REMINDER_OWNER_JIDS || process.env.OWNER_JIDS || '')
        .split(',')
        .map(item => normalizePhoneNumber(item.trim()))
        .filter(Boolean);
}

function isOwner(senderJid) {
    const owners = getOwnerNumbers();
    if (owners.length === 0) return true;

    const senderNumber = normalizePhoneNumber(senderJid);
    return owners.includes(senderNumber);
}

module.exports = {
    isOwner,
    normalizePhoneNumber
};
