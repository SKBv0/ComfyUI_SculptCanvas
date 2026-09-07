import { describe, it, expect } from "vitest";
import {
    selectMeshImport,
    MAX_MESH_FILE_BYTES,
    MAX_COMPANION_FILE_BYTES,
    MAX_COMPANION_FILES,
    MAX_TOTAL_IMPORT_BYTES,
    resolveCompanionFile
} from "../js/core/meshImportSelection.js";

const f = (name, size = 1000, rel = "") => ({ name, size, webkitRelativePath: rel });

describe("selectMeshImport — mesh file picking", () => {
    it("rejects a selection without any mesh file", () => {
        expect(selectMeshImport([f("texture.png")]).error).toBe("no-mesh");
        expect(selectMeshImport([]).error).toBe("no-mesh");
    });

    it("rejects ambiguous selections containing several mesh files", () => {
        const out = selectMeshImport([f("a.obj"), f("b.fbx"), f("c.gltf"), f("d.glb")]);
        expect(out.error).toBe("multiple-meshes");
        expect(out.meshFiles).toHaveLength(4);
        expect(selectMeshImport([f("a.obj")]).kind).toBe("obj");
    });

    it("is case-insensitive on extensions", () => {
        expect(selectMeshImport([f("MODEL.GLB")]).kind).toBe("glb");
    });

    it("rejects a mesh file over the size budget", () => {
        const out = selectMeshImport([f("huge.fbx", MAX_MESH_FILE_BYTES + 1)]);
        expect(out.error).toBe("mesh-too-large");
        expect(out.meshFile.name).toBe("huge.fbx");
    });
});

describe("companion path resolution", () => {
    it("prefers the longest exact relative-path match", () => {
        const woodA = f("wood.png", 10, "a/textures/wood.png");
        const woodB = f("wood.png", 10, "b/textures/wood.png");
        const selected = selectMeshImport([f("scene.gltf"), woodA, woodB]);
        expect(resolveCompanionFile(selected.companionFiles, "/b/textures/wood.png")).toBe(woodB);
    });

    it("rejects ambiguous duplicate-basename fallback", () => {
        const woodA = f("wood.png", 10, "a/wood.png");
        const woodB = f("wood.png", 10, "b/wood.png");
        const selected = selectMeshImport([f("scene.gltf"), woodA, woodB]);
        expect(resolveCompanionFile(selected.companionFiles, "wood.png")).toBeNull();
    });

    it("resolves renamed FBX textures only by unique semantic channel and UDIM", () => {
        const color = f("DRAGON_BAJA_BAJA5_BaseColor.1003.jpg", 10, "dragon/textures/DRAGON_BAJA_BAJA5_BaseColor.1003.jpg");
        const normal = f("DRAGON_BAJA_BAJA5_Normal.1003.jpg", 10, "dragon/textures/DRAGON_BAJA_BAJA5_Normal.1003.jpg");
        const selected = selectMeshImport([f("dragon.fbx"), color, normal]);
        expect(resolveCompanionFile(selected.companionFiles, "DRAGO_1003_Diffuse.jpg")).toBe(color);
        expect(resolveCompanionFile(selected.companionFiles, "DRAGO_1003_Normal.jpg")).toBe(normal);
    });

    it("rejects an ambiguous semantic UDIM match", () => {
        const a = f("A_BaseColor.1003.jpg", 10, "a/A_BaseColor.1003.jpg");
        const b = f("B_Diffuse.1003.jpg", 10, "b/B_Diffuse.1003.jpg");
        const selected = selectMeshImport([f("dragon.fbx"), a, b]);
        expect(resolveCompanionFile(selected.companionFiles, "missing_1003_Diffuse.jpg")).toBeNull();
    });
});

describe("selectMeshImport — companion budgets", () => {
    it("collects textures/.bin/.mtl and ignores unrelated files", () => {
        const out = selectMeshImport([
            f("scene.gltf"),
            f("scene.bin"),
            f("diffuse.png"),
            f("materials.mtl"),
            f("readme.txt"),
            f("script.js")
        ]);
        expect(out.skippedCompanions).toBe(0);
        expect(out.companionFiles.has("scene.bin")).toBe(true);
        expect(out.companionFiles.has("diffuse.png")).toBe(true);
        expect(out.companionFiles.has("materials.mtl")).toBe(true);
        expect(out.companionFiles.has("readme.txt")).toBe(false);
    });

    it("does not advertise image formats the browser upload path cannot decode", () => {
        const out = selectMeshImport([
            f("scene.fbx"),
            f("diffuse.png"),
            f("legacy.tga"),
            f("legacy.tiff")
        ]);
        expect(out.companionFiles.has("diffuse.png")).toBe(true);
        expect(out.companionFiles.has("legacy.tga")).toBe(false);
        expect(out.companionFiles.has("legacy.tiff")).toBe(false);
    });

    it("indexes folder-picked files by relative path and suffixes", () => {
        const out = selectMeshImport([
            f("scene.gltf"),
            f("wood.png", 1000, "model/textures/wood.png")
        ]);
        expect(out.companionFiles.has("wood.png")).toBe(true);
        expect(out.companionFiles.has("model/textures/wood.png")).toBe(true);
        expect(out.companionFiles.has("textures/wood.png")).toBe(true);
    });

    it("skips a companion over the per-file budget", () => {
        const out = selectMeshImport([
            f("a.obj"),
            f("big.png", MAX_COMPANION_FILE_BYTES + 1)
        ]);
        expect(out.skippedCompanions).toBe(1);
        expect(out.companionFiles.size).toBe(0);
    });

    it("caps the companion file count", () => {
        const files = [f("a.obj")];
        for (let i = 0; i < MAX_COMPANION_FILES + 5; i++) {
            files.push(f(`t${i}.png`, 10));
        }
        const out = selectMeshImport(files);
        expect(out.skippedCompanions).toBe(5);
    });

    it("enforces the total import budget across files", () => {
        const MiB = 1024 * 1024;
        // mesh 250 MiB + 4x60 MiB companions = 490 MiB (fits under 512);
        // a 5th 60 MiB companion would cross the total cap and must be skipped.
        const files = [f("a.obj", 250 * MiB)];
        for (let i = 1; i <= 5; i++) files.push(f(`t${i}.png`, 60 * MiB));
        const out = selectMeshImport(files);
        expect(out.error).toBeUndefined();
        expect(out.skippedCompanions).toBe(1);
        expect(out.companionFiles.has("t4.png")).toBe(true);
        expect(out.companionFiles.has("t5.png")).toBe(false);
    });
});
