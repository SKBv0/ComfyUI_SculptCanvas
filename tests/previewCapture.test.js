import { describe, it, expect } from "vitest";
import { WebGLRenderer } from "../js/renderer/WebGLRenderer.js";

describe("preview capture buffer size", () => {
    it("renders into a buffer of the requested size and restores the on-screen size", () => {
        const renderer = Object.create(WebGLRenderer.prototype);
        renderer.canvas = { width: 656, height: 517 };
        let seen = null;
        const result = renderer.withBufferSize(1024, 1024, () => {
            seen = [renderer.canvas.width, renderer.canvas.height];
            return "ok";
        });
        expect(result).toBe("ok");
        expect(seen).toEqual([1024, 1024]);
        expect([renderer.canvas.width, renderer.canvas.height]).toEqual([656, 517]);
    });

    it("restores the on-screen size even when rendering throws", () => {
        const renderer = Object.create(WebGLRenderer.prototype);
        renderer.canvas = { width: 300, height: 200 };
        expect(() => renderer.withBufferSize(2048, 2048, () => { throw new Error("gl"); })).toThrow("gl");
        expect([renderer.canvas.width, renderer.canvas.height]).toEqual([300, 200]);
    });
});
