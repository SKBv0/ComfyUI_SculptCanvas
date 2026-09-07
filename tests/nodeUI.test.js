import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { NodeUI } from "../js/ui/NodeUI.js";
import { api } from "./helpers/comfyApi.js";

vi.mock("./helpers/comfyApi.js", () => ({
    api: { fetchApi: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() }
}));
vi.mock("./helpers/comfyApp.js", () => ({
    app: { extensionManager: { workflow: { activeWorkflow: { changeTracker: { checkState: vi.fn() } } } } }
}));
vi.mock("../js/core/SculptApp.js", async (importOriginal) => {
    const { SculptApp: RealApp } = await importOriginal();
    const { SculptEngine } = await import("../js/engine/SculptEngine.js");
    // Keep real state loading and serialization; only DOM/WebGL are replaced.
    return { SculptApp: class {
        constructor(container, options) {
            this.options = options;
            this.engine = new SculptEngine();
            this.engine.loadPrimitive("sphere", 1);
            this.canvas = { updateMesh() {} };
        }
        loadState(data) { return RealApp.prototype.loadState.call(this, data); }
        _applyRenderSettings() {}
        serializeForWidget() { return this.engine.serializeForWidget(); }
        serialize() { return this.engine.serialize(); }
        serializeMeshPayload() { return this.engine.serializeMeshPayload(); }
        serializeForQueue() { return this.serialize(); }
        captureViewportPngForQueue() { return null; }
        loadPrimitive(type, subdivision) { this.engine.loadPrimitive(type, subdivision); }
        destroy() { this.engine.destroy(); }
    } };
});

let instances;
function makeUI(raw, extraWidgets = []) {
    const widget = { name: "_sculpt_data", value: raw };
    const node = {
        widgets: [...extraWidgets, widget],
        size: [900, 760],
        graph: { change: vi.fn() },
        setDirtyCanvas: vi.fn(),
        addDOMWidget(name, type, element, options) {
            const result = { name, type, element, options };
            this.widgets.push(result);
            return result;
        }
    };
    const ui = new NodeUI(node);
    ui._init();
    instances.push(ui);
    return { ui, node, widget };
}

beforeEach(() => {
    instances = [];
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    vi.stubGlobal("document", { createElement: () => ({
        style: {}, setAttribute() {}, append() {}, appendChild() {}
    }) });
    vi.spyOn(console, "error").mockImplementation(() => {});
    api.fetchApi.mockReset();
    api.fetchApi.mockResolvedValue({ ok: true, json: async () => ({ ref: "a".repeat(64) }) });
});
afterEach(async () => {
    for (const ui of instances) ui.destroy();
    await vi.advanceTimersByTimeAsync(0);
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("NodeUI workflow recovery", () => {
    it.each([
        ["invalid JSON", "{broken"],
        ["non-object", "null"],
        ["missing reference", '{"schemaVersion":5,"_meshOmittedFromWorkflow":true}'],
        ["invalid face", '{"vertices":[0,0,0,1,0,0,0,1,0],"faces":[0,1,99]}'],
        ["missing faces", '{"vertices":[0,0,0,1,0,0,0,1,0]}'],
        ["future schema", '{"schemaVersion":6,"futureGeometry":"original"}']
    ])("preserves %s through sync, workflow save and prompt serialization", async (_, raw) => {
        const { ui, node, widget } = makeUI(raw);
        ui.flushSyncToWidget();
        expect(widget.value).toBe(raw);
        expect(ui.persistenceStatus.style.display).toBe("flex");
        const saved = { widgets_values: ["wrong"] };
        node.onSerialize(saved);
        expect(saved.widgets_values[0]).toBe(raw);
        expect(await widget.serializeValue()).toBe(raw);
        expect(api.fetchApi).not.toHaveBeenCalled();
    });

    it("keeps protected data on tool changes but allows a deliberate geometry replacement", () => {
        const raw = '{"schemaVersion":6,"futureGeometry":"original"}';
        const { ui, widget } = makeUI(raw);
        ui.sculptApp.engine.lightPower = 0.2;
        ui.sculptApp.options.onUpdate();
        ui.flushSyncToWidget();
        expect(widget.value).toBe(raw);
        ui.sculptApp.engine.loadPrimitive("cube", 1);
        ui.sculptApp.options.onUpdate();
        ui.flushSyncToWidget();
        expect(JSON.parse(widget.value).vertices.length).toBeGreaterThan(0);
        expect(ui.persistenceStatus.style.display).toBe("none");
    });

    it("can explicitly reset a protected workflow", () => {
        const { ui, widget } = makeUI("{broken");
        ui.currentSubdivision = 1;
        ui._reloadMesh();
        expect(JSON.parse(widget.value).vertices.length).toBeGreaterThan(0);
        expect(ui.persistenceStatus.style.display).toBe("none");
    });

    it("never attaches an older mesh ref to unsaved geometry", () => {
        const { ui, node, widget } = makeUI("{}");
        ui.sculptApp.engine.maxWidgetSerializeVertices = 0;
        ui.persistence.meshRef = "b".repeat(64);
        ui.flushSyncToWidget();
        expect(JSON.parse(widget.value)._meshRef).toBeUndefined();
        expect(JSON.parse(widget.value)._meshOmittedFromWorkflow).toBe(true);
        // The workflow gets the same ref-less stub, never the old ref and never
        // the full geometry (drafts are autosaved to localStorage); the store
        // upload is requested instead.
        const uploadNow = vi.spyOn(ui.persistence, "uploadNow").mockResolvedValue(undefined);
        const saved = { widgets_values: [widget.value] };
        node.onSerialize(saved);
        const written = JSON.parse(saved.widgets_values[0]);
        expect(written._meshRef).toBeUndefined();
        expect(written._meshOmittedFromWorkflow).toBe(true);
        expect(written.vertices).toBeUndefined();
        expect(uploadNow).toHaveBeenCalled();
    });

    it("retains texture visibility and permits compact manual resizing", () => {
        const { ui } = makeUI('{"showImportedTexture":false}');
        expect(ui.sculptApp.engine.showImportedTexture).toBe(false);
        expect(ui.sculptApp.serialize().showImportedTexture).toBe(false);
        expect(ui.widget.options.getMinHeight()).toBe(300);
        expect(ui.widget.options.getHeight).toBeUndefined();
    });

    it("owns the hidden data widget configuration and queue serializer", () => {
        const { ui, widget } = makeUI("{}");
        expect(ui._dataWidget).toBe(widget);
        expect(widget.type).toBe("hidden");
        expect(widget.hidden).toBe(true);
        expect(widget._hidden).toBe(true);
        expect(widget.computeSize()).toEqual([0, -4]);
        expect(widget.serializeValue).toBeTypeOf("function");
    });

    it("hides the panel-controlled classic widgets and round-trips export settings", () => {
        const extra = [
            { name: "primitive", value: "cube" },
            { name: "subdivision", value: 3 },
            { name: "preview_background", value: "viewport" },
            { name: "preview_size", value: 512 },
            { name: "export_format", value: "none" },
            { name: "filename_prefix", value: "sculpt" }
        ];
        const { ui } = makeUI("{}", extra);
        for (const w of extra) {
            expect(w.type).toBe("hidden");
            expect(w.computeSize()).toEqual([0, -4]);
        }
        expect(ui.getExportSetting("export_format")).toBe("none");
        ui.setExportSetting("export_format", "glb");
        expect(extra[4].value).toBe("glb");
        expect(ui.getExportSetting("preview_size")).toBe(512);
        expect(ui.getExportSetting("does_not_exist")).toBeUndefined();
    });

    it("uploads the diffuse atlas once and attaches its ref for textured exports", async () => {
        const { ui } = makeUI("{}", [{ name: "export_format", value: "glb" }]);
        const image = { width: 2, height: 2 };
        ui.sculptApp.engine.importedDiffuseImage = image;
        ui.sculptApp.engine.mesh.uvs = new Float32Array(ui.sculptApp.engine.mesh.vertexCount * 2);
        ui.sculptApp.encodeDiffuseTexturePng = vi.fn(async () => ({ size: 4, type: "image/png" }));
        api.fetchApi.mockResolvedValue({ ok: true, json: async () => ({ ref: "b".repeat(64) }) });

        const first = await ui.buildQueuePayload(ui.node);
        const second = await ui.buildQueuePayload(ui.node);

        expect(first._textureRef).toBe("b".repeat(64));
        expect(second._textureRef).toBe("b".repeat(64));
        expect(ui.sculptApp.encodeDiffuseTexturePng).toHaveBeenCalledOnce();
        expect(api.fetchApi.mock.calls.filter((c) => c[0] === "/sculpt/texture")).toHaveLength(1);
    });

    it("uploads the texture again after the server reports the reference missing", async () => {
        const { ui } = makeUI("{}", [{ name: "export_format", value: "glb" }]);
        ui.node.id = 7;
        ui.sculptApp.engine.importedDiffuseImage = { width: 2, height: 2 };
        ui.sculptApp.engine.mesh.uvs = new Float32Array(ui.sculptApp.engine.mesh.vertexCount * 2);
        ui.sculptApp.encodeDiffuseTexturePng = vi.fn(async () => ({ size: 4, type: "image/png" }));
        api.fetchApi.mockResolvedValue({ ok: true, json: async () => ({ ref: "c".repeat(64) }) });
        const uploads = () => api.fetchApi.mock.calls.filter((c) => c[0] === "/sculpt/texture").length;

        await ui.buildQueuePayload(ui.node);
        await ui.buildQueuePayload(ui.node);
        expect(uploads()).toBe(1);

        // Earlier tests registered their own listeners; take this instance's.
        const registrations = api.addEventListener.mock.calls.filter((c) => c[0] === "execution_error");
        const handler = registrations[registrations.length - 1][1];
        handler({ detail: { node_id: 99, exception_message: "Sculpt texture reference not found" } });
        await ui.buildQueuePayload(ui.node);
        expect(uploads()).toBe(1);

        handler({ detail: { node_id: 7, exception_message: "Sculpt texture reference not found on this server." } });
        await ui.buildQueuePayload(ui.node);
        expect(uploads()).toBe(2);

        ui.destroy();
        expect(api.removeEventListener).toHaveBeenCalledWith("execution_error", expect.any(Function));
    });

    it("skips the texture upload for geometry-only formats", async () => {
        const { ui } = makeUI("{}", [{ name: "export_format", value: "stl" }]);
        ui.sculptApp.engine.importedDiffuseImage = { width: 2, height: 2 };
        ui.sculptApp.encodeDiffuseTexturePng = vi.fn();
        const payload = await ui.buildQueuePayload(ui.node);
        expect(payload._textureRef).toBeUndefined();
        expect(ui.sculptApp.encodeDiffuseTexturePng).not.toHaveBeenCalled();
    });

    it("blocks a textured export when the atlas upload fails", async () => {
        const { ui } = makeUI("{}", [{ name: "export_format", value: "obj" }]);
        ui.sculptApp.engine.importedDiffuseImage = { width: 2, height: 2 };
        ui.sculptApp.engine.mesh.uvs = new Float32Array(ui.sculptApp.engine.mesh.vertexCount * 2);
        ui.sculptApp.encodeDiffuseTexturePng = vi.fn(async () => ({ size: 4 }));
        api.fetchApi.mockResolvedValue({ ok: false, status: 500 });
        await expect(ui.buildQueuePayload(ui.node)).rejects.toThrow(/texture upload failed/i);
    });

    it("registers a freshly added node with the change tracker", async () => {
        const { app } = await import("./helpers/comfyApp.js");
        const checkState = app.extensionManager.workflow.activeWorkflow.changeTracker.checkState;
        checkState.mockClear();
        makeUI("{}");
        await vi.advanceTimersByTimeAsync(200);
        expect(checkState).toHaveBeenCalledOnce();
    });

    it("leaves the change tracker alone when restoring an existing node", async () => {
        const { app } = await import("./helpers/comfyApp.js");
        const checkState = app.extensionManager.workflow.activeWorkflow.changeTracker.checkState;
        checkState.mockClear();
        makeUI('{"showImportedTexture":false}');
        await vi.advanceTimersByTimeAsync(200);
        expect(checkState).not.toHaveBeenCalled();
    });

    it("prefers captureCanvasState when the frontend provides it", async () => {
        const { app } = await import("./helpers/comfyApp.js");
        const tracker = app.extensionManager.workflow.activeWorkflow.changeTracker;
        tracker.checkState.mockClear();
        tracker.captureCanvasState = vi.fn();
        try {
            const { ui } = makeUI('{"showImportedTexture":false}');
            ui._scheduleGraphChange("mesh");
            await vi.advanceTimersByTimeAsync(200);
            expect(tracker.captureCanvasState).toHaveBeenCalledOnce();
            expect(tracker.checkState).not.toHaveBeenCalled();
        } finally {
            delete tracker.captureCanvasState;
        }
    });

    it("notifies the change tracker once the server store confirms the mesh", async () => {
        const { app } = await import("./helpers/comfyApp.js");
        const checkState = app.extensionManager.workflow.activeWorkflow.changeTracker.checkState;
        const { ui } = makeUI('{"showImportedTexture":false}');
        await vi.advanceTimersByTimeAsync(200);
        checkState.mockClear();
        ui.persistence._resyncWidget();
        await vi.advanceTimersByTimeAsync(200);
        expect(checkState).toHaveBeenCalledOnce();
    });

    it("reports committed changes to the workflow change tracker so F5 keeps them", async () => {
        const { app } = await import("./helpers/comfyApp.js");
        const checkState = app.extensionManager.workflow.activeWorkflow.changeTracker.checkState;
        checkState.mockClear();
        const { ui } = makeUI('{"showImportedTexture":false}');
        ui._scheduleGraphChange("mesh");
        ui._scheduleGraphChange("mesh");
        expect(checkState).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(200);
        expect(checkState).toHaveBeenCalledOnce();
    });

    it("coalesces committed sculpt changes into one graph notification", async () => {
        const { ui, node } = makeUI("{}");

        ui.sculptApp.options.onUpdate("tool");
        ui.sculptApp.options.onUpdate("tool");
        await vi.advanceTimersByTimeAsync(121);

        expect(node.graph.change).toHaveBeenCalledOnce();
        expect(node.setDirtyCanvas).toHaveBeenCalled();
    });

    it("blocks queueing when current geometry cannot be serialized", async () => {
        const { ui, widget } = makeUI("{}");
        ui.sculptApp.serializeForWidget = () => {
            throw new Error("forced serialization failure");
        };

        await expect(widget.serializeValue()).rejects.toThrow(
            "forced serialization failure"
        );
        expect(ui.persistenceStatusText.textContent).toBe(
            "Current sculpt state could not be serialized; queueing is blocked."
        );
    });

    it("shows non-blocking saving and restoring status", () => {
        const { ui } = makeUI("{}");
        ui._setPersistenceStatus("saving");
        expect(ui.persistenceStatusText.textContent).toBe("Saving sculpt mesh…");
        expect(ui.persistenceRetryButton.hidden).toBe(true);
        ui._setPersistenceStatus("restoring");
        expect(ui.persistenceStatusText.textContent).toBe("Restoring sculpt mesh…");
    });
});
