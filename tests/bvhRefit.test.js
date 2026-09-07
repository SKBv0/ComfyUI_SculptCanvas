/**
 * Sculpting moves vertices but never changes which triangle lives in which BVH
 * leaf, so mid-stroke the tree must have its boxes refit rather than rebuilt. A
 * rebuild costs 51 ms at 32k vertices and 898 ms at 130k, long enough that the
 * pointer outruns the stamp budget and a dragged stroke lands as separate
 * mounds.
 *
 * A refit is only correct while topology is unchanged; these tests pin both the
 * equivalence and the boundary where a rebuild is still required.
 */

import { describe, it, expect, vi } from "vitest";
import { SculptEngine } from "../js/engine/SculptEngine.js";
import { Mesh } from "../js/engine/Mesh.js";
import { TriangleBVH } from "../js/engine/TriangleBVH.js";
import { generatePrimitive } from "../js/engine/Primitives.js";

const W = 512;
const H = 512;

function sphereMesh(subdiv = 3) {
    const { vertices, faces } = generatePrimitive("sphere", subdiv);
    const mesh = new Mesh();
    mesh.setData(vertices, faces);
    return mesh;
}

function castRays(engine, count = 40) {
    const hits = [];
    for (let i = 0; i < count; i++) {
        const x = 150 + (i * 220) / count;
        hits.push(engine.getHitInfo(x, H / 2, W, H));
    }
    return hits;
}

describe("TriangleBVH refit", () => {
    it("keeps octree and BVH queries correct while vertices move between refreshes", () => {
        const mesh = new Mesh();
        mesh.setData(
            new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
            new Uint32Array([0, 1, 2])
        );
        const before = new Float32Array(mesh.vertices);
        for (let i = 0; i < mesh.vertices.length; i += 3) mesh.vertices[i] += 2;
        mesh.noteSpatialMovement([0, 1, 2], before);

        expect(mesh.spatialIndexPadding).toBeCloseTo(2, 6);
        expect(mesh.queryVerticesInRadius(2, 0, 0, 0.05)).toContain(0);
        const hit = mesh.triangleBVH.intersectClosest(
            2.2, 0.2, 1,
            0, 0, -1,
            mesh.vertices, mesh.faces, mesh.normals,
            1e-6, -0.04,
            mesh.spatialIndexPadding
        );
        expect(hit).not.toBeNull();

        mesh.refreshSpatialIndexForMovedVertices();
        expect(mesh.spatialIndexPadding).toBe(0);
    });

    it("returns false when there is no tree yet", () => {
        const bvh = new TriangleBVH();
        expect(bvh.refit(new Float32Array(9), new Uint32Array([0, 1, 2]))).toBe(false);
    });

    it("leaves every box enclosing its triangles after vertices move", () => {
        // A refit deliberately keeps the original partition, so the tree is not
        // identical to a fresh build (which would re-split on new centroids).
        // What must hold is the traversal invariant: every box encloses its own
        // triangles, and every parent encloses its children.
        const mesh = sphereMesh(3);
        for (let i = 0; i < mesh.vertices.length; i += 3) {
            mesh.vertices[i + 1] += 0.05 * Math.sin(i);
        }
        expect(mesh.triangleBVH.refit(mesh.vertices, mesh.faces)).toBe(true);

        const order = mesh.triangleBVH._triOrder;
        const encloses = (outer, inner) =>
            outer.minX <= inner.minX + 1e-6 && outer.maxX >= inner.maxX - 1e-6 &&
            outer.minY <= inner.minY + 1e-6 && outer.maxY >= inner.maxY - 1e-6 &&
            outer.minZ <= inner.minZ + 1e-6 && outer.maxZ >= inner.maxZ - 1e-6;

        let leaves = 0;
        const walk = (node) => {
            if (node.leaf) {
                leaves++;
                for (let i = node.begin; i < node.end; i++) {
                    const base = order[i] * 3;
                    for (let c = 0; c < 3; c++) {
                        const v = mesh.faces[base + c] * 3;
                        const p = {
                            minX: mesh.vertices[v], maxX: mesh.vertices[v],
                            minY: mesh.vertices[v + 1], maxY: mesh.vertices[v + 1],
                            minZ: mesh.vertices[v + 2], maxZ: mesh.vertices[v + 2]
                        };
                        expect(encloses(node.box, p)).toBe(true);
                    }
                }
                return;
            }
            expect(encloses(node.box, node.left.box)).toBe(true);
            expect(encloses(node.box, node.right.box)).toBe(true);
            walk(node.left);
            walk(node.right);
        };
        walk(mesh.triangleBVH.root);
        expect(leaves).toBeGreaterThan(10);
    });

    it("keeps raycast results identical through a stroke", () => {
        const viaRefit = new SculptEngine();
        viaRefit.loadPrimitive("sphere", 3);
        viaRefit.activeBrush = "standard";
        viaRefit.brushStrength = 1.0;

        const viaRebuild = new SculptEngine();
        viaRebuild.loadPrimitive("sphere", 3);
        viaRebuild.activeBrush = "standard";
        viaRebuild.brushStrength = 1.0;
        viaRebuild.mesh.refreshSpatialIndexForMovedVertices = function () {
            this.buildOctree();
        };

        for (const engine of [viaRefit, viaRebuild]) {
            engine.startStroke();
            for (let i = 0; i < 25; i++) {
                const hit = engine.getHitInfo(W / 2 + i, H / 2, W, H);
                if (hit) engine.applyBrushAtHit(hit, false, null, null);
            }
            engine.endStroke();
        }

        expect(Array.from(viaRefit.mesh.vertices)).toEqual(Array.from(viaRebuild.mesh.vertices));

        const a = castRays(viaRefit);
        const b = castRays(viaRebuild);
        expect(a.map((h) => !!h)).toEqual(b.map((h) => !!h));
        for (let i = 0; i < a.length; i++) {
            if (!a[i] || !b[i]) continue;
            expect(a[i].point[0]).toBeCloseTo(b[i].point[0], 6);
            expect(a[i].point[1]).toBeCloseTo(b[i].point[1], 6);
            expect(a[i].point[2]).toBeCloseTo(b[i].point[2], 6);
        }
    });

    it("can defer the release-time refresh and flush it during idle time", () => {
        const engine = new SculptEngine();
        engine.loadPrimitive("sphere", 4);
        engine.startStroke();
        const hit = engine.getHitInfo(W / 2, H / 2, W, H);
        engine.applyBrushAtHit(hit);
        const refresh = vi.spyOn(engine.mesh, "refreshSpatialIndexForMovedVertices");

        engine.endStroke({ deferSpatialRefresh: true });
        expect(refresh).not.toHaveBeenCalled();
        expect(engine.octreeDirty).toBe(true);
        expect(engine.flushSpatialIndex()).toBe(true);
        expect(refresh).toHaveBeenCalledOnce();
        expect(engine.octreeDirty).toBe(false);
    });

    it("still rebuilds when adaptive refine changes topology", () => {
        const mesh = sphereMesh(3);
        const faceCountBefore = mesh.faceCount;
        const seeds = [];
        for (let i = 0; i < 200; i++) seeds.push(i);

        const result = mesh.refineRegionForBrush(seeds, {
            center: mesh.getVertex(0),
            radius: 0.4,
            targetEdgeLength: 0.02,
            maxSplitEdges: 200,
            maxAddedVertices: 240,
            maxVertexCount: 260000
        });

        expect(result.changed).toBe(true);
        expect(mesh.faceCount).toBeGreaterThan(faceCountBefore);
        // refineRegionForBrush must leave a tree that matches the new topology.
        const rebuilt = new TriangleBVH();
        rebuilt.build(mesh.vertices, mesh.faces);
        expect(JSON.stringify(mesh.triangleBVH.root)).toBe(JSON.stringify(rebuilt.root));
    });

    it("refreshSpatialIndexForMovedVertices rebuilds a tree that was never built", () => {
        const mesh = sphereMesh(2);
        mesh.triangleBVH = new TriangleBVH();
        mesh.refreshSpatialIndexForMovedVertices();
        expect(mesh.triangleBVH.isBuilt).toBe(true);
    });
});
