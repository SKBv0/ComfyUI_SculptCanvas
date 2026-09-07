/**
 * The global normal orientation sign describes face winding, which sculpting
 * never changes, so it must be derived once at load and then held fixed.
 * Re-deriving it per stroke flips every normal on a flat mesh:
 * `_estimateNormalOrientationSign` scores exactly 0 for a pristine plane, so a
 * single downward (Ctrl/invert) dab tips the sum negative, the surface turns
 * backfacing, every following raycast misses, and the plane is left
 * permanently un-sculptable.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SculptEngine } from "../js/engine/SculptEngine.js";
import { Mesh } from "../js/engine/Mesh.js";
import { generatePrimitive } from "../js/engine/Primitives.js";

const W = 512;
const H = 512;
const CX = W / 2;
const CY = H / 2;

function invertStroke(engine, dabs) {
    let hits = 0;
    engine.startStroke();
    for (let i = 0; i < dabs; i++) {
        const hit = engine.getHitInfo(CX, CY, W, H);
        if (!hit) continue;
        hits++;
        engine.applyBrushAtHit(hit, true, null, null);
        // SculptCanvas._render does a full recalculation every frame mid-stroke.
        engine.mesh.recalculateNormals();
    }
    engine.endStroke();
    return hits;
}

describe("normal orientation sign stability", () => {
    let engine;

    beforeEach(() => {
        engine = new SculptEngine();
    });

    it("keeps the plane sculptable through an inverted stroke", () => {
        engine.loadPrimitive("plane", 3);
        engine.activeBrush = "standard";
        const signBefore = engine.mesh.normalOrientationSign;

        const hits = invertStroke(engine, 12);

        expect(hits).toBe(12);
        expect(engine.mesh.normalOrientationSign).toBe(signBefore);
        expect(engine.getHitInfo(CX, CY, W, H)).not.toBeNull();
    });

    it("actually carves the plane downward instead of no-oping", () => {
        engine.loadPrimitive("plane", 3);
        engine.activeBrush = "standard";
        engine.brushStrength = 1.0;

        invertStroke(engine, 40);

        let minY = Infinity;
        for (let i = 1; i < engine.mesh.vertices.length; i += 3) {
            minY = Math.min(minY, engine.mesh.vertices[i]);
        }
        expect(minY).toBeLessThan(-1e-4);
    });

    it("does not flip normals when sculpting displaces the surface", () => {
        engine.loadPrimitive("plane", 3);
        engine.activeBrush = "standard";
        const n0Before = engine.mesh.getNormal(0);

        invertStroke(engine, 12);

        const n0After = engine.mesh.getNormal(0);
        // Corner vertex is outside the brush falloff, so its normal must not
        // have been inverted by a global sign change.
        expect(Math.sign(n0After[1] || n0Before[1])).toBe(Math.sign(n0Before[1]));
    });

    it("still derives the sign for freshly loaded geometry", () => {
        // A sphere wound so that raw face normals point inward must be
        // corrected on load, otherwise nothing is ever visible.
        const { vertices, faces } = generatePrimitive("sphere", 2);
        const flipped = [];
        for (let i = 0; i < faces.length; i += 3) {
            flipped.push(faces[i], faces[i + 2], faces[i + 1]);
        }

        const a = new Mesh();
        a.setData(vertices, faces);
        const b = new Mesh();
        b.setData(vertices, flipped);

        // Whatever the winding, load-time estimation points normals outward.
        const outward = (mesh, idx) => {
            const [x, y, z] = mesh.getVertex(idx);
            const [nx, ny, nz] = mesh.getNormal(idx);
            return x * nx + y * ny + z * nz;
        };
        expect(outward(a, 10)).toBeGreaterThan(0);
        expect(outward(b, 10)).toBeGreaterThan(0);
    });

    it("re-estimates on import but preserves the sign across undo", () => {
        engine.loadPrimitive("sphere", 2);
        const sphereSign = engine.mesh.normalOrientationSign;

        engine.loadPrimitive("plane", 3);
        expect(engine.mesh._orientationSignEstimated).toBe(true);
        const planeSign = engine.mesh.normalOrientationSign;

        engine.activeBrush = "standard";
        invertStroke(engine, 6);
        engine.undo();

        expect(engine.mesh.normalOrientationSign).toBe(planeSign);
        expect(sphereSign).toBeDefined();
    });
});
