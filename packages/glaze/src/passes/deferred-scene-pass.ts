import {mat4, vec3} from "gl-matrix";

import {COLOR_WGSL, type ColorSpace, srgbToLinear} from "../color";
import type {Geometry} from "../geometry/geometry";
import {MATERIAL_BUFFER_SIZE, materialMap, packMaterialUniforms, PBRMaterial} from "../material/material";
import {sphere} from "../math/bounds";
import {isMirrored} from "../math/transform";
import type {PassInputSlot, PassOutputSlot, PassRenderContext} from "../pass";
import {Pass} from "../pass";
import type {Camera} from "../scene/camera";
import {type DirectionalLight, type PointLight, spotCone, type SpotLight} from "../scene/light";
import type {Mesh} from "../scene/mesh";
import type {Scene} from "../scene/scene";
import {type Cascade, fitCascades, lightView, MAX_CASCADES} from "../scene/shadow-cascades";
import {SkinnedMesh} from "../scene/skin";
import type {Texture, TextureSampling, WrapMode} from "../texture";

// ─── WGSL shaders ─────────────────────────────────────────────────────────────

const IDENTITY = mat4.create();

/** The per-mesh uniforms (160 bytes), shared by every mesh shader. */
const MODEL_UNIFORMS_WGSL = /* wgsl */ `
struct ModelUniforms {
    model:        mat4x4<f32>,
    normalMatrix: mat4x4<f32>,
    flags:        vec4<f32>,   // x = receiveShadow
    morph:        vec4<f32>,   // x = morph targets with a weight this frame, y = vertices
};
`;

const MODEL_UNIFORMS_SIZE = 160;

/**
 * Morph targets: per target and vertex, a position and a normal delta (group 1 binding 2), added by the mesh's
 * weights. Before skinning, as glTF defines. Only targets with a weight this frame are listed (binding 3, as
 * target index and weight), so a face rig with dozens of shapes costs what the active ones do.
 */
const MORPH_WGSL = /* wgsl */ `
@group(1) @binding(2) var<storage, read> morphDeltas: array<vec4<f32>>;
@group(1) @binding(3) var<storage, read> morphActive: array<vec2<f32>>;

struct Morphed {
    position: vec3<f32>,
    normal:   vec3<f32>,
};

fn applyMorphs(vertex: u32, position: vec3<f32>, normal: vec3<f32>) -> Morphed {
    var out = Morphed(position, normal);
    let count    = u32(model.morph.x);
    let vertices = u32(model.morph.y);
    for (var i = 0u; i < count; i++) {
        let pair = morphActive[i]; // target index, weight
        let at = (u32(pair.x) * vertices + vertex) * 2u;
        out.position += morphDeltas[at].xyz * pair.y;
        out.normal   += morphDeltas[at + 1u].xyz * pair.y;
    }
    return out;
}
`;

/**
 * Skinning: the mesh's joint matrices (world space) at group 1 binding 1, next to its model uniforms, and the
 * blend of the four a vertex follows.
 */
const SKIN_WGSL = /* wgsl */ `
@group(1) @binding(1) var<storage, read> jointMatrices: array<mat4x4<f32>>;

fn skinMatrix(joints: vec4<u32>, weights: vec4<f32>) -> mat4x4<f32> {
    return jointMatrices[joints.x] * weights.x + jointMatrices[joints.y] * weights.y
         + jointMatrices[joints.z] * weights.z + jointMatrices[joints.w] * weights.w;
}
`;

/** A shadow vertex stage's extra inputs and its local position, for skinned and / or morphed meshes. */
function shadowVertex(skinned: boolean, morphed: boolean): {inputs: string; local: string} {
    const inputs =
        (skinned ? ", @location(4) joints: vec4<u32>, @location(5) weights: vec4<f32>" : "") +
        (morphed ? ", @builtin(vertex_index) vertex: u32" : "");
    const base = morphed ? "applyMorphs(vertex, position, vec3<f32>(0.0)).position" : "position";
    const local = skinned ? `skinMatrix(joints, weights) * vec4<f32>(${base}, 1.0)` : `vec4<f32>(${base}, 1.0)`;
    return {inputs, local};
}

function buildShadowShader(skinned = false, morphed = false): string {
    const v = shadowVertex(skinned, morphed);
    return /* wgsl */ `
struct ShadowLightUniforms {
    lightSpaceMatrix: mat4x4<f32>,
};
${MODEL_UNIFORMS_WGSL}

@group(0) @binding(0) var<uniform> light: ShadowLightUniforms;
@group(1) @binding(0) var<uniform> model: ModelUniforms;
${skinned ? SKIN_WGSL : ""}
${morphed ? MORPH_WGSL : ""}

@vertex
fn vs_shadow(@location(0) position: vec3<f32>${v.inputs}) -> @builtin(position) vec4<f32> {
    return light.lightSpaceMatrix * model.model * ${v.local};
}
`;
}

/**
 * Shadow casters with alpha: the albedo alpha decides which texels block light. "mask" cuts like the G-buffer;
 * "blend" keeps a share of shadow texels equal to alpha (2×2 ordered; the PCF reads it back as a partial shadow).
 */
function buildAlphaShadowShader(alpha: "mask" | "blend", skinned = false, morphed = false, extras = false): string {
    const v = shadowVertex(skinned, morphed);
    return /* wgsl */ `
struct ShadowLightUniforms {
    lightSpaceMatrix: mat4x4<f32>,
};

${MODEL_UNIFORMS_WGSL}
${MATERIAL_UNIFORMS_WGSL}

@group(0) @binding(0) var<uniform> light: ShadowLightUniforms;
@group(1) @binding(0) var<uniform> model: ModelUniforms;
@group(2) @binding(0) var<uniform> mat: MaterialUniforms;
@group(2) @binding(1) var albedoMap: texture_2d<f32>;
@group(2) @binding(2) var albedoSampler: sampler;
${MAP_UV_WGSL}

struct ShadowVarying {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) uv1: vec2<f32>,
    @location(2) vertexAlpha: f32,
};

${skinned ? SKIN_WGSL : ""}
${morphed ? MORPH_WGSL : ""}

@vertex
fn vs_shadow(@location(0) position: vec3<f32>, @location(2) uv: vec2<f32>${v.inputs}${
        extras ? ", @location(6) uv1: vec2<f32>, @location(7) color: vec4<f32>" : ""
    }) -> ShadowVarying {
    var out: ShadowVarying;
    out.pos = light.lightSpaceMatrix * model.model * ${v.local};
    out.uv = uv;
    out.uv1 = ${extras ? "uv1" : "uv"};
    out.vertexAlpha = ${extras ? "color.a" : "1.0"};
    return out;
}

@fragment
fn fs_shadow(in: ShadowVarying) {
    let alpha = textureSample(albedoMap, albedoSampler, mapUv(0u, in.uv, in.uv1)).a * mat.albedo.a * in.vertexAlpha;
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
    /** Deformed by a skin's joints (a SkinnedMesh with joints and weights). */
    skinned?: boolean;
    /** Has morph targets (blend shapes), weighted by mesh.morphWeights. */
    morphed?: boolean;
    /** Its world transform mirrors (negative determinant): triangles wind clockwise, tangent handedness flips. */
    mirrored?: boolean;
    /** Its geometry has vertex colors or a second UV set (the extra vertex stream). */
    extras?: boolean;
}

/** A mesh drawn with skinning: a SkinnedMesh with a skin, whose geometry has joints and weights. */
function isSkinned(mesh: Mesh): mesh is SkinnedMesh {
    return mesh instanceof SkinnedMesh && mesh.skin !== null && mesh.geometry.skinned;
}

/** A mesh whose geometry has morph targets. */
function isMorphed(mesh: Mesh): boolean {
    return mesh.geometry.morphTargets !== undefined;
}

function getGBufferFeatures(
    mat: PBRMaterial,
    skinned = false,
    morphed = false,
    mirrored = false,
    extras = false,
): GBufferFeatures {
    return {
        parallaxMapping: mat.heightMap != null,
        normalMapping: mat.normalMap != null,
        alpha: mat.alphaMode,
        doubleSided: mat.doubleSided,
        skinned,
        morphed,
        mirrored,
        extras,
    };
}

/** A mirrored transform turns counter-clockwise triangles clockwise on screen: its front faces wind the other way. */
function frontFace(mirrored: boolean | undefined): GPUFrontFace {
    return mirrored ? "cw" : "ccw";
}

function featureKey(f: GBufferFeatures): string {
    return (
        (f.parallaxMapping ? "P" : "") +
        (f.normalMapping ? "N" : "") +
        (f.alpha === "mask" ? "M" : f.alpha === "blend" ? "B" : "") +
        (f.doubleSided ? "2" : "") +
        (f.skinned ? "S" : "") +
        (f.morphed ? "T" : "") +
        (f.mirrored ? "X" : "") +
        (f.extras ? "E" : "")
    );
}

const MATERIAL_UNIFORMS_WGSL = /* wgsl */ `
struct UvTransform {
    row0: vec4<f32>, // a, b, tx, uvSet
    row1: vec4<f32>, // c, d, ty
};

struct MaterialUniforms {
    albedo:            vec4<f32>,
    roughness:         f32,
    metallic:          f32,
    heightScale:       f32,
    normalScale:       f32,
    emissive:          vec4<f32>,
    occlusionStrength: f32,
    alphaCutoff:       f32,
    uvTransforms:      array<UvTransform, 6>, // albedo, normal, emissive, metallicRoughness, height, occlusion
};
`;

/** Where map 'i' is sampled: its UV set, transformed (KHR_texture_transform). Needs 'mat' bound. */
const MAP_UV_WGSL = /* wgsl */ `
fn mapUv(i: u32, uv0: vec2<f32>, uv1: vec2<f32>) -> vec2<f32> {
    let t  = mat.uvTransforms[i];
    let uv = select(uv0, uv1, t.row0.w > 0.5);
    return vec2<f32>(dot(t.row0.xy, uv) + t.row0.z, dot(t.row1.xy, uv) + t.row1.z);
}
`;

/** The extra vertex stream: a second UV set at location 6 and a vertex color at location 7 (see Geometry). */
const EXTRAS_LAYOUT: GPUVertexBufferLayout = {
    arrayStride: 24,
    attributes: [
        {shaderLocation: 6, offset: 0, format: "float32x2"},
        {shaderLocation: 7, offset: 8, format: "float32x4"},
    ],
};

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

${MODEL_UNIFORMS_WGSL}
${MATERIAL_UNIFORMS_WGSL}

@group(0) @binding(0) var<uniform> camera:     CameraUniforms;
@group(1) @binding(0) var<uniform> model:      ModelUniforms;
@group(2) @binding(0) var<uniform> mat:        MaterialUniforms;
@group(2) @binding(1) var albedoMap:           texture_2d<f32>;
@group(2) @binding(2) var albedoSampler:       sampler;
@group(2) @binding(3) var normalMap:           texture_2d<f32>;
@group(2) @binding(4) var emissiveMap:         texture_2d<f32>;
@group(2) @binding(5) var metallicRoughnessMap: texture_2d<f32>; // G=roughness, B=metallic
@group(2) @binding(6) var heightMap:           texture_2d<f32>;
@group(2) @binding(7) var occlusionMap:        texture_2d<f32>; // R=occlusion
@group(2) @binding(8) var normalSampler:       sampler;
@group(2) @binding(9) var emissiveSampler:     sampler;
@group(2) @binding(10) var metallicRoughnessSampler: sampler;
@group(2) @binding(11) var heightSampler:      sampler;
@group(2) @binding(12) var occlusionSampler:   sampler;
${MAP_UV_WGSL}

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal:   vec3<f32>,
    @location(2) uv:       vec2<f32>,
    @location(3) tangent:  vec4<f32>,${
        f.skinned
            ? `
    @location(4) joints:   vec4<u32>,
    @location(5) weights:  vec4<f32>,`
            : ""
    }${
        f.extras
            ? `
    @location(6) uv1:      vec2<f32>,
    @location(7) color:    vec4<f32>,`
            : ""
    }${
        f.morphed
            ? `
    @builtin(vertex_index) vertex: u32,`
            : ""
    }
};
${f.skinned ? SKIN_WGSL : ""}
${f.morphed ? MORPH_WGSL : ""}

struct VertexOutput {
    @builtin(position) clipPos:      vec4<f32>,
    @location(0)       worldPos:     vec3<f32>,
    @location(1)       worldNormal:  vec3<f32>,
    @location(2)       uv:           vec2<f32>,
    @location(3)       worldTangent: vec4<f32>,
    @location(4)       uv1:          vec2<f32>,
    @location(5)       color:        vec4<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {${
        f.morphed
            ? `
    // blend shapes first, then the skin
    let shaped     = applyMorphs(input.vertex, input.position, input.normal);
    let basePos    = shaped.position;
    let baseNormal = shaped.normal;`
            : `
    let basePos    = input.position;
    let baseNormal = input.normal;`
    }${
        f.skinned
            ? `
    // the joints' movement from the bind pose, in mesh space (rigid joints: it also turns normals)
    let skin    = skinMatrix(input.joints, input.weights);
    let local   = skin * vec4<f32>(basePos, 1.0);
    let normal  = (skin * vec4<f32>(baseNormal, 0.0)).xyz;
    let tangent = (skin * vec4<f32>(input.tangent.xyz, 0.0)).xyz;`
            : `
    let local   = vec4<f32>(basePos, 1.0);
    let normal  = baseNormal;
    let tangent = input.tangent.xyz;`
    }
    let worldPos = model.model * local;
    var output: VertexOutput;
    output.clipPos     = camera.viewProjection * worldPos;
    output.worldPos    = worldPos.xyz;
    output.worldNormal = normalize((model.normalMatrix * vec4<f32>(normal, 0.0)).xyz);
    output.uv          = input.uv;
    output.uv1         = ${f.extras ? "input.uv1" : "input.uv"};
    output.color       = ${f.extras ? "input.color" : "vec4<f32>(1.0)"};
    // a tangent lies in the surface: it follows the model matrix (not the normal matrix) under non-uniform scale
    let worldTangentXYZ = normalize((model.model * vec4<f32>(tangent, 0.0)).xyz);
    // a mirror flips the handedness of the frame (cross(N, T) turns the other way)
    output.worldTangent = vec4<f32>(worldTangentXYZ, input.tangent.w${f.mirrored ? " * -1.0" : ""});
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
    var cd    = 1.0 - textureSampleLevel(heightMap, heightSampler, mapUv(4u, cuv, cuv), 0.0).r;
    for (var i: i32 = 0; i < 32; i++) {
        if (depth >= cd) { break; }
        cuv   -= deltaUV;
        cd     = 1.0 - textureSampleLevel(heightMap, heightSampler, mapUv(4u, cuv, cuv), 0.0).r;
        depth += layerDepth;
    }
    let prevUV     = cuv + deltaUV;
    let afterDiff  = cd - depth;
    let beforeDiff = (1.0 - textureSampleLevel(heightMap, heightSampler, mapUv(4u, prevUV, prevUV), 0.0).r) - (depth - layerDepth);
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
    let face = select(-1.0, 1.0, frontFacing);
    let N = face * normalize(input.worldNormal);`
        : `
    let face = 1.0;
    let N = normalize(input.worldNormal);`
}
${
    needsTbn
        ? `
    // re-orthogonalized against N; on a back face the whole frame flips, so a bump reads as a dent
    let T   = normalize(input.worldTangent.xyz * face - N * dot(N, input.worldTangent.xyz * face));
    let B   = cross(N, T) * input.worldTangent.w * face;
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
    let normalSample  = (textureSample(normalMap, normalSampler, mapUv(1u, uv, input.uv1)).rgb * 2.0 - 1.0)
                      * vec3<f32>(mat.normalScale, mat.normalScale, 1.0);
    let shadingNormal = normalize(tbn * normalSample);
`
        : `
    let shadingNormal = N;
`
}
    let albedoUv   = mapUv(0u, uv, input.uv1);
    let texAlbedo4 = textureSample(albedoMap, albedoSampler, albedoUv);
${
    f.alpha === "mask"
        ? `    // mip levels average alpha toward the middle, so cutouts thin out and vanish with distance: lift alpha by
    // the mip level sampled (Golus) to keep their coverage
    let texels = albedoUv * vec2<f32>(textureDimensions(albedoMap));
    let lod    = max(0.5 * log2(max(dot(dpdx(texels), dpdx(texels)), dot(dpdy(texels), dpdy(texels)))), 0.0);
    let alpha  = texAlbedo4.a * (1.0 + lod * 0.25) * mat.albedo.a * input.color.a;
    if (alpha < mat.alphaCutoff) { discard; }`
        : `    let alpha      = texAlbedo4.a * mat.albedo.a * input.color.a;`
}

    let mr        = textureSample(metallicRoughnessMap, metallicRoughnessSampler, mapUv(3u, uv, input.uv1));
    let occlusion = textureSample(occlusionMap, occlusionSampler, mapUv(5u, uv, input.uv1)).r;

    var s: Surface;
    s.albedo    = texAlbedo4.rgb * mat.albedo.rgb * input.color.rgb;
    s.alpha     = alpha;
    s.normal    = shadingNormal;
    s.roughness = clamp(mr.g * mat.roughness, 0.0, 1.0);
    s.metallic  = clamp(mr.b * mat.metallic,  0.0, 1.0);
    s.ao        = clamp(1.0 + mat.occlusionStrength * (occlusion - 1.0), 0.0, 1.0);
    s.emissive  = textureSample(emissiveMap, emissiveSampler, mapUv(2u, uv, input.uv1)).rgb * mat.emissive.rgb;
    return s;
}
`;
}

function buildGBufferShader(f: GBufferFeatures): string {
    return /* wgsl */ `
${buildSurfaceWgsl(f)}
${COVERAGE_AO_WGSL}

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
    out.albedo   = vec4<f32>(s.albedo, encodeCoverageAo(s.ao));
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
function buildForwardShader(f: GBufferFeatures, encode: boolean, sizes: ShadowSizes): string {
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

${shadeWgsl(sizes)}

@fragment
fn fs_main(input: VertexOutput, @builtin(front_facing) frontFacing: bool) -> @location(0) vec4<f32> {
    let s = surface(input, frontFacing);
    let lit = shade(s.albedo, s.ao, s.normal, s.roughness, s.metallic, input.worldPos, model.flags.x, input.clipPos.xy) + s.emissive;
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

/** Shadow map sizes, baked into the shaders. */
interface ShadowSizes {
    directional: number;
    spot: number;
    point: number;
}

const POINT_SHADOW_MATRICES_SIZE = MAX_POINT * 6 * 64;

/** Texels each cube face reaches past its 90° edge: the widest filter (32) plus the bilinear taps. */
const POINT_GUARD_TEXELS = 34;

/**
 * A cube face's half-width in tan units (1 is exactly 90°). Faces overlap by a guard band, so a filter near an
 * edge still reads real depths from its own face instead of clamped texels from the edge.
 */
function pointFaceScale(size: number): number {
    return 1 / Math.max(1 - (2 * POINT_GUARD_TEXELS) / size, 0.5);
}

const CUBE_FACE_DIRS: {dir: [number, number, number]; up: [number, number, number]}[] = [
    {dir: [1, 0, 0], up: [0, -1, 0]},
    {dir: [-1, 0, 0], up: [0, -1, 0]},
    {dir: [0, 1, 0], up: [0, 0, 1]},
    {dir: [0, -1, 0], up: [0, 0, -1]},
    {dir: [0, 0, 1], up: [0, -1, 0]},
    {dir: [0, 0, -1], up: [0, -1, 0]},
];

/** Shadow casters write depth pushed back along their slope, so a lit face doesn't compare against itself. */
const SHADOW_DEPTH_STATE: GPUDepthStencilState = {
    format: "depth32float",
    depthWriteEnabled: true,
    depthCompare: "less",
    depthBias: 2,
    depthBiasSlopeScale: 1.5,
};

/** Near plane of the spot and point shadow projections. */
/** A shadow's strength, 0..1 (a light must cast for any shadow; a tiny strength still counts as casting). */
function shadowStrength(light: {shadow: {intensity: number}}): number {
    return Math.min(Math.max(light.shadow.intensity, 1e-4), 1);
}

/** Where a point or spot shadow map starts: light.shadow.near, kept short of the far plane. */
function shadowNear(light: PointLight | SpotLight): number {
    return Math.min(Math.max(light.shadow.near, 1e-4), shadowFar(light) * 0.5);
}

/** Where it ends: the light's range (at least a little past near). */
function shadowFar(light: PointLight | SpotLight): number {
    return Math.max(light.range, 1e-3);
}

// ─── Lighting uniform layout (in f32 slots) ──────────────────────────────────
//
// ambientColor        vec4                            0
// cameraPosition      vec4                            4
// counts              vec4<u32> (dir, point, spot)    8
// directionalLights   4 × 92  (368 bytes each)        12
// pointLights         8 × 20  (80 bytes each)         380
// spotLights          4 × 40  (160 bytes each)        540
// backgroundColor     vec4                            700
// environmentColor    vec4                            704
// invViewProjection   mat4                            708
// cameraForward       vec4 (xyz)                      724
// Total: 728 slots, 2912 bytes

const DIR_BASE = 12;
const DIR_STRIDE = 92;
const POINT_BASE = DIR_BASE + MAX_DIRECTIONAL * DIR_STRIDE;
const POINT_STRIDE = 20;
const SPOT_BASE = POINT_BASE + MAX_POINT * POINT_STRIDE;
const SPOT_STRIDE = 40;
const BACKGROUND_SLOT = SPOT_BASE + MAX_SPOT * SPOT_STRIDE;
const ENVIRONMENT_SLOT = BACKGROUND_SLOT + 4;
const INV_VP_SLOT = ENVIRONMENT_SLOT + 4;
const CAMERA_FORWARD_SLOT = INV_VP_SLOT + 16;
const LIGHTING_BUFFER_SIZE = (CAMERA_FORWARD_SLOT + 4) * 4;

/**
 * The G-buffer albedo alpha holds AO and doubles as coverage (0 = nothing drawn: background). AO is stored above
 * a floor so a fully occluded texel (black baked AO) still counts as a surface.
 */
const COVERAGE_AO_WGSL = /* wgsl */ `
const AO_FLOOR: f32 = 4.0 / 255.0;
fn encodeCoverageAo(ao: f32) -> f32 { return AO_FLOOR + (1.0 - AO_FLOOR) * clamp(ao, 0.0, 1.0); }
fn decodeCoverageAo(a: f32) -> f32 { return clamp((a - AO_FLOOR) / (1.0 - AO_FLOOR), 0.0, 1.0); }
`;

const LIGHT_STRUCTS_WGSL = /* wgsl */ `
struct DirectionalLight {
    direction:      vec4<f32>,   // xyz = direction, w = shadow strength (0: casts none)
    colorIntensity: vec4<f32>,   // xyz = color, w = intensity
    shadow:         vec4<f32>,   // x = first shadow layer, y = cascades, z = tan(half the light's angle), w = samples
    shadowBias:     vec4<f32>,   // x = normal bias, y = bias (texels), z = cascade blend (0 none, 1 smooth, 2 dither), w = max distance
    splits:         vec4<f32>,   // camera view depth where each cascade ends
    texels:         vec4<f32>,   // world size of a texel, per cascade
    depthRanges:    vec4<f32>,   // world distance each cascade's 0..1 depth spans
    matrices:       array<mat4x4<f32>, ${MAX_CASCADES}>,
};

struct PointLight {
    position:       vec4<f32>,   // xyz = world pos, w = range
    colorIntensity: vec4<f32>,   // xyz = color, w = intensity
    flags:          vec4<f32>,   // x = shadow strength (0: casts none)
    shadow:         vec4<f32>,   // x = light radius, y = samples, z = near, w = far
    shadowBias:     vec4<f32>,   // x = normal bias, y = bias (texels)
};

struct SpotLight {
    position:         vec4<f32>, // xyz = world pos, w = range
    direction:        vec4<f32>, // xyz = direction, w = shadow strength (0: casts none)
    colorIntensity:   vec4<f32>, // xyz = color, w = intensity
    angles:           vec4<f32>, // x = cos(innerAngle), y = cos(outerAngle)
    shadow:           vec4<f32>, // x = light radius, y = samples, z = near, w = far
    shadowBias:       vec4<f32>, // x = normal bias, y = bias (texels)
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
    cameraForward:      vec4<f32>,   // xyz = camera forward, w = 1: tint directional shadow cascades (debug)
};

struct PointShadowMatrices {
    matrices: array<mat4x4<f32>, ${MAX_POINT * 6}>,
};
`;

/**
 * shade(): PBR lighting of one surface point by every light (with shadows), ambient and environment. Expects
 * lighting, environmentMap, envSampler and the shadow maps declared by the including shader.
 */
function shadeWgsl(sizes: ShadowSizes): string {
    return /* wgsl */ `
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

// ─── Shadows ────────────────────────────────────────────────────────────────

// Interleaved gradient noise: a per-pixel angle that turns the sample pattern, so few samples read as fine grain.
fn shadowNoise(pixel: vec2<f32>) -> f32 {
    return 6.28318530 * fract(52.9829189 * fract(dot(pixel, vec2<f32>(0.06711056, 0.00583715))));
}

// Where a point is looked up in a shadow map: off the surface along its normal (more at grazing light, where a
// face would otherwise shadow itself) and toward the light, both in shadow texels of world size 'texel'.
fn shadowLookup(worldPos: vec3<f32>, N: vec3<f32>, L: vec3<f32>, texel: f32, bias: vec4<f32>) -> vec3<f32> {
    let NdotL    = clamp(dot(N, L), 0.0, 1.0);
    let sinTheta = sqrt(1.0 - NdotL * NdotL);
    return worldPos + N * (texel * bias.x * sinTheta) + L * (texel * bias.y);
}

// The lookup point for a filter 'radius' texels wide: a surface tilted to the light changes depth across the
// filter, so it moves further off the surface (beyond the base normal bias) by the extra radius, at grazing light.
fn widenLookup(p: vec3<f32>, N: vec3<f32>, L: vec3<f32>, texel: f32, radius: f32) -> vec3<f32> {
    let NdotL    = clamp(dot(N, L), 0.0, 1.0);
    let sinTheta = sqrt(1.0 - NdotL * NdotL);
    return p + N * (texel * (radius - 1.0) * sinTheta);
}

// Percentage-closer filtering over a disk of 'radius' texels: 'samples' taps on a golden-angle spiral turned by
// 'rotation'. Under a texel (or 4 samples or fewer): four bilinear taps at ±½ texel, which also average the 2×2
// pattern see-through casters leave exactly.
fn pcf(map: texture_depth_2d_array, layer: i32, uv: vec2<f32>, depth: f32, radius: f32, samples: u32, size: f32, rotation: f32) -> f32 {
    let texelUv = 1.0 / size;
    if (samples <= 4u || radius <= 1.0) {
        let h = 0.5 * texelUv;
        return 0.25 * (
            textureSampleCompareLevel(map, shadowSampler, uv + vec2<f32>(-h, -h), layer, depth) +
            textureSampleCompareLevel(map, shadowSampler, uv + vec2<f32>( h, -h), layer, depth) +
            textureSampleCompareLevel(map, shadowSampler, uv + vec2<f32>(-h,  h), layer, depth) +
            textureSampleCompareLevel(map, shadowSampler, uv + vec2<f32>( h,  h), layer, depth));
    }
    // each tap on a texel corner: its bilinear compare is the mean of a 2×2 block, which is exactly a
    // see-through caster's alpha (its 2×2 ordered pattern) instead of grain
    let n = f32(samples);
    var lit = 0.0;
    for (var i = 0u; i < samples; i++) {
        let r = sqrt((f32(i) + 0.5) / n) * radius;
        let a = f32(i) * 2.39996323 + rotation;
        let corner = round(uv * size + vec2<f32>(cos(a), sin(a)) * r) * texelUv;
        lit += textureSampleCompareLevel(map, shadowSampler, corner, layer, depth);
    }
    return lit / n;
}

// The blockers between a point and the light, within 'radius' texels: x = their mean stored depth, y = how many.
fn findBlockers(map: texture_depth_2d_array, layer: i32, uv: vec2<f32>, depth: f32, radius: f32, samples: u32, size: f32, rotation: f32) -> vec2<f32> {
    let n = min(samples, 16u);
    var sum = 0.0;
    var count = 0.0;
    let maxCoord = vec2<i32>(i32(size) - 1);
    for (var i = 0u; i < n; i++) {
        let r = sqrt((f32(i) + 0.5) / f32(n)) * radius;
        let a = f32(i) * 2.39996323 + rotation;
        let coord = clamp(vec2<i32>(floor(uv * size + vec2<f32>(cos(a), sin(a)) * r)), vec2<i32>(0), maxCoord);
        let d = textureLoad(map, coord, layer, 0);
        if (d < depth) {
            sum += d;
            count += 1.0;
        }
    }
    return vec2<f32>(sum / max(count, 1.0), count);
}

// One cascade of a directional light. Contact hardening when the light has a size: the penumbra widens with
// the distance between the receiver and the blockers found up the light.
fn cascadeShadow(i: u32, c: u32, worldPos: vec3<f32>, N: vec3<f32>, L: vec3<f32>, rotation: f32) -> f32 {
    let dl    = lighting.directionalLights[i];
    let texel = dl.texels[c];
    let p     = shadowLookup(worldPos, N, L, texel, dl.shadowBias);
    let ndc   = (dl.matrices[c] * vec4<f32>(p, 1.0)).xyz;
    let uv    = ndc.xy * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5);
    if (ndc.z > 1.0 || any(uv < vec2<f32>(0.0)) || any(uv > vec2<f32>(1.0))) { return 1.0; }
    let layer   = i32(dl.shadow.x) + i32(c);
    let tanHalf = dl.shadow.z;
    let samples = u32(dl.shadow.w);
    let size    = f32(${sizes.directional});
    if (tanHalf <= 0.0) {
        return pcf(dirShadowMaps, layer, uv, ndc.z, 1.0, samples, size, rotation);
    }
    let range    = dl.depthRanges[c];
    // a blocker can sit anywhere up the light: search as wide as the farthest one would blur
    let search   = clamp(tanHalf * ndc.z * range / texel, 1.0, 24.0);
    let blockers = findBlockers(dirShadowMaps, layer, uv, ndc.z, search, samples, size, rotation);
    if (blockers.y == 0.0) { return 1.0; }
    let penumbra = (ndc.z - blockers.x) * range * 2.0 * tanHalf; // world width
    let radius   = clamp(0.5 * penumbra / texel + 1.0, 1.0, 32.0);
    // a wide filter reaches across the surface's own slope: move off it by as much
    let wide = (dl.matrices[c] * vec4<f32>(widenLookup(p, N, L, texel, radius), 1.0)).xyz;
    return pcf(dirShadowMaps, layer, wide.xy * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5), wide.z, radius, samples, size, rotation);
}

fn directionalShadow(i: u32, worldPos: vec3<f32>, N: vec3<f32>, L: vec3<f32>, rotation: f32) -> f32 {
    let dl        = lighting.directionalLights[i];
    let count     = u32(dl.shadow.y);
    let viewDepth = dot(worldPos - lighting.cameraPosition.xyz, lighting.cameraForward.xyz);
    var c = count;
    for (var k = 0u; k < count; k++) {
        if (viewDepth < dl.splits[k]) { c = k; break; }
    }
    if (c >= count) { return 1.0; }
    // hand over to the next cascade over the last tenth of this one
    var fade = 0.0;
    if (dl.shadowBias.z > 0.5 && c + 1u < count) {
        let begin = select(0.0, dl.splits[max(c, 1u) - 1u], c > 0u);
        fade = clamp(((viewDepth - begin) / (dl.splits[c] - begin) - 0.9) * 10.0, 0.0, 1.0);
    }
    var lit: f32;
    if (fade > 0.0 && dl.shadowBias.z > 1.5) {
        // dither: one cascade per pixel, by the same fixed screen-space noise as the filter (no flicker)
        lit = cascadeShadow(i, select(c, c + 1u, fade > rotation * 0.15915494), worldPos, N, L, rotation);
    } else {
        lit = cascadeShadow(i, c, worldPos, N, L, rotation);
        if (fade > 0.0) {
            lit = mix(lit, cascadeShadow(i, c + 1u, worldPos, N, L, rotation), fade);
        }
    }
    // and out of shadow over the last tenth of the max distance
    let maxDistance = dl.shadowBias.w;
    return mix(lit, 1.0, clamp((viewDepth - 0.9 * maxDistance) / (0.1 * maxDistance), 0.0, 1.0));
}

// A spot or point light's shadow (perspective). 'texel' is a texel's world size at the receiver.
fn perspectiveShadow(map: texture_depth_2d_array, layer: i32, lsMatrix: mat4x4<f32>, worldPos: vec3<f32>, N: vec3<f32>, L: vec3<f32>, texel: f32, shadow: vec4<f32>, bias: vec4<f32>, size: f32, rotation: f32) -> f32 {
    let p   = shadowLookup(worldPos, N, L, texel, bias);
    let ls  = lsMatrix * vec4<f32>(p, 1.0);
    let ndc = ls.xyz / ls.w;
    if (ndc.z <= 0.0 || ndc.z > 1.0) { return 1.0; }
    let uv = ndc.xy * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5);
    if (any(uv < vec2<f32>(0.0)) || any(uv > vec2<f32>(1.0))) { return 1.0; }
    let lightRadius = shadow.x;
    let samples     = u32(shadow.y);
    if (lightRadius <= 0.0) {
        return pcf(map, layer, uv, ndc.z, 1.0, samples, size, rotation);
    }
    let near     = shadow.z;
    let far      = shadow.w;
    let receiver = ls.w; // linear distance along the light's view axis
    let search   = clamp(lightRadius / texel, 1.0, 24.0);
    let blockers = findBlockers(map, layer, uv, ndc.z, search, samples, size, rotation);
    if (blockers.y == 0.0) { return 1.0; }
    let blocker  = near * far / (far - blockers.x * (far - near));
    let penumbra = 2.0 * lightRadius * max(receiver - blocker, 0.0) / max(blocker, near);
    let radius   = clamp(0.5 * penumbra / texel + 1.0, 1.0, 32.0);
    // a wide filter reaches across the surface's own slope: move off it by as much
    let wls  = lsMatrix * vec4<f32>(widenLookup(p, N, L, texel, radius), 1.0);
    let wide = wls.xyz / wls.w;
    return pcf(map, layer, wide.xy * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5), wide.z, radius, samples, size, rotation);
}

fn shade(albedo: vec3<f32>, ao: f32, N: vec3<f32>, roughnessIn: f32, metallic: f32, worldPos: vec3<f32>, receiveShadow: f32, pixel: vec2<f32>) -> vec3<f32> {
    let roughness = clamp(roughnessIn, 0.05, 1.0);
    let V     = normalize(lighting.cameraPosition.xyz - worldPos);
    let NdotV = max(dot(N, V), 0.001);
    let F0    = mix(vec3<f32>(0.04), albedo, metallic);
    let rotation = shadowNoise(pixel);

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
        if (dl.direction.w > 0.0 && receiveShadow > 0.0 && dot(N, L) > 0.0) {
            shadow = mix(1.0, directionalShadow(i, worldPos, N, L, rotation), receiveShadow * dl.direction.w);
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
        if (pl.flags.x > 0.0 && receiveShadow > 0.0 && attn > 0.0 && dot(N, L) > 0.0) {
            // the face is chosen by where the lookup lands (off the surface), not by the surface point itself
            let lf    = shadowLookup(worldPos, N, L, 2.0 * dist * ${pointFaceScale(sizes.point).toFixed(6)} / f32(${sizes.point}), pl.shadowBias) - pl.position.xyz;
            let absLF = abs(lf);
            var faceIdx: i32;
            if (absLF.x >= absLF.y && absLF.x >= absLF.z) {
                faceIdx = select(1, 0, lf.x > 0.0);
            } else if (absLF.y >= absLF.z) {
                faceIdx = select(3, 2, lf.y > 0.0);
            } else {
                faceIdx = select(5, 4, lf.z > 0.0);
            }
            let layer = i32(i) * 6 + faceIdx;
            // a face a little over 90° wide: a texel spans 2 · scale · depth / size, the depth being the largest axis
            let texel = 2.0 * ${pointFaceScale(sizes.point).toFixed(6)} * max(absLF.x, max(absLF.y, absLF.z)) / f32(${sizes.point});
            let raw   = perspectiveShadow(pointShadowMaps, layer, pointShadowMatrices.matrices[layer], worldPos, N, L, texel, pl.shadow, pl.shadowBias, f32(${sizes.point}), rotation);
            shadow    = mix(1.0, raw, receiveShadow * pl.flags.x);
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
        let spotAttn = smoothstep(sl.angles.y, sl.angles.x, theta);
        var shadow = 1.0;
        if (sl.direction.w > 0.0 && receiveShadow > 0.0 && attn * spotAttn > 0.0 && dot(N, L) > 0.0) {
            // the cone spans 2 · tan(outer) · depth over the map
            let cosOuter = max(sl.angles.y, 0.01);
            let depth    = dot(-toLight, normalize(sl.direction.xyz));
            let texel    = 2.0 * depth * sqrt(1.0 - cosOuter * cosOuter) / cosOuter / f32(${sizes.spot});
            let raw = perspectiveShadow(spotShadowMaps, i32(i), sl.lightSpaceMatrix, worldPos, N, L, texel, sl.shadow, sl.shadowBias, f32(${sizes.spot}), rotation);
            shadow = mix(1.0, raw, receiveShadow * sl.direction.w);
        }
        colour += brdf_direct(N, V, L, albedo, roughness, metallic, F0, NdotV)
                  * sl.colorIntensity.rgb * (sl.colorIntensity.w * attn * attn * spotAttn * shadow);
    }
    if (lighting.cameraForward.w > 0.5 && lighting.counts.x > 0u && lighting.directionalLights[0].direction.w > 0.5) {
        // debug: tint by the first directional light's cascade (red, green, blue, yellow; none past the last)
        let dl = lighting.directionalLights[0];
        let viewDepth = dot(worldPos - lighting.cameraPosition.xyz, lighting.cameraForward.xyz);
        var tint = vec3<f32>(1.0);
        for (var k = u32(dl.shadow.y); k > 0u; k--) {
            if (viewDepth < dl.splits[k - 1u]) {
                tint = array<vec3<f32>, 4>(
                    vec3<f32>(1.0, 0.35, 0.35), vec3<f32>(0.35, 1.0, 0.35),
                    vec3<f32>(0.35, 0.5, 1.0), vec3<f32>(1.0, 1.0, 0.35))[k - 1u];
            }
        }
        colour *= tint;
    }
    return colour;
}
`;
}

function buildLightingShader(encode: boolean, sizes: ShadowSizes): string {
    return /* wgsl */ `
${COLOR_WGSL}
${COVERAGE_AO_WGSL}
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

${shadeWgsl(sizes)}

fn sampleBgMap(dir: vec3<f32>) -> vec3<f32> {
    return textureSampleLevel(backgroundMap, envSampler, sampleEquirect(dir), 0.0).rgb;
}

@fragment
fn fs_main(input: QuadInput) -> @location(0) vec4<f32> {
    let coord   = vec2<i32>(i32(input.pos.x), i32(input.pos.y));
    let albedo4 = textureLoad(albedoTex, coord, 0);
    if (albedo4.a < AO_FLOOR * 0.5) {
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
        decodeCoverageAo(albedo4.a),
        normalize(normalSample.xyz),
        normalSample.w,
        clamp(posSample.w, 0.0, 1.0),
        posSample.xyz,
        emissiveSample.w,
        input.pos.xy,
    );
    return outputColor(colour + emissiveSample.rgb);
}
`;
}

// ─── GPU resources ────────────────────────────────────────────────────────────

/** One per Geometry, shared by every mesh drawing it. */
interface GeometryGPUResources {
    /** The geometry's version these buffers hold (see Geometry.markChanged). */
    version: number;
    /** The last frame a mesh drew it: unused entries are released. */
    lastFrame: number;
    vertexBuffer: GPUBuffer;
    /** Joints and weights (24 bytes a vertex), for skinned geometry. */
    skinBuffer: GPUBuffer | null;
    /** Second UV set and vertex colors (24 bytes a vertex), when the geometry has either. */
    extrasBuffer: GPUBuffer | null;
    /** Morph target deltas (storage, 32 bytes a vertex per target). */
    morphBuffer: GPUBuffer | null;
    indexBuffer: GPUBuffer;
    indexCount: number;
}

/** One per PBRMaterial: its uniforms (and what was last written to them) and its bind group. */
interface MaterialGPUResources {
    buffer: GPUBuffer;
    uniforms: Float32Array;
    /** The maps the bind group was built with, and their samplers' keys. */
    maps: (Texture | null)[];
    samplerKeys: number[];
    bindGroup: GPUBindGroup | null;
    lastFrame: number;
}

const WRAP_CODES: Record<WrapMode, number> = {repeat: 0, clamp: 1, mirror: 2};

function anisotropyOf(s: TextureSampling | undefined): number {
    return Math.min(Math.max(Math.round(s?.anisotropy ?? 8), 1), 16);
}

/** A number naming a texture's sampling settings (no texture: the default ones). */
function samplerKey(texture: Texture | null): number {
    const s = texture?.sampling;
    if (s === undefined) {
        return WRAP_CODES.repeat | (WRAP_CODES.repeat << 2) | (anisotropyOf(undefined) << 6);
    }
    return (
        (WRAP_CODES[s.wrapU] ?? 0) |
        ((WRAP_CODES[s.wrapV] ?? 0) << 2) |
        ((s.magFilter === "nearest" ? 1 : 0) << 4) |
        ((s.minFilter === "nearest" ? 1 : 0) << 5) |
        (anisotropyOf(s) << 6)
    );
}

/** Cache entries unused this many frames (about two seconds at 60 Hz) are released. */
const EVICT_AFTER_FRAMES = 120;

function destroyGeometryResources(res: GeometryGPUResources): void {
    res.vertexBuffer.destroy();
    res.skinBuffer?.destroy();
    res.extrasBuffer?.destroy();
    res.morphBuffer?.destroy();
    res.indexBuffer.destroy();
}

function destroyMeshResources(res: MeshGPUResources): void {
    res.modelBuffer.destroy();
    res.jointBuffer?.destroy();
    res.morphWeightBuffer?.destroy();
}

function destroyMaterialResources(res: MaterialGPUResources): void {
    res.buffer.destroy();
}

/** One per Mesh: its geometry's buffers, its model uniforms and, skinned, its joint matrices. */
interface MeshGPUResources {
    geometry: Geometry;
    /** The last frame it was drawn: unused entries are released. */
    lastFrame: number;
    vertexBuffer: GPUBuffer;
    skinBuffer: GPUBuffer | null;
    extrasBuffer: GPUBuffer | null;
    indexBuffer: GPUBuffer;
    indexCount: number;
    modelBuffer: GPUBuffer;
    modelBindGroup: GPUBindGroup;
    /** Skinned meshes: joint matrices (storage), sized for `jointCount`. */
    jointBuffer: GPUBuffer | null;
    jointCount: number;
    /** Morphed meshes: this frame's active (target index, weight) pairs (storage). */
    morphWeightBuffer: GPUBuffer | null;
    /** Drawn with its geometry's morph targets. */
    morphed: boolean;
    /** This frame's world transform mirrors (set with the model uniforms). */
    mirrored: boolean;
}

/** The interleaved vertex buffer (position, normal, uv, tangent; 48 bytes), with only `locations` read. */
function vertexLayout(locations: readonly number[]): GPUVertexBufferLayout {
    const all: GPUVertexAttribute[] = [
        {shaderLocation: 0, offset: 0, format: "float32x3"},
        {shaderLocation: 1, offset: 12, format: "float32x3"},
        {shaderLocation: 2, offset: 24, format: "float32x2"},
        {shaderLocation: 3, offset: 32, format: "float32x4"},
    ];
    return {arrayStride: 48, attributes: all.filter((a) => locations.includes(a.shaderLocation))};
}

/** Sets a mesh's vertex buffers in the order meshVertexLayouts declares them. */
function bindMeshBuffers(pass: GPURenderPassEncoder, res: MeshGPUResources): void {
    pass.setVertexBuffer(0, res.vertexBuffer);
    let slot = 1;
    if (res.skinBuffer !== null) {
        pass.setVertexBuffer(slot++, res.skinBuffer);
    }
    if (res.extrasBuffer !== null) {
        pass.setVertexBuffer(slot, res.extrasBuffer);
    }
}

/** A mesh pipeline's vertex buffers: the interleaved one, then the skin's, then the extra stream, as present. */
function meshVertexLayouts(f: GBufferFeatures): GPUVertexBufferLayout[] {
    return [vertexLayout([0, 1, 2, 3]), ...(f.skinned ? [SKIN_LAYOUT] : []), ...(f.extras ? [EXTRAS_LAYOUT] : [])];
}

/** The skin buffer: 4 × uint16 joints at location 4, 4 × float32 weights at location 5. */
const SKIN_LAYOUT: GPUVertexBufferLayout = {
    arrayStride: 24,
    attributes: [
        {shaderLocation: 4, offset: 0, format: "uint16x4"},
        {shaderLocation: 5, offset: 8, format: "float32x4"},
    ],
};

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
    /**
     * Texels per side of each directional cascade and spot light shadow map. Default 1024: sharper costs memory
     * (4 bytes a texel, per cascade) and shadow-pass fill.
     */
    shadowMapSize?: number;
    /** Texels per side of each of a point light's six shadow maps. Default 512. */
    pointShadowMapSize?: number;
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
    /** Debug: tint the scene by the first directional light's shadow cascade (red, green, blue, yellow). */
    debugCascades = false;
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
    /** Model bind group layouts by "skinned:morphed": the uniforms, plus joint matrices and / or morph deltas. */
    private readonly modelLayouts = new Map<string, GPUBindGroupLayout>();
    /** G-buffer and forward pipeline layouts by kind and model layout. */
    private readonly pipelineLayouts = new Map<string, GPUPipelineLayout>();
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
    private envSampler!: GPUSampler;
    /** Material samplers by their settings' key (see samplerKey). */
    private readonly samplers = new Map<number, GPUSampler>();

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

    private readonly shadowSizes: ShadowSizes;
    /** Per directional light (by index): its cascades this frame and its first layer in dirShadowTex. */
    private readonly dirShadows: {cascades: Cascade[]; count: number; firstLayer: number}[] = [];
    private dirShadowLayers = 0;
    /** This frame's shadow casters: draw state and world bounding sphere (for culling per cascade). */
    private readonly casters: {
        res: MeshGPUResources;
        pipeline: GPURenderPipeline;
        material: GPUBindGroup | null;
        /** Its pipeline reads the extra vertex stream (alpha-tested with vertex colors or a second UV set). */
        extras: boolean;
        /** The mesh's layers, against each light's shadow.layers. */
        layers: number;
        rank: number;
        center: vec3;
        radius: number;
    }[] = [];
    private readonly lightViewMatrix = mat4.create();
    private readonly tmpLight = vec3.create();
    private readonly lightingData = new ArrayBuffer(LIGHTING_BUFFER_SIZE);
    private readonly lightingF32 = new Float32Array(this.lightingData);
    private readonly lightingU32 = new Uint32Array(this.lightingData);

    // Per-frame scratch, reused: no allocation per mesh per frame
    private readonly opaqueDraws: {mesh: Mesh; material: PBRMaterial; features: GBufferFeatures; key: string}[] = [];
    private readonly blendDraws: {mesh: Mesh; depth: number}[] = [];
    private readonly modelData = new Float32Array(MODEL_UNIFORMS_SIZE / 4);
    private morphPairs = new Float32Array(16);
    private readonly normalMatrix = mat4.create();
    private readonly tmpCenter = vec3.create();
    private readonly tmpEye = vec3.create();
    private readonly cameraData = new Float32Array(208 / 4);
    private readonly warnedLights = new Set<string>();
    /** This frame's camera view-projection, for culling. */
    private readonly viewProjection = mat4.create();
    private readonly materialScratch = new Float32Array(MATERIAL_BUFFER_SIZE / 4);
    private readonly tmpForward = vec3.create();

    // Cached GPU resources: vertex data per geometry (shared), uniforms per mesh
    private geometryCache = new Map<Geometry, GeometryGPUResources>();
    private meshCache = new Map<Mesh, MeshGPUResources>();
    private materialCache = new Map<PBRMaterial, MaterialGPUResources>();
    /** Frames rendered: cache entries remember when they were last used. */
    private frame = 0;

    constructor({
        scene,
        colorFormat = "rgba16float",
        colorSpace = "linear-srgb",
        shadowMapSize = 1024,
        pointShadowMapSize = 512,
    }: DeferredScenePassOptions) {
        super();
        this.scene = scene;
        this.shadowSizes = {directional: shadowMapSize, spot: shadowMapSize, point: pointShadowMapSize};
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
        this.frame++;
        if (this.frame % 60 === 0) {
            this.evictUnused();
        }

        this.scene.updateWorldMatrices();
        // the camera may be outside the scene's tree (never added): its world matrix comes from its own parents
        const activeCamera = this.scene.activeCamera;
        activeCamera?.computeWorldMatrix(activeCamera.worldMatrix);

        // drawn: what the camera's layers show; casting: any mesh with castShadow, seen or not (a shadow-only mesh
        // sits on a layer the camera hides)
        const visible = this.scene.activeCamera?.visibleLayers ?? 0xffffffff;
        const all = this.scene.collectMeshes().filter((m) => (m.layers & visible) !== 0 || m.castShadow);
        const meshes = all.filter((m) => (m.layers & visible) !== 0);
        const dirLights = this.keepLights(this.scene.collectDirectionalLights(), MAX_DIRECTIONAL, "directional");
        const pointLights = this.keepLights(this.scene.collectPointLights(), MAX_POINT, "point");
        const spotLights = this.keepLights(this.scene.collectSpotLights(), MAX_SPOT, "spot");

        const spotMatrices = spotLights.map((l) => (l.castShadow ? this.computeSpotLightMatrix(l) : null));
        const pointMatrices = pointLights.map((l) => (l.castShadow ? this.computePointLightFaceMatrices(l) : null));

        this.ensureMeshResources(all);
        // model uniforms and joint matrices first: casters and draws below read the final resources
        for (const mesh of all) {
            const res = this.meshCache.get(mesh);
            if (res) {
                if (res.jointBuffer !== null) {
                    this.uploadJoints(mesh as SkinnedMesh, res); // first: the model uniforms read them
                }
                this.uploadModelUniforms(this.meshCache.get(mesh)!, mesh);
            }
        }
        this.uploadCameraUniforms(this.scene.activeCamera, ctx.width, ctx.height);
        this.collectCasters(all);
        this.fitDirectionalShadows(dirLights);
        this.uploadLightingUniforms(dirLights, pointLights, spotLights, spotMatrices);
        this.uploadPointShadowMatrices(pointLights, pointMatrices);

        this.renderShadowMaps(encoder, dirLights, pointLights, spotLights, pointMatrices, spotMatrices);
        this.sortDraws(meshes);
        this.renderGBuffer(encoder, ctx);
        this.renderLighting(encoder, ctx);
        if (this.blendDraws.length > 0) {
            this.renderTransparent(encoder, ctx);
        }
    }

    /**
     * Opaque and masked meshes go to the G-buffer, grouped by pipeline so each variant is bound once. See-through
     * ("blend") meshes are drawn after lighting, farthest first, by their bounds' center depth along the view.
     */
    private sortDraws(meshes: Mesh[]): void {
        const opaque = this.opaqueDraws;
        const blend = this.blendDraws;
        opaque.length = 0;
        blend.length = 0;
        const camera = this.scene.activeCamera;
        const eye = camera ? mat4.getTranslation(this.tmpEye, camera.worldMatrix) : vec3.set(this.tmpEye, 0, 0, 0);
        // depth along the view axis (not distance): right for orthographic cameras and wide panes alike
        const w = camera?.worldMatrix;
        const forward = w ? vec3.set(this.tmpForward, -w[8]!, -w[9]!, -w[10]!) : vec3.set(this.tmpForward, 0, 0, -1);
        const culling = camera !== null;
        for (const mesh of meshes) {
            if (!(mesh.material instanceof PBRMaterial)) {
                continue;
            }
            // outside the camera's view: not drawn (its shadow still is, by the shadow passes' own culling)
            const radius = this.meshBounds(mesh, this.tmpCenter);
            if (culling && mesh.frustumCulled && !sphere.inFrustum(this.tmpCenter, radius, this.viewProjection)) {
                continue;
            }
            if (mesh.material.alphaMode === "blend") {
                blend.push({mesh, depth: vec3.dot(vec3.subtract(this.tmpCenter, this.tmpCenter, eye), forward)});
            } else {
                const mirrored = this.meshCache.get(mesh)?.mirrored ?? false;
                const features = getGBufferFeatures(
                    mesh.material,
                    isSkinned(mesh),
                    isMorphed(mesh),
                    mirrored,
                    mesh.geometry.hasExtras,
                );
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
        this.meshCache.forEach(destroyMeshResources);
        this.meshCache.clear();
        this.materialCache.forEach(destroyMaterialResources);
        this.materialCache.clear();
        this.geometryCache.forEach(destroyGeometryResources);
        this.geometryCache.clear();
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
                // a sampler per map after the albedo's (binding 2): normal, emissive, metallic-roughness, height,
                // occlusion
                ...[8, 9, 10, 11, 12].map((binding) => ({
                    binding,
                    visibility: GPUShaderStage.FRAGMENT,
                    sampler: {type: "filtering" as const},
                })),
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

        this.texSampler = this.samplerFor(null);
        // equirectangular maps wrap around in longitude only: repeating in latitude would blend the poles
        this.envSampler = device.createSampler({
            label: "DeferredScene:environment",
            magFilter: "linear",
            minFilter: "linear",
            addressModeU: "repeat",
            addressModeV: "clamp-to-edge",
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
            code: buildLightingShader(this.outputColorSpace === "srgb", this.shadowSizes),
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
            depthStencil: SHADOW_DEPTH_STATE,
            // the faces toward the light: a shadow starts where the caster does, so objects resting on a surface
            // stay grounded (the normal offset and slope bias keep lit faces from shadowing themselves)
            primitive: {topology: "triangle-list", cullMode: "back"},
        });
    }

    /** The model bind group layout: uniforms (0), joint matrices (1) if skinned, morph deltas (2) if morphed. */
    private modelLayout(skinned: boolean, morphed: boolean): GPUBindGroupLayout {
        if (!skinned && !morphed) {
            return this.modelBindGroupLayout;
        }
        const key = `${skinned}:${morphed}`;
        let layout = this.modelLayouts.get(key);
        if (layout === undefined) {
            layout = this.device.createBindGroupLayout({
                label: `DeferredScene:modelLayout[${key}]`,
                entries: [
                    {
                        binding: 0,
                        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                        buffer: {type: "uniform"},
                    },
                    ...(skinned
                        ? [
                              {
                                  binding: 1,
                                  visibility: GPUShaderStage.VERTEX,
                                  buffer: {type: "read-only-storage" as const},
                              },
                          ]
                        : []),
                    ...(morphed
                        ? [2, 3].map((binding) => ({
                              binding,
                              visibility: GPUShaderStage.VERTEX,
                              buffer: {type: "read-only-storage" as const},
                          }))
                        : []),
                ],
            });
            this.modelLayouts.set(key, layout);
        }
        return layout;
    }

    /** The G-buffer or forward pipeline layout for a model layout. */
    private pipelineLayout(kind: "gbuffer" | "forward", skinned: boolean, morphed: boolean): GPUPipelineLayout {
        if (!skinned && !morphed) {
            return kind === "gbuffer" ? this.gbufferPipelineLayout : this.forwardPipelineLayout;
        }
        const key = `${kind}:${skinned}:${morphed}`;
        let layout = this.pipelineLayouts.get(key);
        if (layout === undefined) {
            const groups = [
                this.cameraBindGroupLayout,
                this.modelLayout(skinned, morphed),
                this.materialBindGroupLayout,
            ];
            layout = this.device.createPipelineLayout({
                bindGroupLayouts: kind === "gbuffer" ? groups : [...groups, this.forwardLightingLayout],
            });
            this.pipelineLayouts.set(key, layout);
        }
        return layout;
    }

    /** The shadow pipeline for a caster: depth only when opaque, alpha-tested for mask / blend, skinned or not. */
    private shadowPipelineFor(
        material: PBRMaterial | null,
        skinned = false,
        morphed = false,
        mirrored = false,
        hasExtras = false,
    ): GPURenderPipeline {
        const alpha = material?.alphaMode ?? "opaque";
        const side = material?.shadowSide ?? (material?.doubleSided ? "both" : "front");
        // only alpha-tested casters read vertex colors / the second UV set
        const extras = hasExtras && alpha !== "opaque";
        if (alpha === "opaque" && side === "front" && !skinned && !morphed && !mirrored) {
            return this.shadowPipeline;
        }
        const key =
            alpha +
            (side === "both" ? "2" : side === "back" ? "B" : "") +
            (skinned ? "S" : "") +
            (morphed ? "T" : "") +
            (mirrored ? "X" : "") +
            (extras ? "E" : "");
        let pipeline = this.shadowPipelines.get(key);
        if (pipeline === undefined) {
            const modelLayout = this.modelLayout(skinned, morphed);
            const skin = skinned ? [SKIN_LAYOUT] : [];
            const opaque = alpha === "opaque";
            const module = this.device.createShaderModule({
                label: `Shadow[${key}]`,
                code: opaque
                    ? buildShadowShader(skinned, morphed)
                    : buildAlphaShadowShader(alpha, skinned, morphed, extras),
            });
            pipeline = this.device.createRenderPipeline({
                label: `DeferredScene:shadow[${key}]`,
                layout: this.device.createPipelineLayout({
                    bindGroupLayouts: opaque
                        ? [this.shadowLightBindGroupLayout, modelLayout]
                        : [this.shadowLightBindGroupLayout, modelLayout, this.materialBindGroupLayout],
                }),
                vertex: {
                    module,
                    entryPoint: "vs_shadow",
                    buffers: [vertexLayout(opaque ? [0] : [0, 2]), ...skin, ...(extras ? [EXTRAS_LAYOUT] : [])],
                },
                ...(opaque ? {} : {fragment: {module, entryPoint: "fs_shadow", targets: []}}),
                depthStencil: SHADOW_DEPTH_STATE,
                primitive: {
                    topology: "triangle-list",
                    // the shadow pass keeps faces turned toward the light ("front") by culling the others
                    cullMode: side === "both" ? "none" : side === "back" ? "front" : "back",
                    frontFace: frontFace(mirrored),
                },
            });
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
                code: buildForwardShader(features, this.outputColorSpace === "srgb", this.shadowSizes),
            });
            pipeline = this.device.createRenderPipeline({
                label: `DeferredScene:forward[${key}]`,
                layout: this.pipelineLayout("forward", !!features.skinned, !!features.morphed),
                vertex: {
                    module,
                    entryPoint: "vs_main",
                    buffers: meshVertexLayouts(features),
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
                primitive: {topology: "triangle-list", cullMode, frontFace: frontFace(features.mirrored)},
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
                layout: this.pipelineLayout("gbuffer", !!features.skinned, !!features.morphed),
                vertex: {
                    module,
                    entryPoint: "vs_main",
                    buffers: meshVertexLayouts(features),
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
                primitive: {
                    topology: "triangle-list",
                    cullMode: features.doubleSided ? "none" : "back",
                    frontFace: frontFace(features.mirrored),
                },
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

        // directional cascades: one layer to start, grown to what the lights use (see fitDirectionalShadows)
        this.dirShadowLayers = 1;
        this.dirShadowTex = makeDepthArray(1, this.shadowSizes.directional, "Shadow:directional");
        this.spotShadowTex = makeDepthArray(MAX_SPOT, this.shadowSizes.spot, "Shadow:spot");
        this.pointShadowTex = makeDepthArray(MAX_POINT * 6, this.shadowSizes.point, "Shadow:point");

        this.shadowSampler = device.createSampler({
            label: "DeferredScene:shadowSampler",
            compare: "less",
            magFilter: "linear",
            minFilter: "linear",
            addressModeU: "clamp-to-edge",
            addressModeV: "clamp-to-edge",
        });

        for (let i = 0; i < MAX_DIRECTIONAL * MAX_CASCADES; i++) {
            const buf = device.createBuffer({
                label: `Shadow:dirLayer${i}`,
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

        this.shadowBindGroup = this.createShadowBindGroup();
    }

    private createShadowBindGroup(): GPUBindGroup {
        return this.device.createBindGroup({
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

    /**
     * This frame's shadow casters, opaque (the common, cheap case) first and then grouped by pipeline variant,
     * with their world bounding spheres.
     */
    private collectCasters(meshes: Mesh[]): void {
        const casters = this.casters;
        let n = 0;
        const ranks = new Map<GPURenderPipeline, number>([[this.shadowPipeline, 0]]);
        for (const mesh of meshes) {
            const res = this.meshCache.get(mesh);
            if (!mesh.castShadow || !res) {
                continue;
            }
            const material = mesh.material instanceof PBRMaterial ? mesh.material : null;
            const extras = res.extrasBuffer !== null && material !== null && material.alphaMode !== "opaque";
            const pipeline = this.shadowPipelineFor(
                material,
                res.jointBuffer !== null,
                res.morphed,
                res.mirrored,
                res.extrasBuffer !== null,
            );
            let rank = ranks.get(pipeline);
            if (rank === undefined) {
                rank = ranks.size;
                ranks.set(pipeline, rank);
            }
            const caster = (casters[n++] ??= {
                res,
                pipeline,
                material: null,
                extras: false,
                layers: 0,
                rank,
                center: vec3.create(),
                radius: 0,
            });
            caster.res = res;
            caster.pipeline = pipeline;
            caster.rank = rank;
            caster.extras = extras;
            caster.layers = mesh.layers;
            caster.material =
                material !== null && material.alphaMode !== "opaque" ? this.materialBindGroup(material) : null;
            caster.radius = this.meshBounds(mesh, caster.center);
        }
        casters.length = n;
        casters.sort((a, b) => a.rank - b.rank);
    }

    /** Fits each shadowed directional light's cascades to the camera and gives them layers of dirShadowTex. */
    private fitDirectionalShadows(dirLights: DirectionalLight[]): void {
        const camera = this.scene.activeCamera as (Camera & {near?: number; far?: number}) | null;
        let layer = 0;
        for (let i = 0; i < dirLights.length; i++) {
            const light = dirLights[i]!;
            const state = (this.dirShadows[i] ??= {cascades: [], count: 0, firstLayer: 0});
            state.count = 0;
            if (!light.castShadow || camera === null) {
                continue;
            }
            const direction = worldForward(light.worldMatrix, this.tmpLight);
            let casterStart = Infinity;
            for (const caster of this.casters) {
                casterStart = Math.min(casterStart, vec3.dot(caster.center, direction) - caster.radius);
            }
            if (casterStart === Infinity) {
                continue; // nothing casts
            }
            state.count = fitCascades(state.cascades, {
                invViewProjection: this.currentInvVP,
                near: camera.near ?? 0.1,
                far: camera.far ?? 1000,
                lightDirection: direction,
                cascades: light.shadow.cascades,
                maxDistance: light.shadow.maxDistance,
                splitBalance: light.shadow.splitBalance,
                mapSize: this.shadowSizes.directional,
                casterStart,
            });
            state.firstLayer = layer;
            layer += state.count;
        }
        if (layer > this.dirShadowLayers) {
            // grow (never shrink: a light toggling its shadow shouldn't reallocate every time)
            this.dirShadowTex.destroy();
            this.dirShadowLayers = layer;
            this.dirShadowTex = this.device.createTexture({
                label: "Shadow:directional",
                size: {
                    width: this.shadowSizes.directional,
                    height: this.shadowSizes.directional,
                    depthOrArrayLayers: layer,
                },
                format: "depth32float",
                usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
            });
            this.shadowBindGroup = this.createShadowBindGroup();
            this.forwardLightingBindGroup = null;
        }
    }

    private renderShadowMaps(
        encoder: GPUCommandEncoder,
        dirLights: DirectionalLight[],
        pointLights: PointLight[],
        spotLights: SpotLight[],
        pointMatrices: (mat4[] | null)[],
        spotMatrices: (mat4 | null)[],
    ): void {
        const casters = this.casters;

        /** Draws the casters; `keep` culls them (a cascade skips what can't shadow its slice). */
        const drawShadowMeshes = (
            pass: GPURenderPassEncoder,
            lightBindGroup: GPUBindGroup,
            layers: number,
            keep?: (caster: (typeof casters)[number]) => boolean,
        ) => {
            let bound: GPURenderPipeline | null = null;
            for (const caster of casters) {
                if ((caster.layers & layers) === 0 || (keep !== undefined && !keep(caster))) {
                    continue;
                }
                const {res, pipeline, material} = caster;
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
                if (res.skinBuffer !== null) {
                    pass.setVertexBuffer(1, res.skinBuffer);
                }
                if (caster.extras) {
                    pass.setVertexBuffer(res.skinBuffer !== null ? 2 : 1, res.extrasBuffer);
                }
                pass.setIndexBuffer(res.indexBuffer, "uint32");
                pass.drawIndexed(res.indexCount);
            }
        };

        const lightSpace = this.tmpCenter;
        for (let i = 0; i < dirLights.length; i++) {
            const state = this.dirShadows[i];
            if (state === undefined || state.count === 0) {
                continue;
            }
            lightView(this.lightViewMatrix, worldForward(dirLights[i]!.worldMatrix, this.tmpLight));
            for (let c = 0; c < state.count; c++) {
                const cascade = state.cascades[c]!;
                const layer = state.firstLayer + c;
                this.device.queue.writeBuffer(this.dirShadowLightBuffers[layer]!, 0, cascade.matrix as Float32Array);
                const pass = encoder.beginRenderPass({
                    label: `Shadow:dir${i}c${c}`,
                    colorAttachments: [],
                    depthStencilAttachment: {
                        view: this.dirShadowTex.createView({
                            dimension: "2d",
                            baseArrayLayer: layer,
                            arrayLayerCount: 1,
                        }),
                        depthClearValue: 1.0,
                        depthLoadOp: "clear",
                        depthStoreOp: "store",
                    },
                });
                // only casters whose bounds overlap the cascade's square, seen from the light
                drawShadowMeshes(pass, this.dirShadowLightBGs[layer]!, dirLights[i]!.shadow.layers, (caster) => {
                    vec3.transformMat4(lightSpace, caster.center, this.lightViewMatrix);
                    const reach = cascade.radius + caster.radius;
                    return (
                        Math.abs(lightSpace[0] - cascade.center[0]) <= reach &&
                        Math.abs(lightSpace[1] - cascade.center[1]) <= reach &&
                        -lightSpace[2] - caster.radius <= -cascade.center[2] + cascade.radius
                    );
                });
                pass.end();
            }
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
                // only casters this face (a frustum out to the light's range) can see
                const face = faceMatrices[f]!;
                drawShadowMeshes(pass, this.pointShadowFaceBGs[slot]!, pointLights[i]!.shadow.layers, (caster) =>
                    sphere.inFrustum(caster.center, caster.radius, face),
                );
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
            drawShadowMeshes(pass, this.spotShadowLightBGs[i]!, spotLights[i]!.shadow.layers, (caster) =>
                sphere.inFrustum(caster.center, caster.radius, lsMatrix),
            );
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

            const matBg = this.materialBindGroup(material);

            pass.setBindGroup(1, res.modelBindGroup);
            pass.setBindGroup(2, matBg);
            bindMeshBuffers(pass, res);
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
                {binding: 6, resource: this.envSampler},
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
                    {binding: 2, resource: this.envSampler},
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
            const features = getGBufferFeatures(
                material,
                res.jointBuffer !== null,
                res.morphed,
                res.mirrored,
                res.extrasBuffer !== null,
            );
            pass.setBindGroup(1, res.modelBindGroup);
            pass.setBindGroup(2, this.materialBindGroup(material));
            bindMeshBuffers(pass, res);
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
        mat4.copy(this.viewProjection, vpMatrix);

        const data = this.cameraData;
        data.set(viewMatrix, 0);
        data.set(projMatrix, 16);
        data.set(vpMatrix, 32);
        data[48] = camPos[0];
        data[49] = camPos[1];
        data[50] = camPos[2];
        data[51] = 1.0;

        this.device.queue.writeBuffer(this.cameraBuffer, 0, data);
    }

    private uploadModelUniforms(res: MeshGPUResources, mesh: Mesh): void {
        // A skinned mesh's joint matrices are already in world space (glTF: the skin, not the mesh node, places
        // the vertices), so its model matrix is identity. Its mirroring is its joints' (the first stands for all).
        const skinned = res.jointBuffer !== null;
        const model = skinned ? IDENTITY : mesh.worldMatrix;
        const normalMatrix = this.normalMatrix;
        // a collapsed (zero-scale) transform has no inverse: identity rather than the previous mesh's matrix
        if (mat4.invert(normalMatrix, model) === null) {
            mat4.identity(normalMatrix);
        }
        mat4.transpose(normalMatrix, normalMatrix);
        const joints = (mesh as SkinnedMesh).jointMatrices;
        res.mirrored = skinned ? joints.length >= 16 && isMirrored(joints) : isMirrored(model);

        const data = this.modelData;
        data.set(model, 0);
        data.set(normalMatrix, 16);
        data[32] = mesh.receiveShadow ? 1.0 : 0.0;
        // morph targets: the ones with a weight, as (index, weight) pairs; their count and the vertex count here
        let active = 0;
        if (res.morphWeightBuffer !== null) {
            const targets = mesh.geometry.morphTargets!.length;
            const pairs =
                this.morphPairs.length >= targets * 2
                    ? this.morphPairs
                    : (this.morphPairs = new Float32Array(targets * 2));
            for (let t = 0; t < targets; t++) {
                const w = mesh.morphWeights[t] ?? 0;
                if (w !== 0) {
                    pairs[active * 2] = t;
                    pairs[active * 2 + 1] = w;
                    active++;
                }
            }
            if (active > 0) {
                this.device.queue.writeBuffer(res.morphWeightBuffer, 0, pairs, 0, active * 2);
            }
        }
        data[36] = active;
        data[37] = mesh.geometry.vertexCount;
        this.device.queue.writeBuffer(res.modelBuffer, 0, data);
    }

    private uploadLightingUniforms(
        dirLights: DirectionalLight[],
        pointLights: PointLight[],
        spotLights: SpotLight[],
        spotMatrices: (mat4 | null)[],
    ): void {
        const data = this.lightingData;
        const f32 = this.lightingF32;
        const u32 = this.lightingU32;
        f32.fill(0);

        const ambient = this.scene.ambientColor;
        f32[0] = srgbToLinear(ambient[0]);
        f32[1] = srgbToLinear(ambient[1]);
        f32[2] = srgbToLinear(ambient[2]);
        f32[3] = 1.0;

        const cam = this.scene.activeCamera;
        const cp = cam ? mat4.getTranslation(this.tmpLight, cam.worldMatrix) : vec3.set(this.tmpLight, 0, 0, 0);
        f32[4] = cp[0];
        f32[5] = cp[1];
        f32[6] = cp[2];
        f32[7] = 1.0;

        u32[8] = dirLights.length;
        u32[9] = pointLights.length;
        u32[10] = spotLights.length;

        for (let i = 0; i < dirLights.length; i++) {
            const base = DIR_BASE + i * DIR_STRIDE;
            const l = dirLights[i]!;
            const state = this.dirShadows[i];
            const shadowed = l.castShadow && state !== undefined && state.count > 0;
            const dir = worldForward(l.worldMatrix, tmpDir);
            f32[base + 0] = dir[0];
            f32[base + 1] = dir[1];
            f32[base + 2] = dir[2];
            f32[base + 3] = shadowed ? shadowStrength(l) : 0.0;
            f32[base + 4] = srgbToLinear(l.color[0]);
            f32[base + 5] = srgbToLinear(l.color[1]);
            f32[base + 6] = srgbToLinear(l.color[2]);
            f32[base + 7] = l.intensity;
            if (!shadowed) {
                continue;
            }
            const sh = l.shadow;
            f32[base + 8] = state.firstLayer;
            f32[base + 9] = state.count;
            f32[base + 10] = Math.tan(((sh.softness / 2) * Math.PI) / 180); // angular diameter in degrees
            f32[base + 11] = Math.max(1, Math.round(sh.samples));
            f32[base + 12] = sh.normalBias;
            f32[base + 13] = sh.bias;
            f32[base + 14] = sh.cascadeBlend === "smooth" ? 1 : sh.cascadeBlend === "dither" ? 2 : 0;
            f32[base + 15] = state.cascades[state.count - 1]!.far;
            for (let c = 0; c < state.count; c++) {
                const cascade = state.cascades[c]!;
                f32[base + 16 + c] = cascade.far;
                f32[base + 20 + c] = cascade.texel;
                f32[base + 24 + c] = cascade.depthRange;
                f32.set(cascade.matrix, base + 28 + c * 16);
            }
        }

        for (let i = 0; i < pointLights.length; i++) {
            const base = POINT_BASE + i * POINT_STRIDE;
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
            f32[base + 8] = l.castShadow ? shadowStrength(l) : 0.0;
            this.packPerspectiveShadow(f32, base + 12, l);
        }

        for (let i = 0; i < spotLights.length; i++) {
            const base = SPOT_BASE + i * SPOT_STRIDE;
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
            f32[base + 7] = l.castShadow ? shadowStrength(l) : 0.0;
            f32[base + 8] = srgbToLinear(l.color[0]);
            f32[base + 9] = srgbToLinear(l.color[1]);
            f32[base + 10] = srgbToLinear(l.color[2]);
            f32[base + 11] = l.intensity;
            const cone = spotCone(l);
            f32[base + 12] = Math.cos(cone.inner);
            f32[base + 13] = Math.cos(cone.outer);
            this.packPerspectiveShadow(f32, base + 16, l);
            if (lm) {
                f32.set(lm, base + 24);
            }
        }

        const bg = this.scene.backgroundColor;
        f32[BACKGROUND_SLOT] = srgbToLinear(bg[0]);
        f32[BACKGROUND_SLOT + 1] = srgbToLinear(bg[1]);
        f32[BACKGROUND_SLOT + 2] = srgbToLinear(bg[2]);
        f32[BACKGROUND_SLOT + 3] = 1.0;

        // Reflections sample the environment map times environmentColor. Without a map the sampled texel is a white
        // placeholder: reflect the ambient color instead (a uniform environment), not a white sky, which would rim
        // every object with a light outline at grazing angles.
        const env = this.scene.environmentColor;
        const sky = this.scene.environmentMap === null ? this.scene.ambientColor : null;
        f32[ENVIRONMENT_SLOT] = srgbToLinear(env[0]) * srgbToLinear(sky?.[0] ?? 1);
        f32[ENVIRONMENT_SLOT + 1] = srgbToLinear(env[1]) * srgbToLinear(sky?.[1] ?? 1);
        f32[ENVIRONMENT_SLOT + 2] = srgbToLinear(env[2]) * srgbToLinear(sky?.[2] ?? 1);
        f32[ENVIRONMENT_SLOT + 3] = 1.0;

        f32.set(this.currentInvVP, INV_VP_SLOT);
        if (cam) {
            const forward = worldForward(cam.worldMatrix, tmpDir);
            f32[CAMERA_FORWARD_SLOT] = forward[0];
            f32[CAMERA_FORWARD_SLOT + 1] = forward[1];
            f32[CAMERA_FORWARD_SLOT + 2] = forward[2];
            f32[CAMERA_FORWARD_SLOT + 3] = this.debugCascades ? 1 : 0;
        }

        this.device.queue.writeBuffer(this.lightingBuffer, 0, data);
    }

    /** A spot or point light's shadow settings: shadow (radius, samples, near, far) then shadowBias. */
    private packPerspectiveShadow(f32: Float32Array, at: number, light: PointLight | SpotLight): void {
        const sh = light.shadow;
        f32[at + 0] = sh.softness;
        f32[at + 1] = Math.max(1, Math.round(sh.samples));
        f32[at + 2] = shadowNear(light);
        f32[at + 3] = shadowFar(light);
        f32[at + 4] = sh.normalBias;
        f32[at + 5] = sh.bias;
    }

    // ─── Private: shadow matrix helpers ─────────────────────────────────────

    private computeSpotLightMatrix(light: SpotLight): mat4 {
        const wp = light.worldMatrix;
        const eye = vec3.fromValues(wp[12]!, wp[13]!, wp[14]!);
        const dir = worldForward(light.worldMatrix, vec3.create());
        const up = Math.abs(dir[1]) > 0.9 ? vec3.fromValues(1, 0, 0) : vec3.fromValues(0, 1, 0);
        const center = vec3.add(vec3.create(), eye, dir);

        const view = mat4.create();
        mat4.lookAt(view, eye, center, up);

        const proj = mat4.create();
        mat4.perspectiveZO(proj, spotCone(light).outer * 2, 1.0, shadowNear(light), shadowFar(light));

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
            mat4.perspectiveZO(
                proj,
                2 * Math.atan(pointFaceScale(this.shadowSizes.point)),
                1,
                shadowNear(light),
                shadowFar(light),
            );
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
            const res = this.meshCache.get(mesh);
            const skinned = isSkinned(mesh);
            const geo = this.geometryResources(mesh.geometry); // re-uploads an edited geometry
            if (
                res !== undefined &&
                res.geometry === mesh.geometry &&
                res.vertexBuffer === geo.vertexBuffer &&
                (res.jointBuffer !== null) === skinned
            ) {
                res.lastFrame = this.frame;
                continue;
            }
            // first draw, or its geometry or skinning changed
            if (res !== undefined) {
                destroyMeshResources(res);
            }
            this.meshCache.set(mesh, this.createMeshResources(mesh, skinned));
        }
    }

    /** Vertex, skin and index buffers, uploaded once per Geometry and shared by its meshes. */
    private geometryResources(geo: Geometry): GeometryGPUResources {
        let res = this.geometryCache.get(geo);
        if (res !== undefined && res.version !== geo.version) {
            // edited in place: new buffers (the meshes drawing it rebind)
            destroyGeometryResources(res);
            this.geometryCache.delete(geo);
            res = undefined;
        }
        if (res !== undefined) {
            res.lastFrame = this.frame;
        } else {
            const {device} = this;
            const interleaved = geo.buildInterleavedBuffer();
            const vertexBuffer = device.createBuffer({
                label: "Geometry:vertex",
                size: interleaved.byteLength,
                usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            });
            device.queue.writeBuffer(vertexBuffer, 0, interleaved);
            const skinData = geo.buildSkinBuffer();
            let skinBuffer: GPUBuffer | null = null;
            if (skinData !== null) {
                skinBuffer = device.createBuffer({
                    label: "Geometry:skin",
                    size: skinData.byteLength,
                    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
                });
                device.queue.writeBuffer(skinBuffer, 0, skinData);
            }
            let extrasBuffer: GPUBuffer | null = null;
            if (geo.hasExtras) {
                const extras = geo.buildExtrasBuffer();
                extrasBuffer = device.createBuffer({
                    label: "Geometry:extras",
                    size: extras.byteLength,
                    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
                });
                device.queue.writeBuffer(extrasBuffer, 0, extras);
            }
            const morphData = geo.buildMorphBuffer();
            let morphBuffer: GPUBuffer | null = null;
            if (morphData !== null) {
                morphBuffer = device.createBuffer({
                    label: "Geometry:morph",
                    size: morphData.byteLength,
                    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
                });
                device.queue.writeBuffer(morphBuffer, 0, morphData);
            }
            const indexBuffer = device.createBuffer({
                label: "Geometry:index",
                size: geo.indices.byteLength,
                usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
            });
            device.queue.writeBuffer(indexBuffer, 0, geo.indices);
            res = {
                version: geo.version,
                lastFrame: this.frame,
                vertexBuffer,
                skinBuffer,
                extrasBuffer,
                morphBuffer,
                indexBuffer,
                indexCount: geo.indexCount,
            };
            this.geometryCache.set(geo, res);
        }
        return res;
    }

    private createMeshResources(mesh: Mesh, skinned: boolean): MeshGPUResources {
        const {device} = this;
        const geo = this.geometryResources(mesh.geometry);
        const modelBuffer = device.createBuffer({
            label: "Mesh:model",
            size: MODEL_UNIFORMS_SIZE,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        const jointCount = skinned ? (mesh as SkinnedMesh).skin!.joints.length : 0;
        const jointBuffer = skinned
            ? device.createBuffer({
                  label: "Mesh:joints",
                  size: Math.max(1, jointCount) * 64,
                  usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
              })
            : null;
        const morphed = geo.morphBuffer !== null;
        // the active (target, weight) pairs: room for every target
        const morphWeightBuffer = morphed
            ? device.createBuffer({
                  label: "Mesh:morphWeights",
                  size: Math.max(1, mesh.geometry.morphTargets!.length) * 8,
                  usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
              })
            : null;
        const modelBindGroup = device.createBindGroup({
            label: "Mesh:modelBindGroup",
            layout: this.modelLayout(jointBuffer !== null, morphed),
            entries: [
                {binding: 0, resource: {buffer: modelBuffer}},
                ...(jointBuffer ? [{binding: 1, resource: {buffer: jointBuffer}}] : []),
                ...(morphed
                    ? [
                          {binding: 2, resource: {buffer: geo.morphBuffer!}},
                          {binding: 3, resource: {buffer: morphWeightBuffer!}},
                      ]
                    : []),
            ],
        });
        return {
            geometry: mesh.geometry,
            lastFrame: this.frame,
            vertexBuffer: geo.vertexBuffer,
            skinBuffer: skinned ? geo.skinBuffer : null,
            extrasBuffer: geo.extrasBuffer,
            indexBuffer: geo.indexBuffer,
            indexCount: geo.indexCount,
            modelBuffer,
            modelBindGroup,
            jointBuffer,
            jointCount,
            morphWeightBuffer,
            morphed,
            mirrored: false,
        };
    }

    /**
     * A material's uniforms and textures as a bind group. Uniforms are packed and compared once a frame, so
     * changed properties reach the GPU without any call; a changed map rebuilds the bind group.
     */
    private materialBindGroup(material: PBRMaterial): GPUBindGroup {
        let res = this.materialCache.get(material);
        if (res === undefined) {
            res = {
                buffer: this.device.createBuffer({
                    label: "PBRMaterial",
                    size: MATERIAL_BUFFER_SIZE,
                    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
                }),
                uniforms: new Float32Array(MATERIAL_BUFFER_SIZE / 4).fill(Number.NaN),
                maps: [null, null, null, null, null, null],
                samplerKeys: [-1, -1, -1, -1, -1, -1],
                bindGroup: null,
                lastFrame: -1,
            };
            this.materialCache.set(material, res);
        }
        if (res.lastFrame === this.frame && res.bindGroup !== null) {
            return res.bindGroup;
        }
        res.lastFrame = this.frame;
        const packed = packMaterialUniforms(material, this.materialScratch);
        for (let i = 0; i < packed.length; i++) {
            if (packed[i] !== res.uniforms[i]) {
                res.uniforms.set(packed);
                this.device.queue.writeBuffer(res.buffer, 0, res.uniforms);
                break;
            }
        }
        // rebuilt when a map, or how one is sampled, changed
        let changed = res.bindGroup === null;
        for (let m = 0; m < 6; m++) {
            const map = materialMap(material, m);
            const key = samplerKey(map);
            if (res.maps[m] !== map || res.samplerKeys[m] !== key) {
                res.maps[m] = map;
                res.samplerKeys[m] = key;
                changed = true;
            }
        }
        if (changed) {
            const [albedo, normal, emissive, metallicRoughness, height, occlusion] = res.maps;
            const white = this.defaultWhiteView;
            res.bindGroup = this.device.createBindGroup({
                label: "PBRMaterial",
                layout: this.materialBindGroupLayout,
                entries: [
                    {binding: 0, resource: {buffer: res.buffer}},
                    {binding: 1, resource: albedo?.srgbView ?? white},
                    {binding: 2, resource: this.samplerFor(albedo ?? null)},
                    {binding: 3, resource: normal?.view ?? this.defaultNormalView},
                    {binding: 4, resource: emissive?.srgbView ?? white},
                    {binding: 5, resource: metallicRoughness?.view ?? white},
                    {binding: 6, resource: height?.view ?? white},
                    {binding: 7, resource: occlusion?.view ?? white},
                    {binding: 8, resource: this.samplerFor(normal ?? null)},
                    {binding: 9, resource: this.samplerFor(emissive ?? null)},
                    {binding: 10, resource: this.samplerFor(metallicRoughness ?? null)},
                    {binding: 11, resource: this.samplerFor(height ?? null)},
                    {binding: 12, resource: this.samplerFor(occlusion ?? null)},
                ],
            });
        }
        return res.bindGroup!;
    }

    /**
     * The lights that fit the shader's arrays. Over the limit, the ones that matter most to the view stay (the
     * brightest suns; the point and spot lights whose reach is nearest the camera), and a warning says so once.
     */
    private keepLights<L extends DirectionalLight | PointLight | SpotLight>(
        lights: L[],
        max: number,
        kind: string,
    ): L[] {
        if (lights.length <= max) {
            return lights;
        }
        if (!this.warnedLights.has(kind)) {
            this.warnedLights.add(kind);
            console.warn(
                `[glaze] ${lights.length} ${kind} lights: only the ${max} that matter most to the view are lit`,
            );
        }
        const eye = this.tmpEye;
        const camera = this.scene.activeCamera;
        if (camera !== null) {
            mat4.getTranslation(eye, camera.worldMatrix);
        }
        const score = (l: L): number => {
            if (!("range" in l)) {
                return -l.intensity;
            }
            const w = l.worldMatrix;
            const distance = Math.hypot(w[12]! - eye[0], w[13]! - eye[1], w[14]! - eye[2]);
            return Math.max(distance - l.range, 0) - l.intensity * 1e-3; // inside the reach: 0, then by intensity
        };
        return [...lights].sort((a, b) => score(a) - score(b)).slice(0, max);
    }

    /** A GPU sampler for a texture's sampling settings (shared by every texture with the same ones). */
    private samplerFor(texture: Texture | null): GPUSampler {
        const key = samplerKey(texture);
        let sampler = this.samplers.get(key);
        if (sampler === undefined) {
            const s = texture?.sampling;
            const wrap = (w: WrapMode | undefined): GPUAddressMode =>
                w === "clamp" ? "clamp-to-edge" : w === "mirror" ? "mirror-repeat" : "repeat";
            const mag = s?.magFilter ?? "linear";
            const min = s?.minFilter ?? "linear";
            sampler = this.device.createSampler({
                label: `Material sampler ${key}`,
                addressModeU: wrap(s?.wrapU),
                addressModeV: wrap(s?.wrapV),
                magFilter: mag,
                minFilter: min,
                mipmapFilter: min,
                // anisotropy needs every filter linear
                maxAnisotropy: mag === "linear" && min === "linear" ? anisotropyOf(s) : 1,
            });
            this.samplers.set(key, sampler);
        }
        return sampler;
    }

    /** Releases meshes, geometries and materials no frame has drawn for a while (removed from the scene). */
    private evictUnused(): void {
        const old = this.frame - EVICT_AFTER_FRAMES;
        for (const [mesh, res] of this.meshCache) {
            if (res.lastFrame < old) {
                destroyMeshResources(res);
                this.meshCache.delete(mesh);
            }
        }
        for (const [geometry, res] of this.geometryCache) {
            if (res.lastFrame < old) {
                destroyGeometryResources(res);
                this.geometryCache.delete(geometry);
            }
        }
        for (const [material, res] of this.materialCache) {
            if (res.lastFrame < old) {
                destroyMaterialResources(res);
                this.materialCache.delete(material);
            }
        }
    }

    /** A skinned mesh's joint matrices for this frame (the buffer grows if its skin changed). */
    private uploadJoints(mesh: SkinnedMesh, res: MeshGPUResources): void {
        const matrices = mesh.updateJointMatrices();
        if (matrices.length / 16 !== res.jointCount) {
            destroyMeshResources(res);
            this.meshCache.set(mesh, this.createMeshResources(mesh, true));
            res = this.meshCache.get(mesh)!;
        }
        if (res.jointBuffer !== null && matrices.length > 0) {
            this.device.queue.writeBuffer(res.jointBuffer, 0, matrices as Float32Array<ArrayBuffer>);
        }
    }

    /** A mesh's world bounding sphere into `center`, returning the radius; for skinned meshes, around its joints. */
    private meshBounds(mesh: Mesh, center: vec3): number {
        const m = mesh.worldMatrix;
        const bounds = mesh.geometry.boundingSphere;
        const scale = Math.sqrt(
            Math.max(
                m[0]! * m[0]! + m[1]! * m[1]! + m[2]! * m[2]!,
                m[4]! * m[4]! + m[5]! * m[5]! + m[6]! * m[6]!,
                m[8]! * m[8]! + m[9]! * m[9]! + m[10]! * m[10]!,
            ),
        );
        // targets add up: weighted reaches bound how far this frame's blend moves a vertex
        let reach = 0;
        if (mesh.geometry.morphTargets !== undefined) {
            const reaches = mesh.geometry.morphReaches;
            for (let t = 0; t < reaches.length; t++) {
                reach += Math.abs(mesh.morphWeights[t] ?? 0) * reaches[t]!;
            }
        }
        if (!isSkinned(mesh)) {
            vec3.transformMat4(center, bounds.center as vec3, m);
            return (bounds.radius + reach) * scale;
        }
        // Each joint matrix carries the bind-pose sphere somewhere; a vertex is a weighted blend of where its
        // joints carry it, so it lies within the union of those spheres.
        const matrices = mesh.jointMatrices;
        const count = matrices.length / 16;
        const c = bounds.center;
        vec3.set(center, 0, 0, 0);
        for (let j = 0; j < count; j++) {
            const o = j * 16;
            center[0] += matrices[o]! * c[0] + matrices[o + 4]! * c[1] + matrices[o + 8]! * c[2] + matrices[o + 12]!;
            center[1] +=
                matrices[o + 1]! * c[0] + matrices[o + 5]! * c[1] + matrices[o + 9]! * c[2] + matrices[o + 13]!;
            center[2] +=
                matrices[o + 2]! * c[0] + matrices[o + 6]! * c[1] + matrices[o + 10]! * c[2] + matrices[o + 14]!;
        }
        vec3.scale(center, center, 1 / Math.max(count, 1));
        let radius = 0;
        for (let j = 0; j < count; j++) {
            const o = j * 16;
            const x = matrices[o]! * c[0] + matrices[o + 4]! * c[1] + matrices[o + 8]! * c[2] + matrices[o + 12]!;
            const y = matrices[o + 1]! * c[0] + matrices[o + 5]! * c[1] + matrices[o + 9]! * c[2] + matrices[o + 13]!;
            const z = matrices[o + 2]! * c[0] + matrices[o + 6]! * c[1] + matrices[o + 10]! * c[2] + matrices[o + 14]!;
            const jointScale = Math.sqrt(
                Math.max(
                    matrices[o]! ** 2 + matrices[o + 1]! ** 2 + matrices[o + 2]! ** 2,
                    matrices[o + 4]! ** 2 + matrices[o + 5]! ** 2 + matrices[o + 6]! ** 2,
                    matrices[o + 8]! ** 2 + matrices[o + 9]! ** 2 + matrices[o + 10]! ** 2,
                ),
            );
            const d = Math.hypot(x - center[0], y - center[1], z - center[2]);
            radius = Math.max(radius, d + (bounds.radius + reach) * jointScale);
        }
        return radius;
    }
}
