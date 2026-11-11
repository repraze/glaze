import {computeTangents, Geometry} from "../geometry/geometry";
import {PBRMaterial} from "../material/material";
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

interface GltfJson {
    accessors?: GltfAccessor[];
    bufferViews?: GltfBufferView[];
    buffers?: {byteLength: number}[];
    meshes?: GltfMesh[];
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

/**
 * GPU-free material descriptor extracted from a GLTF primitive.
 * Scalar defaults follow the GLTF 2.0 spec.
 */
export interface GltfMaterialDescriptor {
    name: string;
    /** RGBA base color factor (default [1,1,1,1]). */
    baseColorFactor: [number, number, number, number];
    /** Default 1.0 per GLTF spec. */
    metallicFactor: number;
    /** Default 1.0 per GLTF spec. */
    roughnessFactor: number;
    emissiveFactor: [number, number, number];
    baseColorTexture: GltfTextureSource | null;
    normalTexture: GltfTextureSource | null;
    emissiveTexture: GltfTextureSource | null;
    occlusionTexture: GltfTextureSource | null;
    /** ORM texture: R=occlusion, G=roughness, B=metallic. */
    metallicRoughnessTexture: GltfTextureSource | null;
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

function extractTextureSource(json: GltfJson, bin: ArrayBuffer, textureIndex: number): GltfTextureSource | null {
    const texture = json.textures?.[textureIndex];
    if (!texture || texture.source === undefined) {
        return null;
    }
    const image = json.images?.[texture.source];
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

function extractMaterial(json: GltfJson, bin: ArrayBuffer, materialIndex: number): GltfMaterialDescriptor {
    const mat = json.materials?.[materialIndex];
    const pbr = mat?.pbrMetallicRoughness ?? {};
    const tex = (ref: GltfTextureRef | undefined) =>
        ref !== undefined ? extractTextureSource(json, bin, ref.index) : null;

    return {
        name: mat?.name ?? "",
        baseColorFactor: pbr.baseColorFactor ?? [1, 1, 1, 1],
        metallicFactor: pbr.metallicFactor ?? 1.0,
        roughnessFactor: pbr.roughnessFactor ?? 1.0,
        emissiveFactor: mat?.emissiveFactor ?? [0, 0, 0],
        baseColorTexture: tex(pbr.baseColorTexture),
        normalTexture: tex(mat?.normalTexture),
        emissiveTexture: tex(mat?.emissiveTexture),
        occlusionTexture: tex(mat?.occlusionTexture),
        metallicRoughnessTexture: tex(pbr.metallicRoughnessTexture),
    };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Parse a GLB (Binary GLTF 2.0) buffer and return one {@link GLBPrimitive} per
 * mesh primitive, each carrying a {@link Geometry} and an optional
 * {@link GltfMaterialDescriptor}.
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

    for (const mesh of json.meshes ?? []) {
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

            const positions = toFloat32(readAccessor(json, bin, posIdx));

            const normals =
                normIdx !== undefined
                    ? toFloat32(readAccessor(json, bin, normIdx))
                    : new Float32Array((positions.length / 3) * 3); // zeros

            const uvs =
                uvIdx !== undefined
                    ? toFloat32(readAccessor(json, bin, uvIdx))
                    : new Float32Array((positions.length / 3) * 2);

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

            const vertexCount = positions.length / 3;
            let tangents: Float32Array;
            if (tanIdx !== undefined) {
                tangents = toFloat32(readAccessor(json, bin, tanIdx));
            } else {
                tangents = computeTangents(positions, normals, uvs, indices, vertexCount);
            }

            const geometry = new Geometry({positions, normals, uvs, indices, tangents});
            const material = prim.material !== undefined ? extractMaterial(json, bin, prim.material) : null;

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
 * Build a {@link PBRMaterial} from a {@link GltfMaterialDescriptor}.
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
    const [r, g, b] = descriptor.baseColorFactor;
    const mat = new PBRMaterial({
        color: [r!, g!, b!],
        metallic: descriptor.metallicFactor,
        roughness: descriptor.roughnessFactor,
        emissive: [descriptor.emissiveFactor[0], descriptor.emissiveFactor[1], descriptor.emissiveFactor[2], 0],
    });

    async function loadTex(source: GltfTextureSource | null): Promise<Texture | null> {
        if (!source) {
            return null;
        }
        if (source.type === "uri") {
            return Texture.fromURL(device, resolveUri(source.uri));
        }
        return Texture.fromBlob(device, new Blob([source.data], {type: source.mimeType}));
    }

    const [albedo, normal, emissive, orm] = await Promise.all([
        loadTex(descriptor.baseColorTexture),
        loadTex(descriptor.normalTexture),
        loadTex(descriptor.emissiveTexture),
        loadTex(descriptor.metallicRoughnessTexture),
    ]);

    if (albedo) {
        mat.albedoMap = albedo;
    }
    if (normal) {
        mat.normalMap = normal;
    }
    if (emissive) {
        mat.emissiveMap = emissive;
    }
    if (orm) {
        mat.ormMap = orm;
    }

    return mat;
}
