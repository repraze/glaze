import {mat3, mat4, type quat, vec3} from "gl-matrix";

import {linearToSrgb} from "../color";
import {computeTangents, Geometry} from "../geometry/geometry";
import {PBRMaterial, type PBRMaterialOptions} from "../material/material";
import {Texture} from "../texture";

// ─── GLTF types (minimal subset) ─────────────────────────────────────────────

interface GltfAccessor {
    bufferView?: number;
    byteOffset?: number;
    componentType: number; // 5120=i8, 5121=u8, 5122=i16, 5123=u16, 5125=u32, 5126=f32
    count: number;
    type: string; // "SCALAR", "VEC2", "VEC3", "VEC4"
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

interface GltfMeshPrimitive {
    attributes: Record<string, number>;
    indices?: number;
    mode?: number;
    material?: number;
}

interface GltfMesh {
    primitives: GltfMeshPrimitive[];
}

interface GltfNode {
    mesh?: number;
    children?: number[];
    matrix?: number[];
    translation?: [number, number, number];
    rotation?: [number, number, number, number];
    scale?: [number, number, number];
}

interface GltfJson {
    accessors?: GltfAccessor[];
    bufferViews?: GltfBufferView[];
    buffers?: {byteLength: number}[];
    meshes?: GltfMesh[];
    nodes?: GltfNode[];
    scenes?: {nodes?: number[]}[];
    scene?: number;
    materials?: GltfMaterialDef[];
    textures?: GltfTextureDef[];
    images?: GltfImageDef[];
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
    /** TEXCOORD_n set each texture reads (default 0). Glaze geometry carries TEXCOORD_0 only. */
    texCoords?: Record<GltfTextureSlot, number>;
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

function readAccessor(json: GltfJson, bin: ArrayBuffer, accessorIndex: number): ArrayLike<number> {
    const accessor = json.accessors![accessorIndex]!;
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
    const byteStride = bv.byteStride;
    const baseOffset = (bv.byteOffset ?? 0) + (accessor.byteOffset ?? 0);

    if (!byteStride || byteStride === elemCount * ct.size) {
        // Tightly packed — create a typed view directly
        return new ct.ctor(bin, baseOffset, totalCount);
    }

    // Interleaved — copy out element by element
    const out = new Float32Array(totalCount);
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
    bin: ArrayBuffer,
    textureIndex: number,
    cache: Map<number, GltfTextureSource | null>,
): GltfTextureSource | null {
    const texture = json.textures?.[textureIndex];
    if (!texture || texture.source === undefined) {
        return null;
    }
    // one source object per image, so slots sharing an image share the object (and the GPU texture)
    if (!cache.has(texture.source)) {
        cache.set(texture.source, extractImageSource(json, bin, texture.source));
    }
    return cache.get(texture.source)!;
}

function extractImageSource(json: GltfJson, bin: ArrayBuffer, imageIndex: number): GltfTextureSource | null {
    const image = json.images?.[imageIndex];
    if (!image) {
        return null;
    }

    if (image.uri !== undefined) {
        return {type: "uri", uri: image.uri};
    }

    if (image.bufferView !== undefined) {
        const bv = json.bufferViews?.[image.bufferView];
        if (!bv) {
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

function extractMaterial(
    json: GltfJson,
    bin: ArrayBuffer,
    materialIndex: number,
    cache: Map<number, GltfTextureSource | null>,
): GltfMaterialDescriptor {
    const mat = json.materials?.[materialIndex];
    const pbr = mat?.pbrMetallicRoughness ?? {};
    const tex = (ref: GltfTextureRef | undefined) =>
        ref !== undefined ? extractTextureSource(json, bin, ref.index, cache) : null;

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
            baseColor: pbr.baseColorTexture?.texCoord ?? 0,
            normal: mat?.normalTexture?.texCoord ?? 0,
            emissive: mat?.emissiveTexture?.texCoord ?? 0,
            occlusion: mat?.occlusionTexture?.texCoord ?? 0,
            metallicRoughness: pbr.metallicRoughnessTexture?.texCoord ?? 0,
        },
    };
}

// ─── Node transforms ─────────────────────────────────────────────────────────

function nodeMatrix(node: GltfNode): mat4 {
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
    const view = new DataView(buffer);

    // GLB header (12 bytes)
    const magic = view.getUint32(0, true);
    const version = view.getUint32(4, true);
    if (magic !== 0x46546c67) {
        throw new Error("GLB: invalid magic number");
    }
    if (version !== 2) {
        throw new Error(`GLB: unsupported version ${version}`);
    }

    // JSON chunk
    const jsonChunkLength = view.getUint32(12, true);
    const jsonChunkType = view.getUint32(16, true);
    if (jsonChunkType !== 0x4e4f534a) {
        throw new Error("GLB: first chunk is not JSON");
    }
    const jsonText = new TextDecoder().decode(new Uint8Array(buffer, 20, jsonChunkLength));
    const json: GltfJson = JSON.parse(jsonText);

    // BIN chunk (optional)
    let bin: ArrayBuffer = new ArrayBuffer(0);
    const binOffset = 20 + jsonChunkLength;
    if (binOffset + 8 <= buffer.byteLength) {
        const binChunkLength = view.getUint32(binOffset, true);
        const binChunkType = view.getUint32(binOffset + 4, true);
        if (binChunkType === 0x004e4942) {
            bin = buffer.slice(binOffset + 8, binOffset + 8 + binChunkLength);
        }
    }

    const primitives: GLBPrimitive[] = [];
    const imageCache = new Map<number, GltfTextureSource | null>();

    for (const {mesh, matrix} of meshInstances(json)) {
        for (const prim of mesh.primitives) {
            // Only support TRIANGLES (mode 4, which is also the default)
            if (prim.mode !== undefined && prim.mode !== 4) {
                continue;
            }

            const posIdx = prim.attributes["POSITION"];
            const normIdx = prim.attributes["NORMAL"];
            const uvIdx = prim.attributes["TEXCOORD_0"];
            const tanIdx = prim.attributes["TANGENT"];

            if (posIdx === undefined) {
                continue;
            }

            let positions = toFloat32(readAccessor(json, bin, posIdx));

            let normals =
                normIdx !== undefined
                    ? toFloat32(readAccessor(json, bin, normIdx))
                    : new Float32Array((positions.length / 3) * 3); // zeros

            const uvs =
                uvIdx !== undefined
                    ? toFloat32(readAccessor(json, bin, uvIdx))
                    : new Float32Array((positions.length / 3) * 2);

            let tangents = tanIdx !== undefined ? toFloat32(readAccessor(json, bin, tanIdx)) : null;

            let indices: Uint32Array;
            if (prim.indices !== undefined) {
                indices = toUint32(readAccessor(json, bin, prim.indices));
            } else {
                // Non-indexed: generate sequential indices
                const count = positions.length / 3;
                indices = new Uint32Array(count);
                for (let i = 0; i < count; i++) {
                    indices[i] = i;
                }
            }

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
            const material = prim.material !== undefined ? extractMaterial(json, bin, prim.material, imageCache) : null;

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
    /** Slots dropped because they read a UV set other than TEXCOORD_0. */
    skipped: GltfTextureSlot[];
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
 * Glaze geometry has a single UV set, so a texture reading another TEXCOORD set is left out (and listed in
 * `skipped`) rather than sampled with the wrong coordinates.
 */
export function planGltfMaterial(descriptor: GltfMaterialDescriptor): GltfMaterialPlan {
    const skipped: GltfTextureSlot[] = [];
    const usable = (slot: GltfTextureSlot, source: GltfTextureSource | null): GltfTextureSource | null => {
        if (!source) {
            return null;
        }
        if ((descriptor.texCoords?.[slot] ?? 0) !== 0) {
            skipped.push(slot);
            return null;
        }
        return source;
    };

    const occlusion = usable("occlusion", descriptor.occlusionTexture);
    const metallicRoughness = usable("metallicRoughness", descriptor.metallicRoughnessTexture);
    const packed = occlusion !== null && metallicRoughness !== null && sameImage(occlusion, metallicRoughness);

    const [r, g, b, a] = descriptor.baseColorFactor;
    const strength = descriptor.emissiveStrength ?? 1;
    const [er, eg, eb] = descriptor.emissiveFactor;
    return {
        options: {
            color: [linearToSrgb(r), linearToSrgb(g), linearToSrgb(b)],
            metallic: descriptor.metallicFactor,
            roughness: descriptor.roughnessFactor,
            emissive: [linearToSrgb(er * strength), linearToSrgb(eg * strength), linearToSrgb(eb * strength), 0],
            normalScale: descriptor.normalScale ?? 1,
            occlusionStrength: occlusion ? (descriptor.occlusionStrength ?? 1) : 1,
            opacity: a,
            alphaMode: descriptor.alphaMode === "MASK" ? "mask" : descriptor.alphaMode === "BLEND" ? "blend" : "opaque",
            alphaCutoff: descriptor.alphaCutoff ?? 0.5,
            doubleSided: descriptor.doubleSided ?? false,
        },
        albedoMap: usable("baseColor", descriptor.baseColorTexture),
        normalMap: usable("normal", descriptor.normalTexture),
        emissiveMap: usable("emissive", descriptor.emissiveTexture),
        ormMap: packed ? occlusion : null,
        metallicRoughnessMap: packed ? null : metallicRoughness,
        occlusionMap: packed ? null : occlusion,
        skipped,
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
 */
export async function createPBRMaterialFromGltf(
    device: GPUDevice,
    descriptor: GltfMaterialDescriptor,
    resolveUri: (uri: string) => string = (uri) => uri,
): Promise<PBRMaterial> {
    const plan = planGltfMaterial(descriptor);
    const mat = new PBRMaterial(plan.options);

    // one GPU texture per image, however many slots use it
    const loaded = new Map<GltfTextureSource, Promise<Texture>>();
    function loadTex(source: GltfTextureSource | null): Promise<Texture | null> {
        if (!source) {
            return Promise.resolve(null);
        }
        let texture = loaded.get(source);
        if (!texture) {
            texture =
                source.type === "uri"
                    ? Texture.fromURL(device, resolveUri(source.uri))
                    : Texture.fromBlob(device, new Blob([source.data], {type: source.mimeType}));
            loaded.set(source, texture);
        }
        return texture;
    }

    [mat.albedoMap, mat.normalMap, mat.emissiveMap, mat.ormMap, mat.metallicRoughnessMap, mat.occlusionMap] =
        await Promise.all([
            loadTex(plan.albedoMap),
            loadTex(plan.normalMap),
            loadTex(plan.emissiveMap),
            loadTex(plan.ormMap),
            loadTex(plan.metallicRoughnessMap),
            loadTex(plan.occlusionMap),
        ]);

    return mat;
}
