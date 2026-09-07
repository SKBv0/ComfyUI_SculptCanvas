import { LoadingManager } from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { MTLLoader } from "three/examples/jsm/loaders/MTLLoader.js";
import { normalizeVerticesToUnitSphere } from "../js/engine/meshNormalize.js";
import { resolveCompanionFile } from "../js/core/meshImportSelection.js";

const FBX_BINARY_MAGIC = "Kaydara FBX Binary";
const FBX_GLOBAL_SETTINGS_SCAN_BYTES = 1024 * 1024;
const TEXTURE_LOAD_TIMEOUT_MS = 60000;

/**
 * Loader.parse() can return before ImageLoader has assigned texture.image, and
 * an unassigned image is indistinguishable from a finished one. Waiting on the
 * LoadingManager's own request lifecycle instead of on the texture objects is
 * what keeps the caller from falling back to an arbitrary folder texture.
 */
export function createLoadingManagerBarrier(
    manager,
    timeoutMs = TEXTURE_LOAD_TIMEOUT_MS
) {
    let started = false;
    let completed = false;
    let resolveLoad;
    const loaded = new Promise((resolve) => {
        resolveLoad = resolve;
    });
    const previousStart = manager.onStart;
    const previousLoad = manager.onLoad;

    manager.onStart = (...args) => {
        started = true;
        if (typeof previousStart === "function") previousStart(...args);
    };
    manager.onLoad = (...args) => {
        completed = true;
        if (typeof previousLoad === "function") previousLoad(...args);
        resolveLoad();
    };

    return {
        async wait() {
            if (!started || completed) return;
            let timer = null;
            try {
                await Promise.race([
                    loaded,
                    new Promise((_, reject) => {
                        timer = setTimeout(() => {
                            reject(new Error("texture loading timed out"));
                        }, Math.max(1, timeoutMs));
                    })
                ]);
            } finally {
                if (timer !== null) clearTimeout(timer);
            }
        },
        restore() {
            manager.onStart = previousStart;
            manager.onLoad = previousLoad;
        }
    };
}

function findAscii(bytes, text, start = 0) {
    outer: for (let i = start; i <= bytes.length - text.length; i++) {
        for (let j = 0; j < text.length; j++) {
            if (bytes[i + j] !== text.charCodeAt(j)) continue outer;
        }
        return i;
    }
    return -1;
}

function readBinaryFbxIntegerProperty(bytes, propertyName) {
    let match = findAscii(bytes, propertyName);
    while (match >= 0) {
        // Binary FBX strings are encoded as: S, uint32 length, bytes.
        const prefix = match - 5;
        if (prefix >= 0 && bytes[prefix] === 0x53) {
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            if (view.getUint32(prefix + 1, true) === propertyName.length) {
                let cursor = match + propertyName.length;
                let valid = true;
                // Skip the P-node type, label and flags strings.
                for (let i = 0; i < 3; i++) {
                    if (cursor + 5 > bytes.length || bytes[cursor] !== 0x53) {
                        valid = false;
                        break;
                    }
                    const length = view.getUint32(cursor + 1, true);
                    cursor += 5 + length;
                }
                if (valid && cursor + 5 <= bytes.length && bytes[cursor] === 0x49) {
                    return view.getInt32(cursor + 1, true);
                }
            }
        }
        match = findAscii(bytes, propertyName, match + propertyName.length);
    }
    return null;
}

/** Read only the global up-axis metadata needed to orient a static FBX mesh. */
export function readFbxAxisSystem(arrayBuffer) {
    if (!(arrayBuffer instanceof ArrayBuffer) || arrayBuffer.byteLength === 0) return null;
    const allBytes = new Uint8Array(arrayBuffer);
    const bytes = allBytes.subarray(0, FBX_GLOBAL_SETTINGS_SCAN_BYTES);
    const magicLength = Math.min(FBX_BINARY_MAGIC.length, bytes.length);
    let magic = "";
    for (let i = 0; i < magicLength; i++) magic += String.fromCharCode(bytes[i]);

    if (magic === FBX_BINARY_MAGIC) {
        const upAxis = readBinaryFbxIntegerProperty(bytes, "UpAxis");
        const upAxisSign = readBinaryFbxIntegerProperty(bytes, "UpAxisSign");
        return Number.isInteger(upAxis)
            ? { upAxis, upAxisSign: upAxisSign === -1 ? -1 : 1 }
            : null;
    }

    // ASCII FBX files are uncommon but cheap to support here as well.
    const text = new TextDecoder().decode(bytes);
    const readAsciiProperty = (name) => {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const match = text.match(new RegExp(`P:\\s*"${escaped}"[^\\r\\n]*?,\\s*(-?\\d+)\\s*$`, "m"));
        return match ? Number.parseInt(match[1], 10) : null;
    };
    const upAxis = readAsciiProperty("UpAxis");
    const upAxisSign = readAsciiProperty("UpAxisSign");
    return Number.isInteger(upAxis)
        ? { upAxis, upAxisSign: upAxisSign === -1 ? -1 : 1 }
        : null;
}

/** Convert FBX X/Z-up authoring coordinates to the viewport's Y-up world. */
export function orientFbxRootToYUp(root, axisSystem) {
    if (!root || !axisSystem) return false;
    const sign = axisSystem.upAxisSign === -1 ? -1 : 1;
    if (axisSystem.upAxis === 2) {
        root.rotateX(-sign * Math.PI / 2);
        return true;
    }
    if (axisSystem.upAxis === 0) {
        root.rotateZ(sign * Math.PI / 2);
        return true;
    }
    if (axisSystem.upAxis === 1 && sign === -1) {
        root.rotateX(Math.PI);
        return true;
    }
    return false;
}

/**
 * Maps file paths to user-provided File blobs (multi-select or folder pick).
 * Works for both FBX textures and GLTF companion files (.bin, images).
 * @param {Map<string, File>} fileMap keys: basename, relative path, path suffixes
 */
function createCompanionFileLoadingManager(fileMap) {
    const manager = new LoadingManager();
    const blobByFile = new Map();
    const getBlobUrl = (file) => {
        if (!blobByFile.has(file)) {
            blobByFile.set(file, URL.createObjectURL(file));
        }
        return blobByFile.get(file);
    };
    // Loaded images keep their decoded pixels; revoking after the parse
    // completes releases the blob memory held by the browser.
    manager.sculptRevokeBlobUrls = () => {
        for (const url of blobByFile.values()) {
            try {
                URL.revokeObjectURL(url);
            } catch {
                /* ignore */
            }
        }
        blobByFile.clear();
    };
    manager.setURLModifier((url) => {
        const file = resolveCompanionFile(fileMap, url);
        if (file) return getBlobUrl(file);
        return url;
    });
    return manager;
}

const DIFFUSE_MAP_KEYS = ["map", "emissiveMap", "lightMap", "specularMap"];

function isRenderableDiffuseImage(img) {
    if (!img) return false;
    if (typeof ImageBitmap !== "undefined" && img instanceof ImageBitmap) {
        return img.width > 0;
    }
    if (img.data && typeof img.width === "number") {
        return img.width > 0;
    }
    if (img.tagName === "IMG") {
        return img.complete && img.naturalWidth > 0;
    }
    if (img.tagName === "CANVAS") {
        return img.width > 0;
    }
    if (img.tagName === "VIDEO") {
        return img.videoWidth > 0;
    }
    if (typeof img.width === "number" && img.width > 0 && !img.tagName) {
        return true;
    }
    return false;
}

/**
 * @param {import("three").Material} mat a single material, never an array
 */
function pickDiffuseImageFromSingleMaterial(mat) {
    if (!mat) return null;
    for (const key of DIFFUSE_MAP_KEYS) {
        const t = mat[key];
        if (t && t.isTexture && isRenderableDiffuseImage(t.image)) {
            return t.image;
        }
    }
    return null;
}

/** Accepts a material or a material array; returns the first diffuse image. */
function pickDiffuseImageFromMaterial(material) {
    if (!material) return null;
    const mats = Array.isArray(material) ? material : [material];
    for (const m of mats) {
        const img = pickDiffuseImageFromSingleMaterial(m);
        if (img) return img;
    }
    return null;
}

/** Three: map.channel 0 -> uv, 1 -> uv1, 2 -> uv2 (WebGLPrograms.getChannel). FBXLoader uses the same names. */
function uvAttributeNameForChannel(ch) {
    const c = typeof ch === "number" && ch >= 0 ? Math.floor(ch) : 0;
    return c === 0 ? "uv" : `uv${c}`;
}

function uvAttributeLooksUsable(attr, vertexCount) {
    if (!attr || attr.itemSize < 2 || attr.count !== vertexCount) return false;
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    const step = Math.max(1, Math.floor(attr.count / 1024));
    for (let i = 0; i < attr.count; i += step) {
        const u = attr.getX(i);
        const v = attr.getY(i);
        minU = Math.min(minU, u);
        maxU = Math.max(maxU, u);
        minV = Math.min(minV, v);
        maxV = Math.max(maxV, v);
    }
    const range = Math.max(maxU - minU, maxV - minV);
    return Number.isFinite(range) && range > 1e-5;
}

function pickDiffuseTextureChannelFromMaterial(material) {
    if (!material) return 0;
    const mats = Array.isArray(material) ? material : [material];
    for (const m of mats) {
        if (!m) continue;
        for (const key of DIFFUSE_MAP_KEYS) {
            const t = m[key];
            if (t && t.isTexture && isRenderableDiffuseImage(t.image)) {
                return typeof t.channel === "number" ? t.channel : 0;
            }
        }
    }
    for (const m of mats) {
        if (!m) continue;
        for (const key of DIFFUSE_MAP_KEYS) {
            const t = m[key];
            if (t && t.isTexture && typeof t.channel === "number") {
                return t.channel;
            }
        }
    }
    return 0;
}

/**
 * @param {import("three").BufferGeometry} geom
 * @param {import("three").Material | import("three").Material[]} material
 */
function resolveUvAttribute(geom, material) {
    const pos = geom.attributes.position;
    const vc = pos ? pos.count : 0;
    if (!vc) return null;

    const ch = pickDiffuseTextureChannelFromMaterial(material);
    const preferred = uvAttributeNameForChannel(ch);
    const tryNames = [...new Set([preferred, "uv", "uv1", "uv2", "uv3"])];

    for (const name of tryNames) {
        const attr = geom.attributes[name];
        if (uvAttributeLooksUsable(attr, vc)) return attr;
    }
    for (const name of tryNames) {
        const attr = geom.attributes[name];
        if (attr && attr.itemSize >= 2 && attr.count === vc) return attr;
    }
    return null;
}

/** Rank a texture filename by how likely it is to be the diffuse/base color map. */
function scoreDiffuseFilename(name) {
    const n = name.toLowerCase();
    let score = 0;
    if (/normal|nrm|roughness|metallic|metalness|ao_map|ambient|opacity|opc|mask|height|disp|bump/i.test(n)) {
        score -= 45;
    }
    if (
        /diffuse|albedo|basecolor|base_color|colormap|diff\.|_diff|_d\.|^d[._-]|color\.|tex(?!coord)|texture_diff/i.test(
            n
        )
    ) {
        score += 55;
    }
    return score;
}

/**
 * Select a single unambiguous diffuse image for legacy files whose material
 * links could not be recovered. A folder containing several equally likely
 * BaseColor/Diffuse files is normally a UDIM or multi-material set; choosing
 * one of them would smear that image over the entire mesh.
 * @param {Map<string, File>} textureFiles
 */
export function selectFallbackDiffuseFile(textureFiles) {
    const seen = new Set();
    const files = [];
    for (const f of textureFiles.values()) {
        if (!seen.has(f) && /\.(png|jpg|jpeg|bmp|webp|gif)$/i.test(f.name)) {
            seen.add(f);
            files.push(f);
        }
    }
    if (!files.length) return null;
    files.sort((a, b) => scoreDiffuseFilename(b.name) - scoreDiffuseFilename(a.name) || a.name.localeCompare(b.name));
    const bestScore = scoreDiffuseFilename(files[0].name);
    const tiedBest = files.filter((file) => scoreDiffuseFilename(file.name) === bestScore);
    if (files.length > 1 && (bestScore <= 0 || tiedBest.length > 1)) return null;
    return files[0];
}

async function pickFallbackDiffuseFromFiles(textureFiles) {
    const file = selectFallbackDiffuseFile(textureFiles);
    if (!file) return null;

    try {
        if (typeof createImageBitmap === "function") {
            const bmp = await createImageBitmap(file);
            if (bmp.width > 0) return bmp;
            bmp.close?.();
            return null;
        }
        const o = URL.createObjectURL(file);
        try {
            const img = new Image();
            await new Promise((resolve, reject) => {
                img.onload = () => resolve();
                img.onerror = () => reject(new Error("img"));
                img.src = o;
            });
            URL.revokeObjectURL(o);
            if (img.naturalWidth > 0) return img;
        } catch {
            URL.revokeObjectURL(o);
        }
    } catch {
        /* leave the mesh untextured instead of applying a broken fallback */
    }
    return null;
}

function collectTexturesFromMaterial(m) {
    const out = [];
    if (!m) return out;
    const keys = [
        "map",
        "emissiveMap",
        "aoMap",
        "lightMap",
        "bumpMap",
        "normalMap",
        "roughnessMap",
        "metalnessMap",
        "alphaMap"
    ];
    for (const key of keys) {
        const t = m[key];
        if (t && t.isTexture) out.push(t);
    }
    return out;
}

function waitForTextureImage(tex) {
    if (!tex || !tex.isTexture) return Promise.resolve();
    const img = tex.image;
    if (!img) return Promise.resolve();
    if (typeof ImageBitmap !== "undefined" && img instanceof ImageBitmap) {
        return Promise.resolve();
    }
    if (img.data && typeof img.width === "number" && img.width > 0) {
        return Promise.resolve();
    }
    if (typeof img.width === "number" && img.width > 0 && !img.tagName) {
        return Promise.resolve();
    }
    if (img.tagName === "IMG") {
        if (img.complete && img.naturalWidth > 0) return Promise.resolve();
        return new Promise((resolve) => {
            const finish = () => {
                img.removeEventListener("load", finish);
                img.removeEventListener("error", finish);
                resolve();
            };
            img.addEventListener("load", finish, { once: true });
            img.addEventListener("error", finish, { once: true });
        });
    }
    if (img.tagName === "VIDEO") {
        if (img.videoWidth > 0) return Promise.resolve();
        return new Promise((resolve) => {
            const finish = () => {
                img.removeEventListener("loadeddata", finish);
                img.removeEventListener("error", finish);
                resolve();
            };
            img.addEventListener("loadeddata", finish, { once: true });
            img.addEventListener("error", finish, { once: true });
        });
    }
    if (img.tagName === "CANVAS" && img.width > 0) return Promise.resolve();
    return Promise.resolve();
}

async function waitForTextureImagesReady(root) {
    const list = [];
    root.traverse((child) => {
        if (!child.material) return;
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        for (const m of mats) {
            list.push(...collectTexturesFromMaterial(m));
        }
    });
    const seen = new Set();
    const unique = [];
    for (const t of list) {
        if (!seen.has(t)) {
            seen.add(t);
            unique.push(t);
        }
    }
    await Promise.all(unique.map((t) => waitForTextureImage(t)));
}

/** Width/height of any image-like source: ImageBitmap, img, canvas, or video. */
function getImageSize(img) {
    if (!img) return { w: 0, h: 0 };
    if (typeof img.width === "number" && typeof img.height === "number") {
        return { w: img.width, h: img.height };
    }
    if (img.tagName === "IMG") {
        return { w: img.naturalWidth || 0, h: img.naturalHeight || 0 };
    }
    if (img.tagName === "VIDEO") {
        return { w: img.videoWidth || 0, h: img.videoHeight || 0 };
    }
    return { w: 0, h: 0 };
}

/**
 * Build a texture atlas from multiple diffuse images and remap UV coordinates.
 * Each unique texture gets a tile in the atlas; UVs are scaled/offset to fit.
 * @param {Array<{image: any, uvIndices: number[]}>} segments
 * @param {number[]} uvs - flat UV array [u0,v0,u1,v1,...] to be modified in-place
 * @returns {HTMLCanvasElement | null} atlas canvas, or null if unable to build
 */
function buildTextureAtlas(segments, uvs) {
    if (typeof document === "undefined") return null;

    const uniqueImages = [];
    const imageToTile = new Map();
    for (const seg of segments) {
        if (!imageToTile.has(seg.image)) {
            imageToTile.set(seg.image, uniqueImages.length);
            uniqueImages.push(seg.image);
        }
    }
    if (uniqueImages.length <= 1) return null;

    // Roughly square grid, so neither dimension runs away with many textures.
    const count = uniqueImages.length;
    const cols = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / cols);

    // Every tile takes the largest source dimension, capped so one oversized
    // texture cannot blow up the whole atlas.
    const MAX_TILE = 2048;
    let tileW = 256;
    let tileH = 256;
    for (const img of uniqueImages) {
        const { w, h } = getImageSize(img);
        if (w > tileW) tileW = Math.min(w, MAX_TILE);
        if (h > tileH) tileH = Math.min(h, MAX_TILE);
    }

    const atlasW = cols * tileW;
    const atlasH = rows * tileH;

    // Cap total atlas size: 4096x4096 RGBA is ~64 MiB of raw pixel memory,
    // a sane budget for a viewport texture (8192 would need ~256 MiB).
    const MAX_ATLAS = 4096;
    if (atlasW > MAX_ATLAS || atlasH > MAX_ATLAS) {
        const scale = Math.min(MAX_ATLAS / atlasW, MAX_ATLAS / atlasH);
        tileW = Math.floor(tileW * scale);
        tileH = Math.floor(tileH * scale);
    }

    const finalW = cols * tileW;
    const finalH = rows * tileH;

    const canvas = document.createElement("canvas");
    canvas.width = finalW;
    canvas.height = finalH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    for (let i = 0; i < uniqueImages.length; i++) {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const dx = col * tileW;
        const dy = row * tileH;
        try {
            ctx.drawImage(uniqueImages[i], dx, dy, tileW, tileH);
        } catch {
            // A tainted or undecodable source leaves a neutral tile rather than
            // shifting every later tile's index.
            ctx.fillStyle = "#808080";
            ctx.fillRect(dx, dy, tileW, tileH);
        }
    }

    // Scale each segment's UVs into its tile. A vertex shared by two segments
    // must only be remapped once, or the second pass squeezes it again.
    const remapped = new Set();
    for (const seg of segments) {
        const tileIdx = imageToTile.get(seg.image);
        const col = tileIdx % cols;
        const row = Math.floor(tileIdx / cols);
        const uOffset = col / cols;
        // The renderer uploads DOM/canvas images with UNPACK_FLIP_Y_WEBGL.
        // Canvas row 0 therefore occupies the highest V band in WebGL.
        const vOffset = (rows - 1 - row) / rows;
        const uScale = 1 / cols;
        const vScale = 1 / rows;

        let minU = Infinity, minV = Infinity;
        let maxU = -Infinity, maxV = -Infinity;
        for (const vertIdx of seg.uvIndices) {
            const idx = vertIdx * 2;
            const u = uvs[idx];
            const v = uvs[idx + 1];
            if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
            minU = Math.min(minU, u);
            minV = Math.min(minV, v);
            maxU = Math.max(maxU, u);
            maxV = Math.max(maxV, v);
        }
        // UDIM tiles store local 0..1 coordinates offset by integer U/V.
        // Remove that tile offset before packing the images into our atlas.
        const uOrigin = minU < -1e-5 || maxU > 1.00001 ? Math.floor(minU + 1e-5) : 0;
        const vOrigin = minV < -1e-5 || maxV > 1.00001 ? Math.floor(minV + 1e-5) : 0;

        for (const vertIdx of seg.uvIndices) {
            if (remapped.has(vertIdx)) continue;
            remapped.add(vertIdx);
            const idx = vertIdx * 2;
            const u = uvs[idx];
            const v = uvs[idx + 1];
            // Clamp before remapping so out-of-range UVs cannot sample a
            // neighboring tile.
            const cu = Math.max(0, Math.min(1, u - uOrigin));
            const cv = Math.max(0, Math.min(1, v - vOrigin));
            uvs[idx] = uOffset + cu * uScale;
            uvs[idx + 1] = vOffset + cv * vScale;
        }
    }

    return canvas;
}

/** Record a segment's diffuse image and note when more than one is in play. */
function registerTextureSegment(diffuseImg, uvIndices, textureSegments, state) {
    if (!diffuseImg || !isRenderableDiffuseImage(diffuseImg)) return;
    if (state.singleDiffuse === null) {
        state.singleDiffuse = diffuseImg;
    } else if (state.singleDiffuse !== diffuseImg) {
        state.hasMultipleTextures = true;
    }
    textureSegments.push({ image: diffuseImg, uvIndices });
}

/**
 * Re-index triangle-corner geometry emitted by loaders such as FBXLoader.
 * Many FBX files are returned as non-indexed buffers (one position per
 * triangle corner), so applying the sculpt vertex budget before compaction
 * rejects meshes whose actual editable topology is much smaller. Position +
 * UV is the identity: UV seams remain split, while repeated corners collapse.
 * Object ownership prevents separate overlapping mesh objects being welded.
 */
export function compactTriangleGeometry(vertices, faces, uvs, vertexOwners = null) {
    const vertexCount = Math.floor(vertices.length / 3);
    const hasUvs = Array.isArray(uvs) && uvs.length === vertexCount * 2;
    const hasOwners = Array.isArray(vertexOwners) && vertexOwners.length === vertexCount;
    if (vertexCount === 0 || !Array.isArray(faces) || faces.length === 0) {
        return {
            vertices,
            faces,
            uvs: hasUvs ? uvs : [],
            vertexOwners: hasOwners ? vertexOwners : []
        };
    }

    const compactVertices = [];
    const compactFaces = [];
    const compactUvs = [];
    const compactOwners = [];
    const indexByCorner = new Map();
    const remap = (sourceIndex) => {
        const vi = sourceIndex * 3;
        const ui = sourceIndex * 2;
        const owner = hasOwners ? vertexOwners[sourceIndex] : 0;
        const key = hasUvs
            ? `${owner}|${Math.round(vertices[vi] * 1e7)}|${Math.round(vertices[vi + 1] * 1e7)}|${Math.round(vertices[vi + 2] * 1e7)}|${Math.round(uvs[ui] * 1e7)}|${Math.round(uvs[ui + 1] * 1e7)}`
            : `${owner}|${Math.round(vertices[vi] * 1e7)}|${Math.round(vertices[vi + 1] * 1e7)}|${Math.round(vertices[vi + 2] * 1e7)}`;
        const existing = indexByCorner.get(key);
        if (existing !== undefined) return existing;
        const target = compactVertices.length / 3;
        indexByCorner.set(key, target);
        compactVertices.push(vertices[vi], vertices[vi + 1], vertices[vi + 2]);
        if (hasUvs) compactUvs.push(uvs[ui], uvs[ui + 1]);
        if (hasOwners) compactOwners.push(owner);
        return target;
    };

    const triangleEnd = faces.length - (faces.length % 3);
    for (let i = 0; i < triangleEnd; i += 3) {
        const a = remap(faces[i]);
        const b = remap(faces[i + 1]);
        const c = remap(faces[i + 2]);
        if (a !== b && b !== c && c !== a) compactFaces.push(a, b, c);
    }
    return {
        vertices: compactVertices,
        faces: compactFaces,
        uvs: compactUvs,
        vertexOwners: compactOwners
    };
}

/**
 * @param {import("three").Object3D} root
 * @returns {{
 *   vertices: number[],
 *   faces: number[],
 *   uvs: number[],
 *   vertexOwners: number[],
 *   baseColorHint: number[] | null,
 *   diffuseImage: import("three").Texture["image"] | null
 * }}
 */
export function extractMeshGeometry(root) {
    const vertices = [];
    const faces = [];
    const uvs = [];
    const vertexOwners = [];
    let baseColorHint = null;
    let nextObjectOwner = 0;

    // Per-segment texture assignments, used to build an atlas if the mesh turns
    // out to carry more than one diffuse image.
    /** @type {Array<{image: any, uvIndices: number[]}>} */
    const textureSegments = [];
    const texState = { singleDiffuse: null, hasMultipleTextures: false };

    root.updateMatrixWorld(true);
    root.traverse((child) => {
        if (child.isInstancedMesh) {
            return;
        }
        if ((!child.isMesh && !child.isSkinnedMesh) || !child.geometry) {
            return;
        }
        if (baseColorHint === null && child.material) {
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            for (const m of mats) {
                if (m && m.color && typeof m.color.r === "number") {
                    const c = m.color;
                    baseColorHint = [c.r, c.g, c.b];
                    break;
                }
            }
        }

        const geom = child.geometry;
        if (!geom.isBufferGeometry) {
            return;
        }
        const pos = geom.attributes.position;
        if (!pos || pos.count < 3) {
            return;
        }
        const objectOwner = nextObjectOwner++;

        const uvAttr = resolveUvAttribute(geom, child.material);

        const e = child.matrixWorld.elements;
        const vertStart = vertices.length / 3;

        for (let i = 0; i < pos.count; i++) {
            const x = pos.getX(i);
            const y = pos.getY(i);
            const z = pos.getZ(i);
            vertices.push(
                e[0] * x + e[4] * y + e[8] * z + e[12],
                e[1] * x + e[5] * y + e[9] * z + e[13],
                e[2] * x + e[6] * y + e[10] * z + e[14]
            );
            if (uvAttr) {
                uvs.push(uvAttr.getX(i), uvAttr.getY(i));
            } else {
                uvs.push(0.5, 0.5);
            }
            vertexOwners.push(objectOwner);
        }

        const index = geom.index;

        const materials = Array.isArray(child.material) ? child.material : null;
        const groups = materials && geom.groups && geom.groups.length > 1 ? geom.groups : null;

        let groupedFacesHandled = false;
        if (groups) {
            // One vertex shared by groups with different textures cannot hold a
            // UV in two atlas tiles at once. Keep indexing intact within each
            // texture and split only the vertices that cross a group boundary.
            const ownerByVertex = new Map();
            const duplicatesByOwner = new Map();
            const vertexForOwner = (localIndex, owner) => {
                const original = vertStart + localIndex;
                const currentOwner = ownerByVertex.get(original);
                if (currentOwner === undefined || currentOwner === owner) {
                    ownerByVertex.set(original, owner);
                    return original;
                }
                let duplicates = duplicatesByOwner.get(owner);
                if (!duplicates) {
                    duplicates = new Map();
                    duplicatesByOwner.set(owner, duplicates);
                }
                if (duplicates.has(original)) return duplicates.get(original);
                const duplicate = vertices.length / 3;
                vertices.push(
                    vertices[original * 3],
                    vertices[original * 3 + 1],
                    vertices[original * 3 + 2]
                );
                uvs.push(uvs[original * 2], uvs[original * 2 + 1]);
                vertexOwners.push(objectOwner);
                duplicates.set(original, duplicate);
                return duplicate;
            };

            for (const group of groups) {
                const mat = materials[group.materialIndex] || materials[0];
                const groupDiffuse = pickDiffuseImageFromSingleMaterial(mat);
                const vertIndicesSet = new Set();
                const available = index ? index.count : pos.count;
                const end = Math.min(group.start + group.count, available);
                const triangleEnd = end - ((end - group.start) % 3);
                const owner = groupDiffuse || mat;
                if (index) {
                    for (let gi = group.start; gi < triangleEnd; gi += 3) {
                        const a = vertexForOwner(index.getX(gi), owner);
                        const b = vertexForOwner(index.getX(gi + 1), owner);
                        const c = vertexForOwner(index.getX(gi + 2), owner);
                        faces.push(a, b, c);
                        vertIndicesSet.add(a);
                        vertIndicesSet.add(b);
                        vertIndicesSet.add(c);
                    }
                } else {
                    for (let gi = group.start; gi < triangleEnd; gi += 3) {
                        const a = vertexForOwner(gi, owner);
                        const b = vertexForOwner(gi + 1, owner);
                        const c = vertexForOwner(gi + 2, owner);
                        faces.push(a, b, c);
                        vertIndicesSet.add(a);
                        vertIndicesSet.add(b);
                        vertIndicesSet.add(c);
                    }
                }
                registerTextureSegment(
                    groupDiffuse,
                    Array.from(vertIndicesSet),
                    textureSegments,
                    texState
                );
            }
            groupedFacesHandled = true;
        } else {
            const childDiffuse = pickDiffuseImageFromMaterial(child.material);
            const uvIndices = Array.from({ length: pos.count }, (_, i) => vertStart + i);
            registerTextureSegment(childDiffuse, uvIndices, textureSegments, texState);
        }

        if (groupedFacesHandled) {
            // The group loop already emitted faces, with vertex splits applied.
        } else if (index) {
            const n = index.count - (index.count % 3);
            for (let i = 0; i < n; i += 3) {
                faces.push(
                    vertStart + index.getX(i),
                    vertStart + index.getY(i),
                    vertStart + index.getZ(i)
                );
            }
        } else {
            const n = pos.count - (pos.count % 3);
            for (let i = 0; i < n; i += 3) {
                faces.push(vertStart + i, vertStart + i + 1, vertStart + i + 2);
            }
        }
    });

    normalizeVerticesToUnitSphere(vertices);
    const nVert = vertices.length / 3;
    const uvOk = uvs.length === nVert * 2;

    let diffuseImage = texState.singleDiffuse;

    // The sculpt engine renders one texture per mesh, so several diffuse maps
    // have to be packed into a single atlas with the UVs remapped to match.
    if (texState.hasMultipleTextures && textureSegments.length > 1 && uvOk) {
        const atlas = buildTextureAtlas(textureSegments, uvs);
        if (atlas) {
            diffuseImage = atlas;
        } else {
            console.warn("Sculpt extractMesh: texture atlas build failed; falling back to a single texture.");
        }
    }

    const compacted = compactTriangleGeometry(vertices, faces, uvOk ? uvs : [], vertexOwners);
    return {
        vertices: compacted.vertices,
        faces: compacted.faces,
        baseColorHint,
        diffuseImage,
        uvs: compacted.uvs,
        vertexOwners: compacted.vertexOwners
    };
}

/**
 * @param {ArrayBuffer} arrayBuffer
 * @param {{ textureFiles?: Map<string, File> }} [options]
 */
export async function parseFBXBuffer(arrayBuffer, options = {}) {
    const axisSystem = readFbxAxisSystem(arrayBuffer);
    const textureFiles = options.textureFiles;
    const manager =
        textureFiles && textureFiles.size > 0
            ? createCompanionFileLoadingManager(textureFiles)
            : new LoadingManager();
    const loadBarrier = createLoadingManagerBarrier(manager);
    try {
        const loader = new FBXLoader(manager);
        const root = loader.parse(arrayBuffer, "");
        await loadBarrier.wait();
        orientFbxRootToYUp(root, axisSystem);
        await waitForTextureImagesReady(root);
        const extracted = extractMeshGeometry(root);
        const tf = options.textureFiles;
        if (
            tf
            && tf.size > 0
            && (!extracted.diffuseImage || !isRenderableDiffuseImage(extracted.diffuseImage))
        ) {
            const fb = await pickFallbackDiffuseFromFiles(tf);
            if (fb) {
                return { ...extracted, diffuseImage: fb };
            }
        }
        return extracted;
    } finally {
        loadBarrier.restore();
        manager.sculptRevokeBlobUrls?.();
    }
}

/**
 * GLB (single buffer), embedded JSON glTF, or .gltf with companion files.
 * When loading .gltf that references external scene.bin or textures, pass
 * companionFiles map (from folder pick) so the loader can resolve them.
 * @param {ArrayBuffer | string} data
 * @param {{ companionFiles?: Map<string, File> }} [options]
 */
export async function parseGLTFData(data, options = {}) {
    const companionFiles = options.companionFiles;
    const manager =
        companionFiles && companionFiles.size > 0
            ? createCompanionFileLoadingManager(companionFiles)
            : new LoadingManager();
    try {
        const loader = new GLTFLoader(manager);
        // A "/" resource path turns relative URIs such as "scene.bin" into
        // "/scene.bin", which the URL modifier can match by basename against
        // the companion file map.
        const resourcePath = companionFiles && companionFiles.size > 0 ? "/" : "";
        const gltf = await loader.parseAsync(data, resourcePath);
        await waitForTextureImagesReady(gltf.scene);
        const extracted = extractMeshGeometry(gltf.scene);

        if (
            companionFiles
            && companionFiles.size > 0
            && (!extracted.diffuseImage || !isRenderableDiffuseImage(extracted.diffuseImage))
        ) {
            const fb = await pickFallbackDiffuseFromFiles(companionFiles);
            if (fb) {
                return { ...extracted, diffuseImage: fb };
            }
        }
        return extracted;
    } finally {
        manager.sculptRevokeBlobUrls?.();
    }
}

/**
 * Parse OBJ text with optional MTL and texture companion files. Unlike the
 * minimal parser in Primitives.js, this path extracts UVs and textures.
 * @param {string} objText raw .obj file content
 * @param {{ companionFiles?: Map<string, File> }} [options]
 */
export async function parseOBJData(objText, options = {}) {
    const companionFiles = options.companionFiles;
    const manager =
        companionFiles && companionFiles.size > 0
            ? createCompanionFileLoadingManager(companionFiles)
            : new LoadingManager();
    try {
        return await _parseOBJDataInner(objText, companionFiles, manager);
    } finally {
        manager.sculptRevokeBlobUrls?.();
    }
}

async function _parseOBJDataInner(objText, companionFiles, manager) {
    const objLoader = new OBJLoader(manager);

    // Materials must be preloaded before the OBJ parse so the loader can bind
    // them; without an .mtl the mesh still loads, just untextured.
    if (companionFiles && companionFiles.size > 0) {
        let mtlFile = null;
        for (const [, file] of companionFiles) {
            if (/\.mtl$/i.test(file.name)) {
                mtlFile = file;
                break;
            }
        }
        if (mtlFile) {
            try {
                const mtlText = await mtlFile.text();
                const mtlLoader = new MTLLoader(manager);
                mtlLoader.setResourcePath("/");
                const mtlCreator = mtlLoader.parse(mtlText, "");
                const loadBarrier = createLoadingManagerBarrier(manager);
                try {
                    mtlCreator.preload();
                    await loadBarrier.wait();
                } finally {
                    loadBarrier.restore();
                }
                objLoader.setMaterials(mtlCreator);
                await waitForTextureImagesReady({ traverse: (cb) => {
                    for (const name in mtlCreator.materials) {
                        cb({ material: mtlCreator.materials[name], isMesh: false });
                    }
                }});
            } catch (err) {
                console.warn("Sculpt: MTL parse failed, loading OBJ without materials:", err);
            }
        }
    }

    const root = objLoader.parse(objText);
    await waitForTextureImagesReady(root);
    const extracted = extractMeshGeometry(root);

    if (
        companionFiles
        && companionFiles.size > 0
        && (!extracted.diffuseImage || !isRenderableDiffuseImage(extracted.diffuseImage))
    ) {
        const fb = await pickFallbackDiffuseFromFiles(companionFiles);
        if (fb) {
            return { ...extracted, diffuseImage: fb };
        }
    }
    return extracted;
}
