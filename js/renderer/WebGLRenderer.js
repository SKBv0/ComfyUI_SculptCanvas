/**
 * WebGL renderer for the sculpt mesh: analytic stylized shading (multi-light
 * GGX) plus wireframe, grid, and cursor passes.
 */

import {
    VERTEX_SHADER,
    FRAGMENT_SHADER,
    WIREFRAME_VERTEX_SHADER,
    WIREFRAME_FRAGMENT_SHADER,
    CURSOR_VERTEX_SHADER,
    CURSOR_FRAGMENT_SHADER,
    GRID_VERTEX_SHADER,
    GRID_VERTEX_SHADER_WEBGL2,
    GRID_FRAGMENT_SHADER,
    GRID_FRAGMENT_SHADER_DERIVATIVES_WEBGL1,
    GRID_FRAGMENT_SHADER_DERIVATIVES_WEBGL2
} from "./Shaders.js";

// exposure: calibrated so 18% grey shows as 18% grey (tests/calibration.test.js).
export const LIGHTING_PRESETS = {
    zbrush_red_wax: {
        keyDir: [0.45, 0.65, 0.60],
        fillDir: [-0.20, 0.90, -0.40],
        rimDir: [-0.90, 0.15, 0.20],
        keyIntensity: 1.08,
        fillIntensity: 0.20,
        rimIntensity: 0.55,
        ambient: 0.26,
        ambientTint: [1.00, 0.93, 0.88],
        keyColor: [1.00, 0.92, 0.84],
        fillColor: [0.64, 0.74, 0.95],
        rimColor: [1.00, 0.78, 0.66],
        exposure: 3.54,
        specularBoost: 0.96,
        subsurfaceStrength: 0.58,
        bgTop: [0.22, 0.22, 0.24],
        bgBottom: [0.12, 0.12, 0.14]
    },
    neutral_grey_clay: {
        keyDir: [0.35, 0.70, 0.60],
        fillDir: [-0.50, 0.30, 0.80],
        rimDir: [-0.15, 0.80, -0.50],
        keyIntensity: 1.08,
        fillIntensity: 0.26,
        rimIntensity: 0.32,
        ambient: 0.27,
        ambientTint: [0.94, 0.96, 1.00],
        keyColor: [0.95, 0.97, 1.00],
        fillColor: [0.72, 0.80, 0.92],
        rimColor: [0.92, 0.95, 1.00],
        exposure: 3.38,
        specularBoost: 0.86,
        subsurfaceStrength: 0.42,
        bgTop: [0.26, 0.26, 0.28],
        bgBottom: [0.14, 0.14, 0.16]
    },
    soft_fill: {
        keyDir: [0.3, 0.52, 0.8],
        fillDir: [-0.55, 0.5, 0.67],
        rimDir: [-0.2, 0.72, -0.66],
        keyIntensity: 0.7,
        fillIntensity: 0.58,
        rimIntensity: 0.16,
        ambient: 0.48,
        ambientTint: [0.95, 0.98, 1.00],
        keyColor: [0.97, 0.95, 0.90],
        fillColor: [0.78, 0.84, 0.97],
        rimColor: [0.92, 0.96, 1.00],
        exposure: 2.58,
        specularBoost: 0.82,
        subsurfaceStrength: 0.52,
        bgTop: [0.19, 0.2, 0.23],
        bgBottom: [0.1, 0.11, 0.12]
    },
    rim_dramatic: {
        keyDir: [0.52, 0.56, 0.64],
        fillDir: [-0.6, 0.1, 0.79],
        rimDir: [-0.05, 0.94, -0.33],
        keyIntensity: 0.95,
        fillIntensity: 0.34,
        rimIntensity: 0.48,
        ambient: 0.33,
        ambientTint: [0.92, 0.94, 1.00],
        keyColor: [1.00, 0.90, 0.78],
        fillColor: [0.56, 0.66, 0.86],
        rimColor: [0.80, 0.90, 1.00],
        exposure: 3.19,
        specularBoost: 1.02,
        subsurfaceStrength: 0.46,
        bgTop: [0.14, 0.15, 0.18],
        bgBottom: [0.07, 0.08, 0.1]
    },
    studio_portrait: {
        keyDir: [0.62, 0.48, 0.62],
        fillDir: [-0.42, 0.52, 0.74],
        rimDir: [-0.35, 0.62, -0.70],
        keyIntensity: 1.04,
        fillIntensity: 0.42,
        rimIntensity: 0.32,
        ambient: 0.31,
        ambientTint: [1.00, 0.92, 0.86],
        keyColor: [1.00, 0.88, 0.72],
        fillColor: [0.70, 0.80, 1.00],
        rimColor: [1.00, 0.82, 0.70],
        exposure: 3.15,
        specularBoost: 1.00,
        subsurfaceStrength: 0.64,
        bgTop: [0.20, 0.18, 0.19],
        bgBottom: [0.09, 0.08, 0.09]
    },
    museum_clay: {
        keyDir: [0.30, 0.70, 0.64],
        fillDir: [-0.44, 0.24, 0.86],
        rimDir: [-0.20, 0.82, -0.52],
        keyIntensity: 0.78,
        fillIntensity: 0.44,
        rimIntensity: 0.18,
        ambient: 0.46,
        ambientTint: [0.98, 0.94, 0.88],
        keyColor: [0.94, 0.90, 0.82],
        fillColor: [0.84, 0.86, 0.92],
        rimColor: [0.96, 0.94, 0.88],
        exposure: 2.89,
        specularBoost: 0.74,
        subsurfaceStrength: 0.36,
        bgTop: [0.25, 0.24, 0.23],
        bgBottom: [0.13, 0.12, 0.12]
    },
    daylight_balanced: {
        keyDir: [0.42, 0.62, 0.66],
        fillDir: [-0.52, 0.42, 0.74],
        rimDir: [-0.28, 0.76, -0.58],
        keyIntensity: 0.84,
        fillIntensity: 0.56,
        rimIntensity: 0.22,
        ambient: 0.50,
        ambientTint: [0.95, 0.98, 1.00],
        keyColor: [1.00, 0.98, 0.92],
        fillColor: [0.78, 0.86, 1.00],
        rimColor: [0.90, 0.96, 1.00],
        exposure: 2.34,
        specularBoost: 0.86,
        subsurfaceStrength: 0.48,
        bgTop: [0.22, 0.25, 0.28],
        bgBottom: [0.11, 0.13, 0.15]
    },
    noir_workshop: {
        keyDir: [0.60, 0.48, 0.54],
        fillDir: [-0.46, 0.10, 0.88],
        rimDir: [-0.12, 0.92, -0.36],
        keyIntensity: 0.92,
        fillIntensity: 0.28,
        rimIntensity: 0.54,
        ambient: 0.30,
        ambientTint: [0.90, 0.92, 0.98],
        keyColor: [1.00, 0.90, 0.76],
        fillColor: [0.54, 0.64, 0.84],
        rimColor: [0.78, 0.90, 1.00],
        exposure: 3.44,
        specularBoost: 1.08,
        subsurfaceStrength: 0.42,
        bgTop: [0.15, 0.16, 0.20],
        bgBottom: [0.07, 0.08, 0.10]
    }
};

export class WebGLRenderer {
    constructor(canvas, options = {}) {
        this.canvas = canvas;
        this.options = options;
        this.contextAttributes = {
            antialias: true,
            alpha: true,
            // Queue captures use readPixels immediately after rendering, so
            // retaining the default framebuffer between composites is wasteful.
            preserveDrawingBuffer: false,
            powerPreference: "high-performance"
        };

        this.gl =
            canvas.getContext("webgl2", this.contextAttributes) ||
            canvas.getContext("webgl", this.contextAttributes);
        if (!this.gl) {
            throw new Error("WebGL not supported");
        }

        this.isWebGL2 =
            typeof WebGL2RenderingContext !== "undefined" &&
            this.gl instanceof WebGL2RenderingContext;
        this._stdDerivExt = this.isWebGL2 ? true : this.gl.getExtension("OES_standard_derivatives");
        this._gridUseDerivatives = this.isWebGL2 || !!this._stdDerivExt;

        this.contextLost = false;
        this._contextLostHandler = (event) => {
            event.preventDefault();
            this.contextLost = true;
            this.options.onContextLost?.();
        };
        this._contextRestoredHandler = () => {
            this.contextLost = false;
            this._rebuildAfterContextRestore();
            this.options.onContextRestored?.();
        };
        this.canvas.addEventListener("webglcontextlost", this._contextLostHandler, false);
        this.canvas.addEventListener("webglcontextrestored", this._contextRestoredHandler, false);

        this._uint32IndicesSupported =
            this.isWebGL2 || !!this.gl.getExtension("OES_element_index_uint");

        this.meshProgram = null;
        this.wireframeProgram = null;
        this.cursorProgram = null;
        this.gridProgram = null;

        this.vertexBuffer = null;
        this.normalBuffer = null;
        this.uvBuffer = null;
        this.indexBuffer = null;
        this.wireframeIndexBuffer = null;
        this.cursorBuffer = null;
        this.gridBuffer = null;

        this.indexCount = 0;
        this.wireframeIndexCount = 0;
        this._vertexBufferLength = 0;
        this._normalBufferLength = 0;
        this._uvBufferLength = 0;
        this._uvDummyScratch = null;
        this.importedDiffuseTexture = null;
        this._importedDiffuseTexSource = null;
        this.showImportedTexture = true;
        this._whiteDummyTexture = null;

        // Visual settings
        this.showWireframe = false;
        this.showGrid = true;
        this.baseColor = [0.38, 0.08, 0.02];
        this.wireColor = [0.15, 0.15, 0.18];
        this.wireOpacity = 0.4;
        this.matcapIntensity = 1.0;
        this.lightingPreset = "zbrush_red_wax";
        this.lightPower = 1.0;
        this.lightYaw = -60.0;
        this.lightPitch = 0.0;
        this.lightRig = {
            keyDir: [0.38, 0.64, 0.67],
            fillDir: [-0.55, 0.3, 0.78],
            rimDir: [-0.15, 0.88, -0.45],
            keyIntensity: 0.92,
            fillIntensity: 0.36,
            rimIntensity: 0.28,
            ambient: 0.34,
            ambientTint: [1.0, 1.0, 1.0],
            keyColor: [1.0, 1.0, 1.0],
            fillColor: [1.0, 1.0, 1.0],
            rimColor: [1.0, 1.0, 1.0],
            exposure: 3.0,
            specularBoost: 1.0,
            subsurfaceStrength: 0.5
        };

        // Cursor state
        this.cursorVisible = false;
        this.cursorCenter = [0, 0, 0];
        this.cursorNormal = [0, 1, 0];
        this.cursorRadius = 0.15;
        this.cursorColor = [1.0, 0.5, 0.1];
        this.cursorInnerRatio = 0.4;

        // Symmetry cursor state
        this.symCursorVisible = false;
        this.symCursorCenter = [0, 0, 0];
        this.symCursorNormal = [0, 1, 0];

        this.currentMesh = null;

        // Background gradient
        this.bgColorTop = [0.18, 0.18, 0.22];
        this.bgColorBottom = [0.10, 0.10, 0.12];
        this._cachedBackgroundCss = "";
        this._baseCanvasWidth = 1;
        this._baseCanvasHeight = 1;
        this.setLightingPreset("zbrush_red_wax");

        this._initShaders();
        this._initBuffers();
        this._initCursorGeometry();
    }
    _normalize(v) {
        const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
        return len > 0 ? [v[0] / len, v[1] / len, v[2] / len] : [0, 0, 0];
    }

    _transformDirection(viewMatrix, dir) {
        // Transform world-space direction to view-space (ignore translation).
        return this._normalize([
            viewMatrix[0] * dir[0] + viewMatrix[4] * dir[1] + viewMatrix[8] * dir[2],
            viewMatrix[1] * dir[0] + viewMatrix[5] * dir[1] + viewMatrix[9] * dir[2],
            viewMatrix[2] * dir[0] + viewMatrix[6] * dir[1] + viewMatrix[10] * dir[2]
        ]);
    }

    _rotateDirection(dir, yawDeg = 0, pitchDeg = 0) {
        const yaw = (yawDeg * Math.PI) / 180.0;
        const pitch = (pitchDeg * Math.PI) / 180.0;
        const cy = Math.cos(yaw);
        const sy = Math.sin(yaw);
        const cp = Math.cos(pitch);
        const sp = Math.sin(pitch);

        // Yaw around global Y axis.
        const xYaw = dir[0] * cy + dir[2] * sy;
        const yYaw = dir[1];
        const zYaw = -dir[0] * sy + dir[2] * cy;

        // Pitch around global X axis.
        const x = xYaw;
        const y = yYaw * cp - zYaw * sp;
        const z = yYaw * sp + zYaw * cp;
        return this._normalize([x, y, z]);
    }

    _rebuildAfterContextRestore() {
        this.isWebGL2 =
            typeof WebGL2RenderingContext !== "undefined" &&
            this.gl instanceof WebGL2RenderingContext;
        this._stdDerivExt = this.isWebGL2 ? true : this.gl.getExtension("OES_standard_derivatives");
        this._gridUseDerivatives = this.isWebGL2 || !!this._stdDerivExt;
        this._uint32IndicesSupported =
            this.isWebGL2 || !!this.gl.getExtension("OES_element_index_uint");
        this.meshProgram = null;
        this.wireframeProgram = null;
        this.cursorProgram = null;
        this.gridProgram = null;

        this.vertexBuffer = null;
        this.normalBuffer = null;
        this.uvBuffer = null;
        this.indexBuffer = null;
        this.wireframeIndexBuffer = null;
        this.cursorBuffer = null;
        this.gridBuffer = null;

        this.indexCount = 0;
        this.wireframeIndexCount = 0;
        this._vertexBufferLength = 0;
        this._normalBufferLength = 0;
        this._uvBufferLength = 0;
        this._uvDummyScratch = null;
        if (this.importedDiffuseTexture) {
            this.gl?.deleteTexture(this.importedDiffuseTexture);
        }
        this.importedDiffuseTexture = null;
        this._importedDiffuseTexSource = null;
        if (this._whiteDummyTexture) {
            this.gl?.deleteTexture(this._whiteDummyTexture);
        }
        this._whiteDummyTexture = null;

        this._initShaders();
        this._initBuffers();
        this._initCursorGeometry();
        this._applyCanvasSize();
        this._applyCanvasBackground();

        if (this.currentMesh) {
            this.updateMesh(this.currentMesh, { topologyChanged: true });
        }
    }

    _applyCanvasBackground() {
        const t = this.bgColorTop;
        const b = this.bgColorBottom;
        const rT = Math.round(t[0] * 255);
        const gT = Math.round(t[1] * 255);
        const bT = Math.round(t[2] * 255);
        const rB = Math.round(b[0] * 255);
        const gB = Math.round(b[1] * 255);
        const bB = Math.round(b[2] * 255);
        const css = `radial-gradient(circle at 50% 45%, rgb(${rT}, ${gT}, ${bT}) 0%, rgb(${rB}, ${gB}, ${bB}) 85%, rgb(10, 10, 12) 100%)`;

        if (css !== this._cachedBackgroundCss) {
            this._cachedBackgroundCss = css;
            this.canvas.style.background = css;
        }
    }
    _initShaders() {
        const gl = this.gl;

        this.meshProgram = this._createProgram(VERTEX_SHADER, FRAGMENT_SHADER);
        if (this.meshProgram) {
            this.meshProgram.aPosition = gl.getAttribLocation(this.meshProgram, "aPosition");
            this.meshProgram.aNormal = gl.getAttribLocation(this.meshProgram, "aNormal");
            this.meshProgram.aUv = gl.getAttribLocation(this.meshProgram, "aUv");
            this.meshProgram.aMask = gl.getAttribLocation(this.meshProgram, "aMask");
            this.meshProgram.uModelView = gl.getUniformLocation(this.meshProgram, "uModelView");
            this.meshProgram.uProjection = gl.getUniformLocation(this.meshProgram, "uProjection");
            this.meshProgram.uKeyLightDir = gl.getUniformLocation(this.meshProgram, "uKeyLightDir");
            this.meshProgram.uFillLightDir = gl.getUniformLocation(this.meshProgram, "uFillLightDir");
            this.meshProgram.uRimLightDir = gl.getUniformLocation(this.meshProgram, "uRimLightDir");
            this.meshProgram.uKeyIntensity = gl.getUniformLocation(this.meshProgram, "uKeyIntensity");
            this.meshProgram.uFillIntensity = gl.getUniformLocation(this.meshProgram, "uFillIntensity");
            this.meshProgram.uRimIntensity = gl.getUniformLocation(this.meshProgram, "uRimIntensity");
            this.meshProgram.uKeyLightColor = gl.getUniformLocation(this.meshProgram, "uKeyLightColor");
            this.meshProgram.uFillLightColor = gl.getUniformLocation(this.meshProgram, "uFillLightColor");
            this.meshProgram.uRimLightColor = gl.getUniformLocation(this.meshProgram, "uRimLightColor");
            this.meshProgram.uAmbientTint = gl.getUniformLocation(this.meshProgram, "uAmbientTint");
            this.meshProgram.uAmbientStrength = gl.getUniformLocation(this.meshProgram, "uAmbientStrength");
            this.meshProgram.uBaseColor = gl.getUniformLocation(this.meshProgram, "uBaseColor");
            this.meshProgram.uMatcapIntensity = gl.getUniformLocation(this.meshProgram, "uMatcapIntensity");
            this.meshProgram.uExposure = gl.getUniformLocation(this.meshProgram, "uExposure");
            this.meshProgram.uSpecularBoost = gl.getUniformLocation(this.meshProgram, "uSpecularBoost");
            this.meshProgram.uSubsurfaceStrength = gl.getUniformLocation(this.meshProgram, "uSubsurfaceStrength");
            this.meshProgram.uDiffuseMap = gl.getUniformLocation(this.meshProgram, "uDiffuseMap");
            this.meshProgram.uUseTexture = gl.getUniformLocation(this.meshProgram, "uUseTexture");
        }

        this.wireframeProgram = this._createProgram(WIREFRAME_VERTEX_SHADER, WIREFRAME_FRAGMENT_SHADER);
        if (this.wireframeProgram) {
            this.wireframeProgram.aPosition = gl.getAttribLocation(this.wireframeProgram, "aPosition");
            this.wireframeProgram.uModelView = gl.getUniformLocation(this.wireframeProgram, "uModelView");
            this.wireframeProgram.uProjection = gl.getUniformLocation(this.wireframeProgram, "uProjection");
            this.wireframeProgram.uWireColor = gl.getUniformLocation(this.wireframeProgram, "uWireColor");
            this.wireframeProgram.uOpacity = gl.getUniformLocation(this.wireframeProgram, "uOpacity");
        }

        this.cursorProgram = this._createProgram(CURSOR_VERTEX_SHADER, CURSOR_FRAGMENT_SHADER);
        if (this.cursorProgram) {
            this.cursorProgram.aPosition = gl.getAttribLocation(this.cursorProgram, "aPosition");
            this.cursorProgram.uModelView = gl.getUniformLocation(this.cursorProgram, "uModelView");
            this.cursorProgram.uProjection = gl.getUniformLocation(this.cursorProgram, "uProjection");
            this.cursorProgram.uCursorCenter = gl.getUniformLocation(this.cursorProgram, "uCursorCenter");
            this.cursorProgram.uCursorNormal = gl.getUniformLocation(this.cursorProgram, "uCursorNormal");
            this.cursorProgram.uCursorRadius = gl.getUniformLocation(this.cursorProgram, "uCursorRadius");
            this.cursorProgram.uCursorColor = gl.getUniformLocation(this.cursorProgram, "uCursorColor");
            this.cursorProgram.uInnerRatio = gl.getUniformLocation(this.cursorProgram, "uInnerRatio");
        }

        let gridVert = GRID_VERTEX_SHADER;
        let gridFrag = GRID_FRAGMENT_SHADER;
        if (this._gridUseDerivatives) {
            if (this.isWebGL2) {
                gridVert = GRID_VERTEX_SHADER_WEBGL2;
                gridFrag = GRID_FRAGMENT_SHADER_DERIVATIVES_WEBGL2;
            } else {
                gridFrag = GRID_FRAGMENT_SHADER_DERIVATIVES_WEBGL1;
            }
        }
        this.gridProgram = this._createProgram(gridVert, gridFrag);
        if (!this.gridProgram && this._gridUseDerivatives) {
            this.gridProgram = this._createProgram(GRID_VERTEX_SHADER, GRID_FRAGMENT_SHADER);
        }
        if (this.gridProgram) {
            this.gridProgram.aPosition = gl.getAttribLocation(this.gridProgram, "aPosition");
            this.gridProgram.uModelView = gl.getUniformLocation(this.gridProgram, "uModelView");
            this.gridProgram.uProjection = gl.getUniformLocation(this.gridProgram, "uProjection");
            this.gridProgram.uGridOffsetY = gl.getUniformLocation(this.gridProgram, "uGridOffsetY");
        }
    }

    _createProgram(vertexSource, fragmentSource) {
        const gl = this.gl;

        const vertexShader = this._compileShader(gl.VERTEX_SHADER, vertexSource);
        const fragmentShader = this._compileShader(gl.FRAGMENT_SHADER, fragmentSource);

        if (!vertexShader || !fragmentShader) return null;

        const program = gl.createProgram();
        gl.attachShader(program, vertexShader);
        gl.attachShader(program, fragmentShader);
        gl.linkProgram(program);

        const linked = gl.getProgramParameter(program, gl.LINK_STATUS);
        if (!linked) {
            console.error("SculptEngine: Program link failed.", gl.getProgramInfoLog(program));
            gl.deleteProgram(program);
            gl.deleteShader(vertexShader);
            gl.deleteShader(fragmentShader);
            return null;
        }

        // The linked program keeps its own copy of the compiled code, so the
        // shader objects can be released here.
        gl.detachShader(program, vertexShader);
        gl.detachShader(program, fragmentShader);
        gl.deleteShader(vertexShader);
        gl.deleteShader(fragmentShader);

        return program;
    }

    _compileShader(type, source) {
        const gl = this.gl;

        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);

        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            const typeName = type === gl.VERTEX_SHADER ? "vertex" : "fragment";
            const info = gl.getShaderInfoLog(shader) || "unknown shader compile error";
            const numberedSource = source
                .split("\n")
                .map((line, idx) => `${idx + 1}: ${line}`)
                .join("\n");
            console.error(`SculptEngine: Shader compilation failed (${typeName}).`, info);
            console.error(numberedSource);
            gl.deleteShader(shader);
            return null;
        }

        return shader;
    }

    _initBuffers() {
        const gl = this.gl;

        this.vertexBuffer = gl.createBuffer();
        this.normalBuffer = gl.createBuffer();
        this.maskBuffer = gl.createBuffer();
        this.uvBuffer = gl.createBuffer();
        this.indexBuffer = gl.createBuffer();
        this.wireframeIndexBuffer = gl.createBuffer();
        this.gridBuffer = gl.createBuffer();
        this._initGridBuffer();
    }

    _initGridBuffer() {
        const gl = this.gl;
        const size = 10;
        const vertices = new Float32Array([
            -size, 0, -size,
            size, 0, -size,
            -size, 0, size,

            size, 0, -size,
            size, 0, size,
            -size, 0, size
        ]);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.gridBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    }

    _initCursorGeometry() {
        const gl = this.gl;

        // Unit disc as a triangle fan: centre vertex plus a closed ring.
        const segments = 32;
        const vertices = [0, 0, 0];

        for (let i = 0; i <= segments; i++) {
            const angle = (i / segments) * Math.PI * 2;
            vertices.push(Math.cos(angle), Math.sin(angle), 0);
        }

        this.cursorBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.cursorBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);
        this.cursorVertexCount = segments + 2;
    }

    _ensureMaskScratch(vertexCount) {
        const n = Math.max(0, vertexCount | 0);
        if (!this._maskZeroScratch || this._maskZeroScratch.length !== n) {
            this._maskZeroScratch = new Float32Array(n);
        }
        return this._maskZeroScratch;
    }

    updateMesh(mesh, options = true) {
        if (this.contextLost || !this.gl) return;

        const gl = this.gl;

        if (!mesh?.vertices || mesh.vertices.length === 0) return;

        this.currentMesh = mesh;
        const normalized = typeof options === "object" && options !== null
            ? options
            : { topologyChanged: !!options };
        const topologyChanged = !!normalized.topologyChanged;
        const dirtyRanges = Array.isArray(normalized.dirtyRanges) ? normalized.dirtyRanges : null;
        const normalDirtyRanges = Array.isArray(normalized.normalDirtyRanges) ? normalized.normalDirtyRanges : null;
        const shouldUseRangeUpload = !topologyChanged && dirtyRanges && dirtyRanges.length > 0;
        const tooFragmented = shouldUseRangeUpload && dirtyRanges.length > 48;
        const maskChanged = !!normalized.maskChanged;
        const vc = mesh.vertexCount;
        const maskData =
            mesh.vertexMask && mesh.vertexMask.length === vc
                ? mesh.vertexMask
                : this._ensureMaskScratch(vc);
        const bufferSizeChanged =
            this._vertexBufferLength !== mesh.vertices.length
            || this._normalBufferLength !== mesh.normals.length
            || this._maskBufferLength !== vc
            || this._uvBufferLength !== vc * 2;
        const maskOnly = maskChanged && !topologyChanged && !bufferSizeChanged;
        const shouldUploadFullGeometry =
            topologyChanged
            || bufferSizeChanged
            || (!maskOnly && (!shouldUseRangeUpload || tooFragmented));

        if (shouldUploadFullGeometry) {
            gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.DYNAMIC_DRAW);
            this._vertexBufferLength = mesh.vertices.length;

            gl.bindBuffer(gl.ARRAY_BUFFER, this.normalBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, mesh.normals, gl.DYNAMIC_DRAW);
            this._normalBufferLength = mesh.normals.length;
        } else if (!maskOnly) {
            this._uploadDirtyRanges(this.vertexBuffer, mesh.vertices, dirtyRanges);
            if (normalDirtyRanges && normalDirtyRanges.length > 0 && normalDirtyRanges.length <= 48) {
                this._uploadDirtyRanges(this.normalBuffer, mesh.normals, normalDirtyRanges);
            } else {
                gl.bindBuffer(gl.ARRAY_BUFFER, this.normalBuffer);
                gl.bufferData(gl.ARRAY_BUFFER, mesh.normals, gl.DYNAMIC_DRAW);
                this._normalBufferLength = mesh.normals.length;
            }
        }

        const uvNeed = vc * 2;
        const hasMeshUvs = !!(mesh.uvs && mesh.uvs.length === uvNeed);
        if (!this._uvDummyScratch || this._uvDummyScratch.length !== uvNeed) {
            this._uvDummyScratch = new Float32Array(uvNeed);
            this._uvDummyScratch.fill(0.5);
        }
        const uvData = hasMeshUvs ? mesh.uvs : this._uvDummyScratch;
        if (topologyChanged || bufferSizeChanged) {
            gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, uvData, gl.DYNAMIC_DRAW);
            this._uvBufferLength = uvNeed;
        }

        if (topologyChanged || bufferSizeChanged) {
            gl.bindBuffer(gl.ARRAY_BUFFER, this.maskBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, maskData, gl.DYNAMIC_DRAW);
            this._maskBufferLength = vc;
        } else if (maskChanged) {
            if (shouldUseRangeUpload && !tooFragmented) {
                this._uploadDirtyRanges1(this.maskBuffer, maskData, dirtyRanges);
            } else {
                gl.bindBuffer(gl.ARRAY_BUFFER, this.maskBuffer);
                gl.bufferData(gl.ARRAY_BUFFER, maskData, gl.DYNAMIC_DRAW);
            }
        }

        if (topologyChanged || this.indexCount === 0) {
            if (!this._uint32IndicesSupported && mesh.vertexCount > 65535) {
                console.warn("SculptEngine: Mesh exceeds 16-bit bounds. Upgrade browser for uint support.");
                return;
            }

            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
            const indexArray = this._uint32IndicesSupported ? mesh.faces : new Uint16Array(mesh.faces);
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indexArray, gl.STATIC_DRAW);
            this.indexCount = mesh.faces.length;

            // The floor grid sits at the lowest vertex. Only a new mesh or a
            // subdivision can move it, so it is recomputed with the topology.
            let minY = 0.0;
            if (mesh.vertices.length > 1) {
                minY = mesh.vertices[1];
                for (let i = 1; i < mesh.vertices.length; i += 3) {
                    if (mesh.vertices[i] < minY) minY = mesh.vertices[i];
                }
            }
            this.gridOffsetY = minY;

            this._updateWireframeIndices(mesh);
        }
    }

    _uploadDirtyRanges(buffer, source, dirtyRanges) {
        const gl = this.gl;
        if (!buffer || !source || !dirtyRanges || dirtyRanges.length === 0) return;
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        const bytesPerVertex = 3 * 4;
        for (const range of dirtyRanges) {
            if (!range || range.count <= 0) continue;
            const start = Math.max(0, Math.floor(range.start));
            const count = Math.max(0, Math.floor(range.count));
            if (count <= 0) continue;
            const from = start * 3;
            const to = Math.min(source.length, (start + count) * 3);
            if (to <= from) continue;
            gl.bufferSubData(gl.ARRAY_BUFFER, start * bytesPerVertex, source.subarray(from, to));
        }
    }

    _uploadDirtyRanges1(buffer, source, dirtyRanges) {
        const gl = this.gl;
        if (!buffer || !source || !dirtyRanges || dirtyRanges.length === 0) return;
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        const bytesPerVertex = 4;
        for (const range of dirtyRanges) {
            if (!range || range.count <= 0) continue;
            const start = Math.max(0, Math.floor(range.start));
            const count = Math.max(0, Math.floor(range.count));
            if (count <= 0) continue;
            const to = Math.min(source.length, start + count);
            if (to <= start) continue;
            gl.bufferSubData(
                gl.ARRAY_BUFFER,
                start * bytesPerVertex,
                source.subarray(start, to)
            );
        }
    }

    _applyCanvasSize() {
        const dpr =
            typeof window !== "undefined" && window.devicePixelRatio
                ? Math.min(window.devicePixelRatio, 2)
                : 1;
        const width = Math.max(1, Math.floor(this._baseCanvasWidth * dpr));
        const height = Math.max(1, Math.floor(this._baseCanvasHeight * dpr));
        this.canvas.width = width;
        this.canvas.height = height;
    }

    setBaseColor(color) {
        this.baseColor = color;
    }

    setImportedDiffuse(image) {
        const gl = this.gl;
        if (!gl || this.contextLost) return;
        if (image == null) {
            this._removeImportedDiffuseLoadListener();
            if (this.importedDiffuseTexture) {
                gl.deleteTexture(this.importedDiffuseTexture);
            }
            this.importedDiffuseTexture = null;
            this._importedDiffuseTexSource = null;
            return;
        }
        if (
            image === this._importedDiffuseTexSource &&
            (this.importedDiffuseTexture || this._importedDiffuseLoadHandler)
        ) {
            return;
        }
        if (image !== this._importedDiffuseTexSource) {
            this._removeImportedDiffuseLoadListener();
            if (this.importedDiffuseTexture) {
                gl.deleteTexture(this.importedDiffuseTexture);
            }
            this.importedDiffuseTexture = null;
            this._importedDiffuseTexSource = image;
        }

        const tryUpload = () => {
            const w = image.width || image.videoWidth || 0;
            const h = image.height || image.videoHeight || 0;
            if (w <= 0 || h <= 0) return false;
            if (this.importedDiffuseTexture) {
                gl.deleteTexture(this.importedDiffuseTexture);
            }
            const tex = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
            const isPow2 = (v) => v > 0 && (v & (v - 1)) === 0;
            if (isPow2(w) && isPow2(h)) {
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
                gl.generateMipmap(gl.TEXTURE_2D);
            } else {
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            }
            this.importedDiffuseTexture = tex;
            return true;
        };

        if (!tryUpload() && "onload" in image) {
            this._importedDiffuseLoadSource = image;
            this._importedDiffuseLoadHandler = () => {
                this._removeImportedDiffuseLoadListener();
                if (this._importedDiffuseTexSource === image && !this._glDisposed) {
                    tryUpload();
                }
            };
            image.addEventListener("load", this._importedDiffuseLoadHandler, { once: true });
        }
    }

    _removeImportedDiffuseLoadListener() {
        if (this._importedDiffuseLoadSource && this._importedDiffuseLoadHandler) {
            this._importedDiffuseLoadSource.removeEventListener?.(
                "load",
                this._importedDiffuseLoadHandler
            );
        }
        this._importedDiffuseLoadSource = null;
        this._importedDiffuseLoadHandler = null;
    }

    _ensureWhiteTexture() {
        const gl = this.gl;
        if (this._whiteDummyTexture) return this._whiteDummyTexture;
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        this._whiteDummyTexture = tex;
        return tex;
    }

    setLightControls({ power, yaw, pitch } = {}) {
        if (typeof power === "number" && Number.isFinite(power)) {
            this.lightPower = Math.max(0.0, Math.min(3.0, power));
        }
        if (typeof yaw === "number" && Number.isFinite(yaw)) {
            this.lightYaw = Math.max(-180.0, Math.min(180.0, yaw));
        }
        if (typeof pitch === "number" && Number.isFinite(pitch)) {
            this.lightPitch = Math.max(-85.0, Math.min(85.0, pitch));
        }
    }

    setLightingPreset(presetId = "zbrush_red_wax") {
        const resolved = LIGHTING_PRESETS[presetId] || LIGHTING_PRESETS.zbrush_red_wax;
        this.lightingPreset = LIGHTING_PRESETS[presetId] ? presetId : "zbrush_red_wax";

        this.lightRig = {
            keyDir: this._normalize(resolved.keyDir),
            fillDir: this._normalize(resolved.fillDir),
            rimDir: this._normalize(resolved.rimDir),
            keyIntensity: resolved.keyIntensity,
            fillIntensity: resolved.fillIntensity,
            rimIntensity: resolved.rimIntensity,
            ambient: resolved.ambient,
            ambientTint: resolved.ambientTint ? [...resolved.ambientTint] : [1.0, 1.0, 1.0],
            keyColor: resolved.keyColor ? [...resolved.keyColor] : [1.0, 1.0, 1.0],
            fillColor: resolved.fillColor ? [...resolved.fillColor] : [1.0, 1.0, 1.0],
            rimColor: resolved.rimColor ? [...resolved.rimColor] : [1.0, 1.0, 1.0],
            exposure: typeof resolved.exposure === "number" ? resolved.exposure : 1.0,
            specularBoost: typeof resolved.specularBoost === "number" ? resolved.specularBoost : 1.0,
            subsurfaceStrength: typeof resolved.subsurfaceStrength === "number" ? resolved.subsurfaceStrength : 0.5
        };
        if (resolved.bgTop) this.bgColorTop = [...resolved.bgTop];
        if (resolved.bgBottom) this.bgColorBottom = [...resolved.bgBottom];
        this._applyCanvasBackground();
    }

    _updateWireframeIndices(mesh) {
        const gl = this.gl;

        const edgeSet = new Set();
        const wireIndices = [];

        for (let i = 0; i < mesh.faces.length; i += 3) {
            const v0 = mesh.faces[i];
            const v1 = mesh.faces[i + 1];
            const v2 = mesh.faces[i + 2];

            const edges = [
                [Math.min(v0, v1), Math.max(v0, v1)],
                [Math.min(v1, v2), Math.max(v1, v2)],
                [Math.min(v2, v0), Math.max(v2, v0)]
            ];

            for (const [a, b] of edges) {
                const key = `${a}-${b}`;
                if (!edgeSet.has(key)) {
                    edgeSet.add(key);
                    wireIndices.push(a, b);
                }
            }
        }

        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.wireframeIndexBuffer);
        const wireArray = this._uint32IndicesSupported ? new Uint32Array(wireIndices) : new Uint16Array(wireIndices);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, wireArray, gl.STATIC_DRAW);
        this.wireframeIndexCount = wireIndices.length;
    }

    setCursor(center, normal, visible = true) {
        this.cursorCenter = center;
        this.cursorNormal = normal;
        this.cursorVisible = visible;
    }

    setSymmetryCursor(center, normal, visible = true) {
        this.symCursorCenter = center;
        this.symCursorNormal = normal;
        this.symCursorVisible = visible;
    }

    hideCursor() {
        this.cursorVisible = false;
        this.symCursorVisible = false;
    }

    render(viewMatrix, projectionMatrix) {
        if (this.contextLost || !this.gl) return;

        const gl = this.gl;

        gl.viewport(0, 0, this.canvas.width, this.canvas.height);

        this._renderBackground();

        // Depth state is set explicitly every frame rather than inherited from
        // whatever the last frame left behind, so each pass below starts from a
        // known configuration.
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);

        if (this.showGrid) {
            this._drawGrid(viewMatrix, projectionMatrix);
        }

        if (this.indexCount === 0) return;

        this._drawMesh(viewMatrix, projectionMatrix);

        const drawWireframe = this.showWireframe;
        if (drawWireframe) {
            this._drawWireframe(viewMatrix, projectionMatrix);
        }

        if (this.cursorVisible) {
            this._drawCursor(viewMatrix, projectionMatrix, this.cursorCenter, this.cursorNormal);
        }

        if (this.symCursorVisible) {
            // Blue keeps the mirrored cursor distinct from the primary one.
            const symColor = [0.4, 0.7, 1.0];
            this._drawCursor(viewMatrix, projectionMatrix, this.symCursorCenter, this.symCursorNormal, symColor);
        }
    }

    readViewportPixels() {
        if (this.contextLost || !this.gl) return null;
        const width = this.canvas.width;
        const height = this.canvas.height;
        if (width < 1 || height < 1) return null;
        const pixels = new Uint8Array(width * height * 4);
        try {
            this.gl.finish();
            this.gl.readPixels(
                0,
                0,
                width,
                height,
                this.gl.RGBA,
                this.gl.UNSIGNED_BYTE,
                pixels
            );
        } catch (error) {
            console.error("Sculpt: viewport pixel capture failed.", error);
            return null;
        }
        return { pixels, width, height };
    }

    _renderBackground() {
        const gl = this.gl;
        gl.clearColor(0.0, 0.0, 0.0, 0.0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    }

    _drawMesh(viewMatrix, projectionMatrix) {
        const gl = this.gl;

        if (!this.meshProgram) return;

        gl.useProgram(this.meshProgram);
        // Disable culling for sculpt stability across mixed winding content.
        gl.disable(gl.CULL_FACE);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
        gl.enableVertexAttribArray(this.meshProgram.aPosition);
        gl.vertexAttribPointer(this.meshProgram.aPosition, 3, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.normalBuffer);
        gl.enableVertexAttribArray(this.meshProgram.aNormal);
        gl.vertexAttribPointer(this.meshProgram.aNormal, 3, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuffer);
        if (this.meshProgram.aUv >= 0) {
            gl.enableVertexAttribArray(this.meshProgram.aUv);
            gl.vertexAttribPointer(this.meshProgram.aUv, 2, gl.FLOAT, false, 0, 0);
        }

        gl.bindBuffer(gl.ARRAY_BUFFER, this.maskBuffer);
        if (this.meshProgram.aMask >= 0) {
            gl.enableVertexAttribArray(this.meshProgram.aMask);
            gl.vertexAttribPointer(this.meshProgram.aMask, 1, gl.FLOAT, false, 0, 0);
        }

        const keyLightDir = this._transformDirection(
            viewMatrix,
            this._rotateDirection(this.lightRig.keyDir, this.lightYaw, this.lightPitch)
        );
        const fillLightDir = this._transformDirection(
            viewMatrix,
            this._rotateDirection(this.lightRig.fillDir, this.lightYaw, this.lightPitch)
        );
        const rimLightDir = this._transformDirection(
            viewMatrix,
            this._rotateDirection(this.lightRig.rimDir, this.lightYaw, this.lightPitch)
        );
        const lightScale = Math.max(0.0, this.lightPower);

        gl.uniformMatrix4fv(this.meshProgram.uModelView, false, viewMatrix);
        gl.uniformMatrix4fv(this.meshProgram.uProjection, false, projectionMatrix);
        gl.uniform3fv(this.meshProgram.uKeyLightDir, keyLightDir);
        gl.uniform3fv(this.meshProgram.uFillLightDir, fillLightDir);
        gl.uniform3fv(this.meshProgram.uRimLightDir, rimLightDir);
        gl.uniform1f(this.meshProgram.uKeyIntensity, this.lightRig.keyIntensity * lightScale);
        gl.uniform1f(this.meshProgram.uFillIntensity, this.lightRig.fillIntensity * lightScale);
        gl.uniform1f(this.meshProgram.uRimIntensity, this.lightRig.rimIntensity * lightScale);
        gl.uniform3fv(this.meshProgram.uKeyLightColor, this.lightRig.keyColor);
        gl.uniform3fv(this.meshProgram.uFillLightColor, this.lightRig.fillColor);
        gl.uniform3fv(this.meshProgram.uRimLightColor, this.lightRig.rimColor);
        gl.uniform3fv(this.meshProgram.uAmbientTint, this.lightRig.ambientTint);
        gl.uniform1f(this.meshProgram.uAmbientStrength, this.lightRig.ambient);
        gl.uniform3fv(this.meshProgram.uBaseColor, this.baseColor);
        gl.uniform1f(this.meshProgram.uMatcapIntensity, this.matcapIntensity);
        gl.uniform1f(this.meshProgram.uExposure, this.lightRig.exposure);
        gl.uniform1f(this.meshProgram.uSpecularBoost, this.lightRig.specularBoost);
        gl.uniform1f(this.meshProgram.uSubsurfaceStrength, this.lightRig.subsurfaceStrength);

        const meshRef = this.currentMesh;
        const uvLen = meshRef?.uvs?.length || 0;
        const useTex =
            !!(
                this.showImportedTexture
                && this.importedDiffuseTexture
                && uvLen === (meshRef?.vertexCount || 0) * 2
            );
        gl.uniform1f(this.meshProgram.uUseTexture, useTex ? 1.0 : 0.0);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, useTex ? this.importedDiffuseTexture : this._ensureWhiteTexture());
        if (this.meshProgram.uDiffuseMap) {
            gl.uniform1i(this.meshProgram.uDiffuseMap, 0);
        }

        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
        const indexType = this._uint32IndicesSupported ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
        gl.drawElements(gl.TRIANGLES, this.indexCount, indexType, 0);

        if (this.meshProgram.aNormal >= 0) {
            gl.disableVertexAttribArray(this.meshProgram.aNormal);
        }
        if (this.meshProgram.aUv >= 0) {
            gl.disableVertexAttribArray(this.meshProgram.aUv);
        }
        if (this.meshProgram.aMask >= 0) {
            gl.disableVertexAttribArray(this.meshProgram.aMask);
        }
    }

    _drawWireframe(viewMatrix, projectionMatrix) {
        const gl = this.gl;

        if (!this.wireframeProgram) return;

        gl.useProgram(this.wireframeProgram);
        gl.disable(gl.CULL_FACE);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
        gl.enableVertexAttribArray(this.wireframeProgram.aPosition);
        gl.vertexAttribPointer(this.wireframeProgram.aPosition, 3, gl.FLOAT, false, 0, 0);

        gl.uniformMatrix4fv(this.wireframeProgram.uModelView, false, viewMatrix);
        gl.uniformMatrix4fv(this.wireframeProgram.uProjection, false, projectionMatrix);
        gl.uniform3fv(this.wireframeProgram.uWireColor, this.wireColor);
        gl.uniform1f(this.wireframeProgram.uOpacity, this.wireOpacity);

        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.wireframeIndexBuffer);
        const indexType = this._uint32IndicesSupported ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
        gl.drawElements(gl.LINES, this.wireframeIndexCount, indexType, 0);

        gl.disable(gl.BLEND);
        // Keep culling disabled globally to avoid split-like visual artifacts.
        gl.disable(gl.CULL_FACE);
    }

    _drawGrid(viewMatrix, projectionMatrix) {
        const gl = this.gl;
        if (!this.gridProgram) return;

        gl.useProgram(this.gridProgram);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.disable(gl.CULL_FACE);
        // Reference grid is composited behind the sculpt. It must not populate
        // the depth buffer or occlude the mesh when viewed from underneath.
        gl.depthMask(false);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.gridBuffer);
        gl.enableVertexAttribArray(this.gridProgram.aPosition);
        gl.vertexAttribPointer(this.gridProgram.aPosition, 3, gl.FLOAT, false, 0, 0);

        gl.uniformMatrix4fv(this.gridProgram.uModelView, false, viewMatrix);
        gl.uniformMatrix4fv(this.gridProgram.uProjection, false, projectionMatrix);
        gl.uniform1f(this.gridProgram.uGridOffsetY, this.gridOffsetY !== undefined ? this.gridOffsetY : -1.0);

        gl.drawArrays(gl.TRIANGLES, 0, 6);

        gl.depthMask(true);
        gl.disable(gl.BLEND);
        gl.enable(gl.CULL_FACE);
    }

    _drawCursor(viewMatrix, projectionMatrix, center, normal, colorOverride = null) {
        const gl = this.gl;

        if (!this.cursorProgram) return;

        gl.useProgram(this.cursorProgram);
        gl.disable(gl.CULL_FACE);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.cursorBuffer);
        gl.enableVertexAttribArray(this.cursorProgram.aPosition);
        gl.vertexAttribPointer(this.cursorProgram.aPosition, 3, gl.FLOAT, false, 0, 0);

        gl.uniformMatrix4fv(this.cursorProgram.uModelView, false, viewMatrix);
        gl.uniformMatrix4fv(this.cursorProgram.uProjection, false, projectionMatrix);
        gl.uniform3fv(this.cursorProgram.uCursorCenter, center);
        gl.uniform3fv(this.cursorProgram.uCursorNormal, normal);
        gl.uniform1f(this.cursorProgram.uCursorRadius, this.cursorRadius);

        const color = colorOverride || this.cursorColor;
        gl.uniform3fv(this.cursorProgram.uCursorColor, color);
        gl.uniform1f(this.cursorProgram.uInnerRatio, this.cursorInnerRatio);

        gl.drawArrays(gl.TRIANGLE_FAN, 0, this.cursorVertexCount);

        gl.depthMask(true);
        gl.disable(gl.BLEND);
        gl.enable(gl.CULL_FACE);
    }

    /** Run fn with the drawing buffer at width x height, then restore the on-screen size. */
    withBufferSize(width, height, fn) {
        const prevWidth = this.canvas.width;
        const prevHeight = this.canvas.height;
        this.canvas.width = Math.max(1, Math.floor(width));
        this.canvas.height = Math.max(1, Math.floor(height));
        try {
            return fn();
        } finally {
            this.canvas.width = prevWidth;
            this.canvas.height = prevHeight;
        }
    }

    resize(cssWidth, cssHeight) {
        this._baseCanvasWidth = Math.max(1, cssWidth);
        this._baseCanvasHeight = Math.max(1, cssHeight);
        this._applyCanvasSize();
    }

    destroy() {
        if (this._glDisposed) return;
        this._glDisposed = true;

        this.canvas.removeEventListener("webglcontextlost", this._contextLostHandler, false);
        this.canvas.removeEventListener("webglcontextrestored", this._contextRestoredHandler, false);
        this._contextLostHandler = null;
        this._contextRestoredHandler = null;
        this._removeImportedDiffuseLoadListener();

        const gl = this.gl;
        if (!gl) return;

        gl.useProgram(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
        const maxAttribs = gl.getParameter(gl.MAX_VERTEX_ATTRIBS) || 8;
        for (let i = 0; i < maxAttribs; i++) {
            gl.disableVertexAttribArray(i);
        }

        if (this.meshProgram) gl.deleteProgram(this.meshProgram);
        if (this.wireframeProgram) gl.deleteProgram(this.wireframeProgram);
        if (this.cursorProgram) gl.deleteProgram(this.cursorProgram);
        if (this.gridProgram) gl.deleteProgram(this.gridProgram);
        if (this.vertexBuffer) gl.deleteBuffer(this.vertexBuffer);
        if (this.normalBuffer) gl.deleteBuffer(this.normalBuffer);
        if (this.uvBuffer) gl.deleteBuffer(this.uvBuffer);
        if (this.indexBuffer) gl.deleteBuffer(this.indexBuffer);
        if (this.wireframeIndexBuffer) gl.deleteBuffer(this.wireframeIndexBuffer);
        if (this.cursorBuffer) gl.deleteBuffer(this.cursorBuffer);
        if (this.gridBuffer) gl.deleteBuffer(this.gridBuffer);

        this.meshProgram = null;
        this.wireframeProgram = null;
        this.cursorProgram = null;
        this.gridProgram = null;
        this.vertexBuffer = null;
        this.normalBuffer = null;
        this.uvBuffer = null;
        this.indexBuffer = null;
        this.wireframeIndexBuffer = null;
        this.cursorBuffer = null;
        this.gridBuffer = null;
        if (this.importedDiffuseTexture) gl.deleteTexture(this.importedDiffuseTexture);
        this.importedDiffuseTexture = null;
        this._importedDiffuseTexSource = null;
        if (this._whiteDummyTexture) gl.deleteTexture(this._whiteDummyTexture);
        this._whiteDummyTexture = null;

        const lose = gl.getExtension("WEBGL_lose_context");
        if (lose) lose.loseContext();
        this.gl = null;
    }
}
