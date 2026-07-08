/**
 * Rating calculation utilities for maimai DX.
 * 
 * Formula: rating = floor(constant × factor × min(achievement, 100.5))
 * Source: https://maimai.wiki/wiki/Score (confirmed against calculator screenshot)
 */

/**
 * Returns the rank multiplier factor for a given achievement percentage.
 * @param {number} achievement Achievement rate as a decimal percentage (e.g. 100.5, not 1.005)
 * @returns {number} Factor
 */
function getRankFactor(achievement) {
    if (achievement >= 100.5) return 0.224; // SSS+
    if (achievement >= 100.0) return 0.216; // SSS
    if (achievement >= 99.5)  return 0.211; // SS+
    if (achievement >= 99.0)  return 0.208; // SS
    if (achievement >= 98.0)  return 0.203; // S+
    if (achievement >= 97.0)  return 0.200; // S
    if (achievement >= 94.0)  return 0.168; // AAA
    if (achievement >= 90.0)  return 0.152; // AA
    if (achievement >= 80.0)  return 0.136; // A
    if (achievement >= 75.0)  return 0.128; // BBB
    if (achievement >= 70.0)  return 0.112; // BB
    if (achievement >= 60.0)  return 0.096; // B
    if (achievement >= 50.0)  return 0.080; // C
    return 0.000;                           // D
}

/**
 * Returns the rank label string for a given achievement percentage.
 * @param {number} achievement
 * @returns {string}
 */
function getRankName(achievement) {
    if (achievement >= 100.5) return 'SSS+';
    if (achievement >= 100.0) return 'SSS';
    if (achievement >= 99.5)  return 'SS+';
    if (achievement >= 99.0)  return 'SS';
    if (achievement >= 98.0)  return 'S+';
    if (achievement >= 97.0)  return 'S';
    if (achievement >= 94.0)  return 'AAA';
    if (achievement >= 90.0)  return 'AA';
    if (achievement >= 80.0)  return 'A';
    if (achievement >= 75.0)  return 'BBB';
    if (achievement >= 70.0)  return 'BB';
    if (achievement >= 60.0)  return 'B';
    if (achievement >= 50.0)  return 'C';
    return 'D';
}

/**
 * Calculates the rating contribution of a single song play.
 * @param {number} constant Chart difficulty constant (e.g. 14.3)
 * @param {number} achievement Achievement percentage (e.g. 100.2359)
 * @returns {number} Integer rating value
 */
function calcSongRating(constant, achievement) {
    if (!constant || !achievement || achievement <= 0) return 0;
    const factor = getRankFactor(achievement);
    const ach = Math.min(achievement, 100.5);
    return Math.floor(constant * factor * ach);
}

module.exports = { getRankFactor, getRankName, calcSongRating };
