import {mat3, mat4, type quat, vec3} from "gl-matrix";

import {type ColorSpace, linearToSrgb} from "../color";
import {computeTangents, Geometry} from "../geometry/geometry";
import {PBRMaterial, type PBRMaterialOptions} from "../material/material";
import {Texture, type TextureSampling, type UvTransform} from "../texture";

// ─── GLTF types (minimal subset) ─────────────────────────────────────────────

interface GltfAccessor {
    bufferView?: number;
    byteOffset?: number;
    componentType: number; // 5120=i8, 5121=u8, 5122=i16, 5123=u16, 5125=u32, 5126=f32
    count: number;
    type: string; // "SCALAR", "VEC2", "VEC3", "VEC4"
    /** Integer data mapped to 0..1 (unsigned) or -1..1 (signed), as quantized UVs and normals use. */
    normalized?: boolean;
    /** A few elements replaced (on zeros, without a bufferView): how morph targets usually store their deltas. */
    sparse?: {
        count: number;
        indices: {bufferView: number; byteOffset?: number; componentType: number};
        values: {bufferView: number; byteOffset?: number};
    };
}

interface GltfBufferView {
    buffer: number;
    byteOffset?: number;
    byteLength: number;
    byteStride?: number;
}

interface GltfTextureRef {
    index: number;
    texCoord?: number;
    extensions?: {
        KHR_texture_transform?: {
            offset?: [number, number];
            rotation?: number;
            scale?: [number, number];
            texCoord?: number;
        };
    };
}

/** @internal A glTF sampler (WebGL enums). */
interface GltfSamplerDef {
    magFilter?: number;
    minFilter?: number;
    wrapS?: number;
    wrapT?: number;
}

interface GltfMaterialDef {
    name?: string;
    pbrMetallicRoughness?: {
        baseColorFactor?: [number, number, number, number];
        baseColorTexture?: GltfTextureRef;
        metallicFactor?: number;
        roughnessFactor?: number;
        metallicRoughnessTexture?: GltfTextureRef;
    };
    normalTexture?: GltfTextureRef & {scale?: number};
    occlusionTexture?: GltfTextureRef & {strength?: number};
    emissiveTexture?: GltfTextureRef;
    emissiveFactor?: [number, number, number];
    alphaMode?: "OPAQUE" | "MASK" | "BLEND";
    alphaCutoff?: number;
    doubleSided?: boolean;
    extensions?: {
        KHR_materials_emissive_strength?: {emissiveStrength?: number};
    };
}

interface GltfTextureDef {
    source?: number;
    sampler?: number;
}
interface GltfImageDef {
    uri?: string;
    bufferView?: number;
    mimeType?: string;
}

/** @internal */
export interface GltfMeshPrimitive {
    attributes: Record<string, number>;
    /** Morph targets: per target, accessors of POSITION / NORMAL / TANGENT deltas. */
    targets?: Record<string, number>[];
    indices?: number;
    mode?: number;
    material?: number;
}

/** @internal */
export interface GltfMesh {
    name?: string;
    primitives: GltfMeshPrimitive[];
    /** Default morph target weights. */
    weights?: number[];
}

/** @internal */
export interface GltfNode {
    name?: string;
    mesh?: number;
    skin?: number;
    /** Morph target weights for this node's mesh (over the mesh's defaults). */
    weights?: number[];
    children?: number[];
    matrix?: number[];
    translation?: [number, number, number];
    rotation?: [number, number, number, number];
    scale?: [number, number, number];
}

/** @internal The subset of glTF JSON Glaze reads. */
export interface GltfJson {
    accessors?: GltfAccessor[];
    bufferViews?: GltfBufferView[];
    buffers?: {byteLength: number; uri?: string}[];
    meshes?: GltfMesh[];
    nodes?: GltfNode[];
    scenes?: {name?: string; nodes?: number[]}[];
    scene?: number;
    materials?: GltfMaterialDef[];
    textures?: GltfTextureDef[];
    images?: GltfImageDef[];
    animations?: GltfAnimation[];
    skins?: {name?: string; joints: number[]; inverseBindMatrices?: number; skeleton?: number}[];
    samplers?: GltfSamplerDef[];
    extensionsUsed?: string[];
    extensionsRequired?: string[];
}

/** Extensions a file may require that Glaze reads correctly. */
const SUPPORTED_REQUIRED_EXTENSIONS = new Set([
    "KHR_mesh_quantization",
    "KHR_materials_emissive_strength",
    "KHR_texture_transform",
]);

/**
 * @internal Throws when the file requires an extension Glaze can't read (Draco or meshopt compression, KTX2 or
 * WebP textures...): without it the geometry or textures would load as zeros or nothing, silently.
 */
export function checkRequiredExtensions(json: GltfJson): void {
    const missing = (json.extensionsRequired ?? []).filter((name) => !SUPPORTED_REQUIRED_EXTENSIONS.has(name));
    if (missing.length > 0) {
        throw new Error(
            `glTF: required extension${missing.length > 1 ? "s" : ""} not supported: ${missing.join(", ")}`,
        );
    }
}

/** @internal */
export interface GltfAnimation {
    name?: string;
    channels: {sampler: number; target: {node?: number; path: "translation" | "rotation" | "scale" | "weights"}}[];
    samplers: {input: number; output: number; interpolation?: "LINEAR" | "STEP" | "CUBICSPLINE"}[];
}

// ─── Component type constants ─────────────────────────────────────────────────

const COMPONENT_TYPES: Record<
    number,
    {ctor: new (b: ArrayBuffer, o: number, l: number) => ArrayLike<number>; size: number}
> = {
    5120: {ctor: Int8Array, size: 1},
    5121: {ctor: Uint8Array, size: 1},
    5122: {ctor: Int16Array, size: 2},
    5123: {ctor: Uint16Array, size: 2},
    5125: {ctor: Uint32Array, size: 4},
    5126: {ctor: Float32Array, size: 4},
};

const TYPE_ELEMENT_COUNT: Record<string, number> = {
    SCALAR: 1,
    VEC2: 2,
    VEC3: 3,
    VEC4: 4,
    MAT2: 4,
    MAT3: 9,
    MAT4: 16,
};

// ─── Public types ─────────────────────────────────────────────────────────────

/** Describes where image data lives — either an external file or inline bytes. */
export type GltfTextureSource =
    {type: "uri"; uri: string} | {type: "embedded"; data: Uint8Array<ArrayBuffer>; mimeType: string};

/** The texture slots of a glTF material. */
export type GltfTextureSlot = "baseColor" | "normal" | "emissive" | "occlusion" | "metallicRoughness";

/** How a material slot samples its texture: the glTF sampler's modes and the slot's UV set and transform. */
export interface GltfTextureSettings {
    sampling: Partial<TextureSampling>;
    transform: Partial<UvTransform>;
}

const WRAP_MODES: Record<number, TextureSampling["wrapU"]> = {33071: "clamp", 33648: "mirror", 10497: "repeat"};

/** A texture slot's settings: its texture's sampler, and the slot's texCoord and KHR_texture_transform. */
function textureSettings(json: GltfJson, ref: GltfTextureRef | undefined): GltfTextureSettings | undefined {
    if (ref === undefined) {
        return undefined;
    }
    const sampling: Partial<TextureSampling> = {};
    const samplerIndex = json.textures?.[ref.index]?.sampler;
    const sampler = samplerIndex !== undefined ? json.samplers?.[samplerIndex] : undefined;
    if (sampler !== undefined) {
        sampling.wrapU = WRAP_MODES[sampler.wrapS ?? 10497] ?? "repeat";
        sampling.wrapV = WRAP_MODES[sampler.wrapT ?? 10497] ?? "repeat";
        if (sampler.magFilter === 9728) {
            sampling.magFilter = "nearest";
        }
        // NEAREST, NEAREST_MIPMAP_NEAREST, NEAREST_MIPMAP_LINEAR
        if (sampler.minFilter === 9728 || sampler.minFilter === 9984 || sampler.minFilter === 9986) {
            sampling.minFilter = "nearest";
        }
    }
    const t = ref.extensions?.KHR_texture_transform;
    const transform: Partial<UvTransform> = {uvSet: (t?.texCoord ?? ref.texCoord ?? 0) === 1 ? 1 : 0};
    if (t !== undefined) {
        transform.offset = [t.offset?.[0] ?? 0, t.offset?.[1] ?? 0];
        transform.scale = [t.scale?.[0] ?? 1, t.scale?.[1] ?? 1];
        transform.rotation = t.rotation ?? 0;
    }
    return {sampling, transform};
}

/** Settings that leave a texture as loaded (repeat, linear, first UV set, no transform). */
function isDefaultSettings(s: GltfTextureSettings | undefined): boolean {
    if (s === undefined) {
        return true;
    }
    const {sampling: a, transform: t} = s;
    return (
        (a.wrapU ?? "repeat") === "repeat" &&
        (a.wrapV ?? "repeat") === "repeat" &&
        (a.magFilter ?? "linear") === "linear" &&
        (a.minFilter ?? "linear") === "linear" &&
        (t.uvSet ?? 0) === 0 &&
        (t.offset?.[0] ?? 0) === 0 &&
        (t.offset?.[1] ?? 0) === 0 &&
        (t.scale?.[0] ?? 1) === 1 &&
        (t.scale?.[1] ?? 1) === 1 &&
        (t.rotation ?? 0) === 0
    );
}

function sameSettings(a: GltfTextureSettings | undefined, b: GltfTextureSettings | undefined): boolean {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null) || (isDefaultSettings(a) && isDefaultSettings(b));
}

/**
 * GPU-free material descriptor extracted from a GLTF primitive.
 * Scalar defaults follow the GLTF 2.0 spec. Factors are as stored in the file (linear). {@link parseGLB}
 * always fills the optional fields; they are optional so hand-built descriptors stay valid.
 *
 * Texture sources are shared by identity: two slots that reference the same image (the common packed
 * occlusion-roughness-metallic case) hold the same {@link GltfTextureSource} object.
 */
export interface GltfMaterialDescriptor {
    name: string;
    /** RGBA base color factor, linear (default [1,1,1,1]). */
    baseColorFactor: [number, number, number, number];
    /** Default 1.0 per GLTF spec. */
    metallicFactor: number;
    /** Default 1.0 per GLTF spec. */
    roughnessFactor: number;
    /** Linear RGB (default [0,0,0]). */
    emissiveFactor: [number, number, number];
    /** KHR_materials_emissive_strength multiplier (default 1). */
    emissiveStrength?: number;
    /** normalTexture.scale (default 1). */
    normalScale?: number;
    /** occlusionTexture.strength (default 1). */
    occlusionStrength?: number;
    baseColorTexture: GltfTextureSource | null;
    normalTexture: GltfTextureSource | null;
    emissiveTexture: GltfTextureSource | null;
    /** R=occlusion. May be the same image as {@link metallicRoughnessTexture} (packed ORM). */
    occlusionTexture: GltfTextureSource | null;
    /** G=roughness, B=metallic; R is unspecified by glTF (often occlusion, when packed). */
    metallicRoughnessTexture: GltfTextureSource | null;
    /** TEXCOORD_n set each texture reads (default 0; KHR_texture_transform's texCoord wins). Glaze reads 0 and 1. */
    texCoords?: Record<GltfTextureSlot, number>;
    /** Per slot: its sampler's wrap and filter modes, and its KHR_texture_transform. */
    textureSettings?: Partial<Record<GltfTextureSlot, GltfTextureSettings>>;
    /** glTF alphaMode (default "OPAQUE") and alphaCutoff (default 0.5, used by "MASK"). */
    alphaMode?: "OPAQUE" | "MASK" | "BLEND";
    alphaCutoff?: number;
    /** Back faces rendered too (default false). */
    doubleSided?: boolean;
}

/** One mesh primitive returned by {@link parseGLB}. */
export interface GLBPrimitive {
    geometry: Geometry;
    /** Null when the primitive has no material in the GLTF JSON. */
    material: GltfMaterialDescriptor | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** @internal Reads an accessor's elements, from whichever buffer its buffer view names. */
export function readAccessor(json: GltfJson, buffers: ArrayBuffer[], accessorIndex: number): ArrayLike<number> {
    const raw = readAccessorRaw(json, buffers, accessorIndex);
    const accessor = json.accessors![accessorIndex]!;
    // decided by the declared type: a sparse accessor without a buffer view is densified into a Float32Array
    // that still holds raw integers
    if (!accessor.normalized || accessor.componentType === 5126) {
        return raw;
    }
    // KHR_mesh_quantization-style normalized integers to floats
    const max = {5120: 127, 5121: 255, 5122: 32767, 5123: 65535, 5125: 4294967295}[accessor.componentType] ?? 1;
    const signed = accessor.componentType === 5120 || accessor.componentType === 5122;
    const out = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
        out[i] = signed ? Math.max(raw[i]! / max, -1) : raw[i]! / max;
    }
    return out;
}

function readAccessorRaw(json: GltfJson, buffers: ArrayBuffer[], accessorIndex: number): ArrayLike<number> {
    const accessor = json.accessors![accessorIndex]!;
    const dense = readAccessorDense(json, buffers, accessor);
    const sparse = accessor.sparse;
    if (sparse === undefined) {
        return dense;
    }
    // copy (the dense data may be a view on the file) and overwrite the listed elements
    const elem = TYPE_ELEMENT_COUNT[accessor.type] ?? 1;
    const out = new (dense.constructor as new (n: number) => ArrayLike<number> & {[i: number]: number})(dense.length);
    for (let i = 0; i < dense.length; i++) {
        out[i] = dense[i]!;
    }
    const view = (bufferView: number, byteOffset: number, componentType: number, count: number) => {
        const bv = json.bufferViews![bufferView]!;
        const ct = COMPONENT_TYPES[componentType]!;
        return new ct.ctor(buffers[bv.buffer]!, (bv.byteOffset ?? 0) + byteOffset, count);
    };
    const indices = view(
        sparse.indices.bufferView,
        sparse.indices.byteOffset ?? 0,
        sparse.indices.componentType,
        sparse.count,
    );
    const values = view(
        sparse.values.bufferView,
        sparse.values.byteOffset ?? 0,
        accessor.componentType,
        sparse.count * elem,
    );
    for (let i = 0; i < sparse.count; i++) {
        for (let k = 0; k < elem; k++) {
            out[indices[i]! * elem + k] = values[i * elem + k]!;
        }
    }
    return out;
}

function readAccessorDense(json: GltfJson, buffers: ArrayBuffer[], accessor: GltfAccessor): ArrayLike<number> {
    const elemCount = TYPE_ELEMENT_COUNT[accessor.type] ?? 1;
    const totalCount = accessor.count * elemCount;
    const ct = COMPONENT_TYPES[accessor.componentType];
    if (!ct) {
        throw new Error(`GLB: unsupported componentType ${accessor.componentType}`);
    }

    if (accessor.bufferView === undefined) {
        // Zero-filled sparse accessor placeholder
        return new Float32Array(totalCount);
    }

    const bv = json.bufferViews![accessor.bufferView]!;
    const bin = buffers[bv.buffer];
    if (bin === undefined) {
        throw new Error(`glTF: buffer ${bv.buffer} is missing`);
    }
    const byteStride = bv.byteStride;
    const baseOffset = (bv.byteOffset ?? 0) + (accessor.byteOffset ?? 0);

    if (!byteStride || byteStride === elemCount * ct.size) {
        // Tightly packed — create a typed view directly
        return new ct.ctor(bin, baseOffset, totalCount);
    }

    // Interleaved: copy out element by element (keeping the component type, so normalization still applies)
    const out = new (ct.ctor as unknown as new (n: number) => ArrayLike<number> & {[i: number]: number})(totalCount);
    for (let i = 0; i < accessor.count; i++) {
        const elemOffset = baseOffset + i * byteStride;
        const src = new ct.ctor(bin, elemOffset, elemCount);
        for (let j = 0; j < elemCount; j++) {
            out[i * elemCount + j] = (src as ArrayLike<number>)[j]!;
        }
    }
    return out;
}

function toFloat32(data: ArrayLike<number>): Float32Array {
    if (data instanceof Float32Array) {
        return data;
    }
    return Float32Array.from(data);
}

function toUint32(data: ArrayLike<number>): Uint32Array {
    if (data instanceof Uint32Array) {
        return data;
    }
    return Uint32Array.from(data);
}

function extractTextureSource(
    json: GltfJson,
    buffers: ArrayBuffer[],
    textureIndex: number,
    cache: Map<number, GltfTextureSource | null>,
): GltfTextureSource | null {
    const texture = json.textures?.[textureIndex];
    if (!texture || texture.source === undefined) {
        return null;
    }
    // one source object per image, so slots sharing an image share the object (and the GPU texture)
    if (!cache.has(texture.source)) {
        cache.set(texture.source, extractImageSource(json, buffers, texture.source));
    }
    return cache.get(texture.source)!;
}

function extractImageSource(json: GltfJson, buffers: ArrayBuffer[], imageIndex: number): GltfTextureSource | null {
    const image = json.images?.[imageIndex];
    if (!image) {
        return null;
    }

    if (image.uri !== undefined) {
        const data = decodeDataUri(image.uri);
        if (data !== null) {
            return {type: "embedded", data: data.bytes, mimeType: image.mimeType ?? data.mimeType};
        }
        return {type: "uri", uri: image.uri};
    }

    if (image.bufferView !== undefined) {
        const bv = json.bufferViews?.[image.bufferView];
        if (!bv) {
            return null;
        }
        const bin = buffers[bv.buffer];
        if (bin === undefined) {
            return null;
        }
        const src = new Uint8Array(bin, bv.byteOffset ?? 0, bv.byteLength);
        return {
            type: "embedded",
            data: src.slice(), // own copy, not a view into bin
            mimeType: image.mimeType ?? "image/png",
        };
    }

    return null;
}

/** @internal */
export function extractMaterial(
    json: GltfJson,
    buffers: ArrayBuffer[],
    materialIndex: number,
    cache: Map<number, GltfTextureSource | null>,
): GltfMaterialDescriptor {
    const mat = json.materials?.[materialIndex];
    const pbr = mat?.pbrMetallicRoughness ?? {};
    const tex = (ref: GltfTextureRef | undefined) =>
        ref !== undefined ? extractTextureSource(json, buffers, ref.index, cache) : null;

    return {
        name: mat?.name ?? "",
        baseColorFactor: pbr.baseColorFactor ?? [1, 1, 1, 1],
        metallicFactor: pbr.metallicFactor ?? 1.0,
        roughnessFactor: pbr.roughnessFactor ?? 1.0,
        emissiveFactor: mat?.emissiveFactor ?? [0, 0, 0],
        emissiveStrength: mat?.extensions?.KHR_materials_emissive_strength?.emissiveStrength ?? 1.0,
        normalScale: mat?.normalTexture?.scale ?? 1.0,
        occlusionStrength: mat?.occlusionTexture?.strength ?? 1.0,
        baseColorTexture: tex(pbr.baseColorTexture),
        normalTexture: tex(mat?.normalTexture),
        emissiveTexture: tex(mat?.emissiveTexture),
        occlusionTexture: tex(mat?.occlusionTexture),
        metallicRoughnessTexture: tex(pbr.metallicRoughnessTexture),
        alphaMode: mat?.alphaMode ?? "OPAQUE",
        alphaCutoff: mat?.alphaCutoff ?? 0.5,
        doubleSided: mat?.doubleSided ?? false,
        texCoords: {
            baseColor: texCoordOf(pbr.baseColorTexture),
            normal: texCoordOf(mat?.normalTexture),
            emissive: texCoordOf(mat?.emissiveTexture),
            occlusion: texCoordOf(mat?.occlusionTexture),
            metallicRoughness: texCoordOf(pbr.metallicRoughnessTexture),
        },
        textureSettings: {
            baseColor: textureSettings(json, pbr.baseColorTexture),
            normal: textureSettings(json, mat?.normalTexture),
            emissive: textureSettings(json, mat?.emissiveTexture),
            occlusion: textureSettings(json, mat?.occlusionTexture),
            metallicRoughness: textureSettings(json, pbr.metallicRoughnessTexture),
        },
    };
}

/** The UV set a texture reference reads: KHR_texture_transform may override it. */
function texCoordOf(ref: GltfTextureRef | undefined): number {
    return ref?.extensions?.KHR_texture_transform?.texCoord ?? ref?.texCoord ?? 0;
}

// ─── Node transforms ─────────────────────────────────────────────────────────

/** @internal A primitive's vertex data, untransformed; null for non-triangle or position-less primitives. */
export function readPrimitive(
    json: GltfJson,
    buffers: ArrayBuffer[],
    prim: GltfMeshPrimitive,
): {
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    tangents: Float32Array | null;
    indices: Uint32Array;
    joints: Uint16Array | null;
    weights: Float32Array | null;
    morphTargets: {positions: Float32Array; normals?: Float32Array}[];
    /** COLOR_0 as linear RGBA (alpha 1 for RGB colors), or null. */
    colors: Float32Array | null;
    /** TEXCOORD_1, or null. */
    uvs1: Float32Array | null;
} | null {
    // triangles: lists (4, the default), strips (5) and fans (6); points and lines are skipped
    const mode = prim.mode ?? 4;
    if (mode !== 4 && mode !== 5 && mode !== 6) {
        return null;
    }
    const posIdx = prim.attributes["POSITION"];
    if (posIdx === undefined) {
        return null;
    }
    const normIdx = prim.attributes["NORMAL"];
    const uvIdx = prim.attributes["TEXCOORD_0"];
    const tanIdx = prim.attributes["TANGENT"];
    const positions = toFloat32(readAccessor(json, buffers, posIdx));
    const vertexCount = positions.length / 3;
    const normals = normIdx !== undefined ? toFloat32(readAccessor(json, buffers, normIdx)) : null;
    const uvs = uvIdx !== undefined ? toFloat32(readAccessor(json, buffers, uvIdx)) : new Float32Array(vertexCount * 2);
    const tangents = tanIdx !== undefined ? toFloat32(readAccessor(json, buffers, tanIdx)) : null;
    const uv1Idx = prim.attributes["TEXCOORD_1"];
    const uvs1 = uv1Idx !== undefined ? toFloat32(readAccessor(json, buffers, uv1Idx)) : null;
    // vertex colors: VEC3 or VEC4, float or normalized integers, already linear (no sRGB decode)
    const colorIdx = prim.attributes["COLOR_0"];
    let colors: Float32Array | null = null;
    if (colorIdx !== undefined) {
        const raw = readAccessor(json, buffers, colorIdx);
        const size = json.accessors![colorIdx]!.type === "VEC3" ? 3 : 4;
        colors = new Float32Array(vertexCount * 4);
        for (let i = 0; i < vertexCount; i++) {
            colors[i * 4] = raw[i * size] ?? 1;
            colors[i * 4 + 1] = raw[i * size + 1] ?? 1;
            colors[i * 4 + 2] = raw[i * size + 2] ?? 1;
            colors[i * 4 + 3] = size === 4 ? (raw[i * size + 3] ?? 1) : 1;
        }
    }
    let indices: Uint32Array;
    if (prim.indices !== undefined) {
        indices = toUint32(readAccessor(json, buffers, prim.indices));
    } else {
        indices = new Uint32Array(vertexCount);
        for (let i = 0; i < vertexCount; i++) {
            indices[i] = i;
        }
    }
    if (mode !== 4) {
        indices = triangleList(indices, mode);
    }
    // skinning: 4 joints and weights per vertex (uint8 / uint16 joints, float or normalized weights)
    const jointsIdx = prim.attributes["JOINTS_0"];
    const weightsIdx = prim.attributes["WEIGHTS_0"];
    let joints: Uint16Array | null = null;
    let weights: Float32Array | null = null;
    if (jointsIdx !== undefined && weightsIdx !== undefined) {
        joints = Uint16Array.from(readAccessor(json, buffers, jointsIdx));
        weights = Float32Array.from(readAccessor(json, buffers, weightsIdx));
        for (let i = 0; i < weights.length; i += 4) {
            const sum = weights[i]! + weights[i + 1]! + weights[i + 2]! + weights[i + 3]!;
            if (sum > 0 && Math.abs(sum - 1) > 1e-6) {
                for (let k = 0; k < 4; k++) {
                    weights[i + k] = weights[i + k]! / sum;
                }
            }
        }
    }
    const morphTargets = (prim.targets ?? []).map((target) => ({
        positions:
            target["POSITION"] !== undefined
                ? toFloat32(readAccessor(json, buffers, target["POSITION"]))
                : new Float32Array(vertexCount * 3),
        ...(target["NORMAL"] !== undefined ? {normals: toFloat32(readAccessor(json, buffers, target["NORMAL"]))} : {}),
    }));
    if (normals === null) {
        // glTF: without normals, a mesh is flat shaded. Every triangle gets its own three vertices.
        return flatShaded({positions, uvs, tangents, indices, joints, weights, morphTargets, colors, uvs1});
    }
    return {positions, normals, uvs, tangents, indices, joints, weights, morphTargets, colors, uvs1};
}

/** Strip (5) or fan (6) indices as a triangle list, keeping every triangle counter-clockwise. */
export function triangleList(indices: Uint32Array, mode: 5 | 6 | number): Uint32Array {
    const count = Math.max(indices.length - 2, 0);
    const out = new Uint32Array(count * 3);
    for (let i = 0; i < count; i++) {
        if (mode === 5) {
            // every other strip triangle winds the other way: swap two of its corners back
            const even = i % 2 === 0;
            out[i * 3] = indices[i]!;
            out[i * 3 + 1] = indices[even ? i + 1 : i + 2]!;
            out[i * 3 + 2] = indices[even ? i + 2 : i + 1]!;
        } else {
            out[i * 3] = indices[0]!;
            out[i * 3 + 1] = indices[i + 1]!;
            out[i * 3 + 2] = indices[i + 2]!;
        }
    }
    return out;
}

/** Splits shared vertices so each triangle has its own, and gives them the triangle's normal. */
function flatShaded(p: {
    positions: Float32Array;
    uvs: Float32Array;
    tangents: Float32Array | null;
    indices: Uint32Array;
    joints: Uint16Array | null;
    weights: Float32Array | null;
    morphTargets: {positions: Float32Array; normals?: Float32Array}[];
    colors: Float32Array | null;
    uvs1: Float32Array | null;
}) {
    const n = p.indices.length;
    const spread = <T extends Float32Array | Uint16Array>(src: T, size: number): T => {
        const out = new (src.constructor as new (length: number) => T)(n * size);
        for (let i = 0; i < n; i++) {
            const v = p.indices[i]!;
            for (let k = 0; k < size; k++) {
                out[i * size + k] = src[v * size + k]!;
            }
        }
        return out;
    };
    const positions = spread(p.positions, 3);
    const normals = new Float32Array(n * 3);
    for (let t = 0; t + 2 < n; t += 3) {
        const a = t * 3;
        const ux = positions[a + 3]! - positions[a]!, uy = positions[a + 4]! - positions[a + 1]!, uz = positions[a + 5]! - positions[a + 2]!; // prettier-ignore
        const vx = positions[a + 6]! - positions[a]!, vy = positions[a + 7]! - positions[a + 1]!, vz = positions[a + 8]! - positions[a + 2]!; // prettier-ignore
        let nx = uy * vz - uz * vy;
        let ny = uz * vx - ux * vz;
        let nz = ux * vy - uy * vx;
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len;
        ny /= len;
        nz /= len;
        for (let k = 0; k < 3; k++) {
            normals[a + k * 3] = nx;
            normals[a + k * 3 + 1] = ny;
            normals[a + k * 3 + 2] = nz;
        }
    }
    return {
        positions,
        normals,
        uvs: spread(p.uvs, 2),
        tangents: p.tangents && spread(p.tangents, 4),
        indices: Uint32Array.from({length: n}, (_, i) => i),
        joints: p.joints && spread(p.joints, 4),
        weights: p.weights && spread(p.weights, 4),
        colors: p.colors && spread(p.colors, 4),
        uvs1: p.uvs1 && spread(p.uvs1, 2),
        morphTargets: p.morphTargets.map((t) => ({
            positions: spread(t.positions, 3),
            ...(t.normals ? {normals: spread(t.normals, 3)} : {}),
        })),
    };
}

/** @internal Splits a GLB file into its JSON and binary chunk (the file's buffer 0). */
export function parseGlbContainer(buffer: ArrayBuffer): {json: GltfJson; buffers: ArrayBuffer[]} {
    const view = new DataView(buffer);
    if (buffer.byteLength < 12 || view.getUint32(0, true) !== 0x46546c67) {
        throw new Error("GLB: invalid magic number");
    }
    const version = view.getUint32(4, true);
    if (version !== 2) {
        throw new Error(`GLB: unsupported version ${version}`);
    }
    if (buffer.byteLength < 20) {
        throw new Error("GLB: truncated header");
    }
    const jsonChunkLength = view.getUint32(12, true);
    if (view.getUint32(16, true) !== 0x4e4f534a) {
        throw new Error("GLB: first chunk is not JSON");
    }
    const json: GltfJson = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonChunkLength)));
    checkRequiredExtensions(json);
    let bin: ArrayBuffer = new ArrayBuffer(0);
    const binOffset = 20 + jsonChunkLength;
    if (binOffset + 8 <= buffer.byteLength) {
        const binChunkLength = view.getUint32(binOffset, true);
        if (view.getUint32(binOffset + 4, true) === 0x004e4942) {
            bin = buffer.slice(binOffset + 8, binOffset + 8 + binChunkLength);
        }
    }
    return {json, buffers: [bin]};
}

/** @internal The bytes of a base64 `data:` URI, or null for any other URI. */
export function decodeDataUri(uri: string): {bytes: Uint8Array<ArrayBuffer>; mimeType: string} | null {
    const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(uri);
    if (match === null) {
        return null;
    }
    const [, mimeType = "", base64, payload = ""] = match;
    if (base64 === undefined) {
        return {bytes: new TextEncoder().encode(decodeURIComponent(payload)) as Uint8Array<ArrayBuffer>, mimeType};
    }
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return {bytes, mimeType: mimeType || "application/octet-stream"};
}

/** @internal A node's local transform. */
export function nodeMatrix(node: GltfNode): mat4 {
    if (node.matrix) {
        return mat4.clone(node.matrix as unknown as mat4);
    }
    return mat4.fromRotationTranslationScale(
        mat4.create(),
        (node.rotation ?? [0, 0, 0, 1]) as unknown as quat,
        (node.translation ?? [0, 0, 0]) as unknown as vec3,
        (node.scale ?? [1, 1, 1]) as unknown as vec3,
    );
}

/** Every (mesh, world matrix) pair of the default scene; every mesh at identity when the file has no scene. */
function meshInstances(json: GltfJson): {mesh: GltfMesh; matrix: mat4 | null}[] {
    const nodes = json.nodes ?? [];
    const roots = json.scenes?.[json.scene ?? 0]?.nodes;
    if (!roots || nodes.length === 0) {
        return (json.meshes ?? []).map((mesh) => ({mesh, matrix: null}));
    }
    const out: {mesh: GltfMesh; matrix: mat4 | null}[] = [];
    const visit = (index: number, parent: mat4, depth: number) => {
        const node = nodes[index];
        if (!node || depth > 256) {
            return;
        }
        const world = mat4.multiply(mat4.create(), parent, nodeMatrix(node));
        const mesh = node.mesh !== undefined ? json.meshes?.[node.mesh] : undefined;
        if (mesh) {
            out.push({mesh, matrix: isIdentity(world) ? null : world});
        }
        for (const child of node.children ?? []) {
            visit(child, world, depth + 1);
        }
    };
    for (const root of roots) {
        visit(root, mat4.create(), 0);
    }
    return out;
}

function isIdentity(m: mat4): boolean {
    return mat4.exactEquals(m, mat4.create());
}

/**
 * Bake a node's world matrix into vertex data (new arrays: accessor data can be shared between instances).
 * A mirroring matrix flips the triangle winding and the tangent handedness.
 */
function bakeTransform(
    matrix: mat4,
    positions: Float32Array,
    normals: Float32Array,
    tangents: Float32Array | null,
    indices: Uint32Array,
): {positions: Float32Array; normals: Float32Array; tangents: Float32Array | null; indices: Uint32Array} {
    const normalMatrix = mat3.normalFromMat4(mat3.create(), matrix) ?? mat3.fromMat4(mat3.create(), matrix);
    const linear = mat3.fromMat4(mat3.create(), matrix);
    const mirrored = mat3.determinant(linear) < 0;
    const v = vec3.create();

    const outPositions = new Float32Array(positions.length);
    for (let i = 0; i < positions.length; i += 3) {
        vec3.set(v, positions[i]!, positions[i + 1]!, positions[i + 2]!);
        vec3.transformMat4(v, v, matrix);
        outPositions.set(v as Float32Array, i);
    }
    const outNormals = new Float32Array(normals.length);
    for (let i = 0; i < normals.length; i += 3) {
        vec3.set(v, normals[i]!, normals[i + 1]!, normals[i + 2]!);
        vec3.normalize(v, vec3.transformMat3(v, v, normalMatrix));
        outNormals.set(v as Float32Array, i);
    }
    let outTangents: Float32Array | null = null;
    if (tangents) {
        outTangents = new Float32Array(tangents.length);
        for (let i = 0; i < tangents.length; i += 4) {
            vec3.set(v, tangents[i]!, tangents[i + 1]!, tangents[i + 2]!);
            vec3.normalize(v, vec3.transformMat3(v, v, linear));
            outTangents.set(v as Float32Array, i);
            outTangents[i + 3] = mirrored ? -tangents[i + 3]! : tangents[i + 3]!;
        }
    }
    let outIndices = indices;
    if (mirrored) {
        outIndices = new Uint32Array(indices.length);
        for (let i = 0; i + 2 < indices.length; i += 3) {
            outIndices[i] = indices[i]!;
            outIndices[i + 1] = indices[i + 2]!;
            outIndices[i + 2] = indices[i + 1]!;
        }
    }
    return {positions: outPositions, normals: outNormals, tangents: outTangents, indices: outIndices};
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Parse a GLB (Binary GLTF 2.0) buffer and return one {@link GLBPrimitive} per
 * mesh primitive, each carrying a {@link Geometry} and an optional
 * {@link GltfMaterialDescriptor}.
 *
 * Primitives come from the default scene's node tree with each node's world transform baked into the
 * vertex data (a file without scenes or nodes yields every mesh untransformed). A mesh used by several
 * nodes appears once per node.
 *
 * Tangents are read from the TANGENT attribute when present, otherwise computed.
 * The material descriptor is `null` when the primitive has no material index.
 */
export function parseGLB(buffer: ArrayBuffer): GLBPrimitive[] {
    const {json, buffers} = parseGlbContainer(buffer);
    const primitives: GLBPrimitive[] = [];
    const imageCache = new Map<number, GltfTextureSource | null>();

    for (const {mesh, matrix} of meshInstances(json)) {
        for (const prim of mesh.primitives) {
            const data = readPrimitive(json, buffers, prim);
            if (data === null) {
                continue;
            }
            let {positions, normals, tangents, indices} = data;
            const {uvs} = data;

            if (matrix) {
                ({positions, normals, tangents, indices} = bakeTransform(
                    matrix,
                    positions,
                    normals,
                    tangents,
                    indices,
                ));
            }

            tangents ??= computeTangents(positions, normals, uvs, indices, positions.length / 3);

            const geometry = new Geometry({positions, normals, uvs, indices, tangents});
            const material =
                prim.material !== undefined ? extractMaterial(json, buffers, prim.material, imageCache) : null;

            primitives.push({geometry, material});
        }
    }

    return primitives;
}

/**
 * Fetch a GLB file from a URL and parse it into {@link GLBPrimitive} instances.
 */
export async function loadGLBFromURL(url: string): Promise<GLBPrimitive[]> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`GLB: failed to fetch '${url}' (${response.status})`);
    }
    const buffer = await response.arrayBuffer();
    return parseGLB(buffer);
}

/**
 * How a {@link GltfMaterialDescriptor} maps onto a {@link PBRMaterial}: scalar options and which texture source
 * goes in which map. GPU-free; {@link createPBRMaterialFromGltf} loads the textures and applies it.
 */
export interface GltfMaterialPlan {
    options: Required<PBRMaterialOptions>;
    albedoMap: GltfTextureSource | null;
    normalMap: GltfTextureSource | null;
    emissiveMap: GltfTextureSource | null;
    /** Set when occlusion and metallic-roughness share one image (R=occlusion, G=roughness, B=metallic). */
    ormMap: GltfTextureSource | null;
    /** G=roughness, B=metallic, when not packed with occlusion. */
    metallicRoughnessMap: GltfTextureSource | null;
    /** R=occlusion, when not packed. */
    occlusionMap: GltfTextureSource | null;
    /** Slots dropped because they read a UV set past TEXCOORD_1. */
    skipped: GltfTextureSlot[];
    /** Sampling and transform per map that isn't plain (repeat, linear, TEXCOORD_0, untransformed). */
    settings: Partial<
        Record<
            "albedoMap" | "normalMap" | "emissiveMap" | "ormMap" | "metallicRoughnessMap" | "occlusionMap",
            GltfTextureSettings
        >
    >;
}

function sameImage(a: GltfTextureSource, b: GltfTextureSource): boolean {
    if (a === b) {
        return true;
    }
    if (a.type === "uri" && b.type === "uri") {
        return a.uri === b.uri;
    }
    return a.type === "embedded" && b.type === "embedded" && a.data === b.data;
}

/**
 * Map a glTF material onto PBRMaterial inputs, per the glTF 2.0 metallic-roughness model:
 *
 * - base color = baseColorFactor × baseColorTexture; emissive = emissiveFactor × strength × emissiveTexture;
 *   factors are converted from glTF's linear values to sRGB, the space Glaze's colors and textures live in.
 * - roughness = roughnessFactor × texture G, metallic = metallicFactor × texture B (R is never read as occlusion).
 * - occlusion comes from occlusionTexture.R scaled by its strength, and is 1 without one. When occlusion and
 *   metallic-roughness are the same image, it becomes one packed {@link PBRMaterial.ormMap}.
 * - normal map XY is scaled by normalTexture.scale.
 *
 * - each texture keeps its sampler's wrap and filter modes, its UV set (TEXCOORD_0 or 1) and its
 *   KHR_texture_transform (`settings`, applied with {@link Texture.withSettings}).
 *
 * Glaze geometry has two UV sets, so a texture reading TEXCOORD_2 or later is left out (and listed in `skipped`)
 * rather than sampled with the wrong coordinates.
 */
export function planGltfMaterial(descriptor: GltfMaterialDescriptor): GltfMaterialPlan {
    const skipped: GltfTextureSlot[] = [];
    const usable = (slot: GltfTextureSlot, source: GltfTextureSource | null): GltfTextureSource | null => {
        if (!source) {
            return null;
        }
        if ((descriptor.texCoords?.[slot] ?? 0) > 1) {
            skipped.push(slot);
            return null;
        }
        return source;
    };

    const occlusion = usable("occlusion", descriptor.occlusionTexture);
    const metallicRoughness = usable("metallicRoughness", descriptor.metallicRoughnessTexture);
    const ts = descriptor.textureSettings ?? {};
    const packed =
        occlusion !== null &&
        metallicRoughness !== null &&
        sameImage(occlusion, metallicRoughness) &&
        sameSettings(ts.occlusion, ts.metallicRoughness);
    const settings: GltfMaterialPlan["settings"] = {};
    const keep = (map: keyof GltfMaterialPlan["settings"], s: GltfTextureSettings | undefined, used: unknown) => {
        if (used !== null && !isDefaultSettings(s)) {
            settings[map] = s!;
        }
    };

    const maps = {
        albedoMap: usable("baseColor", descriptor.baseColorTexture),
        normalMap: usable("normal", descriptor.normalTexture),
        emissiveMap: usable("emissive", descriptor.emissiveTexture),
        ormMap: packed ? occlusion : null,
        metallicRoughnessMap: packed ? null : metallicRoughness,
        occlusionMap: packed ? null : occlusion,
    };
    keep("albedoMap", ts.baseColor, maps.albedoMap);
    keep("normalMap", ts.normal, maps.normalMap);
    keep("emissiveMap", ts.emissive, maps.emissiveMap);
    keep("ormMap", ts.occlusion, maps.ormMap);
    keep("metallicRoughnessMap", ts.metallicRoughness, maps.metallicRoughnessMap);
    keep("occlusionMap", ts.occlusion, maps.occlusionMap);

    const [r, g, b, a] = descriptor.baseColorFactor;
    const strength = descriptor.emissiveStrength ?? 1;
    const [er, eg, eb] = descriptor.emissiveFactor;
    return {
        options: {
            color: [linearToSrgb(r), linearToSrgb(g), linearToSrgb(b)],
            metallic: descriptor.metallicFactor,
            roughness: descriptor.roughnessFactor,
            emissive: [linearToSrgb(er), linearToSrgb(eg), linearToSrgb(eb)],
            emissiveIntensity: strength,
            normalScale: descriptor.normalScale ?? 1,
            occlusionStrength: occlusion ? (descriptor.occlusionStrength ?? 1) : 1,
            opacity: a,
            alphaMode: descriptor.alphaMode === "MASK" ? "mask" : descriptor.alphaMode === "BLEND" ? "blend" : "opaque",
            alphaCutoff: descriptor.alphaCutoff ?? 0.5,
            doubleSided: descriptor.doubleSided ?? false,
        },
        ...maps,
        skipped,
        settings,
    };
}

/**
 * Build a {@link PBRMaterial} from a {@link GltfMaterialDescriptor} (see {@link planGltfMaterial} for the mapping).
 *
 * @param device      WebGPU device used to create textures.
 * @param descriptor  Material descriptor from {@link parseGLB}.
 * @param resolveUri  Maps a relative URI (from the GLTF file) to a URL that can
 *                    be fetched. Defaults to the identity (URI used as-is), which
 *                    works when the GLB is served from the same directory.
 * @param loaded      Texture cache keyed by source; share it between a model's materials.
 */
export async function createPBRMaterialFromGltf(
    device: GPUDevice,
    descriptor: GltfMaterialDescriptor,
    resolveUri: (uri: string) => string = (uri) => uri,
    /** Shares GPU textures across materials: pass the same map for every material of a model. */
    loaded: Map<GltfTextureSource, Promise<Texture>> = new Map(),
): Promise<PBRMaterial> {
    const plan = planGltfMaterial(descriptor);
    const mat = new PBRMaterial(plan.options);

    // one GPU texture per image, however many slots (and materials) use it
    // color maps are sRGB, the rest data (that only changes how mip levels average: both views exist)
    function loadTex(
        source: GltfTextureSource | null,
        colorSpace: ColorSpace = "linear-srgb",
    ): Promise<Texture | null> {
        if (!source) {
            return Promise.resolve(null);
        }
        let texture = loaded.get(source);
        if (!texture) {
            texture =
                source.type === "uri"
                    ? Texture.fromURL(device, resolveUri(source.uri), {colorSpace})
                    : Texture.fromBlob(device, new Blob([source.data], {type: source.mimeType}), {colorSpace});
            loaded.set(source, texture);
        }
        return texture;
    }

    // a slot with its own sampler or transform reads the shared pixels through its own Texture
    const withSettings = async (
        slot: keyof GltfMaterialPlan["settings"],
        texture: Promise<Texture | null>,
    ): Promise<Texture | null> => {
        const t = await texture;
        const s = plan.settings[slot];
        return t !== null && s !== undefined ? t.withSettings(s) : t;
    };
    [mat.albedoMap, mat.normalMap, mat.emissiveMap, mat.ormMap, mat.metallicRoughnessMap, mat.occlusionMap] =
        await Promise.all([
            withSettings("albedoMap", loadTex(plan.albedoMap, "srgb")),
            withSettings("normalMap", loadTex(plan.normalMap)),
            withSettings("emissiveMap", loadTex(plan.emissiveMap, "srgb")),
            withSettings("ormMap", loadTex(plan.ormMap)),
            withSettings("metallicRoughnessMap", loadTex(plan.metallicRoughnessMap)),
            withSettings("occlusionMap", loadTex(plan.occlusionMap)),
        ]);

    return mat;
}
