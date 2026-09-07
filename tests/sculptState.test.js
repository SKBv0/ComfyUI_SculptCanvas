import { describe, expect, it } from "vitest";
import { sanitizeSculptSettings } from "../js/core/sculptState.js";

describe("persisted sculpt setting validation", () => {
    it("accepts known enums and clamps finite numeric settings", () => {
        const safe = sanitizeSculptSettings({
            baseColor: [2, 0.5, -1, 0.2],
            lightingPreset: "museum_clay",
            matcapIntensity: 99,
            lightYaw: -999,
            showWireframe: true,
            toolSettings: {
                activeBrush: "clay",
                symmetry: "x",
                strokeMode: "dragDot",
                brushRadius: 5,
                brushStrength: -1,
                innerRadiusRatio: 2,
                maskPaintMode: false
            }
        });
        expect(safe.baseColor).toEqual([1, 0.5, 0]);
        expect(safe.matcapIntensity).toBe(2);
        expect(safe.lightYaw).toBe(-180);
        expect(safe.showWireframe).toBe(true);
        expect(safe.toolSettings).toMatchObject({
            activeBrush: "clay",
            symmetry: "x",
            strokeMode: "dragDot",
            brushRadius: 1,
            brushStrength: 0.02,
            innerRadiusRatio: 1,
            maskPaintMode: false
        });
    });

    it("drops invalid, non-finite, and type-confused workflow values", () => {
        const safe = sanitizeSculptSettings({
            baseColor: "red",
            lightingPreset: "unknown",
            matcapIntensity: Number.NaN,
            lightPower: "2",
            showGrid: 1,
            toolSettings: {
                activeBrush: "delete-everything",
                symmetry: "all",
                strokeMode: "random",
                brushRadius: Number.POSITIVE_INFINITY,
                maskPaintMode: "true"
            }
        });
        expect(safe).toEqual({ toolSettings: {} });
    });
});
