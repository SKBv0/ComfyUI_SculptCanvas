/**
 * Cross-language parity contract, JS side.
 *
 * The viewport primitives must match the Python generators in nodes.py (used
 * when a queue has no sculpt data), and the frontend/backend limits must
 * agree. tests/test_primitive_parity.py asserts the same fixture from Python.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { generatePrimitive } from "../js/engine/Primitives.js";
import {
    MAX_IMPORT_VERTEX_COUNT, MAX_MESH_FACE_INDICES, MAX_SCULPT_DATA_BYTES,
    PREVIEW_SIZE_MIN, PREVIEW_SIZE_MAX, PREVIEW_SIZE_DEFAULT, EXPORT_FORMATS,
    PRIMITIVE_TYPES, SUBDIVISION_MIN, SUBDIVISION_MAX
} from "../js/engine/limits.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
    readFileSync(join(HERE, "fixtures", "primitive_parity.json"), "utf-8")
);
const NODES_PY = readFileSync(join(HERE, "..", "nodes.py"), "utf-8");

const PRIMITIVES = ["sphere", "cube", "cylinder", "torus", "plane"];
const SUBDIVISIONS = [1, 2, 3, 4, 5];
const BBOX_TOLERANCE = 1e-4;

describe("primitive parity (JS vs shared fixture)", () => {
    for (const prim of PRIMITIVES) {
        for (const sub of SUBDIVISIONS) {
            it(`${prim} @ subdivision ${sub} matches the fixture`, () => {
                const { vertices, faces } = generatePrimitive(prim, sub);
                const expected = fixture[`${prim}:${sub}`];
                expect(expected).toBeDefined();
                expect(vertices.length / 3).toBe(expected.vertexCount);
                expect(faces.length).toBe(expected.faceIndexCount);
                let faceSum = 0;
                for (const f of faces) faceSum += f;
                expect(faceSum).toBe(expected.faceIndexSum);
                const bbox = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
                for (let i = 0; i < vertices.length; i += 3) {
                    for (let a = 0; a < 3; a++) {
                        if (vertices[i + a] < bbox[a]) bbox[a] = vertices[i + a];
                        if (vertices[i + a] > bbox[a + 3]) bbox[a + 3] = vertices[i + a];
                    }
                }
                for (let i = 0; i < 6; i++) {
                    expect(Math.abs(bbox[i] - expected.bbox[i])).toBeLessThanOrEqual(BBOX_TOLERANCE);
                }
            });
        }
    }
});

describe("built-in primitive topology", () => {
    it.each(["sphere", "cube", "cylinder", "torus"])("%s is a welded closed manifold", (prim) => {
        const { vertices, faces } = generatePrimitive(prim, 3);
        const positions = new Set();
        for (let i = 0; i < vertices.length; i += 3) {
            positions.add(`${Math.round(vertices[i] * 1e7)}|${Math.round(vertices[i + 1] * 1e7)}|${Math.round(vertices[i + 2] * 1e7)}`);
        }
        expect(positions.size).toBe(vertices.length / 3);

        const edgeUse = new Map();
        for (let i = 0; i < faces.length; i += 3) {
            const triangle = [faces[i], faces[i + 1], faces[i + 2]];
            for (let edge = 0; edge < 3; edge++) {
                const a = Math.min(triangle[edge], triangle[(edge + 1) % 3]);
                const b = Math.max(triangle[edge], triangle[(edge + 1) % 3]);
                const key = `${a}:${b}`;
                edgeUse.set(key, (edgeUse.get(key) || 0) + 1);
            }
        }
        expect([...edgeUse.values()].filter((count) => count !== 2)).toEqual([]);
    });

    it("keeps the plane intentionally open without non-manifold edges", () => {
        const { faces } = generatePrimitive("plane", 3);
        const edgeUse = new Map();
        for (let i = 0; i < faces.length; i += 3) {
            const triangle = [faces[i], faces[i + 1], faces[i + 2]];
            for (let edge = 0; edge < 3; edge++) {
                const a = Math.min(triangle[edge], triangle[(edge + 1) % 3]);
                const b = Math.max(triangle[edge], triangle[(edge + 1) % 3]);
                const key = `${a}:${b}`;
                edgeUse.set(key, (edgeUse.get(key) || 0) + 1);
            }
        }
        expect([...edgeUse.values()].some((count) => count === 1)).toBe(true);
        expect([...edgeUse.values()].some((count) => count > 2)).toBe(false);
    });
});

describe("limit contract (JS vs nodes.py)", () => {
    it("frontend import limit equals backend MAX_MESH_VERTICES", () => {
        const match = NODES_PY.match(/MAX_MESH_VERTICES\s*=\s*([\d_]+)/);
        expect(match).not.toBeNull();
        const backend = Number(match[1].replace(/_/g, ""));
        expect(MAX_IMPORT_VERTEX_COUNT).toBe(backend);
    });
});

it("EXPORT_FORMATS matches the backend contract", () => {
    const match = NODES_PY.match(/EXPORT_FORMATS\s*=\s*\(([^)]*)\)/);
    expect(match).not.toBeNull();
    const backend = match[1].split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
    expect(EXPORT_FORMATS).toEqual(backend);
});

it("PRIMITIVE_TYPES matches the backend contract", () => {
    const match = NODES_PY.match(/PRIMITIVE_TYPES\s*=\s*\(([^)]*)\)/);
    expect(match).not.toBeNull();
    const backend = match[1].split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
    expect(PRIMITIVE_TYPES).toEqual(backend);
});

for (const [name, value] of Object.entries({
    MAX_MESH_FACE_INDICES, MAX_SCULPT_DATA_BYTES, PREVIEW_SIZE_MIN, PREVIEW_SIZE_MAX, PREVIEW_SIZE_DEFAULT,
    SUBDIVISION_MIN, SUBDIVISION_MAX
})) {
    it(`${name} matches the backend contract`, () => {
        const match = NODES_PY.match(new RegExp(name + "\\s*=\\s*([\\d_]+)"));
        expect(match).not.toBeNull();
        expect(value).toBe(Number(match[1].replaceAll("_", "")));
    });
}
