import { describe, expect, it, vi } from "vitest";
import { chooseWorkflowSculptValue, readPreviewSize, readWidgetValue } from "../js/core/workflowSnapshot.js";
import { PREVIEW_SIZE_DEFAULT, PREVIEW_SIZE_MAX, PREVIEW_SIZE_MIN } from "../js/engine/limits.js";

describe("preview size widget reading", () => {
    const node = (value) => ({ widgets: [{ name: "preview_size", value }] });
    it("clamps to the contract bounds and rounds", () => {
        expect(readPreviewSize(node(99999))).toBe(PREVIEW_SIZE_MAX);
        expect(readPreviewSize(node(1))).toBe(PREVIEW_SIZE_MIN);
        expect(readPreviewSize(node(767.6))).toBe(768);
    });
    it("falls back to the default when the widget is missing or unusable", () => {
        expect(readPreviewSize({ widgets: [] })).toBe(PREVIEW_SIZE_DEFAULT);
        expect(readPreviewSize(null)).toBe(PREVIEW_SIZE_DEFAULT);
        expect(readPreviewSize(node("not a number"))).toBe(PREVIEW_SIZE_DEFAULT);
    });
    it("reads arbitrary widgets with a fallback", () => {
        const n = { widgets: [{ name: "export_format", value: "glb" }] };
        expect(readWidgetValue(n, "export_format", "none")).toBe("glb");
        expect(readWidgetValue(n, "filename_prefix", "sculpt")).toBe("sculpt");
    });
});

const STUB = '{"schemaVersion":5,"_meshOmittedFromWorkflow":true,"_meshRef":"old"}';

describe("workflow snapshot selection", () => {
    it("keeps the stub and requests an upload while the server ref is stale", () => {
        // Full geometry must never land in the workflow here: the frontend
        // autosaves the whole graph to localStorage and a large mesh breaks it.
        const out = chooseWorkflowSculptValue({
            widgetValue: STUB,
            widgetData: { _meshOmittedFromWorkflow: true },
            isCurrentRevisionStored: false,
            pendingRestore: false
        });
        expect(out).toEqual({ value: STUB, needsUpload: true });
    });

    it("keeps the compact stub once the current revision is stored", () => {
        const out = chooseWorkflowSculptValue({
            widgetValue: STUB,
            widgetData: { _meshOmittedFromWorkflow: true },
            isCurrentRevisionStored: true,
            pendingRestore: false
        });
        expect(out).toEqual({ value: STUB, needsUpload: false });
    });

    it("preserves an unsupported future-schema payload byte-for-byte", () => {
        const future = '{"schemaVersion":99,"futureField":{"x":1}}';
        const out = chooseWorkflowSculptValue({
            widgetValue: STUB,
            futurePayload: future,
            widgetData: { _meshOmittedFromWorkflow: true },
            isCurrentRevisionStored: false,
            pendingRestore: false
        });
        expect(out).toEqual({ value: future, needsUpload: false });
    });

    it("keeps the restore stub while server geometry is pending", () => {
        const out = chooseWorkflowSculptValue({
            widgetValue: STUB,
            widgetData: { _meshOmittedFromWorkflow: true },
            isCurrentRevisionStored: false,
            pendingRestore: true
        });
        expect(out).toEqual({ value: STUB, needsUpload: false });
    });
});
