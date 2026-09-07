// sRGB <-> linear. The viewport uses display colours; glTF, three.js and Blender-style MTL use linear.

const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));

export function srgbToLinear(color) {
    if (!Array.isArray(color) || color.length < 3) return null;
    return color.slice(0, 3).map((v) => {
        const x = clamp01(v);
        return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    });
}

export function linearToSrgb(color) {
    if (!Array.isArray(color) || color.length < 3) return null;
    return color.slice(0, 3).map((v) => {
        const x = clamp01(v);
        return x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055;
    });
}

/** Kd of the first material in an MTL file, as written, or null. */
export function firstMtlKd(mtlText) {
    if (typeof mtlText !== "string") return null;
    const m = mtlText.match(/^\s*Kd\s+([-+.\deE]+)\s+([-+.\deE]+)\s+([-+.\deE]+)/m);
    if (!m) return null;
    const rgb = [Number(m[1]), Number(m[2]), Number(m[3])];
    return rgb.every(Number.isFinite) ? rgb : null;
}

/** OBJ base colour from the companion MTL; Kd is read as linear (Blender convention). */
export async function baseColorFromMtlCompanions(companionFiles) {
    if (!companionFiles || typeof companionFiles.values !== "function") return null;
    for (const file of companionFiles.values()) {
        if (!file || !/\.mtl$/i.test(file.name || "")) continue;
        try {
            const kd = firstMtlKd(await file.text());
            if (kd) return linearToSrgb(kd);
        } catch {
            return null;
        }
    }
    return null;
}
