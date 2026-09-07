import { afterEach, describe, expect, it, vi } from "vitest";
import { BrushPanel } from "../js/ui/BrushPanel.js";

function element(tag) {
    return {
        tag,
        children: [],
        dataset: {},
        setAttribute: vi.fn(),
        appendChild(child) { this.children.push(child); return child; }
    };
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("Object orientation controls", () => {
    it("provides six semantic quarter-turn buttons and commits through mesh update", () => {
        vi.stubGlobal("document", { createElement: (tag) => element(tag) });
        const body = element("section");
        const rotateObject = vi.fn(() => true);
        const panel = {
            engine: { rotateObject },
            onUpdate: vi.fn(),
            _beginSection: vi.fn(() => body),
            _updateUndoRedoButtons: vi.fn()
        };

        BrushPanel.prototype._createObjectOrientationSection.call(panel);
        const controls = body.children[0].children;
        expect(controls).toHaveLength(6);
        for (const control of controls) {
            expect(control.type).toBe("button");
            expect(control.setAttribute).toHaveBeenCalledWith("aria-label", expect.stringContaining("Rotate object"));
        }

        controls[1].onclick();
        expect(rotateObject).toHaveBeenCalledWith("x", Math.PI / 2);
        expect(panel.onUpdate).toHaveBeenCalledWith("mesh");
        expect(panel._updateUndoRedoButtons).toHaveBeenCalledOnce();
    });
});
