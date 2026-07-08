const fs = require('fs');
const path = require('path');

const dataDir = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.join(__dirname, '..');

function ensureDataDir() {
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }
}

function dataPath(fileName) {
    ensureDataDir();
    return path.join(dataDir, fileName);
}

module.exports = {
    dataDir,
    dataPath,
    ensureDataDir
};
