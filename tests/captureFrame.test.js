import { describe, it, expect } from "vitest";
import { captureSquare, captureFov } from "../js/core/captureFrame.js";

describe("preview capture square", () => {
    it("is the centred square of a wide viewport", () => {
        expect(captureSquare(800, 500)).toEqual({ left: 150, top: 0, side: 500 });
    });

    it("is the centred square of a tall viewport", () => {
        expect(captureSquare(400, 600)).toEqual({ left: 0, top: 100, side: 400 });
    });

    it("keeps the vertical field of view for a wide viewport", () => {
        expect(captureFov(45, 800, 500)).toBe(45);
    });

    it("narrows the field of view to the width of a tall viewport", () => {
        const fov = captureFov(45, 400, 600);
        expect(fov).toBeLessThan(45);
        const expectedHalfTan = Math.tan((45 * Math.PI) / 360) * (400 / 600);
        expect(Math.tan((fov * Math.PI) / 360)).toBeCloseTo(expectedHalfTan, 10);
    });
});
