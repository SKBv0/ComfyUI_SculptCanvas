/**
 * Primitive mesh generators
 */

import { normalizeVerticesToUnitSphere } from "./meshNormalize.js";

function weldPrimitive(vertices, faces) {
    const weldedVertices = [];
    const remap = new Uint32Array(vertices.length / 3);
    const byPosition = new Map();
    for (let i = 0; i < vertices.length; i += 3) {
        const key = `${Math.round(vertices[i] * 1e7)},${Math.round(vertices[i + 1] * 1e7)},${Math.round(vertices[i + 2] * 1e7)}`;
        let weldedIndex = byPosition.get(key);
        if (weldedIndex === undefined) {
            weldedIndex = weldedVertices.length / 3;
            byPosition.set(key, weldedIndex);
            weldedVertices.push(vertices[i], vertices[i + 1], vertices[i + 2]);
        }
        remap[i / 3] = weldedIndex;
    }
    const weldedFaces = [];
    for (let i = 0; i < faces.length; i += 3) {
        const a = remap[faces[i]];
        const b = remap[faces[i + 1]];
        const c = remap[faces[i + 2]];
        if (a !== b && b !== c && c !== a) weldedFaces.push(a, b, c);
    }
    return { vertices: weldedVertices, faces: weldedFaces };
}

/**
 * Generate a UV sphere
 * @param {number} radius - Sphere radius
 * @param {number} subdivision - Subdivision level (1-5)
 * @returns {{vertices: number[], faces: number[]}}
 */
export function generateSphere(radius = 1.0, subdivision = 3) {
    const latSegments = Math.pow(2, subdivision + 2);
    const lonSegments = latSegments * 2;
    const vertices = [];
    const faces = [];

    // Top pole
    vertices.push(0, radius, 0);

    // Body rings (exclude poles)
    for (let lat = 1; lat < latSegments; lat++) {
        const theta = lat * Math.PI / latSegments;
        const sinTheta = Math.sin(theta);
        const cosTheta = Math.cos(theta);

        for (let lon = 0; lon < lonSegments; lon++) {
            const phi = lon * 2 * Math.PI / lonSegments;
            const x = radius * sinTheta * Math.cos(phi);
            const y = radius * cosTheta;
            const z = radius * sinTheta * Math.sin(phi);
            vertices.push(x, y, z);
        }
    }

    // Bottom pole
    const bottomIndex = vertices.length / 3;
    vertices.push(0, -radius, 0);

    // Top cap
    for (let lon = 0; lon < lonSegments; lon++) {
        const curr = 1 + lon;
        const next = 1 + ((lon + 1) % lonSegments);
        faces.push(0, curr, next);
    }

    // Middle bands
    for (let lat = 0; lat < latSegments - 2; lat++) {
        const rowStart = 1 + lat * lonSegments;
        const nextRowStart = rowStart + lonSegments;

        for (let lon = 0; lon < lonSegments; lon++) {
            const curr = rowStart + lon;
            const next = rowStart + ((lon + 1) % lonSegments);
            const down = nextRowStart + lon;
            const downNext = nextRowStart + ((lon + 1) % lonSegments);

            faces.push(curr, down, next);
            faces.push(next, down, downNext);
        }
    }

    // Bottom cap
    const lastRingStart = 1 + (latSegments - 2) * lonSegments;
    for (let lon = 0; lon < lonSegments; lon++) {
        const curr = lastRingStart + lon;
        const next = lastRingStart + ((lon + 1) % lonSegments);
        faces.push(curr, bottomIndex, next);
    }

    return weldPrimitive(vertices, faces);
}

/**
 * Generate a subdivided cube
 * @param {number} size - Cube size
 * @param {number} subdivision - Subdivision level (1-5)
 * @returns {{vertices: number[], faces: number[]}}
 */
export function generateCube(size = 1.0, subdivision = 3) {
    const half = size / 2;
    const segments = Math.pow(2, subdivision); // 2, 4, 8, 16, 32

    const vertices = [];
    const faces = [];
    let vertexIndex = 0;

    // Define the 6 faces of the cube
    const cubeFaces = [
        // Front (+Z)
        { origin: [-half, -half, half], u: [1, 0, 0], v: [0, 1, 0] },
        // Back (-Z)
        { origin: [half, -half, -half], u: [-1, 0, 0], v: [0, 1, 0] },
        // Top (+Y)
        { origin: [-half, half, -half], u: [1, 0, 0], v: [0, 0, 1] },
        // Bottom (-Y)
        { origin: [-half, -half, half], u: [1, 0, 0], v: [0, 0, -1] },
        // Right (+X)
        { origin: [half, -half, -half], u: [0, 0, 1], v: [0, 1, 0] },
        // Left (-X)
        { origin: [-half, -half, half], u: [0, 0, -1], v: [0, 1, 0] },
    ];

    for (const face of cubeFaces) {
        const startIndex = vertexIndex;

        // Generate vertices for this face
        for (let i = 0; i <= segments; i++) {
            for (let j = 0; j <= segments; j++) {
                const u = i / segments;
                const vt = j / segments;

                const x = face.origin[0] + u * size * face.u[0] + vt * size * face.v[0];
                const y = face.origin[1] + u * size * face.u[1] + vt * size * face.v[1];
                const z = face.origin[2] + u * size * face.u[2] + vt * size * face.v[2];

                vertices.push(x, y, z);
                vertexIndex++;
            }
        }

        // Generate faces for this face
        const cols = segments + 1;
        for (let i = 0; i < segments; i++) {
            for (let j = 0; j < segments; j++) {
                const v0 = startIndex + i * cols + j;
                const v1 = v0 + 1;
                const v2 = v0 + cols;
                const v3 = v2 + 1;

                faces.push(v0, v2, v1);
                faces.push(v1, v2, v3);
            }
        }
    }

    return weldPrimitive(vertices, faces);
}

/**
 * Generate a cylinder
 */
export function generateCylinder(radius = 0.5, height = 1.6, subdivision = 3) {
    const radialSegments = Math.pow(2, subdivision + 1);
    const heightSegments = Math.pow(2, subdivision);

    const vertices = [];
    const faces = [];

    for (let y = 0; y <= heightSegments; y++) {
        const v = y / heightSegments;
        const py = v * height - height / 2;

        for (let x = 0; x <= radialSegments; x++) {
            const u = x / radialSegments;
            const theta = u * Math.PI * 2;
            const px = radius * Math.cos(theta);
            const pz = radius * Math.sin(theta);

            vertices.push(px, py, pz);
        }
    }

    const cols = radialSegments + 1;
    for (let y = 0; y < heightSegments; y++) {
        for (let x = 0; x < radialSegments; x++) {
            const v0 = y * cols + x;
            const v1 = v0 + 1;
            const v2 = (y + 1) * cols + x;
            const v3 = v2 + 1;

            faces.push(v0, v1, v2);
            faces.push(v1, v3, v2);
        }
    }

    // End caps (fan around a center vertex). Matches the Python generator in
    // nodes.py so a fresh node renders the same solid the backend exports.
    const bottomCenter = vertices.length / 3;
    vertices.push(0, -height / 2, 0);
    const topCenter = vertices.length / 3;
    vertices.push(0, height / 2, 0);
    const topRingStart = heightSegments * cols;
    for (let i = 0; i < radialSegments; i++) {
        faces.push(bottomCenter, i + 1, i);
        faces.push(topCenter, topRingStart + i, topRingStart + i + 1);
    }

    return weldPrimitive(vertices, faces);
}

/**
 * Generate a torus
 */
export function generateTorus(radius = 1.0, tube = 0.4, subdivision = 3) {
    const radialSegments = Math.pow(2, subdivision + 1);
    const tubularSegments = Math.pow(2, subdivision + 1);

    const vertices = [];
    const faces = [];

    for (let j = 0; j <= radialSegments; j++) {
        for (let i = 0; i <= tubularSegments; i++) {
            const u = i / tubularSegments * Math.PI * 2;
            const v = j / radialSegments * Math.PI * 2;

            const x = (radius + tube * Math.cos(v)) * Math.cos(u);
            const y = (radius + tube * Math.cos(v)) * Math.sin(u);
            const z = tube * Math.sin(v);

            vertices.push(x, y, z);
        }
    }

    const cols = tubularSegments + 1;
    for (let j = 0; j < radialSegments; j++) {
        for (let i = 0; i < tubularSegments; i++) {
            const v0 = j * cols + i;
            const v1 = v0 + 1;
            const v2 = (j + 1) * cols + i;
            const v3 = v2 + 1;

            faces.push(v0, v1, v2);
            faces.push(v1, v3, v2);
        }
    }

    return weldPrimitive(vertices, faces);
}

/**
 * Generate a plane
 */
export function generatePlane(size = 2.0, subdivision = 4) {
    const segments = Math.pow(2, subdivision);
    const vertices = [];
    const faces = [];

    for (let y = 0; y <= segments; y++) {
        for (let x = 0; x <= segments; x++) {
            vertices.push(
                (x / segments - 0.5) * size,
                0,
                (y / segments - 0.5) * size
            );
        }
    }

    const cols = segments + 1;
    for (let y = 0; y < segments; y++) {
        for (let x = 0; x < segments; x++) {
            const v0 = y * cols + x;
            const v1 = v0 + 1;
            const v2 = (y + 1) * cols + x;
            const v3 = v2 + 1;

            faces.push(v0, v2, v1);
            faces.push(v1, v2, v3);
        }
    }

    return weldPrimitive(vertices, faces);
}

/**
 * Generate a primitive mesh
 */
export function generatePrimitive(type, subdivision = 3) {
    switch (type) {
        case "cube": return generateCube(1.0, subdivision);
        case "cylinder": return generateCylinder(0.5, 1.6, subdivision);
        case "torus": return generateTorus(0.8, 0.3, subdivision);
        case "plane": return generatePlane(2.0, subdivision + 1);
        default: return generateSphere(1.0, subdivision);
    }
}

/**
 * Parse OBJ file text into vertices and faces.
 * Handles triangles and quads (triangulates quads).
 * Centers and scales the mesh to fit within a unit sphere.
 * @param {string} text - Raw OBJ file content
 * @returns {{vertices: number[], faces: number[]}}
 */
export function parseOBJ(text) {
    if (typeof text !== "string" || text.trim().length === 0) {
        return { vertices: [], faces: [] };
    }

    const positions = []; // [x,y,z] per vertex
    const faces = [];
    const lines = text.split(/\r?\n/);

    const resolveFaceIndex = (token, vertexCount) => {
        if (!token) return null;
        const base = token.split("/")[0];
        if (!base) return null;
        const parsed = Number.parseInt(base, 10);
        if (!Number.isFinite(parsed) || parsed === 0) return null;
        const resolved = parsed > 0 ? parsed - 1 : vertexCount + parsed;
        if (resolved < 0 || resolved >= vertexCount) return null;
        return resolved;
    };

    for (const raw of lines) {
        const line = raw.trim();
        if (line.length === 0 || line[0] === "#") continue;

        const parts = line.split(/\s+/);
        const cmd = parts[0];

        if (cmd === "v" && parts.length >= 4) {
            const x = Number.parseFloat(parts[1]);
            const y = Number.parseFloat(parts[2]);
            const z = Number.parseFloat(parts[3]);
            if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
            positions.push(x, y, z);
            continue;
        }

        if (cmd === "f" && parts.length >= 4) {
            const vertexCount = positions.length / 3;
            if (vertexCount < 3) continue;

            const poly = [];
            for (let i = 1; i < parts.length; i++) {
                const idx = resolveFaceIndex(parts[i], vertexCount);
                if (idx === null) continue;
                if (poly.length === 0 || poly[poly.length - 1] !== idx) {
                    poly.push(idx);
                }
            }
            if (poly.length < 3) continue;

            // Triangulate polygon as fan while rejecting degenerate triangles.
            const root = poly[0];
            for (let i = 1; i < poly.length - 1; i++) {
                const a = root;
                const b = poly[i];
                const c = poly[i + 1];
                if (a === b || b === c || c === a) continue;
                faces.push(a, b, c);
            }
        }
    }

    if (positions.length === 0 || faces.length === 0) {
        return { vertices: [], faces: [] };
    }

    const vertices = [...positions];
    normalizeVerticesToUnitSphere(vertices);

    return { vertices, faces };
}
