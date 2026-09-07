/**
 * Pure mesh-import selection logic: which file is the mesh, which companions
 * (textures/.bin/.mtl) come along, and what the import budgets allow.
 *
 * Files are fully read and parsed in the browser, so oversized selections are
 * rejected before any decode rather than risking a frozen tab.
 * DOM-free on purpose: unit-tested with plain {name, size} objects.
 */

export const MAX_MESH_FILE_BYTES = 256 * 1024 * 1024;
export const MAX_COMPANION_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_COMPANION_FILES = 64;
export const MAX_TOTAL_IMPORT_BYTES = 512 * 1024 * 1024;

const COMPANION_IMAGE_RE = /\.(png|jpg|jpeg|bmp|webp|gif)$/i;
const MESH_FILE_RE = /\.(obj|fbx|glb|gltf)$/i;

export function formatMiB(bytes) {
    return `${Math.round(bytes / (1024 * 1024))} MiB`;
}

export function normalizeImportPath(raw) {
    let value = String(raw ?? "").trim();
    if (!value) return "";
    try {
        value = decodeURIComponent(value);
    } catch {
        /* retain undecoded input */
    }
    value = value.replace(/\\/g, "/");
    if (value.startsWith("file://")) {
        try {
            value = new URL(value).pathname || value;
        } catch {
            value = value.replace(/^file:\/*/i, "");
        }
    }
    return value.replace(/^[a-zA-Z]:\//, "/").replace(/^\/*/, "").toLowerCase();
}

/** Resolve exact/suffix paths first; ambiguous duplicate basenames are rejected. */
export function resolveCompanionFile(fileMap, rawUrl) {
    const normalized = normalizeImportPath(rawUrl);
    if (!normalized || !fileMap) return null;
    let best = null;
    let bestLength = -1;
    if (normalized.includes("/")) {
        for (const [key, file] of fileMap) {
            const candidate = normalizeImportPath(key);
            if (
                candidate.includes("/") &&
                (normalized === candidate || normalized.endsWith(`/${candidate}`)) &&
                candidate.length > bestLength
            ) {
                best = file;
                bestLength = candidate.length;
            }
        }
    }
    if (best) return best;

    const basename = normalized.split("/").pop();
    const matches = new Set();
    for (const [key, file] of fileMap) {
        if (normalizeImportPath(key).split("/").pop() === basename) matches.add(file);
    }
    if (matches.size === 1) return matches.values().next().value;
    if (matches.size > 1) return null;

    // Exporters often rename a texture set without updating the paths embedded
    // in the mesh file (for example Diffuse -> BaseColor). Resolve only when the
    // semantic channel and UDIM tile together identify exactly one supplied
    // file; anything ambiguous stays rejected.
    const textureRole = (name) => {
        if (/normal|nrm/i.test(name)) return "normal";
        if (/metallic|metalness/i.test(name)) return "metallic";
        if (/roughness|rough/i.test(name)) return "roughness";
        if (/emissive|emission/i.test(name)) return "emissive";
        if (/diffuse|albedo|basecolor|base_color/i.test(name)) return "color";
        return null;
    };
    const udim = basename.match(/(?:^|[._-])(1\d{3})(?=[._-]|$)/)?.[1] || null;
    const role = textureRole(basename);
    if (!udim || !role) return null;
    const semanticMatches = new Set();
    for (const file of new Set(fileMap.values())) {
        const candidate = normalizeImportPath(file.name).split("/").pop();
        const candidateUdim = candidate.match(/(?:^|[._-])(1\d{3})(?=[._-]|$)/)?.[1] || null;
        if (candidateUdim === udim && textureRole(candidate) === role) semanticMatches.add(file);
    }
    return semanticMatches.size === 1 ? semanticMatches.values().next().value : null;
}

function addCompanionFileKeys(map, file) {
    const nameL = file.name.toLowerCase();
    map.set(nameL, file);
    const rel = (file.webkitRelativePath || "").replace(/\\/g, "/").toLowerCase();
    if (rel) {
        map.set(rel, file);
        const segs = rel.split("/");
        for (let i = 0; i < segs.length; i++) {
            const tail = segs.slice(i).join("/");
            if (tail) map.set(tail, file);
        }
    }
}

/**
 * Classify a user file selection into a mesh + companion map.
 *
 * @param {Array<{name: string, size: number, webkitRelativePath?: string}>} files
 * @returns {{
 *   error?: "no-mesh" | "multiple-meshes" | "mesh-too-large",
 *   meshFile?: object,
 *   kind?: "obj" | "fbx" | "glb" | "gltf",
 *   companionFiles?: Map<string, object>,
 *   skippedCompanions?: number
 * }}
 */
export function selectMeshImport(files) {
    if (!files || files.length === 0) {
        return { error: "no-mesh" };
    }
    const lower = (f) => f.name.toLowerCase();
    const meshFiles = files.filter((file) => MESH_FILE_RE.test(file.name));
    if (meshFiles.length === 0) {
        return { error: "no-mesh" };
    }
    if (meshFiles.length > 1) {
        return { error: "multiple-meshes", meshFiles };
    }
    const meshFile = meshFiles[0];
    if (meshFile.size > MAX_MESH_FILE_BYTES) {
        return { error: "mesh-too-large", meshFile };
    }

    const name = lower(meshFile);
    const kind = name.endsWith(".glb")
        ? "glb"
        : name.endsWith(".gltf")
            ? "gltf"
            : name.endsWith(".fbx")
                ? "fbx"
                : "obj";

    const companionFiles = new Map();
    let totalBytes = meshFile.size;
    let companionCount = 0;
    let skippedCompanions = 0;
    for (const f of files) {
        if (f === meshFile) continue;
        const isCompanion =
            COMPANION_IMAGE_RE.test(f.name) ||
            /\.bin$/i.test(f.name) ||
            /\.mtl$/i.test(f.name);
        if (!isCompanion) continue;
        if (
            f.size > MAX_COMPANION_FILE_BYTES ||
            companionCount >= MAX_COMPANION_FILES ||
            totalBytes + f.size > MAX_TOTAL_IMPORT_BYTES
        ) {
            skippedCompanions++;
            continue;
        }
        totalBytes += f.size;
        companionCount++;
        addCompanionFileKeys(companionFiles, f);
    }
    return { meshFile, kind, companionFiles, skippedCompanions };
}
