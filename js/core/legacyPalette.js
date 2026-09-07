// Swatch values saved before the rigs were calibrated, mapped to the swatch that looks the same now.
const LEGACY_TO_CURRENT = [
    [[0.70, 0.24, 0.17], [0.38, 0.08, 0.02]],
    [[0.55, 0.55, 0.55], [0.29, 0.29, 0.29]],
    [[0.74, 0.56, 0.42], [0.40, 0.30, 0.21]],
    [[0.45, 0.85, 0.60], [0.18, 0.47, 0.32]],
    [[0.80, 0.78, 0.74], [0.44, 0.43, 0.40]],
    [[0.31, 0.30, 0.33], [0.14, 0.13, 0.15]],
    [[0.88, 0.84, 0.76], [0.49, 0.46, 0.42]],
    [[0.59, 0.44, 0.30], [0.31, 0.22, 0.13]]
];

export function migrateLegacyBaseColor(color) {
    if (!Array.isArray(color) || color.length < 3) return color;
    for (const [legacy, current] of LEGACY_TO_CURRENT) {
        if (legacy.every((v, i) => Math.abs(v - color[i]) < 0.005)) return current.slice();
    }
    return color;
}
