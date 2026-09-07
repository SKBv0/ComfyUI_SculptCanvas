import { BRUSH_TYPES } from "../engine/Brush.js";

const BRUSH_IDS = new Set(Object.values(BRUSH_TYPES));
const SYMMETRY_IDS = new Set(["none", "x", "y", "z"]);
const STROKE_MODE_IDS = new Set(["continuous", "dragDot", "line"]);
const LIGHTING_PRESET_IDS = new Set([
    "zbrush_red_wax",
    "neutral_grey_clay",
    "soft_fill",
    "rim_dramatic",
    "studio_portrait",
    "museum_clay",
    "daylight_balanced",
    "noir_workshop"
]);

function finiteClamped(value, min, max) {
    return typeof value === "number" && Number.isFinite(value)
        ? Math.max(min, Math.min(max, value))
        : undefined;
}

function allowedString(value, allowed) {
    return typeof value === "string" && allowed.has(value) ? value : undefined;
}

/** Validate untrusted workflow settings before they reach engine/UI state. */
export function sanitizeSculptSettings(data) {
    const safe = { toolSettings: {} };
    const tools = data?.toolSettings && typeof data.toolSettings === "object"
        ? data.toolSettings
        : {};

    const activeBrush = allowedString(tools.activeBrush, BRUSH_IDS);
    const symmetry = allowedString(tools.symmetry, SYMMETRY_IDS);
    const strokeMode = allowedString(tools.strokeMode, STROKE_MODE_IDS);
    if (activeBrush !== undefined) safe.toolSettings.activeBrush = activeBrush;
    if (symmetry !== undefined) safe.toolSettings.symmetry = symmetry;
    if (strokeMode !== undefined) safe.toolSettings.strokeMode = strokeMode;

    for (const [key, min, max] of [
        ["brushRadius", 0.01, 1.0],
        ["brushStrength", 0.02, 2.0],
        ["innerRadiusRatio", 0.0, 1.0],
        ["lightPower", 0.0, 2.0],
        ["lightYaw", -180, 180],
        ["lightPitch", -75, 75]
    ]) {
        const value = finiteClamped(tools[key], min, max);
        if (value !== undefined) safe.toolSettings[key] = value;
    }
    if (typeof tools.maskPaintMode === "boolean") {
        safe.toolSettings.maskPaintMode = tools.maskPaintMode;
    }
    if (typeof tools.showGrid === "boolean") {
        safe.toolSettings.showGrid = tools.showGrid;
    }

    if (
        Array.isArray(data?.baseColor)
        && data.baseColor.length >= 3
        && data.baseColor.slice(0, 3).every(
            (value) => typeof value === "number" && Number.isFinite(value)
        )
    ) {
        safe.baseColor = data.baseColor.slice(0, 3).map(
            (value) => Math.max(0, Math.min(1, value))
        );
    }

    const lightingPreset = allowedString(data?.lightingPreset, LIGHTING_PRESET_IDS);
    if (lightingPreset !== undefined) safe.lightingPreset = lightingPreset;
    for (const [key, min, max] of [
        ["matcapIntensity", 0.0, 2.0],
        ["lightPower", 0.0, 2.0],
        ["lightYaw", -180, 180],
        ["lightPitch", -75, 75]
    ]) {
        const value = finiteClamped(data?.[key], min, max);
        if (value !== undefined) safe[key] = value;
    }
    for (const key of ["showWireframe", "showGrid", "showImportedTexture"]) {
        if (typeof data?.[key] === "boolean") safe[key] = data[key];
    }
    return safe;
}
