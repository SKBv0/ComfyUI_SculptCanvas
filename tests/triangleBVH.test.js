import { describe, it, expect } from "vitest";
import { TriangleBVH } from "../js/engine/TriangleBVH.js";

const EPS = 1e-6;
const BACKFACE = -0.04;

describe("TriangleBVH", () => {
    it("hits triangle with ray along -Z", () => {
        const vertices = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
        const faces = new Uint32Array([0, 1, 2]);
        const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
        const bvh = new TriangleBVH();
        bvh.build(vertices, faces);
        expect(bvh.isBuilt).toBe(true);
        const hit = bvh.intersectClosest(
            0.25, 0.25, 1,
            0, 0, -1,
            vertices, faces, normals,
            EPS,
            BACKFACE
        );
        expect(hit).not.toBeNull();
        expect(hit.point[0]).toBeCloseTo(0.25, 3);
        expect(hit.point[1]).toBeCloseTo(0.25, 3);
        expect(hit.point[2]).toBeCloseTo(0, 3);
    });

    it("returns null for empty mesh", () => {
        const vertices = new Float32Array([]);
        const faces = new Uint32Array([]);
        const normals = new Float32Array([]);
        const bvh = new TriangleBVH();
        bvh.build(vertices, faces);
        expect(bvh.isBuilt).toBe(false);
        const hit = bvh.intersectClosest(0, 0, 5, 0, 0, -1, vertices, faces, normals, EPS, BACKFACE);
        expect(hit).toBeNull();
    });

    it("returns null when ray misses AABB", () => {
        const vertices = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
        const faces = new Uint32Array([0, 1, 2]);
        const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
        const bvh = new TriangleBVH();
        bvh.build(vertices, faces);
        const hit = bvh.intersectClosest(
            5, 5, 1,
            0, 0, -1,
            vertices, faces, normals,
            EPS,
            BACKFACE
        );
        expect(hit).toBeNull();
    });
});

it("builds large equal-centroid meshes without quadratic selection", () => {
    const vertices = new Float32Array([0,0,0,1,0,0,0,1,0]);
    const faces = Uint32Array.from({ length: 300000 }, (_, i) => i % 3);
    const bvh = new TriangleBVH();
    const start = performance.now();
    bvh.build(vertices, faces);
    expect(performance.now() - start).toBeLessThan(3000);
    expect(bvh._triOrder.length).toBe(100000);
    expect(new Set(bvh._triOrder).size).toBe(100000);
});

it.each([false, true])("preserves hits with sorted centroid order (reversed=%s)", (reversed) => {
    const vertices = [], faces = [], normals = [];
    for (let i = 0; i < 500; i++) {
        const x = reversed ? 499 - i : i;
        vertices.push(x,0,0,x+0.5,0,0,x,0.5,0);
        faces.push(i*3,i*3+1,i*3+2);
        normals.push(0,0,1,0,0,1,0,0,1);
    }
    const bvh = new TriangleBVH();
    bvh.build(new Float32Array(vertices), new Uint32Array(faces));
    for (const x of [0.1, 111.1, 499.1]) {
        const hit = bvh.intersectClosest(x,0.1,1,0,0,-1,vertices,faces,normals,EPS,BACKFACE);
        expect(hit?.point[0]).toBeCloseTo(x);
    }
});
