import { describe, it, expect } from "vitest";
import { displayedMaterialColor } from "./helpers/shadeModel.js";
import { LIGHTING_PRESETS } from "../js/renderer/WebGLRenderer.js";
import { SculptEngine } from "../js/engine/SculptEngine.js";

const GREY18 = 0.46; // sRGB value of 18% linear grey
const opts = { matcapIntensity: 1, lightPower: 1, lightYaw: -60, lightPitch: 0 };
const luminance = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

describe("light rig calibration", () => {
    it.each(Object.keys(LIGHTING_PRESETS))("%s shows 18%% grey as 18%% grey", (id) => {
        const shown = displayedMaterialColor([GREY18, GREY18, GREY18], LIGHTING_PRESETS[id], opts);
        expect(Math.abs(luminance(shown) - GREY18)).toBeLessThan(0.03);
    });

    it("shows the default red wax as a saturated red close to its base colour", () => {
        const base = new SculptEngine().baseColor;
        const shown = displayedMaterialColor(base, LIGHTING_PRESETS.zbrush_red_wax, opts);
        expect(shown[0]).toBeGreaterThan(4 * shown[1]);
        expect(Math.abs(shown[0] - base[0])).toBeLessThan(0.08);
    });
});
