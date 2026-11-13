import {mat4, vec3} from "gl-matrix";

import {COLOR_WGSL, type ColorSpace, srgbToLinear} from "../color";
import type {Geometry} from "../geometry/geometry";
import {PBRMaterial} from "../material/material";
import type {PassInputSlot, PassOutputSlot, PassRenderContext} from "../pass";
import {Pass} from "../pass";
import type {Camera} from "../scene/camera";
import type {DirectionalLight, PointLight, SpotLight} from "../scene/light";
import type {Mesh} from "../scene/mesh";
import type {Scene} from "../scene/scene";

// ─── WGSL shaders ─────────────────────────────────────────────────────────────

function buildShadowShader(): string {
    return /* wgsl */ `
struct ShadowLightUniforms {
    lightSpaceMatrix: mat4x4<f32>,
};

struct ShadowModelUniforms {
    model: mat4x4<f32>,
};

@group(0) @binding(0) var<uniform> light: ShadowLightUniforms;
@group(1) @binding(0) var<uniform> model: ShadowModelUniforms;

@vertex
fn vs_shadow(@location(0) position: vec3<f32>) -> @builtin(position) vec4<f32> {
    return light.lightSpaceMatrix * model.model * vec4<f32>(position, 1.0);
}
`;
}

/**
 * Shadow casters with alpha: the albedo alpha decides which texels block light. "mask" cuts like the G-buffer;
 * "blend" keeps a share of shadow texels equal to alpha (2×2 ordered; the PCF reads it back as a partial shadow).
 */
function buildAlphaShadowShader(alpha: "mask" | "blend"): string {
    return /* wgsl */ `
struct ShadowLightUniforms {
    lightSpaceMatrix: mat4x4<f32>,
};

struct ShadowModelUniforms {
    model: mat4x4<f32>,
};

${MATERIAL_UNIFORMS_WGSL}

@group(0) @binding(0) var<uniform> light: ShadowLightUniforms;
@group(1) @binding(0) var<uniform> model: ShadowModelUniforms;
@group(2) @binding(0) var<uniform> mat: MaterialUniforms;
@group(2) @binding(1) var albedoMap: texture_2d<f32>;
@group(2) @binding(2) var matSampler: sampler;

struct ShadowVarying {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_shadow(@location(0) position: vec3<f32>, @location(2) uv: vec2<f32>) -> ShadowVarying {
    var out: ShadowVarying;
    out.pos = light.lightSpaceMatrix * model.model * vec4<f32>(position, 1.0);
    out.uv = uv;
    return out;
}

@fragment
fn fs_shadow(in: ShadowVarying) {
    let alpha = textureSample(albedoMap, matSampler, in.uv).a * mat.albedo.a;
${
    alpha === "mask"
        ? `    if (alpha < mat.alphaCutoff) { discard; }`
        : `    // 2×2 ordered threshold per shadow texel: the PCF's four ½-texel taps average it back to an even partial
    // shadow (noise, or any coarser pattern, would show through as dots on the receiver)
    let p = vec2<u32>(in.pos.xy) & vec2<u32>(1u);
    let threshold = (f32((p.x * 2u) ^ (p.y * 3u)) + 0.5) / 4.0; // Bayer 2×2: [[0, 2], [3, 1]]
    if (alpha <= threshold) { discard; }`
}
}
`;
}

export interface GBufferFeatures {
    parallaxMapping: boolean; // heightMap is assigned
    normalMapping: boolean; // normalMap is assigned
    /** "mask" cuts below alphaCutoff. ("blend" materials are drawn by the transparent pass, not the G-buffer.) */
    alpha?: "opaque" | "mask" | "blend";
    /** No back-face culling; back faces flip their normal. */
    doubleSided?: boolean;
}

function getGBufferFeatures(mat: PBRMaterial): GBufferFeatures {
    return {
        parallaxMapping: mat.heightMap != null,
        normalMapping: mat.normalMap != null,
        alpha: mat.alphaMode,
        doubleSided: mat.doubleSided,
    };
}

function featureKey(f: GBufferFeatures): string {
    return (
        (f.parallaxMapping ? "P" : "") +
        (f.normalMapping ? "N" : "") +
        (f.alpha === "mask" ? "M" : f.alpha === "blend" ? "B" : "") +
        (f.doubleSided ? "2" : "")
    );
}

const MATERIAL_UNIFORMS_WGSL = /* wgsl */ `
struct MaterialUniforms {
    albedo:            vec4<f32>,
    roughness:         f32,
    metallic:          f32,
    heightScale:       f32,
    normalScale:       f32,
    emissive:          vec4<f32>,
    occlusionStrength: f32,
    alphaCutoff:       f32,
};
`;

/**
 * Everything a mesh pass shares: camera, model and material bindings (groups 0-2), the vertex stage, and
 * surface(), which reads the material at a fragment (maps, parallax, normal mapping, alpha mask).
 */
function buildSurfaceWgsl(f: GBufferFeatures): string {
    const needsTbn = f.parallaxMapping || f.normalMapping;
    return /* wgsl */ `
struct CameraUniforms {
    view:           mat4x4<f32>,
    projection:     mat4x4<f32>,
    viewProjection: mat4x4<f32>,
    position:       vec4<f32>,
};

struct ModelUniforms {
    model:        mat4x4<f32>,
    normalMatrix: mat4x4<f32>,
    flags:        vec4<f32>,   // x = receiveShadow
};

${MATERIAL_UNIFORMS_WGSL}

@group(0) @binding(0) var<uniform> camera:     CameraUniforms;
@group(1) @binding(0) var<uniform> model:      ModelUniforms;
@group(2) @binding(0) var<uniform> mat:        MaterialUniforms;
@group(2) @binding(1) var albedoMap:           texture_2d<f32>;
@group(2) @binding(2) var matSampler:          sampler;
@group(2) @binding(3) var normalMap:           texture_2d<f32>;
@group(2) @binding(4) var emissiveMap:         texture_2d<f32>;
@group(2) @binding(5) var metallicRoughnessMap: texture_2d<f32>; // G=roughness, B=metallic
@group(2) @binding(6) var heightMap:           texture_2d<f32>;
@group(2) @binding(7) var occlusionMap:        texture_2d<f32>; // R=occlusion

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal:   vec3<f32>,
    @location(2) uv:       vec2<f32>,
    @location(3) tangent:  vec4<f32>,
};

struct VertexOutput {
    @builtin(position) clipPos:      vec4<f32>,
    @location(0)       worldPos:     vec3<f32>,
    @location(1)       worldNormal:  vec3<f32>,
    @location(2)       uv:           vec2<f32>,
    @location(3)       worldTangent: vec4<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
    let worldPos = model.model * vec4<f32>(input.position, 1.0);
    var output: VertexOutput;
    output.clipPos     = camera.viewProjection * worldPos;
    output.worldPos    = worldPos.xyz;
    output.worldNormal = normalize((model.normalMatrix * vec4<f32>(input.normal, 0.0)).xyz);
    output.uv          = input.uv;
    let worldTangentXYZ = normalize((model.normalMatrix * vec4<f32>(input.tangent.xyz, 0.0)).xyz);
    output.worldTangent = vec4<f32>(worldTangentXYZ, input.tangent.w);
    return output;
}

${
    f.parallaxMapping
        ? `
fn parallaxOcclusionMapping(uv: vec2<f32>, viewDirT: vec3<f32>, scale: f32) -> vec2<f32> {
    let numLayers  = mix(8.0, 32.0, abs(dot(vec3(0.0, 0.0, 1.0), normalize(viewDirT))));
    let layerDepth = 1.0 / numLayers;
    // tangent-space y is the bitangent, toward -v (the image's top): flip it into uv space
    let deltaUV    = (vec2<f32>(viewDirT.x, -viewDirT.y) / viewDirT.z) * scale / numLayers;
    var depth = 0.0;
    var cuv   = uv;
    var cd    = 1.0 - textureSampleLevel(heightMap, matSampler, cuv, 0.0).r;
    for (var i: i32 = 0; i < 32; i++) {
        if (depth >= cd) { break; }
        cuv   -= deltaUV;
        cd     = 1.0 - textureSampleLevel(heightMap, matSampler, cuv, 0.0).r;
        depth += layerDepth;
    }
    let prevUV     = cuv + deltaUV;
    let afterDiff  = cd - depth;
    let beforeDiff = (1.0 - textureSampleLevel(heightMap, matSampler, prevUV, 0.0).r) - (depth - layerDepth);
    let w = afterDiff / (afterDiff - beforeDiff);
    return mix(cuv, prevUV, w);
}
`
        : ""
}

struct Surface {
    albedo:    vec3<f32>,
    alpha:     f32,
    normal:    vec3<f32>,
    roughness: f32,
    metallic:  f32,
    ao:        f32,
    emissive:  vec3<f32>,
};

fn surface(input: VertexOutput, frontFacing: bool) -> Surface {
${
    f.doubleSided
        ? `
    // a back face is lit from its own side
    let N = select(-1.0, 1.0, frontFacing) * normalize(input.worldNormal);`
        : `
    let N = normalize(input.worldNormal);`
}
${
    needsTbn
        ? `
    let T   = normalize(input.worldTangent.xyz);
    let B   = cross(N, T) * input.worldTangent.w;
    let tbn = mat3x3<f32>(T, B, N);
`
        : ""
}
    var uv = input.uv;
${
    f.parallaxMapping
        ? `
    if (mat.heightScale > 0.001) {
        let viewDir  = normalize(camera.position.xyz - input.worldPos);
        let viewDirT = transpose(tbn) * viewDir;
        uv = parallaxOcclusionMapping(uv, viewDirT, mat.heightScale);
    }
`
        : ""
}
${
    f.normalMapping
        ? `
    // tangent-space normal, +Y toward the top of the image (glTF / OpenGL convention), XY scaled
    let normalSample  = (textureSample(normalMap, matSampler, uv).rgb * 2.0 - 1.0)
                      * vec3<f32>(mat.normalScale, mat.normalScale, 1.0);
    let shadingNormal = normalize(tbn * normalSample);
`
        : `
    let shadingNormal = N;
`
}
    let texAlbedo4 = textureSample(albedoMap, matSampler, uv);
    let alpha      = texAlbedo4.a * mat.albedo.a;
${f.alpha === "mask" ? `    if (alpha < mat.alphaCutoff) { discard; }` : ""}

    let mr        = textureSample(metallicRoughnessMap, matSampler, uv);
    let occlusion = textureSample(occlusionMap, matSampler, uv).r;

    var s: Surface;
    s.albedo    = texAlbedo4.rgb * mat.albedo.rgb;
    s.alpha     = alpha;
    s.normal    = shadingNormal;
    s.roughness = clamp(mr.g * mat.roughness, 0.0, 1.0);
    s.metallic  = clamp(mr.b * mat.metallic,  0.0, 1.0);
    s.ao        = 1.0 + mat.occlusionStrength * (occlusion - 1.0);
    s.emissive  = textureSample(emissiveMap, matSampler, uv).rgb * mat.emissive.rgb;
    return s;
}
`;
}

function buildGBufferShader(f: GBufferFeatures): string {
    return /* wgsl */ `
${buildSurfaceWgsl(f)}

struct GBufferOutput {
    @location(0) albedo:   vec4<f32>,
    @location(1) normal:   vec4<f32>,
    @location(2) worldPos: vec4<f32>,
    @location(3) emissive: vec4<f32>,
};

@fragment
fn fs_main(input: VertexOutput, @builtin(front_facing) frontFacing: bool) -> GBufferOutput {
    let s = surface(input, frontFacing);
    var out: GBufferOutput;
    out.albedo   = vec4<f32>(s.albedo, s.ao);
    out.normal   = vec4<f32>(s.normal, s.roughness);
    out.worldPos = vec4<f32>(input.worldPos, s.metallic);
    out.emissive = vec4<f32>(s.emissive, model.flags.x);
    return out;
}
`;
}

/**
 * See-through ("blend") meshes, drawn after lighting onto the lit color: the same surface() and shade() as the
 * deferred path, premultiplied by alpha. Lighting, environment and shadow maps are group 3.
 */
function buildForwardShader(f: GBufferFeatures, encode: boolean): string {
    return /* wgsl */ `
${buildSurfaceWgsl(f)}
${COLOR_WGSL}
${LIGHT_STRUCTS_WGSL}

@group(3) @binding(0) var<uniform> lighting: LightingUniforms;
@group(3) @binding(1) var environmentMap:    texture_2d<f32>;
@group(3) @binding(2) var envSampler:        sampler;
@group(3) @binding(3) var dirShadowMaps:     texture_depth_2d_array;
@group(3) @binding(4) var spotShadowMaps:    texture_depth_2d_array;
@group(3) @binding(5) var shadowSampler:     sampler_comparison;
@group(3) @binding(6) var pointShadowMaps:   texture_depth_2d_array;
@group(3) @binding(7) var<uniform> pointShadowMatrices: PointShadowMatrices;

${SHADE_WGSL}

@fragment
fn fs_main(input: VertexOutput, @builtin(front_facing) frontFacing: bool) -> @location(0) vec4<f32> {
    let s = surface(input, frontFacing);
    let lit = shade(s.albedo, s.ao, s.normal, s.roughness, s.metallic, input.worldPos, model.flags.x) + s.emissive;
    let c = ${encode ? "linearToSrgb(lit)" : "lit"};
    return vec4<f32>(c * s.alpha, s.alpha); // premultiplied: blend one, one-minus-src-alpha
}
`;
}

// ─── Max lights ──────────────────────────────────────────────────────────────

/** The unit -Z axis of a world matrix: where an entity (a directional or spot light) faces. */
function worldForward(m: mat4, out: vec3): vec3 {
    return vec3.normalize(out, vec3.set(out, -m[8]!, -m[9]!, -m[10]!));
}
const tmpDir = vec3.create();

const MAX_DIRECTIONAL = 4;
const MAX_POINT = 8;
const MAX_SPOT = 4;

// ─── Shadow settings ─────────────────────────────────────────────────────────

const SHADOW_MAP_SIZE = 1024;
const POINT_SHADOW_MAP_SIZE = 512;
/** Depth bias in the shadow map's 0-1 depth (back faces are stored, so it only has to cover precision). */
const SHADOW_BIAS = 0.0005;
/** Normal offset, in shadow texels at a grazing light (see shadowLookup). */
const SHADOW_NORMAL_OFFSET = "1.5";
/** Directional shadows cover ±DIRECTIONAL_SHADOW_EXTENT world units. */
const DIRECTIONAL_SHADOW_EXTENT = 12;
/** World size of one directional shadow texel, as a WGSL literal. */
const DIRECTIONAL_SHADOW_TEXEL = ((2 * DIRECTIONAL_SHADOW_EXTENT) / SHADOW_MAP_SIZE).toFixed(6);

const POINT_SHADOW_MATRICES_SIZE = MAX_POINT * 6 * 64;

const CUBE_FACE_DIRS: {dir: [number, number, number]; up: [number, number, number]}[] = [
    {dir: [1, 0, 0], up: [0, -1, 0]},
    {dir: [-1, 0, 0], up: [0, -1, 0]},
    {dir: [0, 1, 0], up: [0, 0, 1]},
    {dir: [0, -1, 0], up: [0, 0, -1]},
    {dir: [0, 0, 1], up: [0, -1, 0]},
    {dir: [0, 0, -1], up: [0, -1, 0]},
];

// ─── Lighting uniform layout ─────────────────────────────────────────────────
//
// ambientColor:       vec4<f32>                    offset    0   16 bytes
// cameraPosition:     vec4<f32>                    offset   16   16 bytes
// counts:             vec4<u32> (dir,pt,spot,pad)  offset   32   16 bytes
// directionalLights:  array<DirLight, 4>           offset   48  384 bytes  (4 × 96)
// pointLights:        array<PointLight, 8>          offset  432  384 bytes  (8 × 48)
// spotLights:         array<SpotLight, 4>           offset  816  512 bytes  (4 × 128)
// backgroundColor:    vec4<f32>                    offset 1328   16 bytes
// environmentColor:   vec4<f32>                    offset 1344   16 bytes
// invViewProjection:  mat4x4<f32>                  offset 1360   64 bytes
// Total: 1424 bytes

const LIGHTING_BUFFER_SIZE = 1424;

const LIGHT_STRUCTS_WGSL = /* wgsl */ `
struct DirectionalLight {
    direction:        vec4<f32>,      // xyz = direction, w = castShadow (0/1)
    colorIntensity:   vec4<f32>,      // xyz = color, w = intensity
    lightSpaceMatrix: mat4x4<f32>,
};

struct PointLight {
    position:       vec4<f32>,        // xyz = world pos, w = range
    colorIntensity: vec4<f32>,        // xyz = color, w = intensity
    flags:          vec4<f32>,        // x = castShadow (0/1)
};

struct SpotLight {
    position:         vec4<f32>,      // xyz = world pos, w = range
    direction:        vec4<f32>,      // xyz = direction, w = castShadow (0/1)
    colorIntensity:   vec4<f32>,      // xyz = color, w = intensity
    angles:           vec4<f32>,      // x = cos(innerAngle), y = cos(outerAngle)
    lightSpaceMatrix: mat4x4<f32>,
};

struct LightingUniforms {
    ambientColor:       vec4<f32>,
    cameraPosition:     vec4<f32>,
    counts:             vec4<u32>,
    directionalLights:  array<DirectionalLight, ${MAX_DIRECTIONAL}>,
    pointLights:        array<PointLight, ${MAX_POINT}>,
    spotLights:         array<SpotLight, ${MAX_SPOT}>,
    backgroundColor:    vec4<f32>,
    environmentColor:   vec4<f32>,
    invViewProjection:  mat4x4<f32>,
};

struct PointShadowMatrices {
    matrices: array<mat4x4<f32>, ${MAX_POINT * 6}>,
};
`;

/**
 * shade(): PBR lighting of one surface point by every light (with shadows), ambient and environment. Expects
 * lighting, environmentMap, envSampler and the shadow maps declared by the including shader.
 */
const SHADE_WGSL = /* wgsl */ `
const PI: f32 = 3.14159265358979;

fn D_GGX(NdotH: f32, roughness: f32) -> f32 {
    let a  = roughness * roughness;
    let a2 = a * a;
    let d  = NdotH * NdotH * (a2 - 1.0) + 1.0;
    return a2 / (PI * d * d);
}

fn G_Smith(NdotV: f32, NdotL: f32, roughness: f32) -> f32 {
    let r  = roughness + 1.0;
    let k  = (r * r) / 8.0;
    let gv = NdotV / (NdotV * (1.0 - k) + k);
    let gl = NdotL / (NdotL * (1.0 - k) + k);
    return gv * gl;
}

fn F_Schlick(cosTheta: f32, F0: vec3<f32>) -> vec3<f32> {
    return F0 + (vec3<f32>(1.0) - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

fn F_SchlickRoughness(cosTheta: f32, F0: vec3<f32>, roughness: f32) -> vec3<f32> {
    return F0 + (max(vec3<f32>(1.0 - roughness), F0) - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

const INV_TWO_PI: f32 = 0.15915494;
const INV_PI:     f32 = 0.31830988;

fn sampleEquirect(dir: vec3<f32>) -> vec2<f32> {
    let phi   = atan2(dir.z, dir.x);
    let theta = asin(clamp(dir.y, -1.0, 1.0));
    return vec2<f32>(phi * INV_TWO_PI + 0.5, 0.5 - theta * INV_PI);
}

fn sampleEnvMap(dir: vec3<f32>) -> vec3<f32> {
    return textureSampleLevel(environmentMap, envSampler, sampleEquirect(dir), 0.0).rgb;
}

fn brdf_direct(N: vec3<f32>, V: vec3<f32>, L: vec3<f32>, albedo: vec3<f32>, roughness: f32, metallic: f32, F0: vec3<f32>, NdotV: f32) -> vec3<f32> {
    let H     = normalize(V + L);
    let NdotL = max(dot(N, L), 0.0);
    let NdotH = max(dot(N, H), 0.0);
    let HdotV = max(dot(H, V), 0.0);
    let D = D_GGX(NdotH, roughness);
    let G = G_Smith(NdotV, NdotL, roughness);
    let F = F_Schlick(HdotV, F0);
    let specular = (D * G * F) / max(4.0 * NdotV * NdotL, 0.001);
    let diffuse  = (1.0 - metallic) * albedo / PI;
    return (diffuse + specular) * NdotL;
}

// PCF shadow sample — returns 1.0 if lit, 0.0 if fully in shadow. Four bilinear comparisons at ±½ texel: a 3×3
// texel tent, which also averages a 2×2 pattern exactly (the ordered threshold of see-through casters).
fn pcfShadow(shadowMap: texture_depth_2d_array, layer: i32, lsMatrix: mat4x4<f32>, worldPos: vec3<f32>) -> f32 {
    let lsPos = lsMatrix * vec4<f32>(worldPos, 1.0);
    let ndc   = lsPos.xyz / lsPos.w;
    if (ndc.z <= 0.0 || ndc.z > 1.0) { return 1.0; }
    let uv = ndc.xy * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5);
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { return 1.0; }
    let depth = ndc.z - ${SHADOW_BIAS};
    let sz    = 1.0 / f32(${SHADOW_MAP_SIZE});
    let h     = 0.5 * sz;
    let lit   = textureSampleCompareLevel(shadowMap, shadowSampler, uv + vec2<f32>(-h, -h), layer, depth)
              + textureSampleCompareLevel(shadowMap, shadowSampler, uv + vec2<f32>( h, -h), layer, depth)
              + textureSampleCompareLevel(shadowMap, shadowSampler, uv + vec2<f32>(-h,  h), layer, depth)
              + textureSampleCompareLevel(shadowMap, shadowSampler, uv + vec2<f32>( h,  h), layer, depth);
    return lit * 0.25;
}

// Normal offset: where to look a point up in a shadow map. Nudged off the surface along its normal by about a
// shadow texel (texel: its world size there), more as the light grazes: a face turning edge-on to the light
// otherwise shadows itself in stair-stepped bands that don't follow its edges.
fn shadowLookup(worldPos: vec3<f32>, N: vec3<f32>, L: vec3<f32>, texel: f32) -> vec3<f32> {
    let sinTheta = sqrt(1.0 - clamp(dot(N, L), 0.0, 1.0) * clamp(dot(N, L), 0.0, 1.0));
    return worldPos + N * (texel * ${SHADOW_NORMAL_OFFSET} * sinTheta);
}

fn shade(albedo: vec3<f32>, ao: f32, N: vec3<f32>, roughnessIn: f32, metallic: f32, worldPos: vec3<f32>, receiveShadow: f32) -> vec3<f32> {
    let roughness = clamp(roughnessIn, 0.05, 1.0);
    let V     = normalize(lighting.cameraPosition.xyz - worldPos);
    let NdotV = max(dot(N, V), 0.001);
    let F0    = mix(vec3<f32>(0.04), albedo, metallic);

    let F_ibl = F_SchlickRoughness(NdotV, F0, roughness);
    let kD    = (1.0 - F_ibl) * (1.0 - metallic);
    let R     = reflect(-V, N);
    let indirect_diffuse  = lighting.ambientColor.rgb    * albedo * ao * kD;
    let indirect_specular = sampleEnvMap(R) * lighting.environmentColor.rgb * F_ibl * ao;
    var colour = indirect_diffuse + indirect_specular;

    for (var i = 0u; i < lighting.counts.x; i++) {
        let dl = lighting.directionalLights[i];
        let L  = normalize(-dl.direction.xyz);
        var shadow = 1.0;
        if (dl.direction.w > 0.5) {
            let at  = shadowLookup(worldPos, N, L, ${DIRECTIONAL_SHADOW_TEXEL});
            let raw = pcfShadow(dirShadowMaps, i32(i), dl.lightSpaceMatrix, at);
            shadow = mix(1.0, raw, receiveShadow);
        }
        colour += brdf_direct(N, V, L, albedo, roughness, metallic, F0, NdotV)
                  * dl.colorIntensity.rgb * dl.colorIntensity.w * shadow;
    }

    for (var i = 0u; i < lighting.counts.y; i++) {
        let pl      = lighting.pointLights[i];
        let toLight = pl.position.xyz - worldPos;
        let dist    = length(toLight);
        let L       = toLight / dist;
        let attn    = clamp(1.0 - dist / pl.position.w, 0.0, 1.0);
        var shadow  = 1.0;
        if (pl.flags.x > 0.5) {
            let lf    = worldPos - pl.position.xyz;
            let absLF = abs(lf);
            var faceIdx: i32;
            if (absLF.x >= absLF.y && absLF.x >= absLF.z) {
                faceIdx = select(1, 0, lf.x > 0.0);
            } else if (absLF.y >= absLF.z) {
                faceIdx = select(3, 2, lf.y > 0.0);
            } else {
                faceIdx = select(5, 4, lf.z > 0.0);
            }
            let layer    = i32(i) * 6 + faceIdx;
            let lsMatrix = pointShadowMatrices.matrices[layer];
            // a 90° face: a texel spans 2 · distance / size
            let at       = shadowLookup(worldPos, N, L, 2.0 * dist / f32(${POINT_SHADOW_MAP_SIZE}));
            let raw      = pcfShadow(pointShadowMaps, layer, lsMatrix, at);
            shadow       = mix(1.0, raw, receiveShadow);
        }
        colour += brdf_direct(N, V, L, albedo, roughness, metallic, F0, NdotV)
                  * pl.colorIntensity.rgb * (pl.colorIntensity.w * attn * attn * shadow);
    }

    for (var i = 0u; i < lighting.counts.z; i++) {
        let sl      = lighting.spotLights[i];
        let toLight = sl.position.xyz - worldPos;
        let dist    = length(toLight);
        let L       = toLight / dist;
        let attn     = clamp(1.0 - dist / sl.position.w, 0.0, 1.0);
        let theta    = dot(L, normalize(-sl.direction.xyz));
        let spotAttn = clamp(
            (theta - sl.angles.y) / (sl.angles.x - sl.angles.y),
            0.0, 1.0
        );
        var shadow = 1.0;
        if (sl.direction.w > 0.5) {
            // the cone spans 2 · tan(outer) · distance over the map
            let cosOuter = max(sl.angles.y, 0.01);
            let texel    = 2.0 * dist * sqrt(1.0 - cosOuter * cosOuter) / cosOuter / f32(${SHADOW_MAP_SIZE});
            let raw = pcfShadow(spotShadowMaps, i32(i), sl.lightSpaceMatrix, shadowLookup(worldPos, N, L, texel));
            shadow = mix(1.0, raw, receiveShadow);
        }
        colour += brdf_direct(N, V, L, albedo, roughness, metallic, F0, NdotV)
                  * sl.colorIntensity.rgb * (sl.colorIntensity.w * attn * attn * spotAttn * shadow);
    }
    return colour;
}
`;

function buildLightingShader(encode: boolean): string {
    return /* wgsl */ `
${COLOR_WGSL}
${LIGHT_STRUCTS_WGSL}

// lit in linear light; encoded here only when this pass writes straight to the screen
fn outputColor(c: vec3<f32>) -> vec4<f32> {
    return vec4<f32>(${encode ? "linearToSrgb(c)" : "c"}, 1.0);
}

@group(0) @binding(0) var albedoTex:         texture_2d<f32>;
@group(0) @binding(1) var normalTex:         texture_2d<f32>;
@group(0) @binding(2) var posTex:            texture_2d<f32>;
@group(0) @binding(3) var<uniform> lighting: LightingUniforms;
@group(0) @binding(4) var emissiveTex:       texture_2d<f32>;
@group(0) @binding(5) var environmentMap:    texture_2d<f32>;
@group(0) @binding(6) var envSampler:        sampler;
@group(0) @binding(7) var backgroundMap:     texture_2d<f32>;

@group(1) @binding(0) var dirShadowMaps:   texture_depth_2d_array;
@group(1) @binding(1) var spotShadowMaps:  texture_depth_2d_array;
@group(1) @binding(2) var shadowSampler:   sampler_comparison;
@group(1) @binding(3) var pointShadowMaps: texture_depth_2d_array;
@group(1) @binding(4) var<uniform> pointShadowMatrices: PointShadowMatrices;

struct QuadInput {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> QuadInput {
    // Fullscreen triangle from vertex_index (arithmetic — NOT array indexing).
    // Indexing a var array by vertex_index miscompiles to zero on some mobile GPU
    // drivers (Adreno/Mali), collapsing the triangle to nothing → black output.
    let t = vec2<f32>(f32((vi << 1u) & 2u), f32(vi & 2u));
    var out: QuadInput;
    out.pos = vec4<f32>(t * 2.0 - 1.0, 0.0, 1.0);
    out.uv  = vec2<f32>(t.x, 1.0 - t.y);
    return out;
}

${SHADE_WGSL}

fn sampleBgMap(dir: vec3<f32>) -> vec3<f32> {
    return textureSampleLevel(backgroundMap, envSampler, sampleEquirect(dir), 0.0).rgb;
}

@fragment
fn fs_main(input: QuadInput) -> @location(0) vec4<f32> {
    let coord   = vec2<i32>(i32(input.pos.x), i32(input.pos.y));
    let albedo4 = textureLoad(albedoTex, coord, 0);
    if (albedo4.a < 0.01) {
        let dims = vec2<f32>(textureDimensions(albedoTex));
        let ndc  = vec2<f32>(
            input.pos.x / dims.x * 2.0 - 1.0,
            1.0 - input.pos.y / dims.y * 2.0,
        );
        let wp4 = lighting.invViewProjection * vec4<f32>(ndc, 1.0, 1.0);
        let ray = normalize(wp4.xyz / wp4.w - lighting.cameraPosition.xyz);
        return outputColor(sampleBgMap(ray) * lighting.backgroundColor.rgb);
    }
    let normalSample   = textureLoad(normalTex, coord, 0);
    let posSample      = textureLoad(posTex, coord, 0);
    let emissiveSample = textureLoad(emissiveTex, coord, 0);
    let colour = shade(
        albedo4.rgb,
        albedo4.a,
        normalize(normalSample.xyz),
        normalSample.w,
        clamp(posSample.w, 0.0, 1.0),
        posSample.xyz,
        emissiveSample.w,
    );
    return outputColor(colour + emissiveSample.rgb);
}
`;
}

// ─── GPU resource cache per Mesh ──────────────────────────────────────────────

interface MeshGPUResources {
    vertexBuffer: GPUBuffer;
    indexBuffer: GPUBuffer;
    modelBuffer: GPUBuffer;
    modelBindGroup: GPUBindGroup;
    indexCount: number;
}

// ─── DeferredScenePass ───────────────────────────────────────────────────────

export interface DeferredScenePassOptions {
    scene: Scene;
    /**
     * Format for the 'color' output slot. Defaults to 'rgba16float' for HDR pipelines.
     * Set to renderer.format when rendering directly to canvas via canvasSlot: 'color'.
     */
    colorFormat?: GPUTextureFormat;
    /**
     * What the 'color' output holds. `"linear-srgb"` (default): linear light, for a BlitPass (or your own pass) to
     * tone map and encode. `"srgb"`: encoded for the screen, when this pass renders straight to the canvas.
     */
    colorSpace?: ColorSpace;
}

/**
 * Full deferred PBR renderer.
 *
 * Output slots:
 *   color    — final lit scene (colorFormat, default rgba16float)
 *   albedo   — rgba8unorm-srgb, rgb=albedo (linear when sampled), a=ambient occlusion
 *   normal   — rgba16float, rgb=world normal, a=roughness
 *   worldPos — rgba16float, rgb=world position, a=metallic
 *   emissive — rgba16float, rgb=emissive, a=receiveShadow
 *   depth    — depth24plus
 */
/** The G-buffer and lit outputs a DeferredScenePass exposes to the graph. */
export type DeferredSceneOutput = "color" | "albedo" | "normal" | "worldPos" | "emissive" | "depth";

export class DeferredScenePass extends Pass<DeferredSceneOutput> {
    readonly inputSlots: PassInputSlot[] = [];
    readonly outputSlots: PassOutputSlot<DeferredSceneOutput>[];

    private readonly scene: Scene;
    private readonly colorFormat: GPUTextureFormat;
    private readonly outputColorSpace: ColorSpace;

    private device!: GPUDevice;

    // G-buffer pipeline cache (one compiled variant per GBufferFeatures combination)
    private gbufferPipelineLayout!: GPUPipelineLayout;
    private gbufferPipelineCache = new Map<string, GPURenderPipeline>();
    private lightingPipeline!: GPURenderPipeline;

    private cameraBindGroupLayout!: GPUBindGroupLayout;
    private modelBindGroupLayout!: GPUBindGroupLayout;
    private materialBindGroupLayout!: GPUBindGroupLayout;
    private lightingBindGroupLayout!: GPUBindGroupLayout;
    private shadowSceneBindGroupLayout!: GPUBindGroupLayout;

    // Camera uniforms
    private cameraBuffer!: GPUBuffer;
    private cameraBindGroup!: GPUBindGroup;

    // Lighting uniforms
    private lightingBuffer!: GPUBuffer;
    private readonly currentInvVP = mat4.create();

    // Default material texture resources
    private defaultWhiteTex!: GPUTexture;
    private defaultWhiteView!: GPUTextureView;
    private defaultNormalTex!: GPUTexture;
    private defaultNormalView!: GPUTextureView;
    private texSampler!: GPUSampler;

    // Shadow pass: opaque casters write depth only; alpha casters (mask / blend) get a variant reading albedo alpha
    private shadowPipeline!: GPURenderPipeline;
    private readonly shadowPipelines = new Map<string, GPURenderPipeline>();
    private shadowLightBindGroupLayout!: GPUBindGroupLayout;
    private dirShadowTex!: GPUTexture;
    private spotShadowTex!: GPUTexture;
    private pointShadowTex!: GPUTexture;
    private shadowSampler!: GPUSampler;
    private dirShadowLightBuffers: GPUBuffer[] = [];
    private dirShadowLightBGs: GPUBindGroup[] = [];
    private spotShadowLightBuffers: GPUBuffer[] = [];
    private spotShadowLightBGs: GPUBindGroup[] = [];
    private pointShadowFaceBuffers: GPUBuffer[] = [];
    private pointShadowFaceBGs: GPUBindGroup[] = [];
    private pointShadowMatricesBuffer!: GPUBuffer;
    private shadowBindGroup: GPUBindGroup | null = null;

    // Transparent ("blend") pass: forward-shaded, sorted back to front
    private forwardPipelineCache = new Map<string, GPURenderPipeline>();
    private forwardPipelineLayout!: GPUPipelineLayout;
    private forwardLightingLayout!: GPUBindGroupLayout;
    private forwardLightingBindGroup: GPUBindGroup | null = null;
    private forwardEnvView: GPUTextureView | null = null;

    // Per-frame scratch, reused: no allocation per mesh per frame
    private readonly opaqueDraws: {mesh: Mesh; material: PBRMaterial; features: GBufferFeatures; key: string}[] = [];
    private readonly blendDraws: {mesh: Mesh; depth: number}[] = [];
    private readonly modelData = new Float32Array(36);
    private readonly normalMatrix = mat4.create();
    private readonly tmpCenter = vec3.create();

    // Cached mesh GPU resources
    private meshCache = new Map<Mesh, MeshGPUResources>();

    constructor({scene, colorFormat = "rgba16float", colorSpace = "linear-srgb"}: DeferredScenePassOptions) {
        super();
        this.scene = scene;
        this.colorFormat = colorFormat;
        this.outputColorSpace = colorSpace;
        this.outputSlots = [
            {name: "color", spec: {format: colorFormat}},
            {name: "albedo", spec: {format: "rgba8unorm-srgb"}}, // linear albedo, sRGB-encoded storage keeps darks
            {name: "normal", spec: {format: "rgba16float"}},
            {name: "worldPos", spec: {format: "rgba16float"}},
            {name: "emissive", spec: {format: "rgba16float"}},
            {name: "depth", spec: {format: "depth24plus"}},
        ];
    }

    initialize(device: GPUDevice, _canvasFormat: GPUTextureFormat): void {
        this.device = device;

        this.cameraBuffer = device.createBuffer({
            label: "DeferredScene:camera",
            size: 208,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        this.lightingBuffer = device.createBuffer({
            label: "DeferredScene:lighting",
            size: LIGHTING_BUFFER_SIZE,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        this.buildPipelines();
        this.buildShadowPipeline();
        this.initShadowMaps();
    }

    resize(_width: number, _height: number): void {
        // G-buffer textures are managed by the renderer; dimensions tracked via ctx.
    }

    render(ctx: PassRenderContext): void {
        const {encoder} = ctx;

        this.scene.updateWorldMatrices();

        const visible = this.scene.activeCamera?.visibleLayers ?? 0xffffffff;
        const meshes = this.scene.collectMeshes().filter((m) => (m.layers & visible) !== 0);
        const dirLights = this.scene.collectDirectionalLights().slice(0, MAX_DIRECTIONAL);
        const pointLights = this.scene.collectPointLights().slice(0, MAX_POINT);
        const spotLights = this.scene.collectSpotLights().slice(0, MAX_SPOT);

        const dirMatrices = dirLights.map((l) => (l.castShadow ? this.computeDirectionalLightMatrix(l) : null));
        const spotMatrices = spotLights.map((l) => (l.castShadow ? this.computeSpotLightMatrix(l) : null));
        const pointMatrices = pointLights.map((l) => (l.castShadow ? this.computePointLightFaceMatrices(l) : null));

        this.uploadCameraUniforms(this.scene.activeCamera, ctx.width, ctx.height);
        this.uploadLightingUniforms(dirLights, pointLights, spotLights, dirMatrices, spotMatrices);
        this.uploadPointShadowMatrices(pointLights, pointMatrices);

        this.ensureMeshResources(meshes);
        for (const mesh of meshes) {
            const res = this.meshCache.get(mesh);
            if (res) {
                this.uploadModelUniforms(mesh, res.modelBuffer);
            }
        }

        this.renderShadowMaps(
            encoder,
            meshes,
            dirLights,
            pointLights,
            spotLights,
            dirMatrices,
            pointMatrices,
            spotMatrices,
        );
        this.sortDraws(meshes);
        this.renderGBuffer(encoder, ctx);
        this.renderLighting(encoder, ctx);
        if (this.blendDraws.length > 0) {
            this.renderTransparent(encoder, ctx);
        }
    }

    /**
     * Opaque and masked meshes go to the G-buffer, grouped by pipeline so each variant is bound once. See-through
     * ("blend") meshes are drawn after lighting, farthest first, by the distance to their bounds' center.
     */
    private sortDraws(meshes: Mesh[]): void {
        const opaque = this.opaqueDraws;
        const blend = this.blendDraws;
        opaque.length = 0;
        blend.length = 0;
        const camera = this.scene.activeCamera;
        const eye = camera ? mat4.getTranslation(vec3.create(), camera.worldMatrix) : vec3.create();
        for (const mesh of meshes) {
            if (!(mesh.material instanceof PBRMaterial)) {
                continue;
            }
            if (mesh.material.alphaMode === "blend") {
                const bounds = mesh.geometry.boundingSphere;
                const center = vec3.transformMat4(this.tmpCenter, bounds.center as vec3, mesh.worldMatrix);
                blend.push({mesh, depth: vec3.squaredDistance(center, eye)});
            } else {
                const features = getGBufferFeatures(mesh.material);
                opaque.push({mesh, material: mesh.material, features, key: featureKey(features)});
            }
        }
        opaque.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        blend.sort((a, b) => b.depth - a.depth);
    }

    destroy(): void {
        this.gbufferPipelineCache.clear();
        this.forwardPipelineCache.clear();
        this.shadowPipelines.clear();
        this.forwardLightingBindGroup = null;
        this.forwardEnvView = null;
        this.defaultWhiteTex?.destroy();
        this.defaultNormalTex?.destroy();
        this.cameraBuffer?.destroy();
        this.lightingBuffer?.destroy();
        this.dirShadowTex?.destroy();
        this.spotShadowTex?.destroy();
        this.pointShadowTex?.destroy();
        this.pointShadowMatricesBuffer?.destroy();
        for (const b of this.dirShadowLightBuffers) {
            b.destroy();
        }
        for (const b of this.spotShadowLightBuffers) {
            b.destroy();
        }
        for (const b of this.pointShadowFaceBuffers) {
            b.destroy();
        }
        for (const r of this.meshCache.values()) {
            r.vertexBuffer.destroy();
            r.indexBuffer.destroy();
            r.modelBuffer.destroy();
        }
        this.meshCache.clear();
    }

    // ─── Private: pipeline setup ────────────────────────────────────────────

    private buildPipelines(): void {
        const {device} = this;

        this.cameraBindGroupLayout = device.createBindGroupLayout({
            label: "DeferredScene:cameraLayout",
            entries: [
                {binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {type: "uniform"}},
            ],
        });

        this.modelBindGroupLayout = device.createBindGroupLayout({
            label: "DeferredScene:modelLayout",
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                    buffer: {type: "uniform"},
                },
            ],
        });

        this.materialBindGroupLayout = device.createBindGroupLayout({
            label: "DeferredScene:materialLayout",
            entries: [
                {binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: {type: "uniform"}},
                {binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {sampleType: "float"}},
                {binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {type: "filtering"}},
                {binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: {sampleType: "float"}},
                {binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: {sampleType: "float"}},
                {binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: {sampleType: "float"}},
                {binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: {sampleType: "float"}},
                {binding: 7, visibility: GPUShaderStage.FRAGMENT, texture: {sampleType: "float"}},
            ],
        });

        // Default white 1×1 texture (shared for albedo, emissive, ORM defaults)
        const white = new Uint8Array([255, 255, 255, 255]);
        this.defaultWhiteTex = device.createTexture({
            label: "DeferredScene:defaultWhite",
            size: {width: 1, height: 1},
            format: "rgba8unorm",
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        device.queue.writeTexture({texture: this.defaultWhiteTex}, white, {bytesPerRow: 4}, {width: 1, height: 1});
        this.defaultWhiteView = this.defaultWhiteTex.createView();

        // Default flat normal 1×1 texture: (128,128,255) → (0,0,1) after decode
        const flatNormal = new Uint8Array([128, 128, 255, 255]);
        this.defaultNormalTex = device.createTexture({
            label: "DeferredScene:defaultNormal",
            size: {width: 1, height: 1},
            format: "rgba8unorm",
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        device.queue.writeTexture(
            {texture: this.defaultNormalTex},
            flatNormal,
            {bytesPerRow: 4},
            {width: 1, height: 1},
        );
        this.defaultNormalView = this.defaultNormalTex.createView();

        this.texSampler = device.createSampler({
            magFilter: "linear",
            minFilter: "linear",
            mipmapFilter: "linear",
            maxAnisotropy: 8,
            addressModeU: "repeat",
            addressModeV: "repeat",
        });

        this.gbufferPipelineLayout = device.createPipelineLayout({
            bindGroupLayouts: [this.cameraBindGroupLayout, this.modelBindGroupLayout, this.materialBindGroupLayout],
        });

        this.lightingBindGroupLayout = device.createBindGroupLayout({
            label: "DeferredScene:lightingLayout",
            entries: [
                {binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {sampleType: "float"}},
                {binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {sampleType: "unfilterable-float"}},
                {binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {sampleType: "unfilterable-float"}},
                {binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: {type: "uniform"}},
                {binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: {sampleType: "unfilterable-float"}},
                {binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: {sampleType: "float"}},
                {binding: 6, visibility: GPUShaderStage.FRAGMENT, sampler: {type: "filtering"}},
                {binding: 7, visibility: GPUShaderStage.FRAGMENT, texture: {sampleType: "float"}},
            ],
        });

        this.shadowSceneBindGroupLayout = device.createBindGroupLayout({
            label: "DeferredScene:shadowSceneLayout",
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture: {sampleType: "depth", viewDimension: "2d-array"},
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture: {sampleType: "depth", viewDimension: "2d-array"},
                },
                {binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {type: "comparison"}},
                {
                    binding: 3,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture: {sampleType: "depth", viewDimension: "2d-array"},
                },
                {binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: {type: "uniform"}},
            ],
        });

        const lightingLayout = device.createPipelineLayout({
            bindGroupLayouts: [this.lightingBindGroupLayout, this.shadowSceneBindGroupLayout],
        });

        const lightingModule = device.createShaderModule({
            label: "Lighting",
            code: buildLightingShader(this.outputColorSpace === "srgb"),
        });

        this.lightingPipeline = device.createRenderPipeline({
            label: "DeferredScene:lighting",
            layout: lightingLayout,
            vertex: {module: lightingModule, entryPoint: "vs_main"},
            fragment: {
                module: lightingModule,
                entryPoint: "fs_main",
                targets: [{format: this.colorFormat}],
            },
            primitive: {topology: "triangle-list"},
        });

        const depthArray = {sampleType: "depth", viewDimension: "2d-array"} as const;
        this.forwardLightingLayout = device.createBindGroupLayout({
            label: "DeferredScene:forwardLightingLayout",
            entries: [
                {binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: {type: "uniform"}},
                {binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {sampleType: "float"}},
                {binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {type: "filtering"}},
                {binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: depthArray},
                {binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: depthArray},
                {binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: {type: "comparison"}},
                {binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: depthArray},
                {binding: 7, visibility: GPUShaderStage.FRAGMENT, buffer: {type: "uniform"}},
            ],
        });
        this.forwardPipelineLayout = device.createPipelineLayout({
            bindGroupLayouts: [
                this.cameraBindGroupLayout,
                this.modelBindGroupLayout,
                this.materialBindGroupLayout,
                this.forwardLightingLayout,
            ],
        });

        this.cameraBindGroup = device.createBindGroup({
            label: "DeferredScene:camera",
            layout: this.cameraBindGroupLayout,
            entries: [{binding: 0, resource: {buffer: this.cameraBuffer}}],
        });
    }

    private buildShadowPipeline(): void {
        const {device} = this;

        this.shadowLightBindGroupLayout = device.createBindGroupLayout({
            label: "DeferredScene:shadowLightLayout",
            entries: [{binding: 0, visibility: GPUShaderStage.VERTEX, buffer: {type: "uniform"}}],
        });

        const shadowLayout = device.createPipelineLayout({
            bindGroupLayouts: [this.shadowLightBindGroupLayout, this.modelBindGroupLayout],
        });

        const shadowModule = device.createShaderModule({label: "Shadow", code: buildShadowShader()});

        this.shadowPipeline = device.createRenderPipeline({
            label: "DeferredScene:shadow",
            layout: shadowLayout,
            vertex: {
                module: shadowModule,
                entryPoint: "vs_shadow",
                buffers: [
                    {
                        arrayStride: 48,
                        attributes: [
                            {shaderLocation: 0, offset: 0, format: "float32x3"}, // position only
                        ],
                    },
                ],
            },
            // no hardware bias: it would push the edge-on back faces at a silhouette behind what they shadow
            depthStencil: {format: "depth32float", depthWriteEnabled: true, depthCompare: "less"},
            // back faces: a lit face is compared with the far side of its own mesh, never with itself (which
            // stair-steps across faces turning edge-on to the light); faces turned away get no direct light
            primitive: {topology: "triangle-list", cullMode: "front"},
        });
    }

    /** The shadow pipeline for a material: depth only when opaque, alpha-tested for mask / blend. */
    private shadowPipelineFor(material: PBRMaterial | null): GPURenderPipeline {
        const alpha = material?.alphaMode ?? "opaque";
        const doubleSided = material?.doubleSided ?? false;
        if (alpha === "opaque" && !doubleSided) {
            return this.shadowPipeline;
        }
        const key = alpha + (doubleSided ? "2" : "");
        let pipeline = this.shadowPipelines.get(key);
        if (pipeline === undefined) {
            // double-sided casters store the side facing the light, which needs a slope bias against self-shadowing;
            // single-sided ones store back faces, which must not be pushed back (see the base shadow pipeline)
            const depthStencil: GPUDepthStencilState = doubleSided
                ? {
                      format: "depth32float",
                      depthWriteEnabled: true,
                      depthCompare: "less",
                      depthBias: 2,
                      depthBiasSlopeScale: 1.5,
                  }
                : {format: "depth32float", depthWriteEnabled: true, depthCompare: "less"};
            const primitive: GPUPrimitiveState = {topology: "triangle-list", cullMode: doubleSided ? "none" : "front"};
            if (alpha === "opaque") {
                const module = this.device.createShaderModule({label: "Shadow", code: buildShadowShader()});
                pipeline = this.device.createRenderPipeline({
                    label: `DeferredScene:shadow[${key}]`,
                    layout: this.device.createPipelineLayout({
                        bindGroupLayouts: [this.shadowLightBindGroupLayout, this.modelBindGroupLayout],
                    }),
                    vertex: {
                        module,
                        entryPoint: "vs_shadow",
                        buffers: [{arrayStride: 48, attributes: [{shaderLocation: 0, offset: 0, format: "float32x3"}]}],
                    },
                    depthStencil,
                    primitive,
                });
            } else {
                const module = this.device.createShaderModule({
                    label: `Shadow[${alpha}]`,
                    code: buildAlphaShadowShader(alpha),
                });
                pipeline = this.device.createRenderPipeline({
                    label: `DeferredScene:shadow[${key}]`,
                    layout: this.device.createPipelineLayout({
                        bindGroupLayouts: [
                            this.shadowLightBindGroupLayout,
                            this.modelBindGroupLayout,
                            this.materialBindGroupLayout,
                        ],
                    }),
                    vertex: {
                        module,
                        entryPoint: "vs_shadow",
                        buffers: [
                            {
                                arrayStride: 48,
                                attributes: [
                                    {shaderLocation: 0, offset: 0, format: "float32x3"},
                                    {shaderLocation: 2, offset: 24, format: "float32x2"},
                                ],
                            },
                        ],
                    },
                    fragment: {module, entryPoint: "fs_shadow", targets: []},
                    depthStencil,
                    primitive,
                });
            }
            this.shadowPipelines.set(key, pipeline);
        }
        return pipeline;
    }

    private getOrCreateForwardPipeline(features: GBufferFeatures, cullMode: GPUCullMode): GPURenderPipeline {
        const key = `${featureKey(features)}:${cullMode}`;
        let pipeline = this.forwardPipelineCache.get(key);
        if (!pipeline) {
            const module = this.device.createShaderModule({
                label: `Forward[${key}]`,
                code: buildForwardShader(features, this.outputColorSpace === "srgb"),
            });
            pipeline = this.device.createRenderPipeline({
                label: `DeferredScene:forward[${key}]`,
                layout: this.forwardPipelineLayout,
                vertex: {
                    module,
                    entryPoint: "vs_main",
                    buffers: [
                        {
                            arrayStride: 48,
                            attributes: [
                                {shaderLocation: 0, offset: 0, format: "float32x3"},
                                {shaderLocation: 1, offset: 12, format: "float32x3"},
                                {shaderLocation: 2, offset: 24, format: "float32x2"},
                                {shaderLocation: 3, offset: 32, format: "float32x4"},
                            ],
                        },
                    ],
                },
                fragment: {
                    module,
                    entryPoint: "fs_main",
                    targets: [
                        {
                            format: this.colorFormat,
                            blend: {
                                color: {srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add"},
                                alpha: {srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add"},
                            },
                        },
                    ],
                },
                primitive: {topology: "triangle-list", cullMode},
                // tested against the opaque scene, but not written: see-through surfaces don't hide each other
                depthStencil: {format: "depth24plus", depthWriteEnabled: false, depthCompare: "less"},
            });
            this.forwardPipelineCache.set(key, pipeline);
        }
        return pipeline;
    }

    private getOrCreateGBufferPipeline(features: GBufferFeatures): GPURenderPipeline {
        const key = featureKey(features);
        let pipeline = this.gbufferPipelineCache.get(key);
        if (!pipeline) {
            const module = this.device.createShaderModule({
                label: `GBuffer[${key || "flat"}]`,
                code: buildGBufferShader(features),
            });
            pipeline = this.device.createRenderPipeline({
                label: `DeferredScene:gbuffer[${key || "flat"}]`,
                layout: this.gbufferPipelineLayout,
                vertex: {
                    module,
                    entryPoint: "vs_main",
                    buffers: [
                        {
                            arrayStride: 48,
                            attributes: [
                                {shaderLocation: 0, offset: 0, format: "float32x3"},
                                {shaderLocation: 1, offset: 12, format: "float32x3"},
                                {shaderLocation: 2, offset: 24, format: "float32x2"},
                                {shaderLocation: 3, offset: 32, format: "float32x4"},
                            ],
                        },
                    ],
                },
                fragment: {
                    module,
                    entryPoint: "fs_main",
                    targets: [
                        {format: "rgba8unorm-srgb"},
                        {format: "rgba16float"},
                        {format: "rgba16float"},
                        {format: "rgba16float"},
                    ],
                },
                primitive: {topology: "triangle-list", cullMode: features.doubleSided ? "none" : "back"},
                depthStencil: {
                    format: "depth24plus",
                    depthWriteEnabled: true,
                    depthCompare: "less",
                },
            });
            this.gbufferPipelineCache.set(key, pipeline);
        }
        return pipeline;
    }

    precompile(featureSets?: GBufferFeatures[]): void {
        const sets = featureSets ?? [
            {parallaxMapping: false, normalMapping: false},
            {parallaxMapping: false, normalMapping: true},
            {parallaxMapping: true, normalMapping: false},
            {parallaxMapping: true, normalMapping: true},
        ];
        for (const f of sets) {
            this.getOrCreateGBufferPipeline(f);
        }
    }

    private initShadowMaps(): void {
        const {device} = this;

        const makeDepthArray = (layers: number, size: number, label: string) =>
            device.createTexture({
                label,
                size: {width: size, height: size, depthOrArrayLayers: layers},
                format: "depth32float",
                usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
            });

        this.dirShadowTex = makeDepthArray(MAX_DIRECTIONAL, SHADOW_MAP_SIZE, "Shadow:directional");
        this.spotShadowTex = makeDepthArray(MAX_SPOT, SHADOW_MAP_SIZE, "Shadow:spot");
        this.pointShadowTex = makeDepthArray(MAX_POINT * 6, POINT_SHADOW_MAP_SIZE, "Shadow:point");

        this.shadowSampler = device.createSampler({
            label: "DeferredScene:shadowSampler",
            compare: "less",
            magFilter: "linear",
            minFilter: "linear",
            addressModeU: "clamp-to-edge",
            addressModeV: "clamp-to-edge",
        });

        for (let i = 0; i < MAX_DIRECTIONAL; i++) {
            const buf = device.createBuffer({
                label: `Shadow:dirLight${i}`,
                size: 64,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            });
            this.dirShadowLightBuffers.push(buf);
            this.dirShadowLightBGs.push(
                device.createBindGroup({
                    label: `Shadow:dirLightBG${i}`,
                    layout: this.shadowLightBindGroupLayout,
                    entries: [{binding: 0, resource: {buffer: buf}}],
                }),
            );
        }

        for (let i = 0; i < MAX_SPOT; i++) {
            const buf = device.createBuffer({
                label: `Shadow:spotLight${i}`,
                size: 64,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            });
            this.spotShadowLightBuffers.push(buf);
            this.spotShadowLightBGs.push(
                device.createBindGroup({
                    label: `Shadow:spotLightBG${i}`,
                    layout: this.shadowLightBindGroupLayout,
                    entries: [{binding: 0, resource: {buffer: buf}}],
                }),
            );
        }

        for (let i = 0; i < MAX_POINT * 6; i++) {
            const buf = device.createBuffer({
                label: `Shadow:pointFace${i}`,
                size: 64,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            });
            this.pointShadowFaceBuffers.push(buf);
            this.pointShadowFaceBGs.push(
                device.createBindGroup({
                    label: `Shadow:pointFaceBG${i}`,
                    layout: this.shadowLightBindGroupLayout,
                    entries: [{binding: 0, resource: {buffer: buf}}],
                }),
            );
        }

        this.pointShadowMatricesBuffer = device.createBuffer({
            label: "Shadow:pointMatrices",
            size: POINT_SHADOW_MATRICES_SIZE,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        this.shadowBindGroup = device.createBindGroup({
            label: "DeferredScene:shadowBindGroup",
            layout: this.shadowSceneBindGroupLayout,
            entries: [
                {binding: 0, resource: this.dirShadowTex.createView({dimension: "2d-array"})},
                {binding: 1, resource: this.spotShadowTex.createView({dimension: "2d-array"})},
                {binding: 2, resource: this.shadowSampler},
                {binding: 3, resource: this.pointShadowTex.createView({dimension: "2d-array"})},
                {binding: 4, resource: {buffer: this.pointShadowMatricesBuffer}},
            ],
        });
    }

    // ─── Private: render steps ───────────────────────────────────────────────

    private renderShadowMaps(
        encoder: GPUCommandEncoder,
        meshes: Mesh[],
        dirLights: DirectionalLight[],
        pointLights: PointLight[],
        spotLights: SpotLight[],
        dirMatrices: (mat4 | null)[],
        pointMatrices: (mat4[] | null)[],
        spotMatrices: (mat4 | null)[],
    ): void {
        // Casters with their pipeline, opaque (the common, cheap case) first, then grouped by variant.
        const casters: {
            res: MeshGPUResources;
            pipeline: GPURenderPipeline;
            material: GPUBindGroup | null;
            rank: number;
        }[] = [];
        const ranks = new Map<GPURenderPipeline, number>([[this.shadowPipeline, 0]]);
        for (const mesh of meshes) {
            const res = this.meshCache.get(mesh);
            if (!mesh.castShadow || !res) {
                continue;
            }
            const material = mesh.material instanceof PBRMaterial ? mesh.material : null;
            const pipeline = this.shadowPipelineFor(material);
            let rank = ranks.get(pipeline);
            if (rank === undefined) {
                rank = ranks.size;
                ranks.set(pipeline, rank);
            }
            casters.push({
                res,
                pipeline,
                rank,
                material:
                    material !== null && material.alphaMode !== "opaque"
                        ? material.getOrCreateBindGroup(
                              this.device,
                              this.materialBindGroupLayout,
                              this.defaultWhiteView,
                              this.defaultNormalView,
                              this.texSampler,
                          )
                        : null,
            });
        }
        casters.sort((a, b) => a.rank - b.rank);

        const drawShadowMeshes = (pass: GPURenderPassEncoder, lightBindGroup: GPUBindGroup) => {
            let bound: GPURenderPipeline | null = null;
            for (const {res, pipeline, material} of casters) {
                if (pipeline !== bound) {
                    pass.setPipeline(pipeline);
                    pass.setBindGroup(0, lightBindGroup);
                    bound = pipeline;
                }
                pass.setBindGroup(1, res.modelBindGroup);
                if (material !== null) {
                    pass.setBindGroup(2, material);
                }
                pass.setVertexBuffer(0, res.vertexBuffer);
                pass.setIndexBuffer(res.indexBuffer, "uint32");
                pass.drawIndexed(res.indexCount);
            }
        };

        for (let i = 0; i < dirLights.length; i++) {
            const lsMatrix = dirMatrices[i];
            if (!lsMatrix) {
                continue;
            }
            this.device.queue.writeBuffer(this.dirShadowLightBuffers[i]!, 0, lsMatrix as Float32Array);
            const pass = encoder.beginRenderPass({
                label: `Shadow:dir${i}`,
                colorAttachments: [],
                depthStencilAttachment: {
                    view: this.dirShadowTex.createView({dimension: "2d", baseArrayLayer: i, arrayLayerCount: 1}),
                    depthClearValue: 1.0,
                    depthLoadOp: "clear",
                    depthStoreOp: "store",
                },
            });
            drawShadowMeshes(pass, this.dirShadowLightBGs[i]!);
            pass.end();
        }

        for (let i = 0; i < pointLights.length; i++) {
            const faceMatrices = pointMatrices[i];
            if (!faceMatrices) {
                continue;
            }
            for (let f = 0; f < 6; f++) {
                const slot = i * 6 + f;
                this.device.queue.writeBuffer(this.pointShadowFaceBuffers[slot]!, 0, faceMatrices[f] as Float32Array);
                const pass = encoder.beginRenderPass({
                    label: `Shadow:point${i}f${f}`,
                    colorAttachments: [],
                    depthStencilAttachment: {
                        view: this.pointShadowTex.createView({
                            dimension: "2d",
                            baseArrayLayer: slot,
                            arrayLayerCount: 1,
                        }),
                        depthClearValue: 1.0,
                        depthLoadOp: "clear",
                        depthStoreOp: "store",
                    },
                });
                drawShadowMeshes(pass, this.pointShadowFaceBGs[slot]!);
                pass.end();
            }
        }

        for (let i = 0; i < spotLights.length; i++) {
            const lsMatrix = spotMatrices[i];
            if (!lsMatrix) {
                continue;
            }
            this.device.queue.writeBuffer(this.spotShadowLightBuffers[i]!, 0, lsMatrix as Float32Array);
            const pass = encoder.beginRenderPass({
                label: `Shadow:spot${i}`,
                colorAttachments: [],
                depthStencilAttachment: {
                    view: this.spotShadowTex.createView({dimension: "2d", baseArrayLayer: i, arrayLayerCount: 1}),
                    depthClearValue: 1.0,
                    depthLoadOp: "clear",
                    depthStoreOp: "store",
                },
            });
            drawShadowMeshes(pass, this.spotShadowLightBGs[i]!);
            pass.end();
        }
    }

    private renderGBuffer(encoder: GPUCommandEncoder, ctx: PassRenderContext): void {
        const {outputs} = ctx;
        const pass = encoder.beginRenderPass({
            label: "GBuffer",
            colorAttachments: [
                {view: outputs["albedo"]!, clearValue: [0, 0, 0, 0], loadOp: "clear", storeOp: "store"},
                {view: outputs["normal"]!, clearValue: [0, 0, 0, 0], loadOp: "clear", storeOp: "store"},
                {view: outputs["worldPos"]!, clearValue: [0, 0, 0, 0], loadOp: "clear", storeOp: "store"},
                {view: outputs["emissive"]!, clearValue: [0, 0, 0, 0], loadOp: "clear", storeOp: "store"},
            ],
            depthStencilAttachment: {
                view: outputs["depth"]!,
                depthClearValue: 1.0,
                depthLoadOp: "clear",
                depthStoreOp: "store",
            },
        });

        pass.setBindGroup(0, this.cameraBindGroup);

        let activePipelineKey: string | null = null;
        for (const {mesh, material, features, key} of this.opaqueDraws) {
            const res = this.meshCache.get(mesh);
            if (!res) {
                continue;
            }
            if (key !== activePipelineKey) {
                pass.setPipeline(this.getOrCreateGBufferPipeline(features));
                activePipelineKey = key;
            }

            const matBg = material.getOrCreateBindGroup(
                this.device,
                this.materialBindGroupLayout,
                this.defaultWhiteView,
                this.defaultNormalView,
                this.texSampler,
            );

            pass.setBindGroup(1, res.modelBindGroup);
            pass.setBindGroup(2, matBg);
            pass.setVertexBuffer(0, res.vertexBuffer);
            pass.setIndexBuffer(res.indexBuffer, "uint32");
            pass.drawIndexed(res.indexCount);
        }

        pass.end();
    }

    private renderLighting(encoder: GPUCommandEncoder, ctx: PassRenderContext): void {
        const {outputs} = ctx;

        // Build lighting bind group each frame so G-buffer views are always current.
        const envView = this.scene.environmentMap?.srgbView ?? this.defaultWhiteView;
        const bgView = this.scene.backgroundMap?.srgbView ?? this.defaultWhiteView;
        const lightingBG = this.device.createBindGroup({
            label: "DeferredScene:lightingBindGroup",
            layout: this.lightingBindGroupLayout,
            entries: [
                {binding: 0, resource: outputs["albedo"]!},
                {binding: 1, resource: outputs["normal"]!},
                {binding: 2, resource: outputs["worldPos"]!},
                {binding: 3, resource: {buffer: this.lightingBuffer}},
                {binding: 4, resource: outputs["emissive"]!},
                {binding: 5, resource: envView},
                {binding: 6, resource: this.texSampler},
                {binding: 7, resource: bgView},
            ],
        });

        const pass = encoder.beginRenderPass({
            label: "Lighting",
            colorAttachments: [{view: outputs["color"]!, clearValue: [0, 0, 0, 1], loadOp: "clear", storeOp: "store"}],
        });

        pass.setPipeline(this.lightingPipeline);
        pass.setBindGroup(0, lightingBG);
        pass.setBindGroup(1, this.shadowBindGroup!);
        pass.draw(3);
        pass.end();
    }

    /** See-through meshes over the lit scene, farthest first; double-sided ones back faces, then front faces. */
    private renderTransparent(encoder: GPUCommandEncoder, ctx: PassRenderContext): void {
        const {outputs} = ctx;
        const envView = this.scene.environmentMap?.srgbView ?? this.defaultWhiteView;
        if (this.forwardLightingBindGroup === null || envView !== this.forwardEnvView) {
            this.forwardEnvView = envView;
            this.forwardLightingBindGroup = this.device.createBindGroup({
                label: "DeferredScene:forwardLighting",
                layout: this.forwardLightingLayout,
                entries: [
                    {binding: 0, resource: {buffer: this.lightingBuffer}},
                    {binding: 1, resource: envView},
                    {binding: 2, resource: this.texSampler},
                    {binding: 3, resource: this.dirShadowTex.createView({dimension: "2d-array"})},
                    {binding: 4, resource: this.spotShadowTex.createView({dimension: "2d-array"})},
                    {binding: 5, resource: this.shadowSampler},
                    {binding: 6, resource: this.pointShadowTex.createView({dimension: "2d-array"})},
                    {binding: 7, resource: {buffer: this.pointShadowMatricesBuffer}},
                ],
            });
        }

        const pass = encoder.beginRenderPass({
            label: "Transparent",
            colorAttachments: [{view: outputs["color"]!, loadOp: "load", storeOp: "store"}],
            depthStencilAttachment: {view: outputs["depth"]!, depthLoadOp: "load", depthStoreOp: "store"},
        });
        pass.setBindGroup(0, this.cameraBindGroup);
        pass.setBindGroup(3, this.forwardLightingBindGroup);

        let bound: GPURenderPipeline | null = null;
        for (const {mesh} of this.blendDraws) {
            const res = this.meshCache.get(mesh);
            const material = mesh.material as PBRMaterial;
            if (!res) {
                continue;
            }
            const features = getGBufferFeatures(material);
            pass.setBindGroup(1, res.modelBindGroup);
            pass.setBindGroup(
                2,
                material.getOrCreateBindGroup(
                    this.device,
                    this.materialBindGroupLayout,
                    this.defaultWhiteView,
                    this.defaultNormalView,
                    this.texSampler,
                ),
            );
            pass.setVertexBuffer(0, res.vertexBuffer);
            pass.setIndexBuffer(res.indexBuffer, "uint32");
            for (const cullMode of material.doubleSided ? (["front", "back"] as const) : (["back"] as const)) {
                const pipeline = this.getOrCreateForwardPipeline(features, cullMode);
                if (pipeline !== bound) {
                    pass.setPipeline(pipeline);
                    bound = pipeline;
                }
                pass.drawIndexed(res.indexCount);
            }
        }
        pass.end();
    }

    // ─── Private: uniform uploads ────────────────────────────────────────────

    private uploadCameraUniforms(camera: Camera | null, width: number, height: number): void {
        const aspect = width / height;
        const viewMatrix = camera ? camera.getViewMatrix() : mat4.create();
        const projMatrix = camera ? camera.getProjectionMatrix(aspect) : mat4.create();
        const vpMatrix = camera ? camera.getViewProjectionMatrix(aspect) : mat4.create();
        const camPos = camera ? mat4.getTranslation(vec3.create(), camera.worldMatrix) : vec3.create();

        mat4.invert(this.currentInvVP, vpMatrix);

        const data = new Float32Array(208 / 4);
        data.set(viewMatrix, 0);
        data.set(projMatrix, 16);
        data.set(vpMatrix, 32);
        data[48] = camPos[0];
        data[49] = camPos[1];
        data[50] = camPos[2];
        data[51] = 1.0;

        this.device.queue.writeBuffer(this.cameraBuffer, 0, data);
    }

    private uploadModelUniforms(mesh: Mesh, buffer: GPUBuffer): void {
        const model = mesh.worldMatrix;
        const normalMatrix = this.normalMatrix;
        mat4.invert(normalMatrix, model);
        mat4.transpose(normalMatrix, normalMatrix);

        const data = this.modelData;
        data.set(model, 0);
        data.set(normalMatrix, 16);
        data[32] = mesh.receiveShadow ? 1.0 : 0.0;
        this.device.queue.writeBuffer(buffer, 0, data);
    }

    private uploadLightingUniforms(
        dirLights: DirectionalLight[],
        pointLights: PointLight[],
        spotLights: SpotLight[],
        dirMatrices: (mat4 | null)[],
        spotMatrices: (mat4 | null)[],
    ): void {
        const data = new ArrayBuffer(LIGHTING_BUFFER_SIZE);
        const f32 = new Float32Array(data);
        const u32 = new Uint32Array(data);

        const ambient = this.scene.ambientColor;
        f32[0] = srgbToLinear(ambient[0]);
        f32[1] = srgbToLinear(ambient[1]);
        f32[2] = srgbToLinear(ambient[2]);
        f32[3] = 1.0;

        const cam = this.scene.activeCamera;
        const cp = cam ? mat4.getTranslation(vec3.create(), cam.worldMatrix) : vec3.create();
        f32[4] = cp[0];
        f32[5] = cp[1];
        f32[6] = cp[2];
        f32[7] = 1.0;

        u32[8] = dirLights.length;
        u32[9] = pointLights.length;
        u32[10] = spotLights.length;
        u32[11] = 0;

        for (let i = 0; i < dirLights.length; i++) {
            const base = 12 + i * 24;
            const l = dirLights[i]!;
            const lm = dirMatrices[i];
            const dir = worldForward(l.worldMatrix, tmpDir);
            f32[base + 0] = dir[0];
            f32[base + 1] = dir[1];
            f32[base + 2] = dir[2];
            f32[base + 3] = l.castShadow ? 1.0 : 0.0;
            f32[base + 4] = srgbToLinear(l.color[0]);
            f32[base + 5] = srgbToLinear(l.color[1]);
            f32[base + 6] = srgbToLinear(l.color[2]);
            f32[base + 7] = l.intensity;
            if (lm) {
                f32.set(lm, base + 8);
            }
        }

        for (let i = 0; i < pointLights.length; i++) {
            const base = 108 + i * 12;
            const l = pointLights[i]!;
            const wp = l.worldMatrix;
            f32[base + 0] = wp[12]!;
            f32[base + 1] = wp[13]!;
            f32[base + 2] = wp[14]!;
            f32[base + 3] = l.range;
            f32[base + 4] = srgbToLinear(l.color[0]);
            f32[base + 5] = srgbToLinear(l.color[1]);
            f32[base + 6] = srgbToLinear(l.color[2]);
            f32[base + 7] = l.intensity;
            f32[base + 8] = l.castShadow ? 1.0 : 0.0;
        }

        for (let i = 0; i < spotLights.length; i++) {
            const base = 204 + i * 32;
            const l = spotLights[i]!;
            const lm = spotMatrices[i];
            const wp = l.worldMatrix;
            f32[base + 0] = wp[12]!;
            f32[base + 1] = wp[13]!;
            f32[base + 2] = wp[14]!;
            f32[base + 3] = l.range;
            const dir = worldForward(wp, tmpDir);
            f32[base + 4] = dir[0];
            f32[base + 5] = dir[1];
            f32[base + 6] = dir[2];
            f32[base + 7] = l.castShadow ? 1.0 : 0.0;
            f32[base + 8] = srgbToLinear(l.color[0]);
            f32[base + 9] = srgbToLinear(l.color[1]);
            f32[base + 10] = srgbToLinear(l.color[2]);
            f32[base + 11] = l.intensity;
            f32[base + 12] = Math.cos(l.innerAngle);
            f32[base + 13] = Math.cos(l.outerAngle);
            if (lm) {
                f32.set(lm, base + 16);
            }
        }

        const bg = this.scene.backgroundColor;
        f32[332] = srgbToLinear(bg[0]);
        f32[333] = srgbToLinear(bg[1]);
        f32[334] = srgbToLinear(bg[2]);
        f32[335] = 1.0;

        // Reflections sample the environment map times environmentColor. Without a map the sampled texel is a white
        // placeholder: reflect the ambient color instead (a uniform environment), not a white sky, which would rim
        // every object with a light outline at grazing angles.
        const env = this.scene.environmentColor;
        const sky = this.scene.environmentMap === null ? this.scene.ambientColor : null;
        f32[336] = srgbToLinear(env[0]) * srgbToLinear(sky?.[0] ?? 1);
        f32[337] = srgbToLinear(env[1]) * srgbToLinear(sky?.[1] ?? 1);
        f32[338] = srgbToLinear(env[2]) * srgbToLinear(sky?.[2] ?? 1);
        f32[339] = 1.0;

        f32.set(this.currentInvVP, 340);

        this.device.queue.writeBuffer(this.lightingBuffer, 0, data);
    }

    // ─── Private: shadow matrix helpers ─────────────────────────────────────

    private computeDirectionalLightMatrix(light: DirectionalLight): mat4 {
        const dir = worldForward(light.worldMatrix, vec3.create());
        const up = Math.abs(dir[1]) > 0.9 ? vec3.fromValues(1, 0, 0) : vec3.fromValues(0, 1, 0);
        const eye = vec3.scale(vec3.create(), dir, -20);

        const view = mat4.create();
        mat4.lookAt(view, eye, [0, 0, 0], up);

        const proj = mat4.create();
        const e = DIRECTIONAL_SHADOW_EXTENT;
        mat4.orthoZO(proj, -e, e, -e, e, 0.1, 50);

        const lsMatrix = mat4.create();
        mat4.multiply(lsMatrix, proj, view);
        return lsMatrix;
    }

    private computeSpotLightMatrix(light: SpotLight): mat4 {
        const wp = light.worldMatrix;
        const eye = vec3.fromValues(wp[12]!, wp[13]!, wp[14]!);
        const dir = worldForward(light.worldMatrix, vec3.create());
        const up = Math.abs(dir[1]) > 0.9 ? vec3.fromValues(1, 0, 0) : vec3.fromValues(0, 1, 0);
        const center = vec3.add(vec3.create(), eye, dir);

        const view = mat4.create();
        mat4.lookAt(view, eye, center, up);

        const proj = mat4.create();
        mat4.perspectiveZO(proj, light.outerAngle * 2, 1.0, 0.1, light.range);

        const lsMatrix = mat4.create();
        mat4.multiply(lsMatrix, proj, view);
        return lsMatrix;
    }

    private computePointLightFaceMatrices(light: PointLight): mat4[] {
        const wp = light.worldMatrix;
        const eye = vec3.fromValues(wp[12]!, wp[13]!, wp[14]!);

        return CUBE_FACE_DIRS.map(({dir, up}) => {
            const center = vec3.fromValues(eye[0] + dir[0], eye[1] + dir[1], eye[2] + dir[2]);
            const view = mat4.create();
            mat4.lookAt(view, eye, center, vec3.fromValues(up[0], up[1], up[2]));
            const proj = mat4.create();
            mat4.perspectiveZO(proj, Math.PI / 2, 1.0, 0.1, light.range);
            const vp = mat4.create();
            mat4.multiply(vp, proj, view);
            return vp;
        });
    }

    private uploadPointShadowMatrices(pointLights: PointLight[], pointMatrices: (mat4[] | null)[]): void {
        const data = new Float32Array(POINT_SHADOW_MATRICES_SIZE / 4);
        for (let i = 0; i < pointLights.length; i++) {
            const faceMatrices = pointMatrices[i];
            if (!faceMatrices) {
                continue;
            }
            for (let f = 0; f < 6; f++) {
                data.set(faceMatrices[f] as Float32Array, (i * 6 + f) * 16);
            }
        }
        this.device.queue.writeBuffer(this.pointShadowMatricesBuffer, 0, data);
    }

    // ─── Private: mesh GPU resource management ───────────────────────────────

    private ensureMeshResources(meshes: Mesh[]): void {
        for (const mesh of meshes) {
            if (this.meshCache.has(mesh)) {
                continue;
            }
            this.meshCache.set(mesh, this.createMeshResources(mesh.geometry));
        }
    }

    private createMeshResources(geo: Geometry): MeshGPUResources {
        const {device} = this;

        const interleaved = geo.buildInterleavedBuffer();
        const vertexBuffer = device.createBuffer({
            label: "Mesh:vertex",
            size: interleaved.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(vertexBuffer, 0, interleaved);

        const indexBuffer = device.createBuffer({
            label: "Mesh:index",
            size: geo.indices.byteLength,
            usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(indexBuffer, 0, geo.indices);

        const modelBuffer = device.createBuffer({
            label: "Mesh:model",
            size: 144,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        const modelBindGroup = device.createBindGroup({
            label: "Mesh:modelBindGroup",
            layout: this.modelBindGroupLayout,
            entries: [{binding: 0, resource: {buffer: modelBuffer}}],
        });

        return {vertexBuffer, indexBuffer, modelBuffer, modelBindGroup, indexCount: geo.indexCount};
    }
}
