/**
 * Coordinates the sculpt engine, viewport, and controls.
 */

import { migrateLegacyBaseColor } from "./legacyPalette.js";
import { SculptEngine } from "../engine/SculptEngine.js";
import { SculptCanvas } from "../ui/SculptCanvas.js";
import { BrushPanel } from "../ui/BrushPanel.js";
import { sanitizeSculptSettings } from "./sculptState.js";
import { readPreviewSize, readWidgetValue } from "./workflowSnapshot.js";

export class SculptApp {
    constructor(container, options = {}) {
        this.container = container;
        this.options = {
            primitive: "sphere",
            subdivision: 4,
            onUpdate: null,
            onPresetSelect: null,
            ...options
        };

        this.engine = null;
        this.canvas = null;
        this.brushPanel = null;
        this.mainContainer = null;
        this.currentPrimitive = this.options.primitive;
        this.currentSubdivision = this.options.subdivision;

        this._init();
    }

    _init() {
        this.mainContainer = document.createElement("div");
        this.mainContainer.className = "sculpt-app";
        this.mainContainer.style.cssText = `
            display: flex;
            flex-direction: column;
            width: 100%;
            height: 100%;
            background: linear-gradient(165deg, #101216 0%, #0b0d10 100%);
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 12px;
            overflow: hidden;
            box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
            font-family: "Manrope", "Space Grotesk", "Segoe UI", sans-serif;
        `;

        const parsedLayout = new DOMParser().parseFromString(`
            <style>
                .sculpt-viewport-container {
                    flex: 1;
                    position: relative;
                    min-height: 0;
                    overflow: hidden;
                    background: radial-gradient(circle at 50% 35%, #171a20 0%, #0a0c10 72%);
                }
                /* The canvas disables the default outline; restore a visible
                   keyboard-focus indicator without affecting mouse clicks. */
                .sculpt-viewport-container canvas:focus-visible {
                    outline: 2px solid #67d8ff !important;
                    outline-offset: -2px;
                }
                .sculpt-toolbar-container {
                    position: absolute;
                    inset: 6px;
                    z-index: 100;
                    pointer-events: none;
                }
                .sculpt-toolbar-container > * {
                    pointer-events: auto;
                }
                .sculpt-info-bar {
                    position: relative;
                    flex: 0 0 auto;
                    min-width: 0;
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 8px;
                    padding: 4px 8px;
                    background: rgba(10, 13, 18, 0.96);
                    border-top: 1px solid rgba(255, 255, 255, 0.06);
                    font-size: 9px;
                    line-height: 1.2;
                    color: #8d98ab;
                    z-index: 20;
                }
                .sculpt-info-shortcuts {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    overflow-x: auto;
                    scrollbar-width: thin;
                    min-width: 0;
                    flex: 1;
                    padding-bottom: 0;
                }
                .sculpt-info-shortcuts::-webkit-scrollbar {
                    height: 5px;
                }
                .sculpt-info-shortcuts::-webkit-scrollbar-thumb {
                    background: rgba(132, 150, 176, 0.35);
                    border-radius: 999px;
                }
                .sculpt-info-item { display: flex; align-items: center; gap: 4px; flex: 0 0 auto; white-space: nowrap; }
                .sculpt-info-key {
                    padding: 1px 4px;
                    background: rgba(255, 255, 255, 0.08);
                    border-radius: 4px;
                    color: #d9dfeb;
                    border: 1px solid rgba(255, 255, 255, 0.08);
                    font-size: 8px;
                }
            </style>
            <div class="sculpt-viewport-container">
                <div class="sculpt-toolbar-container"></div>
            </div>
            <div class="sculpt-info-bar">
                <div class="sculpt-info-shortcuts">
                    <div class="sculpt-info-item"><span class="sculpt-info-key">LMB</span><span>Sculpt</span></div>
                    <div class="sculpt-info-item"><span class="sculpt-info-key">RMB / Alt+LMB</span><span>Rotate</span></div>
                    <div class="sculpt-info-item"><span class="sculpt-info-key">MMB</span><span>Pan</span></div>
                    <div class="sculpt-info-item"><span class="sculpt-info-key">Shift+LMB</span><span>Smooth</span></div>
                    <div class="sculpt-info-item"><span class="sculpt-info-key">Ctrl</span><span>Invert</span></div>
                    <div class="sculpt-info-item"><span class="sculpt-info-key">Shift+M</span><span>Mask paint</span></div>
                    <div class="sculpt-info-item"><span class="sculpt-info-key">0–9 / B–H–M–T</span><span>Brush</span></div>
                    <div class="sculpt-info-item"><span class="sculpt-info-key">[ ]</span><span>Size</span></div>
                </div>
                <div style="color: #67d8ff; font-weight: 700; letter-spacing: 1px; opacity: 0.8; flex: 0 0 auto;">SCULPT</div>
            </div>
        `, "text/html");
        this.mainContainer.append(
            ...Array.from(parsedLayout.head.childNodes),
            ...Array.from(parsedLayout.body.childNodes)
        );

        this.container.appendChild(this.mainContainer);

        const viewportContainer = this.mainContainer.querySelector(".sculpt-viewport-container");
        const toolbarContainer = this.mainContainer.querySelector(".sculpt-toolbar-container");

        this.engine = new SculptEngine();
        this.engine.loadPrimitive(this.currentPrimitive, this.currentSubdivision);

        this.canvas = new SculptCanvas(viewportContainer, this.engine, (type) => {
            this._onUpdate(type);
        });

        this.brushPanel = new BrushPanel(toolbarContainer, this.engine, {
            onPresetSelect: (primitive, subdivision) => {
                this.options.onPresetSelect?.(primitive, subdivision);
            },
            getExportSetting: (name) => this.options.getExportSetting?.(name),
            setExportSetting: (name, value) => this.options.setExportSetting?.(name, value),
            onUpdate: (type, payload) => {
                if (type === 'mesh') {
                    this.canvas.updateDeformation();
                    this.brushPanel?.refresh();
                }
                if (type === "history") {
                    this.canvas.updateMesh();
                    this.brushPanel?.refresh();
                }
                if (type === 'render') {
                    this._applyRenderSettings();
                }
                if (type === "camera") {
                    this.canvas.requestRender?.();
                }
                if (type === "radius") {
                    this.canvas.refreshCursorRadius?.();
                }
                if (type === 'reset') {
                    // Route through the node so a protected payload is dropped
                    // and a pending server restore is cancelled, exactly as a
                    // preset click does; loadPrimitive alone would leave both.
                    if (this.options.onPresetSelect) {
                        this.options.onPresetSelect(this.currentPrimitive, this.currentSubdivision);
                    } else {
                        this.loadPrimitive(this.currentPrimitive, this.currentSubdivision);
                    }
                }
                if (type === 'mesh-loaded') {
                    this.canvas.updateMesh();
                    this._applyRenderSettings();
                    this.brushPanel?.refresh();
                }
                if (type === 'lighting-preset' && payload) {
                    this.engine.lightingPreset = payload;
                }
                if (type === 'render-settings') {
                    this._applyRenderSettings();
                }
                if (type === 'lighting-preset') this._applyRenderSettings();
                if (type === "mask" || type === "preset") {
                    this.canvas.maskDirty = true;
                    this.canvas.requestRender?.();
                }
                this._onUpdate(type);
            }
        });

        // The canvas needs the panel to route keyboard shortcuts to it.
        this.canvas.brushPanel = this.brushPanel;

        this.canvas.updateMesh();
        this._applyRenderSettings();
        this.brushPanel?.refresh();
    }

    _onUpdate(type = "state") {
        this.options.onUpdate?.(type);
    }

    loadPrimitive(type, subdivision) {
        this.currentPrimitive = type;
        this.currentSubdivision = subdivision;
        this.engine.loadPrimitive(type, subdivision);
        this.canvas.updateMesh();
        this._applyRenderSettings();
        this.brushPanel?.refresh();
    }

    loadState(data) {
        if (!data) return false;
        let geometryApplied = true;

        if (data.vertices && data.faces) {
            const maxVerts = this.engine.maxImportVertexCount || 300000;
            const geometryShapeOk =
                Array.isArray(data.vertices) &&
                Array.isArray(data.faces) &&
                data.vertices.length / 3 <= maxVerts;
            if (!geometryShapeOk) {
                geometryApplied = false;
                console.error("Sculpt: workflow geometry rejected (malformed or over the vertex limit); camera and tools still restored.");
            } else {
                try {
                    // Mesh.setData validates face arity, index bounds, and finiteness.
                    this.engine.mesh.setData(
                        data.vertices,
                        data.faces,
                        data.uvs || null,
                        data.vertexOwners || null
                    );
                    this.engine._setImportedDiffuseImage(null);
                    this.engine.showImportedTexture = true;
                    this.engine.lastMeshImportKind = null;
                    if (Array.isArray(data.vertexMask) && data.vertexMask.length > 0) {
                        this.engine.mesh.applyVertexMaskFromArray(data.vertexMask);
                    }
                    this.engine._resetState();
                } catch (e) {
                    geometryApplied = false;
                    console.error("Sculpt: workflow geometry rejected; camera and tools still restored.", e);
                }
            }
        }

        const safe = sanitizeSculptSettings(data);
        Object.assign(this.engine, safe.toolSettings);
        for (const key of [
            "baseColor", "matcapIntensity", "lightingPreset", "lightPower",
            "lightYaw", "lightPitch", "showWireframe", "showGrid", "showImportedTexture"
        ]) {
            if (!Object.hasOwn(safe, key)) continue;
            this.engine[key] = key === "baseColor" ? migrateLegacyBaseColor(safe[key]) : safe[key];
        }
        for (const key of ["lightPower", "lightYaw", "lightPitch", "showGrid"]) {
            if (!Object.hasOwn(safe, key) && Object.hasOwn(safe.toolSettings, key)) {
                this.engine[key] = safe.toolSettings[key];
            }
        }

        if (data.camera && typeof data.camera === "object") {
            this.engine.restoreCameraState(data.camera);
        }

        this.canvas.updateMesh();
        this._applyRenderSettings();
        this.brushPanel?.refresh();
        return geometryApplied;
    }

    _applyRenderSettings() {
        this.canvas.syncRenderSettings();
    }

    serialize() {
        return this.engine.serialize();
    }

    serializeForWidget() {
        return this.engine.serializeForWidget();
    }

    serializeMeshPayload() {
        return this.engine.serializeMeshPayload();
    }

    captureViewportPngForQueue(graphNode) {
        const background = readWidgetValue(graphNode, "preview_background", "viewport");
        const bg = background === "transparent" ? "transparent" : "viewport";
        const size = readPreviewSize(graphNode);
        return this.canvas?.captureViewportPngBase64?.(size, { background: bg }) || null;
    }

    /** PNG blob of the imported diffuse atlas, or null when there is none. */
    async encodeDiffuseTexturePng() {
        const image = this.engine?.importedDiffuseImage;
        if (!image) return null;
        const width = image.width || image.naturalWidth || 0;
        const height = image.height || image.naturalHeight || 0;
        if (width <= 0 || height <= 0) return null;
        const off = document.createElement("canvas");
        off.width = width;
        off.height = height;
        const ctx = off.getContext("2d");
        if (!ctx) return null;
        ctx.drawImage(image, 0, 0);
        return new Promise((resolve) => off.toBlob((blob) => resolve(blob), "image/png"));
    }

    serializeForQueue(graphNode) {
        const data = this.engine.serialize();
        const b64 = this.captureViewportPngForQueue(graphNode);
        if (b64) {
            data.viewportPngBase64 = b64;
        }
        return data;
    }

    resize() {
        this.canvas?.resize();
    }

    destroy() {
        this.brushPanel?.destroy?.();
        this.brushPanel = null;
        this.canvas?.destroy();
        this.canvas = null;
        this.engine?.destroy?.();
        this.engine = null;

        if (this.mainContainer && this.mainContainer.parentNode) {
            this.mainContainer.parentNode.removeChild(this.mainContainer);
        }
        this.mainContainer = null;
    }
}
