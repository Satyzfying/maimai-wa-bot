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

function writeJsonAtomic(filePath, data) {
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmpPath, filePath);
}

module.exports = {
    dataDir,
    dataPath,
    ensureDataDir,
    writeJsonAtomic
};
