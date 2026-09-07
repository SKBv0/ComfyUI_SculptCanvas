/**
 * GLSL shaders for sculpt rendering.
 *
 * The mesh shader lights the surface with three analytic directional lights
 * (GGX specular, Disney diffuse, wrapped terminator) and tonemaps with ACES.
 * The clay and wax look is computed procedurally; no matcap image is sampled.
 */

export const VERTEX_SHADER = `
    attribute vec3 aPosition;
    attribute vec3 aNormal;
    attribute vec2 aUv;
    attribute float aMask;

    uniform mat4 uModelView;
    uniform mat4 uProjection;

    varying vec3 vNormal;
    varying vec3 vPosition;
    varying vec2 vUv;
    varying float vMask;

    void main() {
        vUv = aUv;
        vMask = aMask;
        // The view matrix is orthonormal, so its upper-left 3x3 is its own
        // inverse transpose and can transform the normal directly.
        vNormal = normalize(mat3(uModelView) * aNormal);
        vPosition = (uModelView * vec4(aPosition, 1.0)).xyz;
        gl_Position = uProjection * vec4(vPosition, 1.0);
    }
`;

export const FRAGMENT_SHADER = `
    precision highp float;

    varying vec3 vNormal;
    varying vec3 vPosition;
    varying vec2 vUv;
    varying float vMask;

    uniform vec3 uKeyLightDir;
    uniform vec3 uFillLightDir;
    uniform vec3 uRimLightDir;
    uniform float uKeyIntensity;
    uniform float uFillIntensity;
    uniform float uRimIntensity;
    uniform float uAmbientStrength;
    uniform vec3 uBaseColor;
    uniform float uMatcapIntensity;
    uniform vec3 uKeyLightColor;
    uniform vec3 uFillLightColor;
    uniform vec3 uRimLightColor;
    uniform vec3 uAmbientTint;
    uniform float uExposure;
    uniform float uSpecularBoost;
    uniform float uSubsurfaceStrength;
    uniform sampler2D uDiffuseMap;
    uniform float uUseTexture;

    const float PI = 3.14159265359;

    vec3 SRGBToLinear(vec3 c) {
        c = clamp(c, 0.0, 1.0);
        vec3 lo = c / 12.92;
        vec3 hi = pow((c + 0.055) / 1.055, vec3(2.4));
        return mix(lo, hi, step(vec3(0.04045), c));
    }

    vec3 LinearToSRGB(vec3 c) {
        c = clamp(c, 0.0, 1.0);
        vec3 lo = c * 12.92;
        vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
        return mix(lo, hi, step(vec3(0.0031308), c));
    }

    vec3 RRTAndODTFit(vec3 v) {
        vec3 a = v * (v + 0.0245786) - 0.000090537;
        vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
        return a / b;
    }

    vec3 ACESFitted(vec3 color) {
        vec3 aces = vec3(
            dot(color, vec3(0.59719, 0.35458, 0.04823)),
            dot(color, vec3(0.07600, 0.90834, 0.01566)),
            dot(color, vec3(0.02840, 0.13383, 0.83777))
        );
        aces = RRTAndODTFit(aces);
        vec3 rec709 = vec3(
            dot(aces, vec3(1.60475, -0.53108, -0.07367)),
            dot(aces, vec3(-0.10208, 1.10813, -0.00605)),
            dot(aces, vec3(-0.00327, -0.07276, 1.07602))
        );
        return clamp(rec709, 0.0, 1.0);
    }

    float D_GGX(float NoH, float roughness) {
        float a = max(roughness, 0.04);
        float a2 = a * a;
        float denom = NoH * NoH * (a2 - 1.0) + 1.0;
        return a2 / max(PI * denom * denom, 1e-5);
    }

    float G_SchlickGGX(float NoV, float roughness) {
        float r = roughness + 1.0;
        float k = (r * r) / 8.0;
        return NoV / max(NoV * (1.0 - k) + k, 1e-5);
    }

    float G_Smith(float NoV, float NoL, float roughness) {
        return G_SchlickGGX(NoV, roughness) * G_SchlickGGX(NoL, roughness);
    }

    vec3 FresnelSchlick(float VoH, vec3 F0) {
        return F0 + (1.0 - F0) * pow(1.0 - VoH, 5.0);
    }

    float WrapDiffuse(float NoL, float wrapAmount) {
        return clamp((NoL + wrapAmount) / (1.0 + wrapAmount), 0.0, 1.0);
    }

    float DisneyDiffuse(float NoL, float NoV, float VoH, float roughness) {
        float fd90 = 0.5 + 2.0 * VoH * VoH * roughness;
        float lightScatter = 1.0 + (fd90 - 1.0) * pow(1.0 - NoL, 5.0);
        float viewScatter = 1.0 + (fd90 - 1.0) * pow(1.0 - NoV, 5.0);
        return lightScatter * viewScatter;
    }

    vec3 shadeDirectional(
        vec3 normal,
        vec3 viewDir,
        vec3 lightDir,
        vec3 lightColor,
        float intensity,
        float roughness,
        float wrapAmount,
        vec3 albedo,
        vec3 F0,
        float specularBoost,
        float subsurfaceStrength
    ) {
        float NoLRaw = dot(normal, lightDir);
        float wrappedNoL = WrapDiffuse(NoLRaw, wrapAmount);
        float NoV = max(dot(normal, viewDir), 1e-4);

        vec3 halfVec = normalize(lightDir + viewDir);
        float NoH = max(dot(normal, halfVec), 0.0);
        float VoH = max(dot(viewDir, halfVec), 0.0);
        float NoLSpec = max(NoLRaw, 0.0);
        float NoLForDiffuse = smoothstep(0.0, 1.0, wrappedNoL);
        NoLForDiffuse = mix(NoLForDiffuse, wrappedNoL, 0.62);
        NoLForDiffuse = max(NoLForDiffuse, 0.02 + 0.03 * (1.0 - roughness));
        float diffuseProfile = DisneyDiffuse(NoLForDiffuse, NoV, VoH, roughness);

        float DPrimary = D_GGX(NoH, roughness);
        float DSecondary = D_GGX(NoH, max(0.08, roughness * 0.45));
        float G = G_Smith(NoV, max(NoLSpec, 1e-4), roughness);
        vec3 F = FresnelSchlick(VoH, F0);

        float denominator = max(4.0 * NoV * max(NoLSpec, 1e-4), 1e-4);
        vec3 specPrimary = (DPrimary * G * F) / denominator;
        vec3 specSecondary = (DSecondary * G * F) / denominator;

        vec3 kD = vec3(1.0) - F;
        float cavity = mix(0.74, 1.0, pow(NoV, 0.65));
        vec3 diffuse = kD * albedo / PI * NoLForDiffuse * diffuseProfile * cavity;

        // Fresnel-driven cavity boost preserves wet edge readability in clay/wax materials.
        float fresnelCavity = mix(0.78, 1.24, pow(1.0 - NoV, 2.2));
        float horizonFade = clamp(4.0 * NoLSpec * NoV, 0.0, 1.0);
        vec3 specular = (specPrimary + specSecondary * 0.35) * fresnelCavity * NoLSpec * specularBoost * horizonFade;

        // Simple forward-scatter approximation for clay/wax readability under grazing light.
        float transmittance = pow(clamp(1.0 - abs(NoLRaw), 0.0, 1.0), 1.5);
        float viewThickness = mix(0.58, 1.0, pow(1.0 - NoV, 1.35));
        vec3 subsurface = albedo * transmittance * viewThickness * (0.08 + 0.24 * (1.0 - roughness)) * subsurfaceStrength;

        return (diffuse + specular + subsurface) * lightColor * intensity;
    }

    void main() {
        vec3 normal = normalize(vNormal);
        vec3 viewDir = normalize(-vPosition);
        vec3 albedo = SRGBToLinear(uBaseColor);
        if (uUseTexture > 0.5) {
            vec3 texRgb = texture2D(uDiffuseMap, vUv).rgb;
            albedo = SRGBToLinear(texRgb);
        }

        float stylization = clamp(uMatcapIntensity / 2.2, 0.0, 1.0);
        float roughness = mix(0.68, 0.18, stylization);
        float wrap = mix(0.12, 0.36, stylization);
        vec3 F0 = mix(vec3(0.028), vec3(0.055), stylization * 0.85);

        vec3 keyColor = SRGBToLinear(uKeyLightColor);
        vec3 fillColor = SRGBToLinear(uFillLightColor);
        vec3 rimColor = SRGBToLinear(uRimLightColor);
        vec3 ambientTint = SRGBToLinear(uAmbientTint);

        vec3 key = shadeDirectional(
            normal, viewDir, normalize(uKeyLightDir), keyColor, uKeyIntensity, roughness, wrap, albedo, F0, uSpecularBoost, uSubsurfaceStrength
        );
        vec3 fill = shadeDirectional(
            normal, viewDir, normalize(uFillLightDir), fillColor, uFillIntensity, min(1.0, roughness + 0.16), wrap + 0.1, albedo, F0, uSpecularBoost * 0.82, uSubsurfaceStrength * 0.85
        );
        vec3 rim = shadeDirectional(
            normal, viewDir, normalize(uRimLightDir), rimColor, uRimIntensity, max(0.12, roughness * 0.72), wrap * 0.52, albedo, F0, uSpecularBoost * 0.82, uSubsurfaceStrength * 0.58
        );

        float hemi = normal.y * 0.5 + 0.5;
        vec3 ambient = albedo * ambientTint * uAmbientStrength * mix(0.74, 1.0, hemi);

        vec3 linearColor = (key + fill + rim + ambient) * max(0.01, uExposure);
        vec3 mapped = ACESFitted(linearColor);
        vec3 finalColor = LinearToSRGB(mapped);
        float mi = clamp(vMask, 0.0, 1.0);
        vec3 maskTint = vec3(1.0, 0.22, 0.18);
        finalColor = mix(finalColor, mix(finalColor, maskTint, 0.5), mi * 0.4);
        gl_FragColor = vec4(finalColor, 1.0);
    }
`;

export const WIREFRAME_VERTEX_SHADER = `
    attribute vec3 aPosition;

    uniform mat4 uModelView;
    uniform mat4 uProjection;

    void main() {
        vec4 viewPos = uModelView * vec4(aPosition, 1.0);
        // Nudge toward the camera so the lines are not z-fought by the shaded
        // surface they sit on.
        viewPos.xyz += normalize(-viewPos.xyz) * 0.005;
        gl_Position = uProjection * viewPos;
    }
`;

export const WIREFRAME_FRAGMENT_SHADER = `
    precision mediump float;

    uniform vec3 uWireColor;
    uniform float uOpacity;

    void main() {
        gl_FragColor = vec4(uWireColor, uOpacity);
    }
`;

export const CURSOR_VERTEX_SHADER = `
    attribute vec3 aPosition;

    uniform mat4 uModelView;
    uniform mat4 uProjection;
    uniform vec3 uCursorCenter;
    uniform float uCursorRadius;
    uniform vec3 uCursorNormal;

    varying float vEdgeFade;

    void main() {
        // Tangent frame for the cursor disc. Crossing with Y degenerates when
        // the surface normal is near-vertical, so fall back to X there.
        vec3 tangent = normalize(cross(uCursorNormal, vec3(0.0, 1.0, 0.0)));
        if (length(tangent) < 0.01) {
            tangent = normalize(cross(uCursorNormal, vec3(1.0, 0.0, 0.0)));
        }
        vec3 bitangent = normalize(cross(uCursorNormal, tangent));

        vec3 worldPos = uCursorCenter +
                        tangent * aPosition.x * uCursorRadius +
                        bitangent * aPosition.y * uCursorRadius +
                        uCursorNormal * 0.01; // lift clear of the surface

        vEdgeFade = length(aPosition.xy);

        gl_Position = uProjection * uModelView * vec4(worldPos, 1.0);
    }
`;

export const CURSOR_FRAGMENT_SHADER = `
    precision mediump float;

    uniform vec3 uCursorColor;
    uniform float uInnerRatio;  // Inner ring ratio (0.0-1.0), default 0.4
    varying float vEdgeFade;

    void main() {
        float dist = vEdgeFade;

        // Inner ring fill (full strength zone)
        float innerFill = smoothstep(uInnerRatio + 0.08, uInnerRatio - 0.02, dist) * 0.3;

        // Inner ring edge highlight
        float innerRing = smoothstep(uInnerRatio - 0.03, uInnerRatio + 0.01, dist)
                        * smoothstep(uInnerRatio + 0.08, uInnerRatio + 0.01, dist) * 0.7;

        // Outer ring gradient (falloff zone indication)
        float outerGradient = smoothstep(1.0, uInnerRatio, dist) * 0.15;

        // Outer ring edge
        float outerRing = smoothstep(0.88, 0.96, dist) * 0.85;

        float alpha = innerFill + innerRing + outerGradient + outerRing;
        gl_FragColor = vec4(uCursorColor, alpha);
    }
`;

export const GRID_VERTEX_SHADER = `
    attribute vec3 aPosition;

    uniform mat4 uModelView;
    uniform mat4 uProjection;
    uniform float uGridOffsetY;

    varying vec3 vWorldPos;

    void main() {
        vec3 pos = aPosition;
        pos.y += uGridOffsetY;
        vWorldPos = pos;
        gl_Position = uProjection * uModelView * vec4(pos, 1.0);
    }
`;

export const GRID_FRAGMENT_SHADER = `
    precision mediump float;

    varying vec3 vWorldPos;

    void main() {
        vec2 coord = vWorldPos.xz * 4.0;
        vec2 cell = abs(fract(coord - 0.5) - 0.5);

        // Derivative-free line width for broad WebGL1 compatibility.
        float line = min(cell.x, cell.y);
        float alpha = 1.0 - smoothstep(0.0, 0.055, line);
        alpha *= 0.15;

        float dist = length(vWorldPos.xz);
        alpha *= smoothstep(3.0, 1.0, dist);

        gl_FragColor = vec4(vec3(0.5), alpha);
    }
`;

export const GRID_FRAGMENT_SHADER_DERIVATIVES_WEBGL1 = `
#extension GL_OES_standard_derivatives : enable
    precision mediump float;

    varying vec3 vWorldPos;

    void main() {
        vec2 coord = vWorldPos.xz * 4.0;
        vec2 derivative = vec2(fwidth(coord.x), fwidth(coord.y));
        vec2 grid = abs(fract(coord - 0.5) - 0.5) / max(derivative, vec2(1e-5));
        float line = min(grid.x, grid.y);
        float alpha = (1.0 - min(line, 1.0)) * 0.15;

        float dist = length(vWorldPos.xz);
        alpha *= smoothstep(3.0, 1.0, dist);

        gl_FragColor = vec4(vec3(0.5), alpha);
    }
`;

export const GRID_VERTEX_SHADER_WEBGL2 = `#version 300 es

in vec3 aPosition;

uniform mat4 uModelView;
uniform mat4 uProjection;
uniform float uGridOffsetY;

out vec3 vWorldPos;

void main() {
    vec3 pos = aPosition;
    pos.y += uGridOffsetY;
    vWorldPos = pos;
    gl_Position = uProjection * uModelView * vec4(pos, 1.0);
}
`;

export const GRID_FRAGMENT_SHADER_DERIVATIVES_WEBGL2 = `#version 300 es
precision mediump float;

in vec3 vWorldPos;
out vec4 fragColor;

void main() {
    vec2 coord = vWorldPos.xz * 4.0;
    vec2 derivative = fwidth(coord);
    vec2 grid = abs(fract(coord - 0.5) - 0.5) / max(derivative, vec2(1e-5));
    float line = min(grid.x, grid.y);
    float alpha = (1.0 - min(line, 1.0)) * 0.15;

    float dist = length(vWorldPos.xz);
    alpha *= smoothstep(3.0, 1.0, dist);

    fragColor = vec4(vec3(0.5), alpha);
}
`;
