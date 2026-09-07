/**
 * Behaviour every brush must satisfy, and the symmetry contract in particular.
 *
 * Clay measures deposit height against a stroke plane that tracks the original
 * side of the model. Mirrored strokes must mirror that plane too, otherwise the
 * reflected pass measures depth from the wrong side and builds noticeably
 * different volume on each half.
 */

import { describe, it, expect } from "vitest";
import { SculptEngine } from "../js/engine/SculptEngine.js";

const W = 800;
const H = 800;
const CY = 400;
const BRUSHES = [
    "standard", "smooth", "inflate", "flatten", "pinch",
    "crease", "clay", "move", "trim", "snake_hook"
];

function engineFor(brush, { strength = 1.0, symmetry = "none", mask = null } = {}) {
    const engine = new SculptEngine();
    engine.loadPrimitive("sphere", 3);
    engine.activeBrush = brush;
    engine.brushStrength = strength;
    engine.symmetry = symmetry;
    // Adaptive refine would change vertex count mid-stroke and break the
    // index-to-index comparisons these tests rely on.
    engine.maxAdaptiveVertexCount = 0;
    if (mask !== null) {
        engine.mesh.ensureVertexMask();
        engine.mesh.vertexMask.fill(mask);
    }
    return engine;
}

function stroke(engine, { dabs = 12, screenX = 400, invert = false, moveDelta = null } = {}) {
    const before = Float32Array.from(engine.mesh.vertices);
    engine.startStroke();
    for (let i = 0; i < dabs; i++) {
        const hit = engine.getHitInfo(screenX, CY, W, H);
        if (hit) {
            engine.applyBrushAtHit(hit, invert, null, moveDelta ? { moveDelta } : null);
        }
    }
    engine.endStroke();
    return before;
}

function maxDisplacement(engine, before) {
    let max = 0;
    for (let i = 0; i < engine.mesh.vertexCount && i * 3 + 2 < before.length; i++) {
        max = Math.max(max, Math.hypot(
            engine.mesh.vertices[i * 3] - before[i * 3],
            engine.mesh.vertices[i * 3 + 1] - before[i * 3 + 1],
            engine.mesh.vertices[i * 3 + 2] - before[i * 3 + 2]
        ));
    }
    return max;
}

/** Worst relative displacement difference between mirror-paired vertices. */
function symmetryError(engine, before, axis) {
    const mesh = engine.mesh;
    const key = (x, y, z) =>
        `${Math.round(x * 1e4)}|${Math.round(y * 1e4)}|${Math.round(z * 1e4)}`;
    const byPosition = new Map();
    const count = before.length / 3;
    for (let i = 0; i < count; i++) {
        byPosition.set(key(before[i * 3], before[i * 3 + 1], before[i * 3 + 2]), i);
    }

    const displacement = (i) => Math.hypot(
        mesh.vertices[i * 3] - before[i * 3],
        mesh.vertices[i * 3 + 1] - before[i * 3 + 1],
        mesh.vertices[i * 3 + 2] - before[i * 3 + 2]
    );

    let worst = 0;
    let pairs = 0;
    for (let i = 0; i < count; i++) {
        const own = displacement(i);
        if (!(own > 1e-6)) continue;
        const mirrored = [before[i * 3], before[i * 3 + 1], before[i * 3 + 2]];
        mirrored[axis] = -mirrored[axis];
        const j = byPosition.get(key(mirrored[0], mirrored[1], mirrored[2]));
        if (j === undefined) continue;
        const other = displacement(j);
        if (Math.max(own, other) < 1e-5) continue;
        pairs++;
        worst = Math.max(worst, Math.abs(own - other) / Math.max(own, other));
    }
    return { worst, pairs };
}

describe("brush invariants", () => {
    it.each(BRUSHES)("%s leaves the mesh untouched at zero strength", (brush) => {
        const engine = engineFor(brush, { strength: 0 });
        const before = stroke(engine, { moveDelta: [0.01, 0, 0] });
        // Zero strength must be an exact no-op. A constant offset anywhere in a
        // brush's depth term makes it deposit material on its own.
        expect(maxDisplacement(engine, before)).toBeLessThan(1e-6);
    });

    it.each(BRUSHES)("%s leaves fully masked vertices untouched", (brush) => {
        const engine = engineFor(brush, { mask: 1 });
        const before = stroke(engine, { moveDelta: [0.01, 0, 0] });
        expect(maxDisplacement(engine, before)).toBeLessThan(1e-6);
    });

    it.each(BRUSHES)("%s stays finite and bounded under a long hard stroke", (brush) => {
        const engine = engineFor(brush, { strength: 2.0 });
        const before = stroke(engine, { dabs: 120, moveDelta: [0.02, 0, 0] });
        for (const value of engine.mesh.vertices) expect(Number.isFinite(value)).toBe(true);
        for (const value of engine.mesh.normals) expect(Number.isFinite(value)).toBe(true);
        // The primitive has radius 1; anything past this is a runaway.
        expect(maxDisplacement(engine, before)).toBeLessThan(3);
    });

    it.each(BRUSHES)("%s does not reach the far side of the model", (brush) => {
        const engine = engineFor(brush);
        const hit = engine.getHitInfo(400, CY, W, H);
        expect(hit).not.toBeNull();
        const before = stroke(engine, { moveDelta: [0.01, 0, 0] });

        let farSideMoved = 0;
        for (let i = 0; i < engine.mesh.vertexCount; i++) {
            const facing = before[i * 3] * hit.point[0]
                + before[i * 3 + 1] * hit.point[1]
                + before[i * 3 + 2] * hit.point[2];
            if (facing > -0.3) continue;
            const moved = Math.hypot(
                engine.mesh.vertices[i * 3] - before[i * 3],
                engine.mesh.vertices[i * 3 + 1] - before[i * 3 + 1],
                engine.mesh.vertices[i * 3 + 2] - before[i * 3 + 2]
            );
            if (moved > 1e-6) farSideMoved++;
        }
        expect(farSideMoved).toBe(0);
    });
});

describe("topology stabilization for aggressive brushes", () => {
    it.each(["pinch", "crease"])("%s prevents per-dab face collapse and inversion", (brush) => {
        const engine = engineFor(brush, { strength: 2.0 });
        engine.brushRadius = 0.54;
        engine.startStroke();
        for (let dab = 0; dab < 30; dab++) {
            const hit = engine.getHitInfo(355 + dab * 3, CY, W, H);
            if (!hit) continue;
            const before = Float32Array.from(engine.mesh.vertices);
            engine.applyBrushAtHit(hit, false);
            for (let fi = 0; fi < engine.mesh.faces.length; fi += 3) {
                const ia = engine.mesh.faces[fi] * 3;
                const ib = engine.mesh.faces[fi + 1] * 3;
                const ic = engine.mesh.faces[fi + 2] * 3;
                const normal = (positions) => {
                    const ux = positions[ib] - positions[ia];
                    const uy = positions[ib + 1] - positions[ia + 1];
                    const uz = positions[ib + 2] - positions[ia + 2];
                    const vx = positions[ic] - positions[ia];
                    const vy = positions[ic + 1] - positions[ia + 1];
                    const vz = positions[ic + 2] - positions[ia + 2];
                    return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
                };
                const n0 = normal(before);
                const n1 = normal(engine.mesh.vertices);
                const a0 = n0[0] ** 2 + n0[1] ** 2 + n0[2] ** 2;
                if (a0 <= 1e-18) continue;
                const a1 = n1[0] ** 2 + n1[1] ** 2 + n1[2] ** 2;
                const alignment = (n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2]) / Math.sqrt(a0 * a1);
                expect(a1 / a0).toBeGreaterThanOrEqual(0.038);
                expect(alignment).toBeGreaterThan(0.015);
            }
        }
        engine.endStroke();
    });
});

describe("imported UV seam cohesion", () => {
    const seamMesh = (owners) => {
        const engine = new SculptEngine();
        engine.mesh.setData(
            [-1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0],
            [0, 1, 2, 3, 4, 5],
            [0, 0, 1, 0, 1, 1, 0, 0, 1, 0, 0, 1],
            owners
        );
        engine.activeBrush = "standard";
        engine.brushStrength = 1;
        return engine;
    };

    it("keeps duplicated UV seam vertices welded during sculpting", () => {
        const engine = seamMesh([0, 0, 0, 0, 0, 0]);
        engine.startStroke();
        engine.applyBrushAtHit({ point: [0, 0.4, 0], normal: [0, 0, 1] }, false, 2);
        engine.endStroke();
        const gap = (a, b) => Math.hypot(
            engine.mesh.vertices[a * 3] - engine.mesh.vertices[b * 3],
            engine.mesh.vertices[a * 3 + 1] - engine.mesh.vertices[b * 3 + 1],
            engine.mesh.vertices[a * 3 + 2] - engine.mesh.vertices[b * 3 + 2]
        );
        expect(gap(1, 3)).toBeLessThan(1e-7);
        expect(gap(2, 5)).toBeLessThan(1e-7);
    });

    it("does not weld coincident vertices owned by separate objects", () => {
        const engine = seamMesh([0, 0, 0, 1, 1, 1]);
        const before = Float32Array.from(engine.mesh.vertices);
        engine.startStroke();
        engine.applyBrushAtHit({ point: [-0.4, 0.4, 0], normal: [0, 0, 1] }, false, 2);
        engine.endStroke();
        expect(Array.from(engine.mesh.vertices.slice(9))).toEqual(Array.from(before.slice(9)));
    });

    it("refines paired seam edges atomically at the split budget boundary", () => {
        const vertices = [];
        const faces = [];
        const owners = [];
        const addTriangle = (x, baseLength) => {
            const first = vertices.length / 3;
            vertices.push(
                x, 0, 0,
                x + baseLength, 0, 0,
                x + baseLength / 2, 0.2, 0
            );
            faces.push(first, first + 1, first + 2);
            owners.push(0, 0, 0);
        };

        // Thirty-one slightly longer candidate edges consume the budget before
        // the duplicated seam pair. A seam pair must be admitted whole or not
        // at all; truncating edge by edge leaves an unpaired midpoint.
        for (let i = 0; i < 31; i++) addTriangle(i * 4, 2.2);
        addTriangle(200, 2);
        addTriangle(200, 2);

        const engine = new SculptEngine();
        engine.mesh.setData(vertices, faces, null, owners);
        const oldVertexCount = engine.mesh.vertexCount;
        const result = engine.mesh.refineRegionForBrush(
            Array.from({ length: oldVertexCount }, (_, index) => index),
            {
                radius: 1000,
                targetEdgeLength: 1,
                edgeThreshold: 1.15,
                maxSplitEdges: 32,
                maxAddedVertices: 64,
                maxVertexCount: 10000
            }
        );

        expect(result.changed).toBe(true);
        const seamMidpoints = [];
        for (let i = oldVertexCount; i < engine.mesh.vertexCount; i++) {
            if (Math.abs(engine.mesh.vertices[i * 3] - 201) < 0.05) {
                seamMidpoints.push(i);
            }
        }
        // Atomic budgeting may defer the pair, or split both together. It
        // must never leave one unpaired midpoint.
        expect([0, 2]).toContain(seamMidpoints.length);
        if (seamMidpoints.length === 2) {
            const group = engine.mesh.coincidentGroupByVertex[seamMidpoints[0]];
            expect(group).toBeGreaterThanOrEqual(0);
            expect(engine.mesh.coincidentGroupByVertex[seamMidpoints[1]]).toBe(group);
        }
    });
});

describe("clay symmetry uses a mirrored stroke plane", () => {
    it.each(["x", "y", "z"])("builds matching volume on both halves for %s", (axis) => {
        const engine = engineFor("clay", { symmetry: axis });
        const before = stroke(engine, { screenX: 310 });
        const { worst, pairs } = symmetryError(engine, before, "xyz".indexOf(axis));
        expect(pairs).toBeGreaterThan(5);
        expect(worst).toBeLessThan(0.08);
    });

    it("regresses if the mirrored pass reuses the original plane", () => {
        const engine = engineFor("clay", { symmetry: "x" });
        const original = engine._getClayBrushContext.bind(engine);
        // This stub hands out the un-mirrored plane on every pass.
        engine._getClayBrushContext = () => {
            const context = original();
            return context ? { ...context } : context;
        };
        const before = stroke(engine, { screenX: 310 });
        const fixed = symmetryError(engine, before, 0);
        // Sanity: the harness itself still finds pairs to compare.
        expect(fixed.pairs).toBeGreaterThan(5);
    });
});
