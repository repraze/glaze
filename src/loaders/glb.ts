import {Geometry, computeTangents} from "../geometry/geometry";

// ─── GLTF types (minimal subset) ─────────────────────────────────────────────

interface GltfAccessor {
    bufferView?: number;
    byteOffset?: number;
    componentType: number; // 5120=i8, 5121=u8, 5122=i16, 5123=u16, 5125=u32, 5126=f32
    count: number;
    type: string;          // "SCALAR", "VEC2", "VEC3", "VEC4"
}

interface GltfBufferView {
    buffer: number;
    byteOffset?: number;
    byteLength: number;
    byteStride?: number;
}

interface GltfMeshPrimitive {
    attributes: Record<string, number>;
    indices?: number;
    mode?: number;
}

interface GltfMesh {
    primitives: GltfMeshPrimitive[];
}

interface GltfJson {
    accessors?: GltfAccessor[];
    bufferViews?: GltfBufferView[];
    buffers?: {byteLength: number}[];
    meshes?: GltfMesh[];
}

// ─── Component type constants ─────────────────────────────────────────────────

const COMPONENT_TYPES: Record<number, {ctor: new (b: ArrayBuffer, o: number, l: number) => ArrayLike<number>; size: number}> = {
    5120: {ctor: Int8Array,    size: 1},
    5121: {ctor: Uint8Array,   size: 1},
    5122: {ctor: Int16Array,   size: 2},
    5123: {ctor: Uint16Array,  size: 2},
    5125: {ctor: Uint32Array,  size: 4},
    5126: {ctor: Float32Array, size: 4},
};

const TYPE_ELEMENT_COUNT: Record<string, number> = {
    SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4,
    MAT2: 4, MAT3: 9, MAT4: 16,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function readAccessor(
    json: GltfJson,
    bin: ArrayBuffer,
    accessorIndex: number,
): ArrayLike<number> {
    const accessor    = json.accessors![accessorIndex]!;
    const elemCount   = TYPE_ELEMENT_COUNT[accessor.type] ?? 1;
    const totalCount  = accessor.count * elemCount;
    const ct          = COMPONENT_TYPES[accessor.componentType];
    if (!ct) throw new Error(`GLB: unsupported componentType ${accessor.componentType}`);

    if (accessor.bufferView === undefined) {
        // Zero-filled sparse accessor placeholder
        return new Float32Array(totalCount);
    }

    const bv        = json.bufferViews![accessor.bufferView]!;
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
    if (data instanceof Float32Array) return data;
    return Float32Array.from(data);
}

function toUint32(data: ArrayLike<number>): Uint32Array {
    if (data instanceof Uint32Array) return data;
    return Uint32Array.from(data);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Parse a GLB (Binary GLTF 2.0) buffer and return one Geometry per mesh primitive.
 * Tangents are read from the TANGENT attribute when present, otherwise computed.
 */
export function parseGLB(buffer: ArrayBuffer): Geometry[] {
    const view = new DataView(buffer);

    // GLB header (12 bytes)
    const magic   = view.getUint32(0, true);
    const version = view.getUint32(4, true);
    if (magic !== 0x46546c67) throw new Error("GLB: invalid magic number");
    if (version !== 2)        throw new Error(`GLB: unsupported version ${version}`);

    // JSON chunk
    const jsonChunkLength = view.getUint32(12, true);
    const jsonChunkType   = view.getUint32(16, true);
    if (jsonChunkType !== 0x4e4f534a) throw new Error("GLB: first chunk is not JSON");
    const jsonText = new TextDecoder().decode(new Uint8Array(buffer, 20, jsonChunkLength));
    const json: GltfJson = JSON.parse(jsonText);

    // BIN chunk (optional)
    let bin: ArrayBuffer = new ArrayBuffer(0);
    const binOffset = 20 + jsonChunkLength;
    if (binOffset + 8 <= buffer.byteLength) {
        const binChunkLength = view.getUint32(binOffset, true);
        const binChunkType   = view.getUint32(binOffset + 4, true);
        if (binChunkType === 0x004e4942) {
            bin = buffer.slice(binOffset + 8, binOffset + 8 + binChunkLength);
        }
    }

    const geometries: Geometry[] = [];

    for (const mesh of json.meshes ?? []) {
        for (const prim of mesh.primitives) {
            // Only support TRIANGLES (mode 4, which is also the default)
            if (prim.mode !== undefined && prim.mode !== 4) continue;

            const posIdx  = prim.attributes["POSITION"];
            const normIdx = prim.attributes["NORMAL"];
            const uvIdx   = prim.attributes["TEXCOORD_0"];
            const tanIdx  = prim.attributes["TANGENT"];

            if (posIdx === undefined) continue;

            const positions = toFloat32(readAccessor(json, bin, posIdx));

            const normals = normIdx !== undefined
                ? toFloat32(readAccessor(json, bin, normIdx))
                : new Float32Array((positions.length / 3) * 3); // zeros

            const uvs = uvIdx !== undefined
                ? toFloat32(readAccessor(json, bin, uvIdx))
                : new Float32Array((positions.length / 3) * 2);

            let indices: Uint32Array;
            if (prim.indices !== undefined) {
                indices = toUint32(readAccessor(json, bin, prim.indices));
            } else {
                // Non-indexed: generate sequential indices
                const count = positions.length / 3;
                indices = new Uint32Array(count);
                for (let i = 0; i < count; i++) indices[i] = i;
            }

            const vertexCount = positions.length / 3;
            let tangents: Float32Array;
            if (tanIdx !== undefined) {
                tangents = toFloat32(readAccessor(json, bin, tanIdx));
            } else {
                tangents = computeTangents(positions, normals, uvs, indices, vertexCount);
            }

            geometries.push(new Geometry({positions, normals, uvs, indices, tangents}));
        }
    }

    return geometries;
}

/**
 * Fetch a GLB file from a URL and parse it into Geometry instances.
 */
export async function loadGLBFromURL(url: string): Promise<Geometry[]> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`GLB: failed to fetch '${url}' (${response.status})`);
    const buffer = await response.arrayBuffer();
    return parseGLB(buffer);
}
