module.exports = {
    name: 'ping',
    aliases: [],
    needsPrefix: false, // Bisa dipicu dengan 'ping' langsung atau '.ping'
    description: 'Menjawab dengan Pong untuk mengecek keaktifan bot.',
    async execute(sock, from, args, msg) {
        await sock.sendMessage(from, { text: 'Pong. Bot aktif.' });
    }
};
