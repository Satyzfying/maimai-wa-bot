const fs = require('fs');
const { dataPath } = require('./paths');

const cachePath = dataPath('music_data_v2.json');
let musicCache = null;

function transformZetarakuToDivingFish(data) {
    if (!data || !data.songs) return [];
    
    const diffMap = {
        'basic': 0,
        'advanced': 1,
        'expert': 2,
        'master': 3,
        'remaster': 4
    };
    
    return data.songs.map(song => {
        if (!song.sheets || song.sheets.length === 0) return null;
        
        const type = song.sheets[0].type.toUpperCase() === 'DX' ? 'DX' : 'SD';
        const ds = [null, null, null, null, null];
        const level = [null, null, null, null, null];
        
        song.sheets.forEach(sheet => {
            const idx = diffMap[sheet.difficulty.toLowerCase()];
            if (idx !== undefined) {
                ds[idx] = sheet.internalLevelValue || sheet.levelValue || null;
                level[idx] = sheet.level || null;
            }
        });
        
        return {
            title: song.title,
            type: type,
            ds: ds,
            level: level,
            version: song.version
        };
    }).filter(Boolean);
}

async function loadMusicData() {
    if (musicCache) return musicCache;

    if (fs.existsSync(cachePath)) {
        try {
            const raw = fs.readFileSync(cachePath, 'utf-8');
            musicCache = JSON.parse(raw);
            console.log(`[MusicLoader] Loaded cache from: ${cachePath} | Songs count: ${musicCache.length}`);
            return musicCache;
        } catch (e) {
            console.error('[MusicLoader] Error reading cache file, redownloading...', e);
        }
    }

    console.log('[MusicLoader] Downloading music data from zetaraku CloudFront API...');
    try {
        const response = await fetch('https://dp4p6x0xfi5o9.cloudfront.net/maimai/data.json');
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const data = await response.json();
        const transformed = transformZetarakuToDivingFish(data);
        fs.writeFileSync(cachePath, JSON.stringify(transformed, null, 2), 'utf-8');
        musicCache = transformed;
        console.log(`[MusicLoader] Music data downloaded, transformed and cached successfully. Total songs: ${transformed.length}`);
        return musicCache;
    } catch (err) {
        console.error('[MusicLoader] Failed to download music data:', err);
        return [];
    }
}

/**
 * Mendapatkan konstanta (ds) untuk suatu lagu berdasarkan judul, tipe, dan tingkat kesulitan.
 * @param {string} title Judul lagu
 * @param {string} type Tipe lagu ('SD' / standard atau 'DX' / deluxe)
 * @param {string} difficulty Tingkat kesulitan ('basic', 'advanced', 'expert', 'master', 'remaster')
 * @returns {number|null} Konstanta lagu, atau null jika tidak ditemukan
 */
async function getSongConstant(title, type, difficulty) {
    const songs = await loadMusicData();
    const cleanTitle = title.trim().toLowerCase();
    
    // Konversi tipe dari website (music_standard.png/music_dx.png) ke format API (SD/DX)
    const apiType = type.toUpperCase() === 'DX' ? 'DX' : 'SD';

    // Cari lagu yang cocok
    const song = songs.find(s => {
        const matchTitle = s.title.trim().toLowerCase() === cleanTitle;
        return matchTitle && s.type === apiType;
    });

    if (!song) {
        // Fallback pencocokan judul longgar (jika ada spasi/tanda petik yang berbeda)
        const looseSong = songs.find(s => {
            const normalizedS = s.title.replace(/[\s\“\”\’\']/g, '').toLowerCase();
            const normalizedT = cleanTitle.replace(/[\s\“\”\’\']/g, '').toLowerCase();
            return normalizedS === normalizedT && s.type === apiType;
        });
        if (looseSong) {
            return extractConstant(looseSong, difficulty);
        }
        return null;
    }

    return extractConstant(song, difficulty);
}

function extractConstant(song, difficulty) {
    // difficulty index mapping
    const diffMap = {
        'basic': 0,
        'advanced': 1,
        'expert': 2,
        'master': 3,
        'remaster': 4
    };
    const idx = diffMap[difficulty.toLowerCase()];
    if (idx !== undefined && song.ds && song.ds[idx]) {
        return song.ds[idx];
    }
    return null;
}

/**
 * Returns the version name of the most recently added version in the dataset.
 * Songs with this version are considered "new" for the B15 pool.
 * @returns {Promise<string>}
 */
async function getCurrentVersion() {
    const songs = await loadMusicData();
    if (!songs.length) return '';
    const uniqueVersions = [...new Set(songs.map(s => s.version).filter(Boolean))];
    return uniqueVersions[uniqueVersions.length - 1] || '';
}

/**
 * Looks up a song entry in the dataset and returns it with all metadata.
 * @param {string} title
 * @param {string} type 'DX' or 'SD'
 * @returns {Promise<Object|null>}
 */
async function findSong(title, type) {
    const songs = await loadMusicData();
    console.log(`[MusicLoader] findSong called. Songs array size: ${songs.length} | Querying: "${title}" (Type: ${type})`);
    const cleanTitle = title.trim().toLowerCase();
    const apiType = type.toUpperCase() === 'DX' ? 'DX' : 'SD';

    let song = songs.find(s => s.title.trim().toLowerCase() === cleanTitle && s.type === apiType);
    if (!song) {
        song = songs.find(s => {
            const nS = s.title.replace(/[\s""'']/g, '').toLowerCase();
            const nT = cleanTitle.replace(/[\s""'']/g, '').toLowerCase();
            return nS === nT && s.type === apiType;
        });
    }
    return song || null;
}

module.exports = { loadMusicData, getSongConstant, getCurrentVersion, findSong };
