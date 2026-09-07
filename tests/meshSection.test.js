import { afterEach, describe, expect, it, vi } from "vitest";
import { BrushPanel } from "../js/ui/BrushPanel.js";

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

describe("Mesh section", () => {
    it("offers every shape and subdivision level and rebuilds through onPresetSelect", () => {
        vi.stubGlobal("document", { createElement: (tag) => element(tag) });
        const body = element("section");
        const settings = { primitive: "sphere", subdivision: 4 };
        const panel = {
            getExportSetting: vi.fn((name) => settings[name]),
            onPresetSelect: vi.fn((primitive, subdivision) => Object.assign(settings, { primitive, subdivision })),
            onUpdate: vi.fn(),
            _beginSection: vi.fn(() => body),
            _setPressed: vi.fn(),
            _exportSyncers: []
        };

        BrushPanel.prototype._createPresetsSection.call(panel);
        const [shapes, label, levels] = body.children;
        expect(shapes.children.map((b) => b.children[0].textContent)).toEqual([
            "Sphere", "Cube", "Cylinder", "Torus", "Plane"
        ]);
        expect(label.textContent).toBe("Subdivision");
        expect(levels.children.map((b) => b.textContent)).toEqual(["1", "2", "3", "4", "5"]);

        shapes.children[1].onclick();
        expect(panel.onPresetSelect).toHaveBeenLastCalledWith("cube", 4);
        levels.children[1].onclick();
        expect(panel.onPresetSelect).toHaveBeenLastCalledWith("cube", 2);
        expect(panel.onUpdate).toHaveBeenCalledWith("preset");
        expect(panel._exportSyncers).toHaveLength(1);
        // Pressed state follows the current settings, not the button clicked.
        expect(panel._setPressed).toHaveBeenCalledWith(shapes.children[1], true);
        expect(panel._setPressed).toHaveBeenCalledWith(levels.children[1], true);

        // A widget written from outside the panel is picked up by syncSettings.
        panel._setPressed.mockClear();
        Object.assign(settings, { primitive: "torus", subdivision: 5 });
        BrushPanel.prototype.syncSettings.call(panel);
        expect(panel._setPressed).toHaveBeenCalledWith(shapes.children[3], true);
        expect(panel._setPressed).toHaveBeenCalledWith(levels.children[4], true);
        expect(panel._setPressed).toHaveBeenCalledWith(shapes.children[1], false);
    });
});
