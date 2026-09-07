/**
 * NodeUI - Integrates SculptApp into a ComfyUI node.
 *
 * Owns DOM and widget wiring only; server-side persistence of large meshes
 * lives in MeshPersistence. Queue payloads are provided through the hidden data
 * widget's async serializeValue, ComfyUI's prompt-serialization hook.
 */

import { api } from "../../../scripts/api.js";
import { app } from "../../../scripts/app.js";
import { SculptApp } from "../core/SculptApp.js";
import { MeshPersistence, MESH_REF_PATTERN } from "../core/MeshPersistence.js";
import { chooseWorkflowSculptValue } from "../core/workflowSnapshot.js";
import { wrapWidgetCallback } from "../core/widgetCallback.js";
import { COPY } from "./copy.js";
import { MAX_SCULPT_DATA_BYTES } from "../engine/limits.js";

/**
 * Classic widgets the brush panel controls instead. They stay in INPUT_TYPES
 * so API callers and older workflows keep working, but the node shows only
 * the viewport.
 */
const PANEL_WIDGETS = [
    "primitive",
    "subdivision",
    "preview_background",
    "preview_size",
    "export_format",
    "filename_prefix"
];

export class NodeUI {
    constructor(node) {
        this.node = node;

        this.sculptApp = null;
        this.persistence = null;
        this.container = null;
        this.resizeObserver = null;
        this._destroyed = false;
        this._initFrameA = null;
        this._initFrameB = null;
        this._widgetCallbackRestore = [];
        this._syncErrorLogged = false;
        this._widgetStubInfoLogged = false;
        this._syncRafId = null;
        this._resizeRafId = null;
        this._graphChangeTimer = null;
        this._serializationError = null;
        this._originalOnSerialize = null;
        this._workflowSerializeHook = null;
        this._protectedPayload = null;
        this._protectedRevision = -1;
        this._acceptSculptUpdates = false;

        this.currentPrimitive = "sphere";
        this.currentSubdivision = 4;

        // Defer init to post-layout frames without hard-coded timers.
        this._initFrameA = requestAnimationFrame(() => {
            this._initFrameA = null;
            this._initFrameB = requestAnimationFrame(() => {
                this._initFrameB = null;
                this._init();
            });
        });
    }

    _init() {
        if (this._destroyed) return;

        // Hide the _sculpt_data widget before the custom DOM widget is added.
        this._hideDataWidget();
        this._hidePanelWidgets();
        // A texture ref is reused across queues. When the server no longer
        // has the file (store pruned, server restarted) the node fails with a
        // "texture reference" error; forget the ref so the next queue uploads
        // the atlas again instead of resending the dead reference.
        this._onExecutionError = (event) => {
            const detail = event?.detail;
            if (!detail || String(detail.node_id) !== String(this.node?.id)) return;
            if (/texture reference/i.test(String(detail.exception_message || ""))) {
                this._textureRefCache = null;
            }
        };
        api.addEventListener?.("execution_error", this._onExecutionError);

        this.container = document.createElement("div");
        this.container.style.cssText = `
            width: 100%;
            height: 100%;
            min-height: 0;
            background: linear-gradient(160deg, #11141a 0%, #0a0d12 100%);
            display: flex;
            flex-direction: column;
            border-radius: 12px;
            overflow: hidden;
            position: relative;
            border: 1px solid rgba(255, 255, 255, 0.08);
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
            container-type: inline-size;
        `;

        this.viewportContainer = document.createElement("div");
        this.viewportContainer.style.cssText = `
            width: 100%;
            flex: 1;
            min-height: 0;
            position: relative;
        `;
        this.container.appendChild(this.viewportContainer);

        this.persistenceStatus = document.createElement("div");
        this.persistenceStatus.setAttribute("role", "status");
        this.persistenceStatus.setAttribute("aria-live", "assertive");
        this.persistenceStatus.style.cssText = `
            display: none;
            position: absolute;
            left: 12px;
            right: 12px;
            bottom: 34px;
            z-index: 220;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
            padding: 8px 10px;
            border: 1px solid rgba(255, 116, 116, 0.55);
            border-radius: 8px;
            background: rgba(35, 12, 16, 0.94);
            color: #ffd7d7;
            font: 600 11px/1.35 "Segoe UI", sans-serif;
        `;
        this.persistenceStatusText = document.createElement("span");
        this.persistenceRetryButton = document.createElement("button");
        this.persistenceRetryButton.type = "button";
        this.persistenceRetryButton.textContent = COPY.retry;
        this.persistenceRetryButton.style.cssText = `
            padding: 4px 8px;
            border: 1px solid rgba(255,255,255,0.2);
            border-radius: 6px;
            background: #51232b;
            color: white;
            cursor: pointer;
        `;
        this.persistenceStatus.append(this.persistenceStatusText, this.persistenceRetryButton);
        this.viewportContainer.appendChild(this.persistenceStatus);

        this._readWidgets();

        this.sculptApp = new SculptApp(this.viewportContainer, {
            primitive: this.currentPrimitive,
            subdivision: this.currentSubdivision,
            onUpdate: (kind = "state") => {
                if (!this._acceptSculptUpdates) return;
                if (this._protectedPayload !== null) {
                    if (this.sculptApp.engine.geometryRevision === this._protectedRevision) return;
                    this._protectedPayload = null;
                    this._setPersistenceStatus("saved");
                }
                this._scheduleSyncToWidget();
                this._scheduleGraphChange(kind);
            },
            onPresetSelect: (primitive, subdivision) => this._applyPreset(primitive, subdivision),
            getExportSetting: (name) => this.getExportSetting(name),
            setExportSetting: (name, value) => this.setExportSetting(name, value)
        });

        this.persistence = new MeshPersistence({
            getEngine: () => this.sculptApp?.engine ?? null,
            serializeMesh: () => this.sculptApp.serializeMeshPayload(),
            serializeMeshBuffers: () => this.sculptApp?.engine?.mesh?.serializeBuffers() ?? null,
            applyMesh: (mesh) => this.sculptApp?.loadState(mesh),
            resyncWidget: () => {
                this._syncToWidget();
                // The stub now carries the stored ref; the draft must pick it up.
                this._scheduleGraphChange("persist");
            },
            fetchApi: async (path, options) => {
                const response = await api.fetchApi(path, options);
                if (!response.ok) {
                    throw new Error(`Sculpt API ${path} failed with HTTP ${response.status}`);
                }
                return response;
            },
            onStatus: (status) => this._setPersistenceStatus(status)
        });
        this._installWorkflowSerializeHook();

        // Fresh node: ComfyUI only records the add on a canvas mouseup, which the viewport swallows.
        const rawData = this._dataWidget?.value;
        const freshNode = !rawData || rawData.trim() === "{}";
        this._restoreWidgetState();
        this._acceptSculptUpdates = true;

        const widget = this.node.addDOMWidget("sculpt_canvas", "custom", this.container, {
            serialize: false,
            hideOnZoom: false,
            // Low enough that the widget can follow a manual node resize. A
            // larger minimum keeps a tall DOM surface that Comfy clips at the
            // bottom when the node is shortened, hiding the shortcut footer.
            getMinHeight: () => 300
        });

        this.widget = widget;

        this.resizeObserver = new ResizeObserver(() => {
            if (this._resizeRafId !== null) cancelAnimationFrame(this._resizeRafId);
            this._resizeRafId = requestAnimationFrame(() => {
                this._resizeRafId = null;
                this.sculptApp?.resize();
            });
        });
        this.resizeObserver.observe(this.container);

        this._setupWidgetCallbacks();

        this._syncToWidget();
        if (freshNode) this._scheduleGraphChange("init");

        this.node.size[0] = Math.max(this.node.size[0], 520);
        this.node.size[1] = Math.max(this.node.size[1], 580);
        this.node.setDirtyCanvas(true);
    }

    _protectPayload(raw, message) {
        this._protectedPayload = raw;
        this._protectedRevision = this.sculptApp.engine.geometryRevision;
        this.persistenceStatusText.textContent = message;
        this.persistenceRetryButton.hidden = true;
        this.persistenceRetryButton.onclick = null;
        this.persistenceStatus.style.display = "flex";
    }

    _restoreWidgetState() {
        const raw = this._dataWidget?.value;
        if (!raw) return;
        try {
            if (new TextEncoder().encode(raw).byteLength > MAX_SCULPT_DATA_BYTES) {
                throw new Error("Sculpt payload exceeds the supported size");
            }
            const data = JSON.parse(raw);
            if (!data || typeof data !== "object" || Array.isArray(data)) {
                throw new Error("Sculpt payload must be an object");
            }
            if (typeof data.schemaVersion === "number" && data.schemaVersion > 5) {
                this._protectPayload(raw, COPY.newerSchema);
                return;
            }
            const hasGeometry = data.vertices != null || data.faces != null;
            const emptyMesh = Array.isArray(data.vertices) && data.vertices.length === 0
                && Array.isArray(data.faces) && data.faces.length === 0;
            if (hasGeometry && !emptyMesh) {
                if (!Array.isArray(data.vertices) || !Array.isArray(data.faces)
                    || !this.sculptApp.loadState(data)) {
                    throw new Error("Sculpt workflow geometry was rejected");
                }
            } else if (data._meshOmittedFromWorkflow || data._meshRef) {
                this.sculptApp.loadState(data);
                if (typeof data._meshRef === "string" && MESH_REF_PATTERN.test(data._meshRef)) {
                    this.persistence.beginRestore(data._meshRef);
                } else {
                    this._protectPayload(raw, COPY.missingMesh);
                }
            } else {
                this.sculptApp.loadState(data);
            }
        } catch (error) {
            this._protectPayload(raw, COPY.invalidPayload);
            console.error("Sculpt: original workflow data preserved after restore failure.", error);
        }
    }

    _hideDataWidget() {
        if (!this.node.widgets) return;

        for (const w of this.node.widgets) {
            if (w.name === "_sculpt_data") {
                w.type = "hidden";
                w.hidden = true;
                w._hidden = true;
                w.computeSize = () => [0, -4];
                if (w.element) w.element.style.display = "none";
                this._dataWidget = w;
                this._installSerializeValue(w);
                break;
            }
        }
    }

    _hidePanelWidgets() {
        this._panelWidgets = {};
        if (!this.node.widgets) return;
        for (const w of this.node.widgets) {
            if (!PANEL_WIDGETS.includes(w.name)) continue;
            w.type = "hidden";
            w.hidden = true;
            w._hidden = true;
            w.computeSize = () => [0, -4];
            if (w.element) w.element.style.display = "none";
            this._panelWidgets[w.name] = w;
        }
    }

    getExportSetting(name) {
        const w = this._panelWidgets?.[name];
        return w ? w.value : undefined;
    }

    setExportSetting(name, value) {
        const w = this._panelWidgets?.[name];
        if (!w || this._destroyed) return;
        w.value = value;
        this._scheduleGraphChange("tool");
    }

    /**
     * Upload the imported diffuse atlas once per image and return its ref.
     * Returns null when there is nothing to upload. Throws when the mesh has a
     * texture but the upload failed, so a textured export never silently
     * degrades to geometry only.
     */
    async _ensureTextureRef() {
        const app = this.sculptApp;
        const engine = app?.engine;
        const image = engine?.importedDiffuseImage;
        if (!image || !engine?.mesh?.uvs || typeof app.encodeDiffuseTexturePng !== "function") {
            return null;
        }
        if (this._textureRefCache?.image === image) return this._textureRefCache.ref;
        let response;
        try {
            const blob = await app.encodeDiffuseTexturePng();
            if (!blob) return null;
            response = await api.fetchApi("/sculpt/texture", {
                method: "POST",
                body: blob,
                headers: { "Content-Type": "image/png" }
            });
        } catch (e) {
            throw new Error(`Sculpt texture upload failed: ${e?.message || e}`);
        }
        if (!response?.ok) {
            throw new Error(`Sculpt texture upload failed: HTTP ${response?.status}`);
        }
        const body = await response.json();
        const ref = body?.ref;
        if (typeof ref !== "string" || !MESH_REF_PATTERN.test(ref)) {
            throw new Error("Sculpt texture upload returned an invalid reference");
        }
        this._textureRefCache = { image, ref };
        return ref;
    }

    async _attachTextureRef(data) {
        const fmt = this.getExportSetting("export_format");
        if (data && (fmt === "obj" || fmt === "glb")) {
            const ref = await this._ensureTextureRef();
            if (ref) data._textureRef = ref;
        }
        return data;
    }

    /**
     * ComfyUI calls widget.serializeValue while building the prompt, so this is
     * the hook for queue-time payloads. Workflow JSON still saves widget.value.
     *
     * The hook is re-asserted after frontend lifecycle changes: until an upload
     * finishes the widget omits its old ref, so a lost hook must fail closed.
     */
    _installSerializeValue(widget) {
        if (!this._sculptSerializeValue) {
            this._sculptSerializeValue = async () => {
                if (this._destroyed || !this.sculptApp) {
                    return widget.value;
                }
                try {
                    this.flushSyncToWidget();
                    if (this._serializationError) throw this._serializationError;
                    if (this._protectedPayload) {
                        return this._protectedPayload;
                    }
                    const payload = await this.buildQueuePayload(this.node);
                    if (payload) {
                        const raw = JSON.stringify(payload);
                        if (new TextEncoder().encode(raw).byteLength > MAX_SCULPT_DATA_BYTES) {
                            throw new Error("Sculpt queue payload exceeds the supported size");
                        }
                        return raw;
                    }
                } catch (e) {
                    console.error("Sculpt: queue payload build failed; queue cancelled.", e);
                    this._setPersistenceStatus("serialization-error");
                    throw e;
                } finally {
                    // The frontend snapshots widget.value before prompt
                    // serialization and restores it afterwards, which can wipe a
                    // _meshRef that an upload attached mid-prompt. Re-sync on
                    // the next macrotask so the widget keeps the latest ref.
                    setTimeout(() => {
                        if (!this._destroyed) this._syncToWidget();
                    }, 0);
                }
                return widget.value;
            };
        }
        this._ensureSerializeValueHook();
    }

    _ensureSerializeValueHook() {
        const widget = this._dataWidget;
        if (!widget || this._destroyed || !this._sculptSerializeValue) return;
        if (widget.serializeValue === this._sculptSerializeValue) return;
        try {
            widget._sculptOriginalSerializeValue = widget.serializeValue;
            widget.serializeValue = this._sculptSerializeValue;
        } catch {
            // Backend rejects an unsaved stub rather than exporting an older mesh.
        }
    }

    /**
     * LiteGraph snapshots widget.value synchronously while saving workflows.
     * If a large-mesh upload is still in flight, write the current full mesh
     * into that one workflow snapshot. Once the current revision is stored,
     * the normal compact _meshRef stub is used.
     */
    _installWorkflowSerializeHook() {
        if (this._workflowSerializeHook || !this.node) return;
        this._originalOnSerialize = this.node.onSerialize;
        this._workflowSerializeHook = (serialized) => {
            const originalResult = this._originalOnSerialize?.call(this.node, serialized);
            const widgetIndex = this.node.widgets?.indexOf(this._dataWidget) ?? -1;
            if (widgetIndex < 0 || !Array.isArray(serialized?.widgets_values)) {
                return originalResult;
            }
            this.flushSyncToWidget();
            const engine = this.sculptApp?.engine;
            if (!engine && !this._protectedPayload) return originalResult;
            const choice = chooseWorkflowSculptValue({
                widgetValue: this._dataWidget.value,
                futurePayload: this._protectedPayload,
                pendingRestore: !!this.persistence?.pendingRestore,
                widgetData: this.sculptApp?.serializeForWidget(),
                isCurrentRevisionStored: !!this.persistence?.isCurrentRevisionStored()
            });
            serialized.widgets_values[widgetIndex] = choice.value;
            if (choice.needsUpload) {
                this.persistence?.uploadNow();
            }
            return originalResult;
        };
        this.node.onSerialize = this._workflowSerializeHook;
    }

    _readWidgets() {
        if (!this.node.widgets) return;
        for (const w of this.node.widgets) {
            if (w.name === "primitive") this.currentPrimitive = w.value || "sphere";
            if (w.name === "subdivision") this.currentSubdivision = w.value || 4;
        }
    }

    _setPersistenceStatus(status) {
        if (!this.persistenceStatus || !this.persistenceRetryButton) return;
        this.persistenceRetryButton.hidden = false;
        if (status === "restore-error") {
            this.persistenceStatusText.textContent = COPY.restoreError;
            this.persistenceRetryButton.onclick = () => {
                if (this.persistence?.meshRef) this.persistence.beginRestore(this.persistence.meshRef);
            };
            this.persistenceStatus.style.display = "flex";
            return;
        }
        if (status === "upload-error") {
            this.persistenceStatusText.textContent = COPY.uploadError;
            this.persistenceRetryButton.onclick = () => this.persistence?.ensureUploaded();
            this.persistenceStatus.style.display = "flex";
            return;
        }
        if (status === "saving" || status === "restoring") {
            this.persistenceStatusText.textContent =
                status === "saving" ? COPY.saving : COPY.restoring;
            this.persistenceRetryButton.hidden = true;
            this.persistenceRetryButton.onclick = null;
            this.persistenceStatus.style.display = "flex";
            return;
        }
        if (status === "serialization-error") {
            this.persistenceStatusText.textContent = COPY.serializationError;
            this.persistenceRetryButton.hidden = true;
            this.persistenceRetryButton.onclick = null;
            this.persistenceStatus.style.display = "flex";
            return;
        }
        if (status === "saved" || status === "restored") {
            this.persistenceStatus.style.display = "none";
            this.persistenceRetryButton.onclick = null;
        }
    }

    _setupWidgetCallbacks() {
        if (!this.node.widgets) return;

        for (const w of this.node.widgets) {
            if (w.name === "primitive" || w.name === "subdivision") {
                const { original, wrapped } = wrapWidgetCallback(w, (value) => {
                    if (w.name === "primitive") this.currentPrimitive = value;
                    if (w.name === "subdivision") this.currentSubdivision = value;

                    this._reloadMesh();
                });
                this._widgetCallbackRestore.push({
                    widget: w,
                    callback: original,
                    wrapped
                });
            }
        }
    }

    _reloadMesh() {
        if (this._destroyed) return;
        // The user is replacing the mesh; a pending server restore must not
        // land on top of it later, and widget syncs must resume.
        this._protectedPayload = null;
        this._setPersistenceStatus("saved");
        this.persistence?.cancelRestore();
        if (this.sculptApp) {
            this.sculptApp.loadPrimitive(this.currentPrimitive, this.currentSubdivision);
            this._syncToWidget();
            this.sculptApp.brushPanel?.syncSettings?.();
        }
    }

    _applyPreset(primitive, subdivision) {
        if (this._destroyed) return;
        this._protectedPayload = null;
        this._setPersistenceStatus("saved");
        this.currentPrimitive = primitive;
        this.currentSubdivision = subdivision;
        if (this.node.widgets) {
            for (const w of this.node.widgets) {
                if (w.name === "primitive") w.value = primitive;
                if (w.name === "subdivision") w.value = subdivision;
            }
        }
        this.persistence?.cancelRestore();
        this.sculptApp?.loadPrimitive(primitive, subdivision);
        this._syncToWidget();
        this.node.setDirtyCanvas(true);
    }

    _scheduleSyncToWidget() {
        if (this._destroyed) return;
        if (this._syncRafId !== null) return;
        this._syncRafId = requestAnimationFrame(() => {
            this._syncRafId = null;
            this._syncToWidget();
        });
    }

    _scheduleGraphChange(_kind = "state") {
        if (this._destroyed) return;
        if (this._graphChangeTimer !== null) {
            clearTimeout(this._graphChangeTimer);
        }
        this._graphChangeTimer = setTimeout(() => {
            this._graphChangeTimer = null;
            if (this._destroyed) return;
            this.node.graph?.change?.();
            this.node.setDirtyCanvas?.(true, true);
            this._notifyChangeTracker();
        }, 120);
    }

    // The change tracker only listens to canvas mouse/key events, which the viewport cancels.
    _notifyChangeTracker() {
        try {
            const tracker = app?.extensionManager?.workflow?.activeWorkflow?.changeTracker;
            // captureCanvasState replaced checkState in frontend 1.5x.
            if (typeof tracker?.captureCanvasState === "function") tracker.captureCanvasState();
            else tracker?.checkState?.();
        } catch (e) {
            if (!this._trackerErrorLogged) {
                console.warn("Sculpt: could not notify the workflow change tracker.", e);
                this._trackerErrorLogged = true;
            }
        }
    }

    flushSyncToWidget() {
        if (this._destroyed) return;
        if (this._syncRafId !== null) {
            cancelAnimationFrame(this._syncRafId);
            this._syncRafId = null;
        }

        this._syncToWidget();
    }

    _syncToWidget() {
        if (this._destroyed) return;
        if (!this._dataWidget || !this.sculptApp || this._protectedPayload) return;
        this._ensureSerializeValueHook();
        if (this.persistence?.shouldBlockWidgetSync()) return;
        try {
            const data = this.sculptApp.serializeForWidget();
            if (data._meshOmittedFromWorkflow) {
                if (this.persistence?.isCurrentRevisionStored()) {
                    data._meshRef = this.persistence.meshRef;
                }
                this.persistence?.noteStubSynced();
                if (!this._widgetStubInfoLogged) {
                    console.info(
                        "Sculpt: mesh too large to embed in workflow JSON; persisting it server-side and embedding a reference instead."
                    );
                    this._widgetStubInfoLogged = true;
                }
            }
            this._dataWidget.value = JSON.stringify(data);
            this._serializationError = null;
        } catch (error) {
            this._serializationError = error instanceof Error
                ? error
                : new Error("Sculpt serialization failed");
            this._setPersistenceStatus("serialization-error");
            if (!this._syncErrorLogged) {
                console.error("Sculpt: Serialization payload construction failed.");
                this._syncErrorLogged = true;
            }
        }
    }

    /**
     * Payload for queueing. Small meshes embed full geometry inline; large
     * meshes are flushed to the server store and only a stub with _meshRef and
     * the viewport capture goes into the prompt (the backend resolves the ref).
     */
    async buildQueuePayload(graphNode) {
        const sculptApp = this.sculptApp;
        const engine = sculptApp?.engine;
        if (!engine || !this.persistence) return null;
        if (this.persistence.pendingRestore && this.persistence.meshRef) {
            // The real mesh hasn't arrived from the server store yet; keep the
            // widget's stub (with _meshRef) so the backend resolves the stored
            // mesh instead of receiving the placeholder primitive.
            return null;
        }
        let data;
        if (!sculptApp.serializeForWidget()._meshOmittedFromWorkflow) {
            data = sculptApp.serializeForQueue(graphNode);
        } else {
            const ref = await this.persistence.ensureUploaded();
            if (!ref) {
                // Persistence failed; fall back to inline full geometry.
                data = sculptApp.serializeForQueue(graphNode);
            } else {
                data = sculptApp.serializeForWidget();
                data._meshRef = ref;
                const b64 = sculptApp.captureViewportPngForQueue(graphNode);
                if (b64) {
                    data.viewportPngBase64 = b64;
                }
            }
        }
        return this._attachTextureRef(data);
    }

    destroy() {
        this._destroyed = true;
        if (this._onExecutionError) {
            api.removeEventListener?.("execution_error", this._onExecutionError);
            this._onExecutionError = null;
        }
        this._textureRefCache = null;
        this._panelWidgets = null;

        this.persistence?.destroy();
        this.persistence = null;

        if (this._syncRafId !== null) {
            cancelAnimationFrame(this._syncRafId);
            this._syncRafId = null;
        }

        if (this._resizeRafId !== null) {
            cancelAnimationFrame(this._resizeRafId);
            this._resizeRafId = null;
        }

        if (this._graphChangeTimer !== null) {
            clearTimeout(this._graphChangeTimer);
            this._graphChangeTimer = null;
        }

        if (this._initFrameA !== null) {
            cancelAnimationFrame(this._initFrameA);
            this._initFrameA = null;
        }

        if (this._initFrameB !== null) {
            cancelAnimationFrame(this._initFrameB);
            this._initFrameB = null;
        }

        for (const item of this._widgetCallbackRestore) {
            if (item?.widget?.callback === item.wrapped) {
                item.widget.callback = item.callback;
            }
        }
        this._widgetCallbackRestore = [];

        if (this._dataWidget && this._sculptSerializeValue) {
            try {
                if (this._dataWidget.serializeValue === this._sculptSerializeValue) {
                    this._dataWidget.serializeValue = this._dataWidget._sculptOriginalSerializeValue;
                }
                delete this._dataWidget._sculptOriginalSerializeValue;
            } catch {
                /* non-configurable widget internals; nothing to restore */
            }
        }
        this._sculptSerializeValue = null;

        if (this.node?.onSerialize === this._workflowSerializeHook) {
            this.node.onSerialize = this._originalOnSerialize;
        }
        this._workflowSerializeHook = null;
        this._originalOnSerialize = null;

        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }

        this.sculptApp?.destroy();
        this.sculptApp = null;
        this.container = null;
        this.viewportContainer = null;
        if (this.persistenceRetryButton) this.persistenceRetryButton.onclick = null;
        this.persistenceStatus = null;
        this.persistenceStatusText = null;
        this.persistenceRetryButton = null;

        if (this.widget && this.node.widgets) {
            const idx = this.node.widgets.indexOf(this.widget);
            if (idx !== -1) {
                this.node.widgets.splice(idx, 1);
            }
        }
        this.widget = null;
    }
}
