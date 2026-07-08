module.exports = {
    name: 'help',
    aliases: ['menu', 'h'],
    needsPrefix: true,
    description: 'Menampilkan daftar perintah dan menu bantuan bot.',
    async execute(sock, from, args, msg) {
        const helpText = 
            `*MENU BANTUAN MAIMAI WA BOT*\n` +
            `• *.login* : Hubungkan akun Maimai DX NET (Chat Pribadi).\n` +
            `• *.rating* (/*.rt*) : Tampilkan nickname dan DX Rating.\n` +
            `• *.recent* (/*.rc*) : Tampilkan 5 riwayat bermain terbaru.\n` +
            `• *.recent page [1-5]* (/*.recent p [1-5]*) : Navigasi riwayat.\n` +
            `• *.recent [1-25]* : Tampilkan detail rincian skor riwayat.\n` +
            `• *.top* (/*.b50*) : Tampilkan Best 15 (PRiSM) & total rating B50.\n` +
            `• *.top old [halaman]* : Tampilkan Best 35 lagu lama (halaman 1/2).\n` +
            `• *.top refresh* : Perbarui paksa data Best 50 dari SEGA.\n` +
            `• *.ping* : Cek responsivitas bot.\n` +
            `• *.help* (/*.menu*) : Tampilkan menu bantuan.\n` +
            `_Catatan: Pemeliharaan SEGA berlangsung setiap hari pukul 03:00 - 06:00 WITA._`;

        await sock.sendMessage(from, { text: helpText });
    }
};
