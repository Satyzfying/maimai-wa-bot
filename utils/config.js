const fs = require('fs');
const path = require('path');

function readConfig() {
    const configPath = path.join(__dirname, '..', 'config.json');
    if (!fs.existsSync(configPath)) {
        return {};
    }

    try {
        return JSON.parse(fs.readFileSync(configPath, 'utf-8') || '{}');
    } catch (err) {
        console.error('[Config] Error membaca config.json:', err.message);
        return {};
    }
}

function getPublicUrl() {
    const config = readConfig();
    return process.env.PUBLIC_URL || process.env.ZEABUR_PUBLIC_URL || config.publicUrl || '';
}

module.exports = {
    readConfig,
    getPublicUrl
};
