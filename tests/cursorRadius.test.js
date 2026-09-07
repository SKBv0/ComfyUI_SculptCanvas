import { describe, it, expect, vi } from "vitest";
import { SculptCanvas } from "../js/ui/SculptCanvas.js";

function makeCanvas(cursorVisible) {
    const c = Object.create(SculptCanvas.prototype);
    c.engine = {
        brushRadius: 0.5,
        camera: { distance: 3, theta: 0, phi: 0, target: [0, 0, 0], fov: 45 }
    };
    c.canvas = { getBoundingClientRect: () => ({ width: 600, height: 400 }) };
    c.renderer = { cursorVisible, cursorCenter: [0, 0, 0], cursorRadius: 0.15 };
    c.requestRender = vi.fn();
    return c;
}

describe("brush ring after a radius change", () => {
    it("uses the depth-corrected world radius, not the raw slider value", () => {
        const c = makeCanvas(true);
        c.refreshCursorRadius();
        const expected = c._computeWorldBrushRadiusAtPoint([0, 0, 0]);
        expect(c.renderer.cursorRadius).toBeCloseTo(expected, 6);
        expect(c.renderer.cursorRadius).not.toBeCloseTo(0.5, 2);
        expect(c.requestRender).toHaveBeenCalled();
    });

    it("leaves a hidden ring alone", () => {
        const c = makeCanvas(false);
        c.refreshCursorRadius();
        expect(c.renderer.cursorRadius).toBe(0.15);
        expect(c.requestRender).not.toHaveBeenCalled();
    });
});
