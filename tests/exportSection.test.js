import { afterEach, describe, expect, it, vi } from "vitest";
import { BrushPanel } from "../js/ui/BrushPanel.js";
import { EXPORT_FORMATS } from "../js/engine/limits.js";

function element(tag) {
    return {
        tag,
        children: [],
        dataset: {},
        setAttribute: vi.fn(),
        appendChild(child) { this.children.push(child); return child; },
        append(...nodes) { this.children.push(...nodes); }
    };
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("Export section", () => {
    it("writes every choice into its widget and follows the EXPORT_FORMATS contract", () => {
        vi.stubGlobal("document", { createElement: (tag) => element(tag) });
        const body = element("section");
        const settings = { preview_background: "viewport", preview_size: 512, export_format: "none", filename_prefix: "sculpt" };
        const panel = {
            getExportSetting: vi.fn((name) => settings[name]),
            setExportSetting: vi.fn((name, value) => { settings[name] = value; }),
            _beginSection: vi.fn(() => body),
            _createChoiceRow: BrushPanel.prototype._createChoiceRow,
            _setPressed: vi.fn(),
            _exportSyncers: []
        };

        BrushPanel.prototype._createExportSection.call(panel);
        // label, group, label, group, label, group, label, input
        const groups = body.children.filter((c) => c.className === "sculpt-zpanel-segmented");
        const [background, sizes, formats] = groups;
        const input = body.children.find((c) => c.tag === "input");

        expect(formats.children.map((b) => b.textContent)).toEqual(["Off", "OBJ", "GLB", "STL"]);
        expect(formats.children).toHaveLength(EXPORT_FORMATS.length);
        expect(sizes.children.map((b) => b.textContent)).toEqual(["256", "512", "1024", "2048"]);

        formats.children[2].onclick();
        expect(settings.export_format).toBe("glb");
        formats.children[0].onclick();
        expect(settings.export_format).toBe("none");
        sizes.children[2].onclick();
        expect(settings.preview_size).toBe(1024);
        background.children[1].onclick();
        expect(settings.preview_background).toBe("transparent");

        input.value = "   my model  ";
        input.onchange();
        expect(settings.filename_prefix).toBe("my model");
        input.value = "   ";
        input.onchange();
        expect(settings.filename_prefix).toBe("sculpt");

        expect(panel._exportSyncers).toHaveLength(4);
    });
});
