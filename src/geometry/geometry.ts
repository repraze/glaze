export interface GeometryOptions {
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    indices: Uint32Array;
}

export class Geometry {
    /** 3 floats per vertex: x, y, z */
    readonly positions: Float32Array;
    /** 3 floats per vertex: nx, ny, nz */
    readonly normals: Float32Array;
    /** 2 floats per vertex: u, v */
    readonly uvs: Float32Array;
    readonly indices: Uint32Array;

    readonly vertexCount: number;
    readonly indexCount: number;

    constructor({ positions, normals, uvs, indices }: GeometryOptions) {
        this.positions = positions;
        this.normals = normals;
        this.uvs = uvs;
        this.indices = indices;
        this.vertexCount = positions.length / 3;
        this.indexCount = indices.length;
    }

    /**
     * Returns an interleaved Float32Array with layout:
     * [px, py, pz, nx, ny, nz, u, v] per vertex (stride = 32 bytes).
     */
    buildInterleavedBuffer(): Float32Array {
        const stride = 8; // floats per vertex
        const out = new Float32Array(this.vertexCount * stride);
        for (let i = 0; i < this.vertexCount; i++) {
            const vo = i * stride;
            out[vo + 0] = this.positions[i * 3 + 0]!;
            out[vo + 1] = this.positions[i * 3 + 1]!;
            out[vo + 2] = this.positions[i * 3 + 2]!;
            out[vo + 3] = this.normals[i * 3 + 0]!;
            out[vo + 4] = this.normals[i * 3 + 1]!;
            out[vo + 5] = this.normals[i * 3 + 2]!;
            out[vo + 6] = this.uvs[i * 2 + 0]!;
            out[vo + 7] = this.uvs[i * 2 + 1]!;
        }
        return out;
    }
}
