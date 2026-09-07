import { describe, it, expect } from "vitest";
import { srgbToLinear, linearToSrgb, firstMtlKd, baseColorFromMtlCompanions } from "../js/core/colorSpace.js";
import { migrateLegacyBaseColor } from "../js/core/legacyPalette.js";

describe("colour space helpers", () => {
    it("round-trips a display colour through linear", () => {
        const back = linearToSrgb(srgbToLinear([0.38, 0.08, 0.02]));
        expect(back[0]).toBeCloseTo(0.38, 6);
        expect(back[1]).toBeCloseTo(0.08, 6);
        expect(back[2]).toBeCloseTo(0.02, 6);
    });

    it("passes null through", () => {
        expect(linearToSrgb(null)).toBeNull();
        expect(srgbToLinear(undefined)).toBeNull();
    });

    it("reads the first Kd of an MTL and ignores comments and other keys", () => {
        const mtl = "# ComfyUI Sculpt Export\nnewmtl sculpt_material\nKa 0 0 0\nKd 0.1193 0.0072 0.0015\nKs 0 0 0\nnewmtl other\nKd 1 1 1\n";
        expect(firstMtlKd(mtl)).toEqual([0.1193, 0.0072, 0.0015]);
        expect(firstMtlKd("newmtl a\nKa 1 1 1\n")).toBeNull();
        expect(firstMtlKd(null)).toBeNull();
    });

    it("turns an exported MTL back into the base colour it was written from", async () => {
        const files = new Map([["sculpt.mtl", { name: "sculpt.mtl", text: async () => "newmtl m\nKd 0.1193 0.0072 0.0015\n" }]]);
        const base = await baseColorFromMtlCompanions(files);
        expect(base[0]).toBeCloseTo(0.38, 2);
        expect(base[1]).toBeCloseTo(0.08, 2);
        expect(base[2]).toBeCloseTo(0.02, 2);
        expect(await baseColorFromMtlCompanions(new Map())).toBeNull();
        expect(await baseColorFromMtlCompanions(null)).toBeNull();
    });
});

describe("legacy palette", () => {
    it("maps swatch colours saved before calibration to the current swatch", () => {
        expect(migrateLegacyBaseColor([0.70, 0.24, 0.17])).toEqual([0.38, 0.08, 0.02]);
        expect(migrateLegacyBaseColor([0.55, 0.55, 0.55])).toEqual([0.29, 0.29, 0.29]);
    });

    it("leaves imported and current colours alone", () => {
        expect(migrateLegacyBaseColor([0.38, 0.08, 0.02])).toEqual([0.38, 0.08, 0.02]);
        expect(migrateLegacyBaseColor([0.5, 0.1, 0.9])).toEqual([0.5, 0.1, 0.9]);
        expect(migrateLegacyBaseColor(null)).toBeNull();
    });
});
