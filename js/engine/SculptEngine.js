/**
 * Main sculpting engine
 * Manages mesh, camera, brushes, and undo system
 */

import { linearToSrgb, baseColorFromMtlCompanions } from "../core/colorSpace.js";
import { Mesh } from "./Mesh.js";
import { MeshParseWorkerError, parseMeshInWorker } from "../core/meshParseWorkerClient.js";
import { generatePrimitive, parseOBJ } from "./Primitives.js";
import { applyBrush, applyMaskBrush, getAffectedVertices, BRUSH_TYPES } from "./Brush.js";
import {
    MAX_IMPORT_VERTEX_COUNT,
    MAX_MESH_FACE_INDICES,
    MAX_WIDGET_EMBED_VERTICES,
    MAX_WIDGET_EMBED_FACE_INDICES
} from "./limits.js";

export const CAMERA_PHI_LIMIT = Math.PI / 2 - 0.1;
const MAX_CAMERA_TARGET_ABS = 1_000_000;

export class SculptEngine {
    constructor() {
        this.mesh = new Mesh();

        // Undo system
        this.undoStack = [];
        this.redoStack = [];
        this.maxUndoSteps = 20;
        this.maxUndoBytes = 96 * 1024 * 1024;
        this._strokeUndoSession = null;

        // Draw is the onboarding default: it produces a predictable normal-
        // direction dome that is easier to read than planar clay buildup.
        // Saved workflows still restore whichever specialist brush they used.
        this.activeBrush = BRUSH_TYPES.STANDARD;
        this.brushRadius = 0.15;
        // A single dab is deliberately subtle because dabs are meant to stack,
        // so a low default reads as "the brush does nothing" on a first try.
        // The slider still spans 0.02-2.0 for fine work.
        this.brushStrength = 1.0;
        this.innerRadiusRatio = 0.4; // Two-ring brush: inner/outer ratio
        this.symmetry = 'none'; // 'none', 'x', 'y', 'z'
        // Red wax gives the working surface a clear hue/value identity against
        // the charcoal viewport. The key light is yawed off to the side: a zero
        // yaw sits nearly on the camera axis and flattens the read of form.
        this.baseColor = [0.38, 0.08, 0.02];
        this.matcapIntensity = 1.0;
        this.lightingPreset = "zbrush_red_wax";
        this.lightPower = 1.0;
        this.lightYaw = -60.0;
        this.lightPitch = 0.0;
        this.showWireframe = false;
        this.showGrid = true;

        // Camera
        this.camera = {
            distance: 3.0,
            theta: Math.PI / 4,    // Horizontal angle
            phi: Math.PI / 6,     // Vertical angle
            target: [0, 0, 0],
            fov: 45,
            near: 0.1,
            far: 100
        };

        // State
        this.strokeStarted = false;
        this.backfaceRejectDot = 0.04;
        this.normalRecalcCounter = 0;
        this.strokeDabCount = 0;
        this.octreeDirty = false;
        this.octreeRebuildInterval = 18;
        this.clayStrokeState = null;
        this.strokeRefineBudgetRemaining = 0;
        this.pendingTopologyUpload = false;
        this.maxAdaptiveVertexCount = 260000;
        // Region refinement currently rebuilds global adjacency/spatial data.
        // Keep it interactive on default primitives, but never trigger that
        // O(mesh) rebuild mid-stroke on already-dense meshes.
        this.maxInteractiveRefineVertexCount = 12_000;
        this.maxImportVertexCount = MAX_IMPORT_VERTEX_COUNT;
        this.maxWidgetSerializeVertices = MAX_WIDGET_EMBED_VERTICES;
        this.perfBudget = {
            targetDabMs: 4.0,
            softLimitMs: 5.5,
            hardLimitMs: 7.0
        };
        this.lastPerfSnapshot = {
            tier: "normal",
            applyMs: 0
        };
        this.cameraRevision = 0;
        this._raycastMatrixCache = {
            revision: -1,
            width: 0,
            height: 0,
            viewMatrix: null,
            projMatrix: null,
            invView: null,
            invProj: null
        };
        this.importedDiffuseImage = null;
        this.showImportedTexture = true;
        this.lastMeshImportKind = null;
        this.maskPaintMode = false;
        this.strokeMode = "continuous";
        this.snakeHookVel = [0, 0, 0];

        // Bumped whenever mesh geometry actually changes (stroke end, undo/redo,
        // load/import). Lets persistence skip serialize+hash work entirely when
        // only the camera or tool settings moved.
        this.geometryRevision = 0;
        this._movementBeforeScratch = new Float32Array(0);
        this._movementAfterScratch = new Float32Array(0);
    }

    /**
     * Load a primitive mesh
     */
    loadPrimitive(type, subdivision) {
        const { vertices, faces } = generatePrimitive(type, subdivision);
        this._setImportedDiffuseImage(null);
        this.showImportedTexture = true;
        this.lastMeshImportKind = null;
        this.mesh.setData(vertices, faces);
        this._resetState();
    }

    /**
     * Load mesh from OBJ file text.
     * @param {string} objText - Raw .obj file content
     * @returns {boolean} true if loaded successfully
     */
    loadFromOBJ(objText) {
        const { vertices, faces } = parseOBJ(objText);
        if (vertices.length === 0 || faces.length === 0) {
            console.warn('Sculpt: OBJ file is empty or invalid.');
            return false;
        }
        return this._applyImportedMesh(vertices, faces, null, { importKind: "obj" });
    }

    /**
     * Load OBJ via Three.js OBJLoader with UV + MTL + texture support.
     * Use this instead of loadFromOBJ when companion files (textures, .mtl) are available.
     * @param {string} objText - Raw .obj file content
     * @param {{ companionFiles?: Map<string, File> }} [options]
     * @returns {Promise<boolean>}
     */
    async loadFromOBJData(objText, options = {}) {
        if (typeof objText !== "string" || objText.trim().length === 0) {
            console.warn("Sculpt: OBJ text is empty.");
            return false;
        }
        try {
            let parsed;
            try {
                parsed = await parseMeshInWorker("obj", objText, options);
            } catch (error) {
                if (error?.name === "AbortError") return false;
                if (!(error instanceof MeshParseWorkerError) || !error.fallbackAllowed) {
                    throw error;
                }
            }
            const bundleUrl = new URL("../mesh/parseMeshThree.bundle.js", import.meta.url).href;
            if (!parsed) {
                const { parseOBJData } = await import(bundleUrl);
                parsed = await parseOBJData(objText, options);
            }
            const { vertices, faces, uvs, diffuseImage, vertexOwners } = parsed;
            if (vertices.length === 0 || faces.length === 0) {
                console.warn("Sculpt: OBJ has no triangle geometry.");
                return false;
            }
            // three.js reads MTL Kd as sRGB; Blender and our exporter use linear.
            const baseColorHint = await baseColorFromMtlCompanions(options.companionFiles);
            return this._applyImportedMesh(vertices, faces, baseColorHint, {
                uvs,
                vertexOwners,
                diffuseImage,
                importKind: "obj",
                shouldApply: options.shouldApply
            });
        } catch (err) {
            console.error("Sculpt: OBJ (Three.js) load failed", err);
            return false;
        }
    }

    _applyImportedMesh(vertices, faces, baseColorHint, extra = null) {
        if (typeof extra?.shouldApply === "function" && !extra.shouldApply()) {
            return false;
        }
        if (vertices.length === 0 || faces.length === 0) {
            return false;
        }
        const vertCount = vertices.length / 3;
        if (faces.length > MAX_MESH_FACE_INDICES) {
            console.warn(`Sculpt: import has too many face indices (max ${MAX_MESH_FACE_INDICES}).`);
            return false;
        }
        if (vertCount > this.maxImportVertexCount) {
            console.warn(
                `Sculpt: import too dense (${vertCount} verts). Max import: ${this.maxImportVertexCount}`
            );
            return false;
        }
        if (vertCount > this.maxAdaptiveVertexCount) {
            console.info(
                `Sculpt: large mesh (${vertCount} verts); adaptive refine caps at ${this.maxAdaptiveVertexCount}.`
            );
        }
        let uvs = extra && extra.uvs;
        if (!uvs || uvs.length !== vertCount * 2) {
            uvs = null;
        } else {
            for (let i = 0; i < uvs.length; i++) {
                if (!Number.isFinite(uvs[i])) {
                    uvs = null;
                    break;
                }
            }
        }
        let vertexOwners = extra && extra.vertexOwners;
        if (!vertexOwners || vertexOwners.length !== vertCount) vertexOwners = null;
        this.mesh.setData(vertices, faces, uvs, vertexOwners);
        if (
            Array.isArray(baseColorHint) &&
            baseColorHint.length === 3 &&
            baseColorHint.every((value) => Number.isFinite(value))
        ) {
            this.baseColor = baseColorHint.map((value) => Math.max(0, Math.min(1, value)));
        }
        this._setImportedDiffuseImage(extra?.diffuseImage || null);
        this.showImportedTexture = true;
        if (extra && extra.importKind) {
            this.lastMeshImportKind = extra.importKind;
        }
        this._resetState();
        return true;
    }

    /**
     * Load mesh from FBX binary (ASCII FBX is not supported by Three.js FBXLoader).
     * @param {ArrayBuffer} buffer
     * @param {{ textureFiles?: Map<string, File> }} [options] Pass PNG/JPG from the same folder (multi-select) so FBX external paths resolve.
     * @returns {Promise<boolean>}
     */
    async loadFromFBXBuffer(buffer, options = {}) {
        if (!(buffer instanceof ArrayBuffer) || buffer.byteLength === 0) {
            console.warn("Sculpt: FBX buffer is empty.");
            return false;
        }
        try {
            let parsed;
            let mainThreadBuffer = buffer;
            try {
                parsed = await parseMeshInWorker("fbx", buffer, options);
            } catch (error) {
                if (error?.name === "AbortError") return false;
                if (!(error instanceof MeshParseWorkerError) || !error.fallbackAllowed) {
                    throw error;
                }
                mainThreadBuffer = error.returnedData;
            }
            const bundleUrl = new URL("../mesh/parseMeshThree.bundle.js", import.meta.url).href;
            if (!parsed) {
                const { parseFBXBuffer } = await import(bundleUrl);
                parsed = await parseFBXBuffer(mainThreadBuffer, options);
            }
            const { vertices, faces, baseColorHint, uvs, diffuseImage, vertexOwners } = parsed;
            if (vertices.length === 0 || faces.length === 0) {
                console.warn("Sculpt: FBX has no triangle geometry.");
                return false;
            }
            // three.js material colours are linear.
            return this._applyImportedMesh(vertices, faces, linearToSrgb(baseColorHint), {
                uvs,
                vertexOwners,
                diffuseImage,
                importKind: "fbx",
                shouldApply: options.shouldApply
            });
        } catch (err) {
            console.error("Sculpt: FBX load failed", err);
            return false;
        }
    }

    /**
     * Load GLB, self-contained glTF JSON, or .gltf with companion files.
     * For .gltf with external scene.bin / textures, pass companionFiles from folder pick.
     * Viewport can show embedded diffuse textures when UVs exist.
     * @param {ArrayBuffer | string} data
     * @param {{ companionFiles?: Map<string, File> }} [options]
     * @returns {Promise<boolean>}
     */
    async loadFromGLTFData(data, options = {}) {
        if (
            !(data instanceof ArrayBuffer) &&
            typeof data !== "string"
        ) {
            console.warn("Sculpt: GLTF data is empty or invalid.");
            return false;
        }
        if (typeof data === "string" && data.trim().length === 0) {
            console.warn("Sculpt: GLTF text is empty.");
            return false;
        }
        if (data instanceof ArrayBuffer && data.byteLength === 0) {
            console.warn("Sculpt: GLTF buffer is empty.");
            return false;
        }
        try {
            let parsed;
            let mainThreadData = data;
            try {
                parsed = await parseMeshInWorker("gltf", data, options);
            } catch (error) {
                if (error?.name === "AbortError") return false;
                if (!(error instanceof MeshParseWorkerError) || !error.fallbackAllowed) {
                    throw error;
                }
                mainThreadData = error.returnedData;
            }
            const bundleUrl = new URL("../mesh/parseMeshThree.bundle.js", import.meta.url).href;
            if (!parsed) {
                const { parseGLTFData } = await import(bundleUrl);
                parsed = await parseGLTFData(mainThreadData, options);
            }
            const { vertices, faces, baseColorHint, uvs, diffuseImage, vertexOwners } = parsed;
            if (vertices.length === 0 || faces.length === 0) {
                console.warn("Sculpt: GLTF has no triangle geometry.");
                return false;
            }
            // glTF baseColorFactor and three.js material colours are linear.
            return this._applyImportedMesh(vertices, faces, linearToSrgb(baseColorHint), {
                uvs,
                vertexOwners,
                diffuseImage,
                importKind: "gltf",
                shouldApply: options.shouldApply
            });
        } catch (err) {
            console.error("Sculpt: GLTF load failed", err);
            console.warn(
                "Sculpt: For .gltf that references external scene.bin or textures, use Load folder… to select the folder containing the .gltf and its companion files."
            );
            return false;
        }
    }

    /**
     * Reset sculpting state after loading new mesh
     */
    _resetState() {
        this.geometryRevision++;
        this.undoStack = [];
        this.redoStack = [];
        this._strokeUndoSession = null;
        this.normalRecalcCounter = 0;
        this.strokeDabCount = 0;
        this.octreeDirty = false;
        this.clayStrokeState = null;
        this.strokeRefineBudgetRemaining = 0;
        this.pendingTopologyUpload = true;
        this.lastPerfSnapshot = {
            tier: "normal",
            applyMs: 0
        };
        this.snakeHookVel = [0, 0, 0];
        this._updateSpatialRebuildInterval();
    }

    /**
     * Get the view matrix
     */
    getViewMatrix() {
        const { distance, theta, phi, target } = this.camera;

        const x = distance * Math.sin(theta) * Math.cos(phi);
        const y = distance * Math.sin(phi);
        const z = distance * Math.cos(theta) * Math.cos(phi);

        const eye = [x + target[0], y + target[1], z + target[2]];

        return this._lookAt(eye, target, [0, 1, 0]);
    }

    /**
     * Get the projection matrix
     */
    getProjectionMatrix(aspect, fovOverride = null) {
        const { fov, near, far } = this.camera;
        const fovDeg = fovOverride ?? fov;
        return this._perspective(fovDeg * Math.PI / 180, aspect, near, far);
    }

    _lookAt(eye, target, up) {
        let zAxis = this._normalize([
            eye[0] - target[0],
            eye[1] - target[1],
            eye[2] - target[2]
        ]);
        if (zAxis[0] === 0 && zAxis[1] === 0 && zAxis[2] === 0) {
            zAxis = [0, 0, 1];
        }
        let xAxis = this._normalize(this._cross(up, zAxis));
        if (xAxis[0] === 0 && xAxis[1] === 0 && xAxis[2] === 0) {
            const fallbackUp = Math.abs(zAxis[1]) > 0.999 ? [1, 0, 0] : [0, 1, 0];
            xAxis = this._normalize(this._cross(fallbackUp, zAxis));
        }
        const yAxis = this._cross(zAxis, xAxis);

        return new Float32Array([
            xAxis[0], yAxis[0], zAxis[0], 0,
            xAxis[1], yAxis[1], zAxis[1], 0,
            xAxis[2], yAxis[2], zAxis[2], 0,
            -this._dot(xAxis, eye), -this._dot(yAxis, eye), -this._dot(zAxis, eye), 1
        ]);
    }

    _perspective(fov, aspect, near, far) {
        const f = 1 / Math.tan(fov / 2);
        const nf = 1 / (near - far);

        return new Float32Array([
            f / aspect, 0, 0, 0,
            0, f, 0, 0,
            0, 0, (far + near) * nf, -1,
            0, 0, 2 * far * near * nf, 0
        ]);
    }

    _normalize(v) {
        const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
        if (len === 0) return [0, 0, 0];
        return [v[0] / len, v[1] / len, v[2] / len];
    }

    _cross(a, b) {
        return [
            a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0]
        ];
    }

    _dot(a, b) {
        return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    }

    /**
     * Camera controls
     */
    rotateCamera(deltaTheta, deltaPhi) {
        // Invert to make the object follow the mouse movement (standard orbital camera feel)
        this.camera.theta -= deltaTheta;
        this.camera.phi = Math.max(
            -CAMERA_PHI_LIMIT,
            Math.min(CAMERA_PHI_LIMIT, this.camera.phi - deltaPhi)
        );
        this.cameraRevision++;
    }

    /**
     * Restore untrusted workflow camera data without violating projection and
     * orbit invariants. Partial or malformed fields retain the current value.
     */
    restoreCameraState(input) {
        if (!input || typeof input !== "object" || Array.isArray(input)) return false;

        const next = {
            ...this.camera,
            target: [...this.camera.target]
        };
        if (typeof input.distance === "number" && Number.isFinite(input.distance)) {
            next.distance = Math.max(0.2, Math.min(25, input.distance));
        }
        if (typeof input.theta === "number" && Number.isFinite(input.theta)) {
            const turn = Math.PI * 2;
            next.theta = ((input.theta + Math.PI) % turn + turn) % turn - Math.PI;
        }
        if (typeof input.phi === "number" && Number.isFinite(input.phi)) {
            next.phi = Math.max(-CAMERA_PHI_LIMIT, Math.min(CAMERA_PHI_LIMIT, input.phi));
        }
        if (
            Array.isArray(input.target)
            && input.target.length >= 3
            && input.target.slice(0, 3).every(
                (value) => typeof value === "number"
                    && Number.isFinite(value)
                    && Math.abs(value) <= MAX_CAMERA_TARGET_ABS
            )
        ) {
            next.target = input.target.slice(0, 3);
        }
        if (typeof input.fov === "number" && Number.isFinite(input.fov)) {
            next.fov = Math.max(10, Math.min(120, input.fov));
        }

        const candidateNear =
            typeof input.near === "number"
            && Number.isFinite(input.near)
            && input.near > 0
            && input.near <= MAX_CAMERA_TARGET_ABS
                ? input.near
                : next.near;
        const candidateFar =
            typeof input.far === "number"
            && Number.isFinite(input.far)
            && input.far > 0
            && input.far <= MAX_CAMERA_TARGET_ABS
                ? input.far
                : next.far;
        if (candidateNear < candidateFar) {
            next.near = candidateNear;
            next.far = candidateFar;
        }

        this.camera = next;
        this.cameraRevision++;
        return true;
    }

    zoomCamera(delta) {
        const zoomSpeed = 0.0012;
        const factor = 1 + delta * zoomSpeed;
        this.camera.distance = Math.max(0.2, Math.min(25, this.camera.distance * factor));
        this.cameraRevision++;
    }

    panCamera(deltaX, deltaY) {
        const { theta, phi } = this.camera;
        const worldUp = [0, 1, 0];

        // Camera forward from spherical coordinates (towards target)
        const forward = this._normalize([
            -Math.sin(theta) * Math.cos(phi),
            -Math.sin(phi),
            -Math.cos(theta) * Math.cos(phi)
        ]);
        const right = this._normalize(this._cross(forward, worldUp));
        const up = this._normalize(this._cross(right, forward));

        const panSpeed = this.camera.distance * 0.0019;

        this.camera.target[0] += (-right[0] * deltaX + up[0] * deltaY) * panSpeed;
        this.camera.target[1] += (-right[1] * deltaX + up[1] * deltaY) * panSpeed;
        this.camera.target[2] += (-right[2] * deltaX + up[2] * deltaY) * panSpeed;
        this.cameraRevision++;
    }

    frameCamera(resetOrbit = false) {
        const vertices = this.mesh?.vertices;
        if (!vertices || vertices.length < 3) return false;
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (let i = 0; i < vertices.length; i += 3) {
            minX = Math.min(minX, vertices[i]);
            minY = Math.min(minY, vertices[i + 1]);
            minZ = Math.min(minZ, vertices[i + 2]);
            maxX = Math.max(maxX, vertices[i]);
            maxY = Math.max(maxY, vertices[i + 1]);
            maxZ = Math.max(maxZ, vertices[i + 2]);
        }
        const target = [(minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5];
        const radius = Math.max(0.05, Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) * 0.5);
        const halfFov = Math.max(5, Math.min(60, this.camera.fov * 0.5)) * Math.PI / 180;
        this.camera.target = target;
        this.camera.distance = Math.max(0.2, Math.min(25, (radius / Math.sin(halfFov)) * 1.12));
        if (resetOrbit) {
            this.camera.theta = Math.PI / 4;
            this.camera.phi = Math.PI / 6;
        }
        this.cameraRevision++;
        return true;
    }

    /**
     * Bake an object-space rotation into the mesh around its bounds center.
     * This is intentionally separate from camera orbit: imported assets often
     * arrive with a different up-axis, and their corrected orientation must be
     * preserved by sculpting, workflow persistence, and OBJ export.
     */
    rotateObject(axis, radians) {
        if (!['x', 'y', 'z'].includes(axis) || !Number.isFinite(radians)) return false;
        const angle = radians % (Math.PI * 2);
        if (Math.abs(angle) < 1e-8 || !this.mesh?.vertices || this.mesh.vertexCount === 0) return false;
        if (this.strokeStarted) this.endStroke();

        const vertices = this.mesh.vertices;
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (let i = 0; i < vertices.length; i += 3) {
            minX = Math.min(minX, vertices[i]);
            minY = Math.min(minY, vertices[i + 1]);
            minZ = Math.min(minZ, vertices[i + 2]);
            maxX = Math.max(maxX, vertices[i]);
            maxY = Math.max(maxY, vertices[i + 1]);
            maxZ = Math.max(maxZ, vertices[i + 2]);
        }
        const cx = (minX + maxX) * 0.5;
        const cy = (minY + maxY) * 0.5;
        const cz = (minZ + maxZ) * 0.5;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const beforePositions = new Float32Array(vertices);

        for (let i = 0; i < vertices.length; i += 3) {
            const x = vertices[i] - cx;
            const y = vertices[i + 1] - cy;
            const z = vertices[i + 2] - cz;
            if (axis === 'x') {
                vertices[i + 1] = cy + y * cos - z * sin;
                vertices[i + 2] = cz + y * sin + z * cos;
            } else if (axis === 'y') {
                vertices[i] = cx + x * cos + z * sin;
                vertices[i + 2] = cz - x * sin + z * cos;
            } else {
                vertices[i] = cx + x * cos - y * sin;
                vertices[i + 1] = cy + x * sin + y * cos;
            }
        }

        const indices = new Uint32Array(this.mesh.vertexCount);
        for (let i = 0; i < indices.length; i++) indices[i] = i;
        this._pushUndoEntry({
            kind: "delta",
            indices,
            beforePositions,
            afterPositions: new Float32Array(vertices)
        });
        this.mesh.recalculateNormals();
        // Edge lengths are invariant under rigid rotation; spatial bounds are not.
        this.mesh.refreshSpatialIndexForMovedVertices();
        this.pendingTopologyUpload = false;
        this.geometryRevision++;
        this.normalRecalcCounter = 0;
        this.octreeDirty = false;
        return true;
    }

    /**
     * Start a sculpting stroke
     */
    startStroke() {
        if (!this.strokeStarted) {
            this.strokeStarted = true;
            this.strokeDabCount = 0;
            this.clayStrokeState = null;
            this.strokeRefineBudgetRemaining = this.activeBrush === BRUSH_TYPES.CLAY ? 1800 : 0;
            if (this.activeBrush === BRUSH_TYPES.SNAKE_HOOK) {
                this.snakeHookVel = [0, 0, 0];
            }
            this._beginUndoStrokeSession();
        }
    }

    /**
     * Unproject screen position to world space at a specific depth
     */
    unproject(screenX, screenY, canvasWidth, canvasHeight, clipZ) {
        const matrices = this._getRaycastMatrices(canvasWidth, canvasHeight);
        const invView = matrices.invView;
        const invProj = matrices.invProj;

        const ndcX = (screenX / canvasWidth) * 2 - 1;
        const ndcY = 1 - (screenY / canvasHeight) * 2;

        const clip = [ndcX, ndcY, clipZ, 1];
        const view = this._multiplyVec4(invProj, clip);
        const worldPos = this._transformPoint(invView, [view[0] / view[3], view[1] / view[3], view[2] / view[3]]);

        return worldPos;
    }

    /**
     * Project world point to clip space for depth retrieval
     */
    projectToClip(worldPos, canvasWidth, canvasHeight) {
        const matrices = this._getRaycastMatrices(canvasWidth, canvasHeight);
        const view = matrices.viewMatrix;
        const proj = matrices.projMatrix;

        const viewPos = this._multiplyVec4(view, [worldPos[0], worldPos[1], worldPos[2], 1.0]);
        const clipPos = this._multiplyVec4(proj, viewPos);

        return [clipPos[0] / clipPos[3], clipPos[1] / clipPos[3], clipPos[2] / clipPos[3]];
    }

    /**
     * End sculpting stroke
     */
    endStroke({ deferSpatialRefresh = false } = {}) {
        this.strokeStarted = false;
        this.clayStrokeState = null;
        this.strokeRefineBudgetRemaining = 0;
        if (this.strokeDabCount > 0) {
            this.geometryRevision++;
        }
        if (this.octreeDirty && !deferSpatialRefresh) {
            // Only positions moved during the stroke; any topology change (clay
            // refine) already rebuilt the indices at the point it happened.
            this.mesh.refreshSpatialIndexForMovedVertices();
            this.octreeDirty = false;
        }
        this._finalizeUndoStrokeSession();
    }

    flushSpatialIndex() {
        if (!this.octreeDirty) return false;
        this.mesh.refreshSpatialIndexForMovedVertices();
        this.octreeDirty = false;
        return true;
    }

    _beginUndoStrokeSession() {
        if (this.maskPaintMode) {
            this._strokeUndoSession = {
                mode: "maskDelta",
                preMaskMap: new Map(),
                changed: false
            };
            return;
        }
        if (this.activeBrush === BRUSH_TYPES.CLAY) {
            this._strokeUndoSession = {
                mode: "full",
                beforeState: this.mesh.cloneState(),
                changed: false
            };
            return;
        }

        this._strokeUndoSession = {
            mode: "delta",
            preMap: new Map(),
            changed: false
        };
    }

    _captureStrokePrePositions(indices) {
        const session = this._strokeUndoSession;
        if (!session || session.mode !== "delta" || !indices || indices.length === 0) return;
        const vertices = this.mesh.vertices;
        for (const idx of indices) {
            if (session.preMap.has(idx) || idx < 0 || idx >= this.mesh.vertexCount) continue;
            const i = idx * 3;
            session.preMap.set(idx, [vertices[i], vertices[i + 1], vertices[i + 2]]);
        }
    }

    _captureAffectedPositions(indices) {
        const needed = (indices?.length || 0) * 3;
        if (this._movementBeforeScratch.length < needed) {
            this._movementBeforeScratch = new Float32Array(needed);
        }
        const vertices = this.mesh.vertices;
        for (let n = 0; n < indices.length; n++) {
            const vi = indices[n] * 3;
            const bi = n * 3;
            this._movementBeforeScratch[bi] = vertices[vi];
            this._movementBeforeScratch[bi + 1] = vertices[vi + 1];
            this._movementBeforeScratch[bi + 2] = vertices[vi + 2];
        }
        return this._movementBeforeScratch;
    }

    _stabilizeAffectedTopology(indices, beforePositions) {
        if (!indices?.length || !this.mesh.vertexFaces) return 1;
        const needed = indices.length * 3;
        if (this._movementAfterScratch.length < needed) {
            this._movementAfterScratch = new Float32Array(needed);
        }
        const after = this._movementAfterScratch;
        const vertices = this.mesh.vertices;
        const beforeOffset = new Map();
        const facesToCheck = new Set();
        for (let n = 0; n < indices.length; n++) {
            const idx = indices[n];
            const vi = idx * 3;
            const bi = n * 3;
            beforeOffset.set(idx, bi);
            after[bi] = vertices[vi];
            after[bi + 1] = vertices[vi + 1];
            after[bi + 2] = vertices[vi + 2];
            for (const faceIdx of this.mesh.vertexFaces[idx] || []) facesToCheck.add(faceIdx);
        }

        const setBlend = (t) => {
            for (let n = 0; n < indices.length; n++) {
                const vi = indices[n] * 3;
                const bi = n * 3;
                vertices[vi] = beforePositions[bi] + (after[bi] - beforePositions[bi]) * t;
                vertices[vi + 1] = beforePositions[bi + 1] + (after[bi + 1] - beforePositions[bi + 1]) * t;
                vertices[vi + 2] = beforePositions[bi + 2] + (after[bi + 2] - beforePositions[bi + 2]) * t;
            }
        };
        const read = (idx, axis, useBefore) => {
            const offset = beforeOffset.get(idx);
            return useBefore && offset !== undefined ? beforePositions[offset + axis] : vertices[idx * 3 + axis];
        };
        const isSafe = (t) => {
            setBlend(t);
            for (const faceIdx of facesToCheck) {
                const fi = faceIdx * 3;
                const ia = this.mesh.faces[fi];
                const ib = this.mesh.faces[fi + 1];
                const ic = this.mesh.faces[fi + 2];
                const ax0 = read(ia, 0, true), ay0 = read(ia, 1, true), az0 = read(ia, 2, true);
                const bx0 = read(ib, 0, true), by0 = read(ib, 1, true), bz0 = read(ib, 2, true);
                const cx0 = read(ic, 0, true), cy0 = read(ic, 1, true), cz0 = read(ic, 2, true);
                const ax1 = vertices[ia * 3], ay1 = vertices[ia * 3 + 1], az1 = vertices[ia * 3 + 2];
                const bx1 = vertices[ib * 3], by1 = vertices[ib * 3 + 1], bz1 = vertices[ib * 3 + 2];
                const cx1 = vertices[ic * 3], cy1 = vertices[ic * 3 + 1], cz1 = vertices[ic * 3 + 2];
                const u0x = bx0 - ax0, u0y = by0 - ay0, u0z = bz0 - az0;
                const v0x = cx0 - ax0, v0y = cy0 - ay0, v0z = cz0 - az0;
                const u1x = bx1 - ax1, u1y = by1 - ay1, u1z = bz1 - az1;
                const v1x = cx1 - ax1, v1y = cy1 - ay1, v1z = cz1 - az1;
                const n0x = u0y * v0z - u0z * v0y;
                const n0y = u0z * v0x - u0x * v0z;
                const n0z = u0x * v0y - u0y * v0x;
                const n1x = u1y * v1z - u1z * v1y;
                const n1y = u1z * v1x - u1x * v1z;
                const n1z = u1x * v1y - u1y * v1x;
                const area0Sq = n0x * n0x + n0y * n0y + n0z * n0z;
                const area1Sq = n1x * n1x + n1y * n1y + n1z * n1z;
                if (area0Sq <= 1e-18) continue;
                const dot = n0x * n1x + n0y * n1y + n0z * n1z;
                if (area1Sq < area0Sq * 0.04 || dot <= Math.sqrt(area0Sq * area1Sq) * 0.02) return false;
            }
            return true;
        };

        if (isSafe(1)) return 1;
        let low = 0;
        let high = 1;
        for (let iteration = 0; iteration < 8; iteration++) {
            const mid = (low + high) * 0.5;
            if (isSafe(mid)) low = mid;
            else high = mid;
        }
        setBlend(low);
        return low;
    }

    _captureStrokePreMask(indices) {
        const session = this._strokeUndoSession;
        if (!session || session.mode !== "maskDelta" || !indices || indices.length === 0) return;
        this.mesh.ensureVertexMask();
        const mask = this.mesh.vertexMask;
        for (const idx of indices) {
            if (session.preMaskMap.has(idx) || idx < 0 || idx >= this.mesh.vertexCount) continue;
            session.preMaskMap.set(idx, mask[idx]);
        }
    }

    _finalizeUndoStrokeSession() {
        const session = this._strokeUndoSession;
        this._strokeUndoSession = null;
        if (!session || !session.changed) return;

        if (session.mode === "maskDelta") {
            if (!session.preMaskMap || session.preMaskMap.size === 0) return;
            const indices = Array.from(session.preMaskMap.keys()).sort((a, b) => a - b);
            const beforeMask = new Float32Array(indices.length);
            const afterMask = new Float32Array(indices.length);
            this.mesh.ensureVertexMask();
            const mask = this.mesh.vertexMask;
            for (let i = 0; i < indices.length; i++) {
                const idx = indices[i];
                beforeMask[i] = session.preMaskMap.get(idx);
                afterMask[i] = mask[idx];
            }
            this._pushUndoEntry({
                kind: "maskDelta",
                indices: new Uint32Array(indices),
                beforeMask,
                afterMask
            });
            return;
        }

        if (session.mode === "full") {
            const entry = {
                kind: "full",
                before: session.beforeState,
                after: this.mesh.cloneState()
            };
            this._pushUndoEntry(entry);
            return;
        }

        if (!session.preMap || session.preMap.size === 0) return;
        const indices = Array.from(session.preMap.keys()).sort((a, b) => a - b);
        const beforePositions = new Float32Array(indices.length * 3);
        const afterPositions = new Float32Array(indices.length * 3);
        const vertices = this.mesh.vertices;

        let ptr = 0;
        for (const idx of indices) {
            const before = session.preMap.get(idx);
            beforePositions[ptr] = before[0];
            beforePositions[ptr + 1] = before[1];
            beforePositions[ptr + 2] = before[2];

            const i = idx * 3;
            afterPositions[ptr] = vertices[i];
            afterPositions[ptr + 1] = vertices[i + 1];
            afterPositions[ptr + 2] = vertices[i + 2];
            ptr += 3;
        }

        const entry = {
            kind: "delta",
            indices: new Uint32Array(indices),
            beforePositions,
            afterPositions
        };
        this._pushUndoEntry(entry);
    }

    _pushUndoEntry(entry) {
        this.undoStack.push(entry);
        this.redoStack = [];
        this._trimHistoryStack(this.undoStack);
    }

    _historyEntryBytes(entry) {
        const seen = new Set();
        const visit = (value) => {
            if (!value || typeof value !== "object" || seen.has(value)) return 0;
            seen.add(value);
            if (ArrayBuffer.isView(value)) return value.byteLength;
            if (value instanceof ArrayBuffer) return value.byteLength;
            let total = 0;
            for (const child of Object.values(value)) total += visit(child);
            return total;
        };
        return visit(entry);
    }

    _trimHistoryStack(stack) {
        while (stack.length > this.maxUndoSteps) stack.shift();
        let bytes = 0;
        for (const entry of stack) bytes += this._historyEntryBytes(entry);
        while (stack.length && bytes > this.maxUndoBytes) {
            bytes -= this._historyEntryBytes(stack.shift());
        }
    }

    /**
     * Get hit info at screen position (for cursor display)
     */
    getHitInfo(screenX, screenY, canvasWidth, canvasHeight) {
        return this._raycastWithInfo(screenX, screenY, canvasWidth, canvasHeight);
    }

    /**
     * Scale each vertex falloff by how unmasked it is. The cubic makes a
     * partial mask bite early, so a soft mask edge still visibly protects.
     */
    _weightFalloffByMask(affectedList) {
        if (!affectedList || affectedList.length === 0) return [];
        this.mesh.ensureVertexMask();
        const mask = this.mesh.vertexMask;
        const out = [];
        for (const item of affectedList) {
            const mi = Math.min(1, Math.max(0, mask[item.index] ?? 0));
            const free = 1 - mi;
            const w = free * free * free;
            if (w <= 1e-9) continue;
            out.push({ index: item.index, falloff: item.falloff * w });
        }
        return out;
    }

    _applyMaskPaintAtHit(hitInfo, invert = false, radiusOverride = null) {
        const brushRadius = radiusOverride ?? this.brushRadius;
        const sym = this.symmetry || "none";
        let origAffected = getAffectedVertices(this.mesh, hitInfo.point, brushRadius, this.innerRadiusRatio);
        let origFiltered = this._filterBackfacingAffected(origAffected, hitInfo.normal);
        let mirrorFiltered = [];
        let mirrorHitPoint = null;
        if (sym !== "none") {
            mirrorHitPoint = [...hitInfo.point];
            let mirrorHitNormal = [...hitInfo.normal];
            if (sym === "x") {
                mirrorHitPoint[0] = -mirrorHitPoint[0];
                mirrorHitNormal[0] = -mirrorHitNormal[0];
            } else if (sym === "y") {
                mirrorHitPoint[1] = -mirrorHitPoint[1];
                mirrorHitNormal[1] = -mirrorHitNormal[1];
            } else if (sym === "z") {
                mirrorHitPoint[2] = -mirrorHitPoint[2];
                mirrorHitNormal[2] = -mirrorHitNormal[2];
            }
            const mirrorAffected = getAffectedVertices(this.mesh, mirrorHitPoint, brushRadius, this.innerRadiusRatio);
            mirrorFiltered = this._filterBackfacingAffected(mirrorAffected, mirrorHitNormal);
        }
        let mirrorOnlyFiltered = this._mirrorSideOnly(origFiltered, mirrorFiltered);
        origFiltered = this.mesh.expandCoincidentAffected(origFiltered);
        mirrorOnlyFiltered = this.mesh.expandCoincidentAffected(mirrorOnlyFiltered);
        let allFiltered = [...origFiltered, ...mirrorOnlyFiltered];
        if (allFiltered.length === 0) return null;
        const affectedIndices = allFiltered.map((a) => a.index);
        this._captureStrokePreMask(affectedIndices);
        if (origFiltered.length > 0) {
            applyMaskBrush(this.mesh, origFiltered, this.brushStrength, invert);
        }
        if (mirrorOnlyFiltered.length > 0) {
            applyMaskBrush(this.mesh, mirrorOnlyFiltered, this.brushStrength, invert);
        }
        this.mesh.synchronizeCoincidentMask();
        this.strokeDabCount++;
        if (this._strokeUndoSession) {
            this._strokeUndoSession.changed = true;
        }
        const dirtyRanges = this._computeDirtyRangesFromIndices(affectedIndices);
        return {
            affectedIndices,
            dirtyRanges,
            topologyChanged: false,
            maskOnly: true,
            perfSnapshot: this.lastPerfSnapshot
        };
    }

    /**
     * Apply the brush using an already computed hit result. Avoids a duplicate
     * raycast when the caller already resolved hit info for the cursor.
     */
    applyBrushAtHit(hitInfo, invert = false, radiusOverride = null, extraContext = null) {
        if (!hitInfo) return null;

        if (this.maskPaintMode) {
            return this._applyMaskPaintAtHit(hitInfo, invert, radiusOverride);
        }

        const brushRadius = radiusOverride ?? this.brushRadius;
        const isClayStroke = this.activeBrush === BRUSH_TYPES.CLAY;
        const sym = this.symmetry || 'none';

        // Collect original side (no symmetry for getAffectedVertices - we handle it ourselves)
        let origAffected = getAffectedVertices(this.mesh, hitInfo.point, brushRadius, this.innerRadiusRatio);
        let origFiltered = this._filterBackfacingAffected(origAffected, hitInfo.normal);
        origFiltered = this._weightFalloffByMask(origFiltered);

        // Collect mirrored side
        let mirrorFiltered = [];
        let mirrorHitPoint = null;
        let mirrorHitNormal = null;
        if (sym !== 'none') {
            mirrorHitPoint = [...hitInfo.point];
            mirrorHitNormal = [...hitInfo.normal];
            if (sym === 'x') { mirrorHitPoint[0] = -mirrorHitPoint[0]; mirrorHitNormal[0] = -mirrorHitNormal[0]; }
            else if (sym === 'y') { mirrorHitPoint[1] = -mirrorHitPoint[1]; mirrorHitNormal[1] = -mirrorHitNormal[1]; }
            else if (sym === 'z') { mirrorHitPoint[2] = -mirrorHitPoint[2]; mirrorHitNormal[2] = -mirrorHitNormal[2]; }

            const mirrorAffected = getAffectedVertices(this.mesh, mirrorHitPoint, brushRadius, this.innerRadiusRatio);
            mirrorFiltered = this._filterBackfacingAffected(mirrorAffected, mirrorHitNormal);
            mirrorFiltered = this._weightFalloffByMask(mirrorFiltered);
        }

        let mirrorOnlyFiltered = this._mirrorSideOnly(origFiltered, mirrorFiltered);
        origFiltered = this.mesh.expandCoincidentAffected(origFiltered);
        mirrorOnlyFiltered = this.mesh.expandCoincidentAffected(mirrorOnlyFiltered);
        let allFiltered = [...origFiltered, ...mirrorOnlyFiltered];
        if (allFiltered.length === 0) return null;

        if (isClayStroke) {
            this._updateClayStrokeState(hitInfo);
            const topologyChanged = this._refineClayRegionIfNeeded(allFiltered, hitInfo, brushRadius, extraContext?.strokeContext || null);
            if (topologyChanged) {
                this.pendingTopologyUpload = true;
                this._updateSpatialRebuildInterval();
                // Re-collect after topology change
                origAffected = getAffectedVertices(this.mesh, hitInfo.point, brushRadius, this.innerRadiusRatio);
                origFiltered = this._weightFalloffByMask(this._filterBackfacingAffected(origAffected, hitInfo.normal));
                if (sym !== 'none' && mirrorHitPoint) {
                    const mirrorAffected2 = getAffectedVertices(this.mesh, mirrorHitPoint, brushRadius, this.innerRadiusRatio);
                    mirrorFiltered = this._weightFalloffByMask(this._filterBackfacingAffected(mirrorAffected2, mirrorHitNormal));
                }
                mirrorOnlyFiltered = this._mirrorSideOnly(origFiltered, mirrorFiltered);
                origFiltered = this.mesh.expandCoincidentAffected(origFiltered);
                mirrorOnlyFiltered = this.mesh.expandCoincidentAffected(mirrorOnlyFiltered);
                allFiltered = [...origFiltered, ...mirrorOnlyFiltered];
                if (origFiltered.length === 0 && mirrorOnlyFiltered.length === 0) return null;
                this._updateClayStrokeState(hitInfo);
            }
        } else {
            this.clayStrokeState = null;
        }

        const finalFiltered = allFiltered;
        const affectedIndices = finalFiltered.map(a => a.index);
        this._captureStrokePrePositions(affectedIndices);
        const beforePositions = this._captureAffectedPositions(affectedIndices);
        const baseContext = this._buildBrushContext(hitInfo, brushRadius, extraContext, isClayStroke);
        const applyMs = baseContext.strokeContext?.applyMs || 0;
        const perfTier = this._resolvePerfTier(applyMs);
        this.lastPerfSnapshot = {
            tier: perfTier,
            applyMs
        };

        let brushContext = baseContext;
        if (this.activeBrush === BRUSH_TYPES.SNAKE_HOOK && extraContext?.moveDelta) {
            const d = extraContext.moveDelta;
            const decay = 0.78;
            this.snakeHookVel[0] = this.snakeHookVel[0] * decay + d[0];
            this.snakeHookVel[1] = this.snakeHookVel[1] * decay + d[1];
            this.snakeHookVel[2] = this.snakeHookVel[2] * decay + d[2];
            brushContext = {
                ...baseContext,
                moveDelta: [
                    d[0] + this.snakeHookVel[0] * 0.52,
                    d[1] + this.snakeHookVel[1] * 0.52,
                    d[2] + this.snakeHookVel[2] * 0.52
                ]
            };
        }

        if (origFiltered.length > 0) {
            applyBrush(this.activeBrush, this.mesh, origFiltered, this.brushStrength, invert, brushContext);
        }

        // Mirrored side: exclude verts already in orig pass (seam/plane overlap would double-apply)
        if (mirrorOnlyFiltered.length > 0 && mirrorHitPoint) {
            const axis = sym === 'x' ? 0 : (sym === 'y' ? 1 : (sym === 'z' ? 2 : -1));
            const mirrorContext = { ...brushContext, hitPoint: mirrorHitPoint, hitNormal: mirrorHitNormal };
            const flip = (vec) => {
                if (!Array.isArray(vec) || axis < 0) return vec;
                const out = [...vec];
                out[axis] = -out[axis];
                return out;
            };
            if (mirrorContext.moveDelta) {
                mirrorContext.moveDelta = flip(mirrorContext.moveDelta);
            }
            // Clay measures deposit height against the stroke plane, and that
            // plane tracks the original side. Reusing it verbatim would make
            // the mirrored dab reference a plane on the far side of the model
            // and deposit a visibly different depth on the two halves.
            if (mirrorContext.clayStroke) {
                mirrorContext.clayStroke = {
                    ...mirrorContext.clayStroke,
                    planeOrigin: flip(mirrorContext.clayStroke.planeOrigin),
                    planeNormal: flip(mirrorContext.clayStroke.planeNormal),
                    tangent: flip(mirrorContext.clayStroke.tangent)
                };
            }
            applyBrush(this.activeBrush, this.mesh, mirrorOnlyFiltered, this.brushStrength, invert, mirrorContext);
        }
        this.mesh.synchronizeCoincidentVertices(affectedIndices);
        if (
            this.activeBrush === BRUSH_TYPES.PINCH
            || this.activeBrush === BRUSH_TYPES.CREASE
            || this.activeBrush === BRUSH_TYPES.INFLATE
            || this.activeBrush === BRUSH_TYPES.MOVE
            || this.activeBrush === BRUSH_TYPES.SNAKE_HOOK
        ) {
            this._stabilizeAffectedTopology(affectedIndices, beforePositions);
        }
        this.mesh.noteSpatialMovement(affectedIndices, beforePositions);

        const nextDabCount = this.strokeDabCount + 1;
        const normalIndices = this.mesh.recalculateNormalsPartial(affectedIndices);
        this.mesh.computeEdgeLengths(affectedIndices);
        this.normalRecalcCounter++;
        this.strokeDabCount = nextDabCount;
        this.octreeDirty = true;
        if (this._strokeUndoSession) {
            this._strokeUndoSession.changed = true;
        }

        const periodicRebuildInterval = Math.max(this.octreeRebuildInterval, perfTier === "degrade2" ? 40 : 32);
        if (
            this.mesh.vertexCount < 30_000
            && this.mesh.spatialIndexPadding > brushRadius * 0.6
            && this.strokeDabCount % periodicRebuildInterval === 0
            && perfTier !== "degrade2"
        ) {
            // Mid-stroke: refit, never rebuild. A rebuild here is the single
            // most expensive operation in a drag, long enough at high density
            // that the pointer outruns the stamp budget and the stroke lands as
            // separate mounds instead of one ridge.
            this.mesh.refreshSpatialIndexForMovedVertices();
            this.octreeDirty = false;
        }

        const dirtyRanges = this._computeDirtyRangesFromIndices(affectedIndices);
        const normalDirtyRanges = this._computeDirtyRangesFromIndices(normalIndices);
        return {
            affectedIndices,
            dirtyRanges,
            normalDirtyRanges,
            topologyChanged: this.pendingTopologyUpload,
            perfSnapshot: this.lastPerfSnapshot
        };
    }

    _buildBrushContext(hitInfo, brushRadius, extraContext, isClayStroke) {
        const incoming = extraContext || {};
        const sourceStroke = incoming.strokeContext || {};
        const pressure = Number.isFinite(sourceStroke.pressure) ? Math.max(0, Math.min(1, sourceStroke.pressure)) : 1.0;
        const speedPxPerSec = Number.isFinite(sourceStroke.speedPxPerSec) ? Math.max(0, sourceStroke.speedPxPerSec) : 0;
        const spacingPx = Number.isFinite(sourceStroke.spacingPx) ? Math.max(0, sourceStroke.spacingPx) : 0;
        const spacingWorld = Number.isFinite(sourceStroke.spacingWorld) ? Math.max(0, sourceStroke.spacingWorld) : 0;
        const applyMs = Number.isFinite(sourceStroke.applyMs) ? Math.max(0, sourceStroke.applyMs) : 0;
        const timestampSec = Number.isFinite(sourceStroke.timestampSec) ? sourceStroke.timestampSec : (performance.now() * 0.001);
        const symmetry = typeof sourceStroke.symmetry === "string" ? sourceStroke.symmetry : this.symmetry;

        return {
            ...incoming,
            hitPoint: hitInfo.point,
            hitNormal: hitInfo.normal,
            radius: brushRadius,
            clayStroke: isClayStroke ? this._getClayBrushContext() : null,
            strokeContext: {
                pressure,
                speedPxPerSec,
                spacingPx,
                spacingWorld,
                applyMs,
                timestampSec,
                symmetry
            }
        };
    }

    _updateClayStrokeState(hitInfo) {
        const point = hitInfo.point;
        const normal = this._normalize(hitInfo.normal || [0, 1, 0]);
        if (!this.clayStrokeState) {
            this.clayStrokeState = {
                planeOrigin: [point[0], point[1], point[2]],
                planeNormal: [normal[0], normal[1], normal[2]],
                tangent: [0, 0, 0],
                lastPoint: [point[0], point[1], point[2]],
                dabs: 0
            };
            return;
        }

        const state = this.clayStrokeState;
        let nx = state.planeNormal[0];
        let ny = state.planeNormal[1];
        let nz = state.planeNormal[2];
        if (nx * normal[0] + ny * normal[1] + nz * normal[2] < 0) {
            nx = -nx;
            ny = -ny;
            nz = -nz;
        }

        const normalBlend = 0.14;
        const blendedNormal = this._normalize([
            nx * (1 - normalBlend) + normal[0] * normalBlend,
            ny * (1 - normalBlend) + normal[1] * normalBlend,
            nz * (1 - normalBlend) + normal[2] * normalBlend
        ]);
        state.planeNormal[0] = blendedNormal[0];
        state.planeNormal[1] = blendedNormal[1];
        state.planeNormal[2] = blendedNormal[2];

        const dx = point[0] - state.lastPoint[0];
        const dy = point[1] - state.lastPoint[1];
        const dz = point[2] - state.lastPoint[2];
        const dLen = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dLen > 1e-6) {
            const invLen = 1 / dLen;
            let tx = dx * invLen;
            let ty = dy * invLen;
            let tz = dz * invLen;
            const dotN = tx * state.planeNormal[0] + ty * state.planeNormal[1] + tz * state.planeNormal[2];
            tx -= state.planeNormal[0] * dotN;
            ty -= state.planeNormal[1] * dotN;
            tz -= state.planeNormal[2] * dotN;
            const tLen = Math.sqrt(tx * tx + ty * ty + tz * tz);
            if (tLen > 1e-6) {
                tx /= tLen;
                ty /= tLen;
                tz /= tLen;
                const smooth = 0.3;
                const oldTx = state.tangent[0];
                const oldTy = state.tangent[1];
                const oldTz = state.tangent[2];
                const mixed = this._normalize([
                    oldTx * (1 - smooth) + tx * smooth,
                    oldTy * (1 - smooth) + ty * smooth,
                    oldTz * (1 - smooth) + tz * smooth
                ]);
                state.tangent[0] = mixed[0];
                state.tangent[1] = mixed[1];
                state.tangent[2] = mixed[2];
            }
        }

        const originFollow = 0.2;
        state.planeOrigin[0] += (point[0] - state.planeOrigin[0]) * originFollow;
        state.planeOrigin[1] += (point[1] - state.planeOrigin[1]) * originFollow;
        state.planeOrigin[2] += (point[2] - state.planeOrigin[2]) * originFollow;
        state.lastPoint[0] = point[0];
        state.lastPoint[1] = point[1];
        state.lastPoint[2] = point[2];
        state.dabs += 1;
    }

    _getClayBrushContext() {
        if (!this.clayStrokeState) return null;
        return {
            planeOrigin: [...this.clayStrokeState.planeOrigin],
            planeNormal: [...this.clayStrokeState.planeNormal],
            tangent: [...this.clayStrokeState.tangent],
            dabs: this.clayStrokeState.dabs
        };
    }

    _refineClayRegionIfNeeded(filtered, hitInfo, brushRadius, strokeContext = null) {
        if (!filtered || filtered.length === 0) return false;
        if (this.mesh.vertexCount >= this.maxAdaptiveVertexCount) return false;
        if (this.mesh.vertexCount > this.maxInteractiveRefineVertexCount) return false;
        if (brushRadius < 0.02) return false;
        if (this.strokeRefineBudgetRemaining <= 0) return false;
        const speedPxPerSec = Number.isFinite(strokeContext?.speedPxPerSec) ? strokeContext.speedPxPerSec : 0;
        const applyMs = Number.isFinite(strokeContext?.applyMs) ? Math.max(0, strokeContext.applyMs) : 0;
        const perfTier = this._resolvePerfTier(applyMs);
        if (perfTier === "degrade2") return false;
        const speedNorm = Math.max(0, Math.min(1, speedPxPerSec / 900));
        const perfNorm = perfTier === "degrade1"
            ? 0.55
            : Math.max(0, Math.min(1, (applyMs - this.perfBudget.targetDabMs) / (this.perfBudget.softLimitMs - this.perfBudget.targetDabMs + 1e-6)));
        const baseInterval = perfTier === "degrade1" ? 10 : 6;
        const interval = Math.max(5, Math.min(24, Math.round(baseInterval + speedNorm * 8 + perfNorm * 6)));
        if (this.strokeDabCount % interval !== 0) return false;

        let avgEdge = 0;
        const count = Math.min(filtered.length, 96);
        for (let i = 0; i < count; i++) {
            avgEdge += this.mesh.getEdgeScale(filtered[i].index);
        }
        avgEdge /= Math.max(1, count);

        const targetEdge = Math.max(0.006, brushRadius * 0.2);
        if (avgEdge <= targetEdge * 1.16) return false;

        const tierScale = perfTier === "degrade1" ? 0.58 : 1.0;
        const budgetScale = (1.0 - speedNorm * 0.65) * (1.0 - perfNorm * 0.75) * tierScale;
        const maxSplitEdges = Math.max(56, Math.floor(220 * budgetScale));
        const maxAddedVertices = Math.max(64, Math.floor(260 * budgetScale));
        const perStrokeRemaining = Math.max(0, this.strokeRefineBudgetRemaining);

        const affectedIndices = filtered.map((entry) => entry.index);
        const refineResult = this.mesh.refineRegionForBrush(affectedIndices, {
            center: hitInfo.point,
            radius: brushRadius,
            targetEdgeLength: targetEdge,
            edgeThreshold: 1.14,
            maxSplitEdges: Math.min(maxSplitEdges, perStrokeRemaining),
            maxAddedVertices: Math.min(maxAddedVertices, perStrokeRemaining),
            maxVertexCount: this.maxAdaptiveVertexCount
        });

        if (!refineResult.changed) return false;

        this.strokeRefineBudgetRemaining = Math.max(0, this.strokeRefineBudgetRemaining - (refineResult.addedVertices || 0));
        this.octreeDirty = false;
        return true;
    }

    consumeTopologyChanged() {
        const changed = this.pendingTopologyUpload;
        this.pendingTopologyUpload = false;
        return changed;
    }

    _mirrorSideOnly(origFiltered, mirrorFiltered) {
        if (!mirrorFiltered || mirrorFiltered.length === 0) return [];
        if (!origFiltered || origFiltered.length === 0) return mirrorFiltered;
        const origIdx = new Set(origFiltered.map((a) => a.index));
        return mirrorFiltered.filter((a) => !origIdx.has(a.index));
    }

    _filterBackfacingAffected(affected, hitNormal) {
        if (!affected || affected.length === 0 || !hitNormal) return affected || [];

        const nLenSq = hitNormal[0] * hitNormal[0] + hitNormal[1] * hitNormal[1] + hitNormal[2] * hitNormal[2];
        if (nLenSq < 1e-10) return affected;

        const minDot = -0.25;

        const filtered = [];
        const normals = this.mesh.normals;
        for (const entry of affected) {
            const ni = entry.index * 3;
            const nx = normals[ni];
            const ny = normals[ni + 1];
            const nz = normals[ni + 2];
            const dot = nx * hitNormal[0] + ny * hitNormal[1] + nz * hitNormal[2];
            // Original and mirrored candidate sets are filtered separately by
            // the caller with their own hit normals. Applying global symmetry
            // here a second time accepts the back face of thin geometry.
            if (dot >= minDot) {
                filtered.push(entry);
            }
        }

        // An empty result is a valid answer. Falling back to the unfiltered
        // list would disable backface rejection in exactly the case it exists
        // for, letting a dab bleed through to the far side of a thin surface.
        return filtered;
    }

    /**
     * Raycast from screen position to mesh with full hit info
     */
    _raycastWithInfo(screenX, screenY, canvasWidth, canvasHeight) {
        if (canvasWidth <= 0 || canvasHeight <= 0) return null;

        const matrices = this._getRaycastMatrices(canvasWidth, canvasHeight);
        const invView = matrices.invView;
        const invProj = matrices.invProj;

        // Convert screen to NDC
        const ndcX = (screenX / canvasWidth) * 2 - 1;
        const ndcY = 1 - (screenY / canvasHeight) * 2;

        // Unproject near clip point (z = -1)
        const ncx = ndcX;
        const ncy = ndcY;
        const nearClipX = invProj[0] * ncx + invProj[4] * ncy - invProj[8] + invProj[12];
        const nearClipY = invProj[1] * ncx + invProj[5] * ncy - invProj[9] + invProj[13];
        const nearClipZ = invProj[2] * ncx + invProj[6] * ncy - invProj[10] + invProj[14];
        const nearClipW = invProj[3] * ncx + invProj[7] * ncy - invProj[11] + invProj[15];
        if (Math.abs(nearClipW) < 1e-10) return null;
        const invNearW = 1 / nearClipW;
        const nearViewX = nearClipX * invNearW;
        const nearViewY = nearClipY * invNearW;
        const nearViewZ = nearClipZ * invNearW;

        // Unproject far clip point (z = 1)
        const farClipX = invProj[0] * ncx + invProj[4] * ncy + invProj[8] + invProj[12];
        const farClipY = invProj[1] * ncx + invProj[5] * ncy + invProj[9] + invProj[13];
        const farClipZ = invProj[2] * ncx + invProj[6] * ncy + invProj[10] + invProj[14];
        const farClipW = invProj[3] * ncx + invProj[7] * ncy + invProj[11] + invProj[15];
        if (Math.abs(farClipW) < 1e-10) return null;
        const invFarW = 1 / farClipW;
        const farViewX = farClipX * invFarW;
        const farViewY = farClipY * invFarW;
        const farViewZ = farClipZ * invFarW;

        // Transform to world space
        const nearWorldW = invView[3] * nearViewX + invView[7] * nearViewY + invView[11] * nearViewZ + invView[15];
        if (Math.abs(nearWorldW) < 1e-10) return null;
        const invNearWorldW = 1 / nearWorldW;
        const rayOriginX = (invView[0] * nearViewX + invView[4] * nearViewY + invView[8] * nearViewZ + invView[12]) * invNearWorldW;
        const rayOriginY = (invView[1] * nearViewX + invView[5] * nearViewY + invView[9] * nearViewZ + invView[13]) * invNearWorldW;
        const rayOriginZ = (invView[2] * nearViewX + invView[6] * nearViewY + invView[10] * nearViewZ + invView[14]) * invNearWorldW;

        const farWorldW = invView[3] * farViewX + invView[7] * farViewY + invView[11] * farViewZ + invView[15];
        if (Math.abs(farWorldW) < 1e-10) return null;
        const invFarWorldW = 1 / farWorldW;
        const rayEndX = (invView[0] * farViewX + invView[4] * farViewY + invView[8] * farViewZ + invView[12]) * invFarWorldW;
        const rayEndY = (invView[1] * farViewX + invView[5] * farViewY + invView[9] * farViewZ + invView[13]) * invFarWorldW;
        const rayEndZ = (invView[2] * farViewX + invView[6] * farViewY + invView[10] * farViewZ + invView[14]) * invFarWorldW;

        let rayDirX = rayEndX - rayOriginX;
        let rayDirY = rayEndY - rayOriginY;
        let rayDirZ = rayEndZ - rayOriginZ;
        const dirLen = Math.sqrt(rayDirX * rayDirX + rayDirY * rayDirY + rayDirZ * rayDirZ);
        if (dirLen < 1e-10) return null;
        const invDirLen = 1 / dirLen;
        rayDirX *= invDirLen;
        rayDirY *= invDirLen;
        rayDirZ *= invDirLen;

        return this._intersectMeshWithInfo(rayOriginX, rayOriginY, rayOriginZ, rayDirX, rayDirY, rayDirZ);
    }

    _getRaycastMatrices(canvasWidth, canvasHeight) {
        const cache = this._raycastMatrixCache;
        if (
            cache.revision === this.cameraRevision
            && cache.width === canvasWidth
            && cache.height === canvasHeight
            && cache.invView
            && cache.invProj
            && cache.viewMatrix
            && cache.projMatrix
        ) {
            return cache;
        }

        const aspect = canvasWidth / canvasHeight;
        const viewMatrix = this.getViewMatrix();
        const projMatrix = this.getProjectionMatrix(aspect);
        const invView = this._invertMatrix(viewMatrix);
        const invProj = this._invertMatrix(projMatrix);

        this._raycastMatrixCache = {
            revision: this.cameraRevision,
            width: canvasWidth,
            height: canvasHeight,
            viewMatrix,
            projMatrix,
            invView,
            invProj
        };
        return this._raycastMatrixCache;
    }

    _intersectMeshWithInfo(ox, oy, oz, dx, dy, dz) {
        const vertices = this.mesh.vertices;
        const faces = this.mesh.faces;
        const normals = this.mesh.normals;
        const faceCount = this.mesh.faceCount;
        const EPSILON = 0.000001;
        const backfaceThreshold = -this.backfaceRejectDot;

        const bvh = this.mesh.triangleBVH;
        if (bvh && bvh.isBuilt && faceCount > 0) {
            const hit = bvh.intersectClosest(
                ox, oy, oz, dx, dy, dz,
                vertices, faces, normals,
                EPSILON,
                backfaceThreshold,
                this.mesh.spatialIndexPadding
            );
            if (hit) return hit;
            return null;
        }

        let closestT = Infinity;

        let hitPointX = 0;
        let hitPointY = 0;
        let hitPointZ = 0;
        let hitNormalX = 0;
        let hitNormalY = 0;
        let hitNormalZ = 0;

        for (let faceId = 0; faceId < faceCount; faceId++) {
            const faceBase = faceId * 3;
            const v0Idx = faces[faceBase];
            const v1Idx = faces[faceBase + 1];
            const v2Idx = faces[faceBase + 2];
            const i0 = v0Idx * 3;
            const i1 = v1Idx * 3;
            const i2 = v2Idx * 3;
            if (i2 + 2 >= vertices.length) continue;

            const v0x = vertices[i0], v0y = vertices[i0 + 1], v0z = vertices[i0 + 2];
            const v1x = vertices[i1], v1y = vertices[i1 + 1], v1z = vertices[i1 + 2];
            const v2x = vertices[i2], v2y = vertices[i2 + 1], v2z = vertices[i2 + 2];

            const edge1x = v1x - v0x, edge1y = v1y - v0y, edge1z = v1z - v0z;
            const edge2x = v2x - v0x, edge2y = v2y - v0y, edge2z = v2z - v0z;

            const hx = dy * edge2z - dz * edge2y;
            const hy = dz * edge2x - dx * edge2z;
            const hz = dx * edge2y - dy * edge2x;
            const a = edge1x * hx + edge1y * hy + edge1z * hz;
            if (a > -EPSILON && a < EPSILON) continue;

            const f = 1 / a;
            const sx = ox - v0x, sy = oy - v0y, sz = oz - v0z;
            const u = f * (sx * hx + sy * hy + sz * hz);
            if (u < 0 || u > 1) continue;

            const qx = sy * edge1z - sz * edge1y;
            const qy = sz * edge1x - sx * edge1z;
            const qz = sx * edge1y - sy * edge1x;
            const v = f * (dx * qx + dy * qy + dz * qz);
            if (v < 0 || u + v > 1) continue;

            const t = f * (edge2x * qx + edge2y * qy + edge2z * qz);
            if (t <= EPSILON || t >= closestT) continue;

            // Interpolate and normalize shading normal.
            const n0 = v0Idx * 3;
            const n1 = v1Idx * 3;
            const n2 = v2Idx * 3;
            const w = 1 - u - v;
            let nx = normals[n0] * w + normals[n1] * u + normals[n2] * v;
            let ny = normals[n0 + 1] * w + normals[n1 + 1] * u + normals[n2 + 1] * v;
            let nz = normals[n0 + 2] * w + normals[n1 + 2] * u + normals[n2 + 2] * v;
            const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz);
            if (nLen < 1e-10) continue;
            const invNLen = 1 / nLen;
            nx *= invNLen;
            ny *= invNLen;
            nz *= invNLen;

            // Backface rejection should follow shading normal, not raw winding.
            const facing = nx * dx + ny * dy + nz * dz;
            if (facing >= backfaceThreshold) continue;

            closestT = t;
            hitPointX = ox + dx * t;
            hitPointY = oy + dy * t;
            hitPointZ = oz + dz * t;
            hitNormalX = nx;
            hitNormalY = ny;
            hitNormalZ = nz;
        }

        if (closestT === Infinity) return null;
        return {
            point: [hitPointX, hitPointY, hitPointZ],
            normal: [hitNormalX, hitNormalY, hitNormalZ]
        };
    }

    /**
     * Matrix inverse for world-to-local conversion
     */
    _invertMatrix(m) {
        const inv = new Float32Array(16);
        const det = this._matrixDeterminant(m);

        if (Math.abs(det) < 0.00001) {
            console.warn("[Sculpt] _invertMatrix: determinant≈0; returned identity because the matrix may be singular");
            return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
        }

        const invDet = 1 / det;

        inv[0] = (m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10]) * invDet;
        inv[1] = (-m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10]) * invDet;
        inv[2] = (m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6]) * invDet;
        inv[3] = (-m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6]) * invDet;
        inv[4] = (-m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10]) * invDet;
        inv[5] = (m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10]) * invDet;
        inv[6] = (-m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6]) * invDet;
        inv[7] = (m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6]) * invDet;
        inv[8] = (m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9]) * invDet;
        inv[9] = (-m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9]) * invDet;
        inv[10] = (m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5]) * invDet;
        inv[11] = (-m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5]) * invDet;
        inv[12] = (-m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9]) * invDet;
        inv[13] = (m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9]) * invDet;
        inv[14] = (-m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5]) * invDet;
        inv[15] = (m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5]) * invDet;

        return inv;
    }

    _matrixDeterminant(m) {
        return m[0] * (m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10])
            - m[1] * (m[4] * m[10] * m[15] - m[4] * m[11] * m[14] - m[8] * m[6] * m[15] + m[8] * m[7] * m[14] + m[12] * m[6] * m[11] - m[12] * m[7] * m[10])
            + m[2] * (m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9])
            - m[3] * (m[4] * m[9] * m[14] - m[4] * m[10] * m[13] - m[8] * m[5] * m[14] + m[8] * m[6] * m[13] + m[12] * m[5] * m[10] - m[12] * m[6] * m[9]);
    }

    _multiplyVec4(m, v) {
        return [
            m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] * v[3],
            m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13] * v[3],
            m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] * v[3],
            m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15] * v[3]
        ];
    }

    _transformPoint(m, p) {
        const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
        if (Math.abs(w) < 1e-10) {
            console.warn("[Sculpt] _transformPoint: w≈0; skipped perspective division");
            return [0, 0, 0];
        }
        return [
            (m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]) / w,
            (m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]) / w,
            (m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]) / w
        ];
    }

    undo() {
        if (this.strokeStarted) {
            this.endStroke();
        }
        if (this.undoStack.length === 0) return false;

        const entry = this.undoStack.pop();
        const ok = this._applyUndoEntry(entry, "before");
        if (ok) {
            this.redoStack.push(entry);
            this._trimHistoryStack(this.redoStack);
        }
        return ok;
    }

    redo() {
        if (this.strokeStarted) {
            this.endStroke();
        }
        if (this.redoStack.length === 0) return false;

        const entry = this.redoStack.pop();
        const ok = this._applyUndoEntry(entry, "after");
        if (ok) {
            this.undoStack.push(entry);
            this._trimHistoryStack(this.undoStack);
        }
        return ok;
    }

    _applyUndoEntry(entry, phase) {
        if (!entry) return false;
        const target = phase === "before" ? entry.before : entry.after;
        if (entry.kind === "full") {
            this.mesh.restoreState(target);
            this.pendingTopologyUpload = true;
            this._syncImportedTextureWithMeshUvs();
            this._afterHistoryApply();
            return true;
        }

        if (entry.kind === "maskDelta" && entry.indices && entry.beforeMask && entry.afterMask) {
            const src = phase === "before" ? entry.beforeMask : entry.afterMask;
            this.mesh.ensureVertexMask();
            const mask = this.mesh.vertexMask;
            const safeLen = Math.min(entry.indices.length, src.length);
            for (let i = 0; i < safeLen; i++) {
                const idx = entry.indices[i];
                if (idx >= 0 && idx < this.mesh.vertexCount) {
                    mask[idx] = src[i];
                }
            }
            this.pendingTopologyUpload = false;
            this._afterHistoryApply();
            return true;
        }

        if (entry.kind === "delta" && entry.indices) {
            const deltaTarget = phase === "before" ? entry.beforePositions : entry.afterPositions;
            if (!deltaTarget) {
                console.error("[Sculpt] _applyUndoEntry: missing", phase, "positions; skipped entry because history may be inconsistent");
                return false;
            }
            const vertices = this.mesh.vertices;
            let ptr = 0;
            for (let i = 0; i < entry.indices.length; i++) {
                const idx = entry.indices[i];
                if (idx < 0 || idx >= this.mesh.vertexCount) {
                    ptr += 3;
                    continue;
                }
                const vi = idx * 3;
                vertices[vi] = deltaTarget[ptr];
                vertices[vi + 1] = deltaTarget[ptr + 1];
                vertices[vi + 2] = deltaTarget[ptr + 2];
                ptr += 3;
            }
            this.mesh.recalculateNormalsPartial(entry.indices);
            this.mesh.computeEdgeLengths(entry.indices);
            // A delta entry only rewrites positions, so topology is unchanged.
            this.mesh.refreshSpatialIndexForMovedVertices();
            this.pendingTopologyUpload = false;
            this._afterHistoryApply();
            return true;
        }

        return false;
    }

    _syncImportedTextureWithMeshUvs() {
        const vc = this.mesh.vertexCount;
        if (!this.mesh.uvs || this.mesh.uvs.length !== vc * 2) {
            this._setImportedDiffuseImage(null);
        }
    }

    _setImportedDiffuseImage(image) {
        const previous = this.importedDiffuseImage;
        if (previous === image) return;
        this.importedDiffuseImage = image;
        try {
            previous?.close?.();
        } catch {
            /* decoded image resource already closed */
        }
    }

    destroy() {
        this._setImportedDiffuseImage(null);
    }

    _afterHistoryApply() {
        this.geometryRevision++;
        this.normalRecalcCounter = 0;
        this.strokeDabCount = 0;
        this.octreeDirty = false;
        this.clayStrokeState = null;
        this._strokeUndoSession = null;
        this._updateSpatialRebuildInterval();
    }

    _updateSpatialRebuildInterval() {
        const vtx = this.mesh?.vertexCount || 0;
        if (vtx <= 0) {
            this.octreeRebuildInterval = 24;
            return;
        }
        // Dense meshes rebuild less frequently during stroke, always rebuilt at stroke end.
        const interval = Math.floor(vtx / 2400);
        this.octreeRebuildInterval = Math.max(24, Math.min(64, interval));
    }

    _resolvePerfTier(applyMs) {
        const ms = Number.isFinite(applyMs) ? Math.max(0, applyMs) : 0;
        if (ms >= this.perfBudget.hardLimitMs) return "degrade2";
        if (ms >= this.perfBudget.softLimitMs) return "degrade1";
        return "normal";
    }

    getPerfSnapshot() {
        return this.lastPerfSnapshot;
    }

    _computeDirtyRangesFromIndices(indices) {
        if (!indices || indices.length === 0) return [];
        if (indices.length > 2048) {
            return [{ start: 0, count: this.mesh.vertexCount }];
        }
        const uniqueSorted = Array.from(new Set(indices))
            .filter((idx) => idx >= 0 && idx < this.mesh.vertexCount)
            .sort((a, b) => a - b);
        if (uniqueSorted.length === 0) return [];

        const ranges = [];
        let start = uniqueSorted[0];
        let end = start;
        for (let i = 1; i < uniqueSorted.length; i++) {
            const idx = uniqueSorted[i];
            if (idx <= end + 2) {
                end = idx;
                continue;
            }
            ranges.push({ start, count: (end - start + 1) });
            start = idx;
            end = idx;
        }
        ranges.push({ start, count: (end - start + 1) });

        // Too fragmented ranges can be slower than one upload.
        if (ranges.length > 56) {
            return [{ start: 0, count: this.mesh.vertexCount }];
        }
        return ranges;
    }

    canUndo() {
        return this.undoStack.length > 0;
    }

    canRedo() {
        return this.redoStack.length > 0;
    }

    /**
     * Serialize state for saving
     */
    _serializeCommonState() {
        const cam = this.camera;
        return {
            camera: {
                distance: cam.distance,
                theta: cam.theta,
                phi: cam.phi,
                target: [cam.target[0], cam.target[1], cam.target[2]],
                fov: cam.fov,
                near: cam.near,
                far: cam.far
            },
            baseColor: this.baseColor,
            matcapIntensity: this.matcapIntensity,
            lightingPreset: this.lightingPreset,
            lightPower: this.lightPower,
            lightYaw: this.lightYaw,
            lightPitch: this.lightPitch,
            showWireframe: this.showWireframe,
            showGrid: this.showGrid,
            showImportedTexture: this.showImportedTexture,
            toolSettings: {
                activeBrush: this.activeBrush,
                brushRadius: this.brushRadius,
                brushStrength: this.brushStrength,
                innerRadiusRatio: this.innerRadiusRatio,
                symmetry: this.symmetry,
                strokeMode: this.strokeMode,
                maskPaintMode: this.maskPaintMode
            }
        };
    }

    serialize() {
        return {
            schemaVersion: 5,
            ...this.mesh.serialize(),
            ...this._serializeCommonState()
        };
    }

    /**
     * Geometry-only payload for the server-side mesh store (vertices, faces,
     * uvs, vertexMask). Camera and tool settings stay in the workflow stub.
     */
    serializeMeshPayload() {
        return {
            schemaVersion: 5,
            ...this.mesh.serialize()
        };
    }

    /**
     * Large geometry is stored separately; NodeUI attaches a current mesh ref.
     */
    serializeForWidget() {
        if (
            this.mesh.vertexCount <= this.maxWidgetSerializeVertices &&
            this.mesh.faces.length <= MAX_WIDGET_EMBED_FACE_INDICES
        ) {
            return this.serialize();
        }
        return {
            schemaVersion: 5,
            _meshOmittedFromWorkflow: true,
            vertexCount: this.mesh.vertexCount,
            faceCount: this.mesh.faceCount,
            ...this._serializeCommonState()
        };
    }
}

export { BRUSH_TYPES };
