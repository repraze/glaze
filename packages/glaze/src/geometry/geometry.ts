import {box3, type ReadonlyBox3, type ReadonlySphere, sphere} from "../math/bounds";

export interface GeometryOptions {
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    indices: Uint32Array;
    /** 4 floats per vertex: tangent xyz + handedness w (+1 or -1). */
    tangents?: Float32Array;
    /** Skinning: 4 joint indices per vertex (into the skin's joints). Needs `weights`. */
    joints?: Uint16Array;
    /** Skinning: 4 weights per vertex, summing to 1. */
    weights?: Float32Array;
    /** Blend shapes: per target, position deltas (3 a vertex) and optionally normal deltas. */
    morphTargets?: MorphTarget[];
}

/** A blend shape: how far each vertex (and its normal) moves at weight 1. */
export interface MorphTarget {
    /** 3 floats a vertex. */
    positions: Float32Array;
    /** 3 floats a vertex; none: normals stay. */
    normals?: Float32Array;
}

export class Geometry {
    /** 3 floats per vertex: x, y, z */
    readonly positions: Float32Array;
    /** 3 floats per vertex: nx, ny, nz */
    readonly normals: Float32Array;
    /** 2 floats per vertex: u, v */
    readonly uvs: Float32Array;
    readonly indices: Uint32Array;
    /** 4 floats per vertex: tangent xyz + handedness w (+1 or -1). Optional. */
    readonly tangents?: Float32Array;
    /** Skinning: 4 joint indices per vertex. Optional (with `weights`). */
    readonly joints?: Uint16Array;
    /** Skinning: 4 weights per vertex. */
    readonly weights?: Float32Array;
    /** Blend shapes, weighted per mesh by `mesh.morphWeights`. */
    readonly morphTargets?: readonly MorphTarget[];

    readonly vertexCount: number;
    readonly indexCount: number;

    constructor({positions, normals, uvs, indices, tangents, joints, weights, morphTargets}: GeometryOptions) {
        this.morphTargets = morphTargets !== undefined && morphTargets.length > 0 ? morphTargets : undefined;
        if ((joints === undefined) !== (weights === undefined)) {
            throw new Error("Geometry: joints and weights go together");
        }
        this.joints = joints;
        this.weights = weights;
        this.positions = positions;
        this.normals = normals;
        this.uvs = uvs;
        this.indices = indices;
        this.tangents = tangents;
        this.vertexCount = positions.length / 3;
        this.indexCount = indices.length;
    }

    private _boundingBox: ReadonlyBox3 | null = null;
    private _boundingSphere: ReadonlySphere | null = null;

    /** Local-space box around the positions, computed on first use and cached (see `markChanged`). */
    get boundingBox(): ReadonlyBox3 {
        return (this._boundingBox ??= box3.fromPositions(box3.create(), this.positions));
    }

    /** Local-space sphere around the positions, computed on first use and cached (see `markChanged`). */
    get boundingSphere(): ReadonlySphere {
        return (this._boundingSphere ??= sphere.fromPositions(sphere.create(), this.positions));
    }

    /** Has per-vertex joints and weights: drawn by a SkinnedMesh, deformed by its skin. */
    get skinned(): boolean {
        return this.joints !== undefined;
    }

    /**
     * The skin attributes as one buffer, 24 bytes a vertex: 4 × uint16 joints, then 4 × float32 weights.
     * Null without them.
     */
    buildSkinBuffer(): ArrayBuffer | null {
        if (this.joints === undefined || this.weights === undefined) {
            return null;
        }
        const out = new ArrayBuffer(this.vertexCount * 24);
        const u16 = new Uint16Array(out);
        const f32 = new Float32Array(out);
        for (let i = 0; i < this.vertexCount; i++) {
            for (let k = 0; k < 4; k++) {
                u16[i * 12 + k] = this.joints[i * 4 + k]!;
                f32[i * 6 + 2 + k] = this.weights[i * 4 + k]!;
            }
        }
        return out;
    }

    /**
     * The morph targets for the GPU: per target, per vertex, a position delta then a normal delta (two vec4s,
     * 32 bytes). Null without targets.
     */
    buildMorphBuffer(): Float32Array | null {
        const targets = this.morphTargets;
        if (targets === undefined) {
            return null;
        }
        const n = this.vertexCount;
        const out = new Float32Array(targets.length * n * 8);
        targets.forEach((target, t) => {
            for (let i = 0; i < n; i++) {
                const at = (t * n + i) * 8;
                for (let k = 0; k < 3; k++) {
                    out[at + k] = target.positions[i * 3 + k] ?? 0;
                    out[at + 4 + k] = target.normals?.[i * 3 + k] ?? 0;
                }
            }
        });
        return out;
    }

    /** How far any morph target moves any vertex: what bounds grow by when weights are up to 1. */
    get morphReach(): number {
        if (this._morphReach !== null) {
            return this._morphReach;
        }
        let reach = 0;
        for (const target of this.morphTargets ?? []) {
            for (let i = 0; i < target.positions.length; i += 3) {
                reach = Math.max(
                    reach,
                    Math.hypot(target.positions[i]!, target.positions[i + 1]!, target.positions[i + 2]!),
                );
            }
        }
        return (this._morphReach = reach);
    }
    private _morphReach: number | null = null;

    /**
     * Call after editing the vertex data (positions, normals, uvs, tangents, joints, weights, morph targets or
     * indices) in place: cached bounds are recomputed on next use and renderers upload the data again.
     */
    markChanged(): void {
        this._boundingBox = null;
        this._boundingSphere = null;
        this._morphReach = null;
        this._version++;
    }

    /** Bumped by `markChanged`: renderers re-upload when it moves. */
    get version(): number {
        return this._version;
    }
    private _version = 0;

    /**
     * Returns an interleaved Float32Array with layout per vertex (stride = 48 bytes):
     * [px, py, pz,  nx, ny, nz,  u, v,  tx, ty, tz, tw]
     *
     * Tangent components default to (0, 0, 0, 1) when tangents are absent.
     */
    buildInterleavedBuffer(): Float32Array {
        const stride = 12;
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
            out[vo + 8] = this.tangents?.[i * 4 + 0] ?? 0;
            out[vo + 9] = this.tangents?.[i * 4 + 1] ?? 0;
            out[vo + 10] = this.tangents?.[i * 4 + 2] ?? 0;
            out[vo + 11] = this.tangents?.[i * 4 + 3] ?? 1;
        }
        return out;
    }
}

/**
 * Compute per-vertex tangents using the standard UV-space method (MikkTSpace-style).
 * Returns a Float32Array of 4 floats per vertex: tangent xyz + handedness w (+1 or -1).
 *
 * Follows glTF: the tangent points along +u and the bitangent, `cross(normal, tangent) * w`, points toward the
 * top of the image (-v, since v runs down). A normal map's green channel is therefore "up" in the image
 * (the OpenGL / glTF normal-map convention), and w is +1 for an unmirrored mapping.
 */
export function computeTangents(
    positions: Float32Array,
    normals: Float32Array,
    uvs: Float32Array,
    indices: Uint32Array,
    vertexCount: number,
): Float32Array {
    const tan1 = new Float32Array(vertexCount * 3);
    const tan2 = new Float32Array(vertexCount * 3);

    for (let t = 0; t < indices.length / 3; t++) {
        const i0 = indices[t * 3 + 0]!;
        const i1 = indices[t * 3 + 1]!;
        const i2 = indices[t * 3 + 2]!;

        const x0 = positions[i0 * 3]!,
            y0 = positions[i0 * 3 + 1]!,
            z0 = positions[i0 * 3 + 2]!;
        const x1 = positions[i1 * 3]!,
            y1 = positions[i1 * 3 + 1]!,
            z1 = positions[i1 * 3 + 2]!;
        const x2 = positions[i2 * 3]!,
            y2 = positions[i2 * 3 + 1]!,
            z2 = positions[i2 * 3 + 2]!;
        const u0 = uvs[i0 * 2]!,
            v0 = uvs[i0 * 2 + 1]!;
        const u1 = uvs[i1 * 2]!,
            v1 = uvs[i1 * 2 + 1]!;
        const u2 = uvs[i2 * 2]!,
            v2 = uvs[i2 * 2 + 1]!;

        const e1x = x1 - x0,
            e1y = y1 - y0,
            e1z = z1 - z0;
        const e2x = x2 - x0,
            e2y = y2 - y0,
            e2z = z2 - z0;
        const du1 = u1 - u0,
            dv1 = v1 - v0;
        const du2 = u2 - u0,
            dv2 = v2 - v0;

        const det = du1 * dv2 - du2 * dv1;
        const r = det !== 0 ? 1 / det : 0;

        const tx = (dv2 * e1x - dv1 * e2x) * r;
        const ty = (dv2 * e1y - dv1 * e2y) * r;
        const tz = (dv2 * e1z - dv1 * e2z) * r;
        const bx = (du1 * e2x - du2 * e1x) * r;
        const by = (du1 * e2y - du2 * e1y) * r;
        const bz = (du1 * e2z - du2 * e1z) * r;

        for (const i of [i0, i1, i2]) {
            tan1[i * 3]! += tx;
            tan1[i * 3 + 1]! += ty;
            tan1[i * 3 + 2]! += tz;
            tan2[i * 3]! += bx;
            tan2[i * 3 + 1]! += by;
            tan2[i * 3 + 2]! += bz;
        }
    }

    const out = new Float32Array(vertexCount * 4);

    for (let i = 0; i < vertexCount; i++) {
        const nx = normals[i * 3]!,
            ny = normals[i * 3 + 1]!,
            nz = normals[i * 3 + 2]!;
        const tx = tan1[i * 3]!,
            ty = tan1[i * 3 + 1]!,
            tz = tan1[i * 3 + 2]!;
        const bx = tan2[i * 3]!,
            by = tan2[i * 3 + 1]!,
            bz = tan2[i * 3 + 2]!;

        // Gram-Schmidt orthogonalize T against N
        const ndotT = nx * tx + ny * ty + nz * tz;
        let ox = tx - nx * ndotT;
        let oy = ty - ny * ndotT;
        let oz = tz - nz * ndotT;
        const len = Math.sqrt(ox * ox + oy * oy + oz * oz);
        if (len > 0) {
            ox /= len;
            oy /= len;
            oz /= len;
        }

        // Handedness: cross(N, T) * w should point toward -v (image up), against the accumulated dP/dv
        const cx = ny * oz - nz * oy;
        const cy = nz * ox - nx * oz;
        const cz = nx * oy - ny * ox;
        const w = cx * bx + cy * by + cz * bz > 0 ? -1 : 1;

        out[i * 4] = ox;
        out[i * 4 + 1] = oy;
        out[i * 4 + 2] = oz;
        out[i * 4 + 3] = w;
    }

    return out;
}
