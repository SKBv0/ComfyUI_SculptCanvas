import { afterEach, describe, expect, it } from "vitest";
import {
    BufferGeometry,
    Float32BufferAttribute,
    LoadingManager,
    Mesh,
    MeshBasicMaterial,
    Scene,
    Texture
} from "three";
import {
    compactTriangleGeometry,
    createLoadingManagerBarrier,
    extractMeshGeometry,
    selectFallbackDiffuseFile
} from "../scripts/parseThreeMeshEntry.js";

afterEach(() => {
    delete globalThis.document;
});

describe("multi-material texture atlas seams", () => {
    it("rejects an ambiguous multi-UDIM folder fallback", () => {
        const textures = new Map([
            ["1001", { name: "DRAGON_BaseColor.1001.jpg" }],
            ["1002", { name: "DRAGON_BaseColor.1002.jpg" }],
            ["normal", { name: "DRAGON_Normal.1001.jpg" }]
        ]);
        expect(selectFallbackDiffuseFile(textures)).toBeNull();
    });

    it("keeps a unique diffuse fallback beside non-color maps", () => {
        const diffuse = { name: "body_BaseColor.jpg" };
        const textures = new Map([
            ["diffuse", diffuse],
            ["normal", { name: "body_Normal.jpg" }],
            ["roughness", { name: "body_Roughness.jpg" }]
        ]);
        expect(selectFallbackDiffuseFile(textures)).toBe(diffuse);
    });

    it("waits for LoadingManager resources that finish after parse returns", async () => {
        const manager = new LoadingManager();
        const barrier = createLoadingManagerBarrier(manager, 100);
        manager.itemStart("delayed-diffuse.jpg");

        let settled = false;
        const waiting = barrier.wait().then(() => {
            settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(false);

        manager.itemEnd("delayed-diffuse.jpg");
        await waiting;
        expect(settled).toBe(true);
        barrier.restore();
    });

    it("duplicates only vertices shared across different texture tiles", () => {
        globalThis.document = {
            createElement: () => ({
                width: 0,
                height: 0,
                getContext: () => ({
                    drawImage() {},
                    fillRect() {},
                    fillStyle: ""
                })
            })
        };

        const geometry = new BufferGeometry();
        geometry.setAttribute("position", new Float32BufferAttribute([
            -1, -1, 0,
             1, -1, 0,
             1,  1, 0,
            -1,  1, 0
        ], 3));
        geometry.setAttribute("uv", new Float32BufferAttribute([
            0, 0, 1, 0, 1, 1, 0, 1
        ], 2));
        geometry.setIndex([0, 1, 2, 0, 2, 3]);
        geometry.addGroup(0, 3, 0);
        geometry.addGroup(3, 3, 1);

        const imageA = { width: 16, height: 16 };
        const imageB = { width: 16, height: 16 };
        const materialA = new MeshBasicMaterial({ map: new Texture(imageA) });
        const materialB = new MeshBasicMaterial({ map: new Texture(imageB) });
        const root = new Scene();
        root.add(new Mesh(geometry, [materialA, materialB]));

        const result = extractMeshGeometry(root);
        const firstFace = new Set(result.faces.slice(0, 3));
        const secondFace = new Set(result.faces.slice(3, 6));
        const sharedIndices = [...firstFace].filter((index) => secondFace.has(index));

        expect(result.vertices).toHaveLength(18); // 4 originals + 2 seam duplicates
        expect(sharedIndices).toEqual([]);
        expect(result.diffuseImage).not.toBe(imageA);
        expect(result.uvs).toHaveLength(12);
        expect(result.vertexOwners).toEqual([0, 0, 0, 0, 0, 0]);
    });

    it("normalizes offset UDIM coordinates before packing atlas tiles", () => {
        globalThis.document = {
            createElement: () => ({
                width: 0,
                height: 0,
                getContext: () => ({ drawImage() {}, fillRect() {}, fillStyle: "" })
            })
        };
        const root = new Scene();
        const imageA = { width: 16, height: 16 };
        const imageB = { width: 16, height: 16 };
        const makeTriangle = (offset, image) => {
            const geometry = new BufferGeometry();
            geometry.setAttribute("position", new Float32BufferAttribute([
                offset, 0, 0, offset + 1, 0, 0, offset, 1, 0
            ], 3));
            geometry.setAttribute("uv", new Float32BufferAttribute([
                offset, 0, offset + 1, 0, offset, 1
            ], 2));
            return new Mesh(geometry, new MeshBasicMaterial({ map: new Texture(image) }));
        };
        root.add(makeTriangle(0, imageA));
        root.add(makeTriangle(1, imageB));

        const result = extractMeshGeometry(root);
        const secondFace = result.faces.slice(3, 6);
        const secondU = secondFace.map((index) => result.uvs[index * 2]);
        expect(Math.min(...secondU)).toBeCloseTo(0.5, 6);
        expect(Math.max(...secondU)).toBeCloseTo(1.0, 6);
    });

    it("maps canvas atlas rows to the V bands produced by WebGL Y-flip", () => {
        globalThis.document = {
            createElement: () => ({
                width: 0,
                height: 0,
                getContext: () => ({ drawImage() {}, fillRect() {}, fillStyle: "" })
            })
        };
        const root = new Scene();
        for (let tile = 0; tile < 4; tile++) {
            const geometry = new BufferGeometry();
            geometry.setAttribute("position", new Float32BufferAttribute([
                tile, 0, 0, tile + 0.5, 0, 0, tile, 0.5, 0
            ], 3));
            geometry.setAttribute("uv", new Float32BufferAttribute([
                0, 0, 1, 0, 0, 1
            ], 2));
            const image = { width: 16, height: 16, tile };
            root.add(new Mesh(geometry, new MeshBasicMaterial({ map: new Texture(image) })));
        }

        const result = extractMeshGeometry(root);
        const firstV = result.faces.slice(0, 3).map((index) => result.uvs[index * 2 + 1]);
        const lastV = result.faces.slice(9, 12).map((index) => result.uvs[index * 2 + 1]);

        expect(Math.min(...firstV)).toBeCloseTo(0.5, 6);
        expect(Math.max(...firstV)).toBeCloseTo(1.0, 6);
        expect(Math.min(...lastV)).toBeCloseTo(0.0, 6);
        expect(Math.max(...lastV)).toBeCloseTo(0.5, 6);
    });
});

describe("loader corner compaction", () => {
    it("indexes repeated triangle corners without merging a UV seam", () => {
        const result = compactTriangleGeometry(
            [
                0, 0, 0, 1, 0, 0, 1, 1, 0,
                0, 0, 0, 1, 1, 0, 0, 1, 0,
                // Same position as vertex 0 but a different UV: must remain split.
                0, 0, 0
            ],
            [0, 1, 2, 3, 4, 5, 6, 1, 2],
            [
                0, 0, 1, 0, 1, 1,
                0, 0, 1, 1, 0, 1,
                0.5, 0.5
            ],
            [0, 0, 0, 0, 0, 0, 0]
        );

        expect(result.vertices).toHaveLength(15); // four shared corners + one UV seam
        expect(result.faces).toEqual([0, 1, 2, 0, 2, 3, 4, 1, 2]);
        expect(result.uvs).toHaveLength(10);
    });

    it("does not weld coincident vertices owned by separate mesh objects", () => {
        const result = compactTriangleGeometry(
            [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0],
            [0, 1, 2, 3, 4, 5],
            [],
            [0, 0, 0, 1, 1, 1]
        );
        expect(result.vertices).toHaveLength(18);
        expect(result.faces).toEqual([0, 1, 2, 3, 4, 5]);
    });
});
