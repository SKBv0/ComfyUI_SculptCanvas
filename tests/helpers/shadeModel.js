// Test-only port of the mesh fragment shader (js/renderer/Shaders.js): shades a
// sphere of normals and returns the average tone-mapped colour, so rig
// calibration can be checked without a GPU. Keep in step with the shader.

const PI = Math.PI;
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const normalize = (v) => {
    const len = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / len, v[1] / len, v[2] / len];
};
const mix = (a, b, t) => a + (b - a) * t;
const smoothstep = (x) => {
    const t = clamp01(x);
    return t * t * (3 - 2 * t);
};

export function srgbToLinear(c) {
    return c.map((v) => {
        const x = clamp01(v);
        return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    });
}

export function linearToSrgb(c) {
    return c.map((v) => {
        const x = clamp01(v);
        return x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055;
    });
}

function rrtAndOdtFit(v) {
    return v.map((x) => {
        const a = x * (x + 0.0245786) - 0.000090537;
        const b = x * (0.983729 * x + 0.4329510) + 0.238081;
        return a / b;
    });
}

function acesFitted(color) {
    const aces = rrtAndOdtFit([
        dot(color, [0.59719, 0.35458, 0.04823]),
        dot(color, [0.07600, 0.90834, 0.01566]),
        dot(color, [0.02840, 0.13383, 0.83777])
    ]);
    return [
        clamp01(dot(aces, [1.60475, -0.53108, -0.07367])),
        clamp01(dot(aces, [-0.10208, 1.10813, -0.00605])),
        clamp01(dot(aces, [-0.00327, -0.07276, 1.07602]))
    ];
}

function dGgx(NoH, roughness) {
    const a = Math.max(roughness, 0.04);
    const a2 = a * a;
    const denom = NoH * NoH * (a2 - 1) + 1;
    return a2 / Math.max(PI * denom * denom, 1e-5);
}

function gSchlickGgx(NoV, roughness) {
    const r = roughness + 1;
    const k = (r * r) / 8;
    return NoV / Math.max(NoV * (1 - k) + k, 1e-5);
}

function shadeDirectional(normal, viewDir, lightDir, lightColor, intensity, roughness, wrapAmount, albedo, F0, specularBoost, subsurfaceStrength) {
    const NoLRaw = dot(normal, lightDir);
    const wrappedNoL = clamp01((NoLRaw + wrapAmount) / (1 + wrapAmount));
    const NoV = Math.max(dot(normal, viewDir), 1e-4);

    const halfVec = normalize([lightDir[0] + viewDir[0], lightDir[1] + viewDir[1], lightDir[2] + viewDir[2]]);
    const NoH = Math.max(dot(normal, halfVec), 0);
    const VoH = Math.max(dot(viewDir, halfVec), 0);
    const NoLSpec = Math.max(NoLRaw, 0);
    let NoLForDiffuse = smoothstep(wrappedNoL);
    NoLForDiffuse = mix(NoLForDiffuse, wrappedNoL, 0.62);
    NoLForDiffuse = Math.max(NoLForDiffuse, 0.02 + 0.03 * (1 - roughness));
    const fd90 = 0.5 + 2 * VoH * VoH * roughness;
    const diffuseProfile = (1 + (fd90 - 1) * (1 - NoLForDiffuse) ** 5) * (1 + (fd90 - 1) * (1 - NoV) ** 5);

    const DPrimary = dGgx(NoH, roughness);
    const DSecondary = dGgx(NoH, Math.max(0.08, roughness * 0.45));
    const G = gSchlickGgx(NoV, roughness) * gSchlickGgx(Math.max(NoLSpec, 1e-4), roughness);
    const F = F0.map((f) => f + (1 - f) * (1 - VoH) ** 5);

    const denominator = Math.max(4 * NoV * Math.max(NoLSpec, 1e-4), 1e-4);
    const cavity = mix(0.74, 1, NoV ** 0.65);
    const fresnelCavity = mix(0.78, 1.24, (1 - NoV) ** 2.2);
    const horizonFade = clamp01(4 * NoLSpec * NoV);
    const transmittance = clamp01(1 - Math.abs(NoLRaw)) ** 1.5;
    const viewThickness = mix(0.58, 1, (1 - NoV) ** 1.35);
    const sss = transmittance * viewThickness * (0.08 + 0.24 * (1 - roughness)) * subsurfaceStrength;

    return albedo.map((a, i) => {
        const specPrimary = (DPrimary * G * F[i]) / denominator;
        const specSecondary = (DSecondary * G * F[i]) / denominator;
        const diffuse = (1 - F[i]) * a / PI * NoLForDiffuse * diffuseProfile * cavity;
        const specular = (specPrimary + specSecondary * 0.35) * fresnelCavity * NoLSpec * specularBoost * horizonFade;
        return (diffuse + specular + a * sss) * lightColor[i] * intensity;
    });
}

function rotateDirection(dir, yawDeg = 0, pitchDeg = 0) {
    const yaw = (yawDeg * PI) / 180;
    const pitch = (pitchDeg * PI) / 180;
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    const xYaw = dir[0] * cy + dir[2] * sy;
    const yYaw = dir[1];
    const zYaw = -dir[0] * sy + dir[2] * cy;
    return normalize([xYaw, yYaw * cp - zYaw * sp, yYaw * sp + zYaw * cp]);
}

/** Shade one point of the sphere; mirrors the mesh fragment shader without texture or mask. */
function shadePoint(normal, albedo, rig, opts) {
    const viewDir = [0, 0, 1];
    const stylization = clamp01((opts.matcapIntensity ?? 1) / 2.2);
    const roughness = mix(0.68, 0.18, stylization);
    const wrap = mix(0.12, 0.36, stylization);
    const F0 = [0, 1, 2].map(() => mix(0.028, 0.055, stylization * 0.85));
    const scale = Math.max(0, opts.lightPower ?? 1);
    const yaw = opts.lightYaw ?? 0;
    const pitch = opts.lightPitch ?? 0;

    const key = shadeDirectional(normal, viewDir, rotateDirection(rig.keyDir, yaw, pitch), srgbToLinear(rig.keyColor),
        rig.keyIntensity * scale, roughness, wrap, albedo, F0, rig.specularBoost, rig.subsurfaceStrength);
    const fill = shadeDirectional(normal, viewDir, rotateDirection(rig.fillDir, yaw, pitch), srgbToLinear(rig.fillColor),
        rig.fillIntensity * scale, Math.min(1, roughness + 0.16), wrap + 0.1, albedo, F0, rig.specularBoost * 0.82, rig.subsurfaceStrength * 0.85);
    const rim = shadeDirectional(normal, viewDir, rotateDirection(rig.rimDir, yaw, pitch), srgbToLinear(rig.rimColor),
        rig.rimIntensity * scale, Math.max(0.12, roughness * 0.72), wrap * 0.52, albedo, F0, rig.specularBoost * 0.82, rig.subsurfaceStrength * 0.58);

    const hemi = normal[1] * 0.5 + 0.5;
    const ambientTint = srgbToLinear(rig.ambientTint);
    const exposure = Math.max(0.01, rig.exposure ?? 1);
    const linear = albedo.map((a, i) =>
        (key[i] + fill[i] + rim[i] + a * ambientTint[i] * rig.ambient * mix(0.74, 1, hemi)) * exposure);
    return linearToSrgb(acesFitted(linear));
}

/**
 * Average on-screen colour of a sphere with this base colour under the rig,
 * as sRGB in 0..1. Samples the camera-facing hemisphere with a Fibonacci
 * spiral and weights by projected area, which is what the eye integrates.
 */
export function displayedMaterialColor(baseColor, rig, opts = {}) {
    if (!rig || !Array.isArray(baseColor) || baseColor.length < 3) return null;
    const albedo = srgbToLinear(baseColor.slice(0, 3));
    const samples = 128;
    const golden = PI * (3 - Math.sqrt(5));
    const sum = [0, 0, 0];
    let weight = 0;
    for (let i = 0; i < samples; i++) {
        // z in (0, 1]: normals that face the camera.
        const z = 1 - (i + 0.5) / samples;
        const r = Math.sqrt(Math.max(0, 1 - z * z));
        const phi = golden * i;
        const c = shadePoint([Math.cos(phi) * r, Math.sin(phi) * r, z], albedo, rig, opts);
        sum[0] += c[0] * z;
        sum[1] += c[1] * z;
        sum[2] += c[2] * z;
        weight += z;
    }
    return sum.map((v) => Math.round((v / weight) * 10000) / 10000);
}
