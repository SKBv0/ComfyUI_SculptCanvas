/**
 * Engine-level behavior tests: raycasting, brush application, the undo/redo
 * roundtrip, and geometry-revision semantics. These run DOM-free, since the
 * engine module has no browser dependencies.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { SculptEngine } from "../js/engine/SculptEngine.js";
import { Mesh } from "../js/engine/Mesh.js";
import { WebGLRenderer } from "../js/renderer/WebGLRenderer.js";
import {
    OFFSCREEN_CONTEXT_RELEASE_MS,
    SculptCanvas
} from "../js/ui/SculptCanvas.js";
import { getAffectedVertices } from "../js/engine/Brush.js";

const W = 512;
const H = 512;
const CENTER = [W / 2, H / 2];

function snapshot(engine) {
    return Float32Array.from(engine.mesh.vertices);
}

function maxDiff(engine, snap) {
    const v = engine.mesh.vertices;
    let m = 0;
    for (let i = 0; i < v.length; i++) {
        const d = Math.abs(v[i] - snap[i]);
        if (d > m) m = d;
    }
    return m;
}

function applyStroke(engine, dabs = 10) {
    engine.startStroke();
    for (let i = 0; i < dabs; i++) {
        const hit = engine.getHitInfo(CENTER[0], CENTER[1], W, H);
        expect(hit).not.toBeNull();
        engine.applyBrushAtHit(hit, false, null, null);
    }
    engine.endStroke();
}

describe("SculptEngine raycast + brush", () => {
    let engine;
    beforeEach(() => {
        engine = new SculptEngine();
        engine.loadPrimitive("sphere", 3);
    });

    it("raycasts a hit at screen center with the default camera", () => {
        const hit = engine.getHitInfo(CENTER[0], CENTER[1], W, H);
        expect(hit).not.toBeNull();
        expect(hit.point).toHaveLength(3);
        expect(hit.normal).toHaveLength(3);
        // Default camera orbits a unit sphere at distance 3: the hit sits on
        // the surface, roughly one unit from the origin.
        const r = Math.hypot(...hit.point);
        expect(r).toBeGreaterThan(0.8);
        expect(r).toBeLessThan(1.3);
    });

    it("misses when aiming at empty space", () => {
        expect(engine.getHitInfo(5, 5, W, H)).toBeNull();
    });

    it("a stroke of dabs visibly deforms the mesh", () => {
        const before = snapshot(engine);
        applyStroke(engine);
        expect(maxDiff(engine, before)).toBeGreaterThan(1e-4);
    });

    it("bumps geometryRevision only when a stroke actually applied dabs", () => {
        const rev = engine.geometryRevision;
        engine.startStroke();
        engine.endStroke(); // no dabs
        expect(engine.geometryRevision).toBe(rev);
        applyStroke(engine, 3);
        expect(engine.geometryRevision).toBe(rev + 1);
    });
});

describe("Clay interactive topology budget", () => {
    it("skips global refinement once the mesh is already dense", () => {
        const engine = new SculptEngine();
        engine.loadPrimitive("sphere", 5);
        engine.activeBrush = "clay";
        engine.startStroke();
        const refine = vi.spyOn(engine.mesh, "refineRegionForBrush");
        const hit = engine.getHitInfo(CENTER[0], CENTER[1], W, H);

        engine.applyBrushAtHit(hit, false, null, {
            strokeContext: { speedPxPerSec: 0, applyMs: 0 }
        });

        expect(engine.mesh.vertexCount).toBeGreaterThan(engine.maxInteractiveRefineVertexCount);
        expect(refine).not.toHaveBeenCalled();
        engine.endStroke();
    });
});

describe("new-node sculpt readability", () => {
    it("starts with red wax and a key light separated from the default camera", () => {
        const engine = new SculptEngine();
        expect(engine.baseColor).toEqual([0.38, 0.08, 0.02]);
        expect(engine.lightingPreset).toBe("zbrush_red_wax");

        const renderer = Object.create(WebGLRenderer.prototype);
        renderer.canvas = { style: {} };
        renderer._applyCanvasBackground = vi.fn();
        renderer.setLightingPreset(engine.lightingPreset);

        const cameraDirection = [
            Math.sin(engine.camera.theta) * Math.cos(engine.camera.phi),
            Math.sin(engine.camera.phi),
            Math.cos(engine.camera.theta) * Math.cos(engine.camera.phi)
        ];
        const keyDirection = renderer._rotateDirection(
            renderer.lightRig.keyDir,
            engine.lightYaw,
            engine.lightPitch
        );
        const cameraKeyAlignment = cameraDirection[0] * keyDirection[0]
            + cameraDirection[1] * keyDirection[1]
            + cameraDirection[2] * keyDirection[2];

        // A near-1.0 alignment is flat headlight shading. The side-lit default
        // must retain enough front contribution while revealing normal changes.
        expect(cameraKeyAlignment).toBeGreaterThan(0.25);
        expect(cameraKeyAlignment).toBeLessThan(0.70);
        const rimDirection = renderer._rotateDirection(
            renderer.lightRig.rimDir,
            engine.lightYaw,
            engine.lightPitch
        );
        const cameraRimAlignment = cameraDirection[0] * rimDirection[0]
            + cameraDirection[1] * rimDirection[1]
            + cameraDirection[2] * rimDirection[2];
        // The default rim must truly come from behind the object, not from a
        // second frontal/top direction that flattens the silhouette.
        expect(cameraRimAlignment).toBeLessThan(-0.70);
        expect(renderer.lightRig.rimIntensity / renderer.lightRig.fillIntensity).toBeGreaterThan(2.3);
        // The default working light must describe shallow relief without
        // requiring an orbit: a dominant side key, restrained fill/ambient.
        const shadowFill = renderer.lightRig.fillIntensity + renderer.lightRig.ambient;
        expect(renderer.lightRig.keyIntensity / shadowFill).toBeGreaterThan(1.7);
    });
});

describe("WebGL grid depth isolation", () => {
    it("draws the reference grid without writing mesh-occluding depth", () => {
        const depthMask = vi.fn();
        const gl = {
            BLEND: 1,
            SRC_ALPHA: 2,
            ONE_MINUS_SRC_ALPHA: 3,
            CULL_FACE: 4,
            ARRAY_BUFFER: 5,
            FLOAT: 6,
            TRIANGLES: 7,
            useProgram: vi.fn(),
            enable: vi.fn(),
            disable: vi.fn(),
            blendFunc: vi.fn(),
            depthMask,
            bindBuffer: vi.fn(),
            enableVertexAttribArray: vi.fn(),
            vertexAttribPointer: vi.fn(),
            uniformMatrix4fv: vi.fn(),
            uniform1f: vi.fn(),
            drawArrays: vi.fn()
        };
        const renderer = Object.create(WebGLRenderer.prototype);
        Object.assign(renderer, {
            gl,
            gridProgram: {
                aPosition: 0,
                uModelView: {},
                uProjection: {},
                uGridOffsetY: {}
            },
            gridBuffer: {},
            gridOffsetY: -1
        });

        renderer._drawGrid(new Float32Array(16), new Float32Array(16));

        expect(depthMask.mock.calls).toEqual([[false], [true]]);
    });
});

describe("WebGL incremental mesh uploads", () => {
    function makeIncrementalRenderer(gl) {
        const renderer = Object.create(WebGLRenderer.prototype);
        Object.assign(renderer, {
            gl,
            contextLost: false,
            vertexBuffer: { id: "position" },
            normalBuffer: { id: "normal" },
            uvBuffer: { id: "uv" },
            maskBuffer: { id: "mask" },
            _vertexBufferLength: 9,
            _normalBufferLength: 9,
            _uvBufferLength: 6,
            _maskBufferLength: 3,
            indexCount: 3,
            _maskZeroScratch: null,
            _uvDummyScratch: new Float32Array(6)
        });
        return renderer;
    }

    it("updates only the dirty mask range for a mask-only dab", () => {
        let boundBuffer = null;
        const uploads = [];
        const gl = {
            ARRAY_BUFFER: 1,
            DYNAMIC_DRAW: 2,
            bindBuffer: vi.fn((target, buffer) => { boundBuffer = buffer; }),
            bufferData: vi.fn(),
            bufferSubData: vi.fn((target, offset, data) => {
                uploads.push({ buffer: boundBuffer, offset, bytes: data.byteLength });
            })
        };
        const renderer = makeIncrementalRenderer(gl);
        const mesh = {
            vertexCount: 3,
            vertices: new Float32Array(9),
            normals: new Float32Array(9),
            uvs: new Float32Array(6),
            vertexMask: new Float32Array([0, 1, 0]),
            faces: new Uint32Array([0, 1, 2])
        };

        renderer.updateMesh(mesh, {
            topologyChanged: false,
            dirtyRanges: [{ start: 1, count: 1 }],
            maskChanged: true
        });

        expect(gl.bufferData).not.toHaveBeenCalled();
        expect(uploads).toEqual([
            { buffer: renderer.maskBuffer, offset: 4, bytes: 4 }
        ]);
    });

    it("uploads position and expanded normal ranges without resending full buffers", () => {
        let boundBuffer = null;
        const uploads = [];
        const gl = {
            ARRAY_BUFFER: 1,
            DYNAMIC_DRAW: 2,
            bindBuffer: vi.fn((target, buffer) => { boundBuffer = buffer; }),
            bufferData: vi.fn(),
            bufferSubData: vi.fn((target, offset, data) => {
                uploads.push({ buffer: boundBuffer.id, offset, bytes: data.byteLength });
            })
        };
        const renderer = makeIncrementalRenderer(gl);
        const mesh = {
            vertexCount: 3,
            vertices: new Float32Array(9),
            normals: new Float32Array(9),
            uvs: new Float32Array(6),
            vertexMask: new Float32Array(3),
            faces: new Uint32Array([0, 1, 2])
        };

        renderer.updateMesh(mesh, {
            topologyChanged: false,
            dirtyRanges: [{ start: 1, count: 1 }],
            normalDirtyRanges: [{ start: 0, count: 3 }]
        });

        expect(gl.bufferData).not.toHaveBeenCalled();
        expect(uploads).toEqual([
            { buffer: "position", offset: 12, bytes: 12 },
            { buffer: "normal", offset: 0, bytes: 36 }
        ]);
    });
});

describe("SculptEngine camera basis", () => {
    it("frames an off-center mesh and can restore the default orbit", () => {
        const engine = new SculptEngine();
        engine.mesh.setData(
            new Float32Array([10, 2, 0, 12, 2, 0, 10, 4, 0]),
            new Uint32Array([0, 1, 2])
        );
        engine.camera.theta = -2;
        engine.camera.phi = -1;

        expect(engine.frameCamera(true)).toBe(true);
        expect(engine.camera.target).toEqual([11, 3, 0]);
        expect(engine.camera.theta).toBeCloseTo(Math.PI / 4, 8);
        expect(engine.camera.phi).toBeCloseTo(Math.PI / 6, 8);
        expect(engine.camera.distance).toBeGreaterThan(0.2);
    });

    it("keeps a finite orthonormal view basis when view direction is parallel to world up", () => {
        const engine = new SculptEngine();
        engine.camera.phi = Math.PI / 2;
        const view = engine.getViewMatrix();
        expect(Array.from(view).every(Number.isFinite)).toBe(true);
        const xLen = Math.hypot(view[0], view[4], view[8]);
        const yLen = Math.hypot(view[1], view[5], view[9]);
        const zLen = Math.hypot(view[2], view[6], view[10]);
        expect(xLen).toBeCloseTo(1, 5);
        expect(yLen).toBeCloseTo(1, 5);
        expect(zLen).toBeCloseTo(1, 5);
    });

    it("keeps restored orbit and clipping planes inside renderable invariants", () => {
        const engine = new SculptEngine();
        const originalNear = engine.camera.near;
        const originalFar = engine.camera.far;
        const originalTarget = [...engine.camera.target];

        expect(engine.restoreCameraState({
            theta: 1e6,
            phi: 1e6,
            near: 1000,
            target: [1e300, 0, 0]
        })).toBe(true);

        expect(engine.camera.theta).toBeGreaterThanOrEqual(-Math.PI);
        expect(engine.camera.theta).toBeLessThan(Math.PI);
        expect(Math.abs(engine.camera.phi)).toBeLessThan(Math.PI / 2);
        expect(engine.camera.near).toBe(originalNear);
        expect(engine.camera.far).toBe(originalFar);
        expect(engine.camera.target).toEqual(originalTarget);
        expect(Array.from(engine.getViewMatrix()).every(Number.isFinite)).toBe(true);
        expect(Array.from(engine.getProjectionMatrix(1)).every(Number.isFinite)).toBe(true);
    });

    it("serializes mask paint mode with the rest of the tool state", () => {
        const engine = new SculptEngine();
        engine.loadPrimitive("sphere", 2);
        engine.maskPaintMode = true;
        expect(engine.serialize().toolSettings.maskPaintMode).toBe(true);
        expect(engine.serializeForWidget().toolSettings.maskPaintMode).toBe(true);
    });

    it("keeps full and widget serialization common state identical", () => {
        const engine = new SculptEngine();
        engine.loadPrimitive("sphere", 2);
        engine.maxWidgetSerializeVertices = 0;
        engine.activeBrush = "pinch";
        engine.brushRadius = 0.37;
        engine.camera.distance = 4.2;
        engine.showGrid = false;
        const full = engine.serialize();
        const widget = engine.serializeForWidget();
        for (const key of [
            "camera", "baseColor", "matcapIntensity", "lightingPreset",
            "lightPower", "lightYaw", "lightPitch", "showWireframe",
            "showGrid", "toolSettings"
        ]) {
            expect(widget[key]).toEqual(full[key]);
        }
    });
});

describe("SculptEngine object orientation", () => {
    it("bakes a centered quarter turn while preserving UVs, mask, and distances", () => {
        const engine = new SculptEngine();
        engine.mesh.setData(
            [0, 0, 0, 2, 0, 0, 0, 1, 0],
            [0, 1, 2],
            [0, 0, 1, 0, 0, 1]
        );
        engine.mesh.applyVertexMaskFromArray([0.1, 0.2, 0.3]);
        engine._resetState();
        const beforeRevision = engine.geometryRevision;

        expect(engine.rotateObject("x", Math.PI / 2)).toBe(true);
        expect(Array.from(engine.mesh.vertices)).toEqual([
            0, 0.5, -0.5,
            2, 0.5, -0.5,
            0, 0.5, 0.5
        ]);
        expect(Array.from(engine.mesh.uvs)).toEqual([0, 0, 1, 0, 0, 1]);
        expect(Array.from(engine.mesh.vertexMask)).toEqual([
            expect.closeTo(0.1, 5), expect.closeTo(0.2, 5), expect.closeTo(0.3, 5)
        ]);
        expect(engine.geometryRevision).toBe(beforeRevision + 1);
        expect(engine.canUndo()).toBe(true);
        expect(engine.serialize().vertices).toEqual(Array.from(engine.mesh.vertices));
    });

    it("undoes and redoes a baked orientation exactly", () => {
        const engine = new SculptEngine();
        engine.loadPrimitive("cube", 2);
        const original = Float32Array.from(engine.mesh.vertices);
        engine.rotateObject("z", -Math.PI / 2);
        const rotated = Float32Array.from(engine.mesh.vertices);

        expect(engine.undo()).toBe(true);
        expect(engine.mesh.vertices).toEqual(original);
        expect(engine.redo()).toBe(true);
        expect(engine.mesh.vertices).toEqual(rotated);
    });

    it("rejects invalid and zero rotations without dirtying history", () => {
        const engine = new SculptEngine();
        engine.loadPrimitive("sphere", 1);
        expect(engine.rotateObject("q", Math.PI / 2)).toBe(false);
        expect(engine.rotateObject("x", Number.NaN)).toBe(false);
        expect(engine.rotateObject("x", Math.PI * 2)).toBe(false);
        expect(engine.canUndo()).toBe(false);
    });
});

describe("brush spatial-query fallback", () => {
    it("treats an empty octree result as definitive instead of scanning every vertex", () => {
        const vertices = new Proxy({}, {
            get() {
                throw new Error("full vertex scan should not run");
            }
        });
        const mesh = {
            vertices,
            vertexCount: 100,
            queryVerticesInRadius: () => [],
            neighbors: []
        };
        expect(getAffectedVertices(mesh, [0, 0, 0], 0.01)).toEqual([]);
    });
});

describe("SculptEngine undo/redo", () => {
    let engine;
    beforeEach(() => {
        engine = new SculptEngine();
        engine.loadPrimitive("sphere", 3);
    });

    it("undo restores the pre-stroke mesh exactly; redo re-applies it", () => {
        const original = snapshot(engine);
        expect(engine.canUndo()).toBe(false);

        applyStroke(engine);
        const sculpted = snapshot(engine);
        expect(engine.canUndo()).toBe(true);
        expect(maxDiff(engine, original)).toBeGreaterThan(1e-4);

        expect(engine.undo()).toBe(true);
        expect(maxDiff(engine, original)).toBeLessThan(1e-6);
        expect(engine.canRedo()).toBe(true);

        expect(engine.redo()).toBe(true);
        expect(maxDiff(engine, sculpted)).toBeLessThan(1e-6);
    });

    it("a new stroke clears the redo stack", () => {
        applyStroke(engine);
        engine.undo();
        expect(engine.canRedo()).toBe(true);
        applyStroke(engine, 2);
        expect(engine.canRedo()).toBe(false);
    });

    it("undo/redo bump geometryRevision (persistence must see the change)", () => {
        applyStroke(engine);
        const rev = engine.geometryRevision;
        engine.undo();
        expect(engine.geometryRevision).toBeGreaterThan(rev);
        const rev2 = engine.geometryRevision;
        engine.redo();
        expect(engine.geometryRevision).toBeGreaterThan(rev2);
    });
});

describe("textured sculpt UV invariants", () => {
    it("keeps imported UVs byte-for-byte unchanged during a regular brush stroke", () => {
        const engine = new SculptEngine();
        engine.loadPrimitive("sphere", 3);
        const uvs = new Float32Array(engine.mesh.vertexCount * 2);
        for (let i = 0; i < engine.mesh.vertexCount; i++) {
            uvs[i * 2] = (i % 17) / 16;
            uvs[i * 2 + 1] = (i % 13) / 12;
        }
        engine.mesh.uvs = uvs;
        const before = new Uint8Array(uvs.buffer.slice(0));

        applyStroke(engine, 4);

        expect(new Uint8Array(engine.mesh.uvs.buffer)).toEqual(before);
    });

    it("interpolates UV midpoints when adaptive refinement splits triangle edges", () => {
        const mesh = new Mesh();
        mesh.setData(
            [0, 0, 0, 2, 0, 0, 0, 2, 0],
            [0, 1, 2],
            [0, 0, 1, 0, 0, 1]
        );

        const result = mesh.refineRegionForBrush([0, 1, 2], {
            center: [0.5, 0.5, 0],
            radius: 3,
            targetEdgeLength: 0.1,
            maxVertexCount: 100
        });

        expect(result).toEqual({ changed: true, addedVertices: 3 });
        expect(Array.from(mesh.uvs.slice(6))).toEqual([
            0.5, 0,
            0.5, 0.5,
            0, 0.5
        ]);
    });

    it("keeps coincident UV seam copies distinct while refining both sides atomically", () => {
        const mesh = new Mesh();
        mesh.setData(
            [
                0, 0, 0, 2, 0, 0, 0, 2, 0,
                0, 0, 0, 2, 0, 0, 0, 2, 0
            ],
            [0, 1, 2, 3, 4, 5],
            [
                0, 0, 1, 0, 0, 1,
                1, 0, 2, 0, 1, 1
            ],
            [0, 0, 0, 0, 0, 0]
        );

        const result = mesh.refineRegionForBrush([0, 3], {
            center: [0.5, 0.5, 0],
            radius: 3,
            targetEdgeLength: 0.1,
            maxVertexCount: 100
        });
        const newSeamGroups = mesh.coincidentGroups.filter(
            (members) => members.length === 2 && members.every((index) => index >= 6)
        );

        expect(result).toEqual({ changed: true, addedVertices: 6 });
        expect(newSeamGroups).toHaveLength(3);
        for (const [a, b] of newSeamGroups) {
            expect(mesh.uvs[b * 2] - mesh.uvs[a * 2]).toBeCloseTo(1, 6);
            expect(mesh.uvs[b * 2 + 1]).toBeCloseTo(mesh.uvs[a * 2 + 1], 6);
        }
    });

    it("restores refined UV topology exactly through clay undo and redo", () => {
        const engine = new SculptEngine();
        engine.loadPrimitive("sphere", 2);
        engine.activeBrush = "clay";
        const uvs = new Float32Array(engine.mesh.vertexCount * 2);
        for (let i = 0; i < engine.mesh.vertexCount; i++) {
            uvs[i * 2] = (i % 11) / 10;
            uvs[i * 2 + 1] = (i % 7) / 6;
        }
        engine.mesh.uvs = uvs;
        const originalUvs = Float32Array.from(uvs);
        const originalVertexCount = engine.mesh.vertexCount;

        engine.startStroke();
        const hit = engine.getHitInfo(CENTER[0], CENTER[1], W, H);
        engine.applyBrushAtHit(hit, false, null, {
            strokeContext: { speedPxPerSec: 0, applyMs: 0 }
        });
        engine.endStroke();

        const refinedUvs = Float32Array.from(engine.mesh.uvs);
        const refinedVertexCount = engine.mesh.vertexCount;
        expect(refinedVertexCount).toBeGreaterThan(originalVertexCount);
        expect(engine.undo()).toBe(true);
        expect(engine.mesh.vertexCount).toBe(originalVertexCount);
        expect(engine.mesh.uvs).toEqual(originalUvs);
        expect(engine.redo()).toBe(true);
        expect(engine.mesh.vertexCount).toBe(refinedVertexCount);
        expect(engine.mesh.uvs).toEqual(refinedUvs);
    });
});

describe("SculptEngine per-brush behavior", () => {
    const DISPLACEMENT_BRUSHES = [
        "standard", "smooth", "inflate", "flatten", "pinch", "crease", "clay", "trim"
    ];

    for (const brush of DISPLACEMENT_BRUSHES) {
        for (const invert of [false, true]) {
            it(`${brush}${invert ? " (invert)" : ""} deforms without NaN`, () => {
                const engine = new SculptEngine();
                engine.loadPrimitive("sphere", 3);
                engine.activeBrush = brush;
                const before = snapshot(engine);
                engine.startStroke();
                for (let i = 0; i < 8; i++) {
                    const hit = engine.getHitInfo(CENTER[0], CENTER[1], W, H);
                    expect(hit).not.toBeNull();
                    engine.applyBrushAtHit(hit, invert, null, null);
                }
                engine.endStroke();
                const v = engine.mesh.vertices;
                for (let i = 0; i < v.length; i++) {
                    expect(Number.isFinite(v[i])).toBe(true);
                }
                // Smooth on a perfect sphere barely moves; every other brush must.
                const min = brush === "smooth" ? 1e-7 : 5e-4;
                expect(maxDiff(engine, before)).toBeGreaterThan(min);
            });
        }
    }

    it("move brush follows moveDelta", () => {
        const engine = new SculptEngine();
        engine.loadPrimitive("sphere", 3);
        engine.activeBrush = "move";
        const before = snapshot(engine);
        engine.startStroke();
        const hit = engine.getHitInfo(CENTER[0], CENTER[1], W, H);
        engine.applyBrushAtHit(hit, false, null, { moveDelta: [0.05, 0, 0] });
        engine.endStroke();
        expect(maxDiff(engine, before)).toBeGreaterThan(1e-3);
    });

    it("snake_hook accumulates drag inertia beyond plain move", () => {
        const run = (brush) => {
            const engine = new SculptEngine();
            engine.loadPrimitive("sphere", 3);
            engine.activeBrush = brush;
            const before = snapshot(engine);
            engine.startStroke();
            for (let i = 0; i < 6; i++) {
                const hit = engine.getHitInfo(CENTER[0], CENTER[1], W, H);
                engine.applyBrushAtHit(hit, false, null, { moveDelta: [0.01, 0, 0] });
            }
            engine.endStroke();
            return maxDiff(engine, before);
        };
        expect(run("snake_hook")).toBeGreaterThan(run("move"));
    });

    it("sharpen (smooth invert) stays bounded on a long held stroke", () => {
        const engine = new SculptEngine();
        engine.loadPrimitive("sphere", 3);
        engine.activeBrush = "standard";
        // Create some relief first so sharpen has deviation to amplify.
        engine.startStroke();
        for (let i = 0; i < 6; i++) {
            const hit = engine.getHitInfo(CENTER[0], CENTER[1], W, H);
            engine.applyBrushAtHit(hit, false, null, null);
        }
        engine.endStroke();

        engine.activeBrush = "smooth";
        engine.brushStrength = 1.0;
        const beforeSharpen = snapshot(engine);
        engine.startStroke();
        for (let i = 0; i < 60; i++) {
            const hit = engine.getHitInfo(CENTER[0], CENTER[1], W, H);
            if (!hit) break;
            engine.applyBrushAtHit(hit, true, null, null); // invert = sharpen
        }
        engine.endStroke();
        const v = engine.mesh.vertices;
        for (let i = 0; i < v.length; i++) {
            expect(Number.isFinite(v[i])).toBe(true);
        }
        // Unclamped this diverged exponentially; the local-scale cap keeps the
        // total excursion in the same order as the mesh itself.
        expect(maxDiff(engine, beforeSharpen)).toBeLessThan(0.5);
    });

    it("mask paint fully protects, subtract fully releases", () => {
        const engine = new SculptEngine();
        engine.loadPrimitive("sphere", 3);
        engine.maskPaintMode = true;
        engine.brushStrength = 1.0; // pinned so the test survives default changes
        engine.startStroke();
        for (let i = 0; i < 40; i++) {
            const hit = engine.getHitInfo(CENTER[0], CENTER[1], W, H);
            engine.applyBrushAtHit(hit, false, null, null); // add mask
        }
        const mask = engine.mesh.vertexMask;
        let sawFull = false;
        for (let i = 0; i < mask.length; i++) if (mask[i] === 1) sawFull = true;
        expect(sawFull).toBe(true);

        for (let i = 0; i < 80; i++) {
            const hit = engine.getHitInfo(CENTER[0], CENTER[1], W, H);
            engine.applyBrushAtHit(hit, true, null, null); // subtract mask
        }
        engine.endStroke();
        let residue = 0;
        for (let i = 0; i < mask.length; i++) if (mask[i] > 0 && mask[i] < 0.01) residue++;
        expect(residue).toBe(0);
    });

    it("draw is the onboarding brush for a fresh engine", () => {
        expect(new SculptEngine().activeBrush).toBe("standard");
    });
});

describe("SculptEngine serialization roundtrip", () => {
    it("rejects finite values that would overflow the Float32 mesh storage", () => {
        const mesh = new Mesh();
        expect(() => mesh.setData(
            [1e300, 0, 0, 1, 0, 0, 0, 1, 0],
            [0, 1, 2]
        )).toThrow(/vertex/);
    });

    it("serialize() output rebuilds an identical mesh via setData()", () => {
        const engine = new SculptEngine();
        // Sphere: the screen-center ray is guaranteed to hit (a torus would
        // put the default camera's center ray through its hole).
        engine.loadPrimitive("sphere", 3);
        applyStroke(engine, 4);

        const data = engine.mesh.serialize();
        const rebuilt = new Mesh();
        rebuilt.setData(data.vertices, data.faces, data.uvs || null);

        expect(rebuilt.vertexCount).toBe(engine.mesh.vertexCount);
        expect(rebuilt.faceCount).toBe(engine.mesh.faceCount);
        let m = 0;
        for (let i = 0; i < rebuilt.vertices.length; i++) {
            const d = Math.abs(rebuilt.vertices[i] - engine.mesh.vertices[i]);
            if (d > m) m = d;
        }
        expect(m).toBeLessThan(1e-6);
    });

    it("serializeBuffers() matches serialize() content", () => {
        const engine = new SculptEngine();
        engine.loadPrimitive("cube", 2);
        const plain = engine.mesh.serialize();
        const buffers = engine.mesh.serializeBuffers();
        expect(Array.from(buffers.vertices)).toEqual(plain.vertices);
        expect(Array.from(buffers.faces)).toEqual(plain.faces);
    });

    it("roundtrips imported object ownership used for UV seam cohesion", () => {
        const mesh = new Mesh();
        mesh.setData(
            [-1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0],
            [0, 1, 2, 3, 4, 5],
            [0, 0, 1, 0, 1, 1, 0, 0, 1, 0, 0, 1],
            [3, 3, 3, 3, 3, 3]
        );
        const plain = mesh.serialize();
        const buffers = mesh.serializeBuffers();
        const rebuilt = new Mesh();
        rebuilt.setData(plain.vertices, plain.faces, plain.uvs, plain.vertexOwners);

        expect(plain.vertexOwners).toEqual([3, 3, 3, 3, 3, 3]);
        expect(Array.from(buffers.vertexOwners)).toEqual(plain.vertexOwners);
        expect(Array.from(rebuilt.vertexOwners)).toEqual(plain.vertexOwners);
        expect(rebuilt.coincidentGroups).toHaveLength(2);
    });
});

describe("WebGL viewport capture", () => {
    it("reads the current framebuffer without requiring preserveDrawingBuffer", () => {
        const readPixels = vi.fn((x, y, width, height, format, type, target) => {
            target.set([1, 2, 3, 4, 5, 6, 7, 8]);
        });
        const renderer = Object.create(WebGLRenderer.prototype);
        renderer.contextLost = false;
        renderer.canvas = { width: 1, height: 2 };
        renderer.gl = {
            RGBA: 6408,
            UNSIGNED_BYTE: 5121,
            finish: vi.fn(),
            readPixels
        };

        const capture = renderer.readViewportPixels();
        expect(capture.width).toBe(1);
        expect(capture.height).toBe(2);
        expect(Array.from(capture.pixels)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
        expect(readPixels).toHaveBeenCalledOnce();
    });

    it("releases an offscreen context after the idle grace period", async () => {
        vi.useFakeTimers();
        const canvas = Object.create(SculptCanvas.prototype);
        const destroy = vi.fn();
        canvas._destroyed = false;
        canvas._visible = false;
        canvas._offscreenReleaseTimer = null;
        canvas.renderer = { destroy };

        canvas._scheduleOffscreenContextRelease();
        await vi.advanceTimersByTimeAsync(OFFSCREEN_CONTEXT_RELEASE_MS + 1);

        expect(destroy).toHaveBeenCalledOnce();
        expect(canvas.renderer).toBeNull();
        vi.useRealTimers();
    });

    it("synchronizes every engine render setting through one canvas owner", () => {
        const canvas = Object.create(SculptCanvas.prototype);
        canvas.requestRender = vi.fn();
        canvas.engine = {
            matcapIntensity: 0,
            lightingPreset: "studio",
            lightPower: 1.5,
            lightYaw: -0.25,
            lightPitch: 0.75,
            showGrid: true,
            showWireframe: true,
            baseColor: [0.1, 0.2, 0.3],
            importedDiffuseImage: { id: "diffuse" },
            showImportedTexture: false
        };
        canvas.renderer = {
            setLightingPreset: vi.fn(),
            setLightControls: vi.fn(),
            setBaseColor: vi.fn(),
            setImportedDiffuse: vi.fn()
        };

        canvas.syncRenderSettings();

        expect(canvas.renderer.matcapIntensity).toBe(0);
        expect(canvas.renderer.setLightingPreset).toHaveBeenCalledWith("studio");
        expect(canvas.renderer.setLightControls).toHaveBeenCalledWith({
            power: 1.5, yaw: -0.25, pitch: 0.75
        });
        expect(canvas.renderer.showGrid).toBe(true);
        expect(canvas.renderer.showWireframe).toBe(true);
        expect(canvas.renderer.setBaseColor).toHaveBeenCalledWith([0.1, 0.2, 0.3]);
        expect(canvas.renderer.setImportedDiffuse).toHaveBeenCalledWith({ id: "diffuse" });
        expect(canvas.renderer.showImportedTexture).toBe(false);
        expect(canvas.requestRender).toHaveBeenCalledOnce();
    });
});

describe("SculptEngine import commit guard", () => {
    it("does not mutate engine state when a completed parse is stale", () => {
        const engine = new SculptEngine();
        engine.loadPrimitive("sphere", 2);
        const beforeVertices = snapshot(engine);
        const beforeRevision = engine.geometryRevision;
        const beforeColor = [...engine.baseColor];
        const ok = engine._applyImportedMesh(
            [0, 0, 0, 1, 0, 0, 0, 1, 0],
            [0, 1, 2],
            [1, 0, 0],
            { importKind: "gltf", shouldApply: () => false }
        );
        expect(ok).toBe(false);
        expect(engine.geometryRevision).toBe(beforeRevision);
        expect(Array.from(engine.mesh.vertices)).toEqual(Array.from(beforeVertices));
        expect(engine.baseColor).toEqual(beforeColor);
    });

    it("closes the previous decoded texture when the mesh is replaced or destroyed", () => {
        const engine = new SculptEngine();
        const image = { close: vi.fn() };
        engine._setImportedDiffuseImage(image);
        engine.loadPrimitive("sphere", 2);
        expect(image.close).toHaveBeenCalledTimes(1);

        const second = { close: vi.fn() };
        engine._setImportedDiffuseImage(second);
        engine.destroy();
        expect(second.close).toHaveBeenCalledTimes(1);
    });

    it("does not partially commit color or texture when imported geometry is invalid", () => {
        const engine = new SculptEngine();
        engine.loadPrimitive("sphere", 2);
        const previousImage = { close: vi.fn() };
        engine._setImportedDiffuseImage(previousImage);
        const beforeColor = [...engine.baseColor];
        expect(() => engine._applyImportedMesh(
            [0, 0, 0, 1, 0, 0, 0, 1, 0],
            [0, 1, 99],
            [0, 1, 0],
            { diffuseImage: { close: vi.fn() }, importKind: "obj" }
        )).toThrow();
        expect(engine.baseColor).toEqual(beforeColor);
        expect(engine.importedDiffuseImage).toBe(previousImage);
        expect(previousImage.close).not.toHaveBeenCalled();
    });

    it("drops non-finite imported UVs and color hints", () => {
        const engine = new SculptEngine();
        const beforeColor = [...engine.baseColor];
        expect(engine._applyImportedMesh(
            [0, 0, 0, 1, 0, 0, 0, 1, 0],
            [0, 1, 2],
            [Number.NaN, 1, 0],
            { uvs: [0, 0, 1, 0, Number.NaN, 1], importKind: "gltf" }
        )).toBe(true);
        expect(engine.baseColor).toEqual(beforeColor);
        expect(engine.mesh.uvs).toBeNull();
    });
});

describe("SculptEngine history budgets", () => {
    it("evicts old typed-array snapshots when the byte budget is exceeded", () => {
        const engine = new SculptEngine();
        engine.maxUndoSteps = 20;
        engine.maxUndoBytes = 64;
        engine._pushUndoEntry({ kind: "delta", beforePositions: new Float32Array(8) });
        engine._pushUndoEntry({ kind: "delta", beforePositions: new Float32Array(8) });
        engine._pushUndoEntry({ kind: "delta", beforePositions: new Float32Array(8) });
        expect(engine.undoStack).toHaveLength(2);
    });

    it("drops a single snapshot larger than the allowed budget", () => {
        const engine = new SculptEngine();
        engine.maxUndoBytes = 16;
        engine._pushUndoEntry({ kind: "full", before: new Float32Array(8) });
        expect(engine.undoStack).toHaveLength(0);
    });
});

describe("SculptEngine backface rejection", () => {
    let engine;
    beforeEach(() => {
        engine = new SculptEngine();
        engine.loadPrimitive("sphere", 3);
    });

    it("keeps vertices that face the stroke", () => {
        const hit = engine.getHitInfo(CENTER[0], CENTER[1], W, H);
        const affected = getAffectedVertices(
            engine.mesh, hit.point, engine.brushRadius, engine.innerRadiusRatio, "none"
        );
        const kept = engine._filterBackfacingAffected(affected, hit.normal);
        expect(kept.length).toBeGreaterThan(0);
    });

    it("rejects an all-backfacing set instead of passing it through", () => {
        // Reverting to the unfiltered list here would let a mirrored dab that
        // landed on nothing sculpt whatever vertices happened to be nearby.
        const affected = [];
        for (let i = 0; i < 10; i++) affected.push({ index: i, falloff: 1 });
        const n = engine.mesh.getNormal(0);
        const away = [-n[0], -n[1], -n[2]];
        expect(engine._filterBackfacingAffected(affected, away)).toHaveLength(0);
    });

    it("does not let symmetry make a backfacing candidate valid", () => {
        engine.symmetry = "x";
        engine.mesh.normals[0] = -1;
        engine.mesh.normals[1] = 0;
        engine.mesh.normals[2] = 0;
        expect(engine._filterBackfacingAffected(
            [{ index: 0, falloff: 1 }],
            [1, 0, 0]
        )).toHaveLength(0);
    });

    it("recalculates crease normals only for direction and final geometry", () => {
        engine.activeBrush = "crease";
        const recalc = vi.spyOn(engine.mesh, "recalculateNormalsPartial");
        engine.startStroke();
        const hit = engine.getHitInfo(CENTER[0], CENTER[1], W, H);
        engine.applyBrushAtHit(hit, false, null, null);
        engine.endStroke();
        expect(recalc).toHaveBeenCalledTimes(2);
    });

    it("still sculpts normally with the fallback removed", () => {
        const snap = snapshot(engine);
        applyStroke(engine, 10);
        expect(maxDiff(engine, snap)).toBeGreaterThan(0);
    });
});
