import { it, expect, vi } from "vitest";
import { Mesh } from "../js/engine/Mesh.js";
import { SculptEngine } from "../js/engine/SculptEngine.js";
import { MAX_MESH_FACE_INDICES } from "../js/engine/limits.js";

it("rejects too many faces before replacing or building the current mesh", () => {
    const engine = new SculptEngine();
    engine.loadPrimitive("sphere", 1);
    const previous = engine.mesh.vertices;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const faces = new Uint32Array(MAX_MESH_FACE_INDICES + 1);
    try {
        expect(engine._applyImportedMesh([0,0,0,1,0,0,0,1,0], faces)).toBe(false);
        expect(engine.mesh.vertices).toBe(previous);
        expect(() => engine.mesh.setData([0,0,0,1,0,0,0,1,0], faces)).toThrow(/limit/);
        expect(engine.mesh.vertices).toBe(previous);
    } finally { warning.mockRestore(); }
});
it("rejects invalid UVs before changing the mesh", () => {
    const mesh = new Mesh();
    const original = mesh.vertices;
    expect(() => mesh.setData([0,0,0,1,0,0,0,1,0], [0,1,2], [NaN,0,0,0,0,0])).toThrow(/finite/);
    expect(mesh.vertices).toBe(original);
});
