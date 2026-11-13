import {computeTangents, Geometry} from "../geometry/geometry";

// ─── OBJ parser ───────────────────────────────────────────────────────────────

/**
 * Parse an OBJ text string into a single Geometry.
 * Supports: `v` (positions), `vn` (normals), `vt` (UVs), `f` (faces, with 1-based or negative relative indices).
 * Vertices without a normal get a smooth one from the faces around them.
 * Material directives (mtllib/usemtl) and object/group names are ignored.
 * All faces are triangulated via fan triangulation.
 * Tangents are computed automatically.
 */
export function parseOBJ(text: string): Geometry {
    const srcPositions: number[] = [];
    const srcNormals: number[] = [];
    const srcUvs: number[] = [];

    const outPositions: number[] = [];
    const outNormals: number[] = [];
    const outUvs: number[] = [];
    const outIndices: number[] = [];
    /** Output vertices whose face corner named no normal: they get one computed from the faces around them. */
    const missingNormal: boolean[] = [];

    // Cache for (pos/uv/norm) triplet → output vertex index
    const vertexCache = new Map<string, number>();

    /** OBJ indices count from 1; negative ones count back from the last element read so far. */
    const resolve = (index: number, count: number): number => (index < 0 ? count + index : index - 1);

    function getVertex(posIdx: number, uvIdx: number, normIdx: number): number {
        const key = `${posIdx}/${uvIdx}/${normIdx}`;
        const cached = vertexCache.get(key);
        if (cached !== undefined) {
            return cached;
        }

        const idx = outPositions.length / 3;

        const pi = posIdx * 3;
        outPositions.push(srcPositions[pi] ?? 0, srcPositions[pi + 1] ?? 0, srcPositions[pi + 2] ?? 0);

        const hasNormal = normIdx >= 0 && normIdx * 3 + 2 < srcNormals.length;
        const ni = normIdx * 3;
        outNormals.push(
            hasNormal ? srcNormals[ni]! : 0,
            hasNormal ? srcNormals[ni + 1]! : 0,
            hasNormal ? srcNormals[ni + 2]! : 0,
        );
        missingNormal.push(!hasNormal);

        const ui = uvIdx * 2;
        outUvs.push(uvIdx >= 0 ? (srcUvs[ui] ?? 0) : 0, 1 - (uvIdx >= 0 ? (srcUvs[ui + 1] ?? 0) : 0)); // flip V for GL convention

        vertexCache.set(key, idx);
        return idx;
    }

    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) {
            continue;
        }

        const parts = line.split(/\s+/);
        const cmd = parts[0];

        if (cmd === "v") {
            srcPositions.push(parseFloat(parts[1] ?? "0"), parseFloat(parts[2] ?? "0"), parseFloat(parts[3] ?? "0"));
        } else if (cmd === "vn") {
            srcNormals.push(parseFloat(parts[1] ?? "0"), parseFloat(parts[2] ?? "0"), parseFloat(parts[3] ?? "0"));
        } else if (cmd === "vt") {
            srcUvs.push(parseFloat(parts[1] ?? "0"), parseFloat(parts[2] ?? "0"));
        } else if (cmd === "f") {
            // Fan triangulation: vertex 0 + pairs of consecutive vertices
            const faceVerts = parts.slice(1).map((token) => {
                const [p, t, n] = token.split("/").map((s) => (s ? parseInt(s, 10) : 0));
                return getVertex(
                    resolve(p || 1, srcPositions.length / 3),
                    t ? resolve(t, srcUvs.length / 2) : -1,
                    n ? resolve(n, srcNormals.length / 3) : -1,
                );
            });
            for (let i = 1; i < faceVerts.length - 1; i++) {
                outIndices.push(faceVerts[0]!, faceVerts[i]!, faceVerts[i + 1]!);
            }
        }
    }

    // Vertices without a normal: the area-weighted sum of the faces' normals around them (smooth where the
    // corners share a position and UV)
    if (missingNormal.includes(true)) {
        for (let t = 0; t + 2 < outIndices.length; t += 3) {
            const i0 = outIndices[t]!;
            const i1 = outIndices[t + 1]!;
            const i2 = outIndices[t + 2]!;
            const ux = outPositions[i1 * 3]! - outPositions[i0 * 3]!;
            const uy = outPositions[i1 * 3 + 1]! - outPositions[i0 * 3 + 1]!;
            const uz = outPositions[i1 * 3 + 2]! - outPositions[i0 * 3 + 2]!;
            const vx = outPositions[i2 * 3]! - outPositions[i0 * 3]!;
            const vy = outPositions[i2 * 3 + 1]! - outPositions[i0 * 3 + 1]!;
            const vz = outPositions[i2 * 3 + 2]! - outPositions[i0 * 3 + 2]!;
            // the cross product's length is twice the area: bigger faces count more
            const nx = uy * vz - uz * vy;
            const ny = uz * vx - ux * vz;
            const nz = ux * vy - uy * vx;
            for (const i of [i0, i1, i2]) {
                if (missingNormal[i]) {
                    outNormals[i * 3] = outNormals[i * 3]! + nx;
                    outNormals[i * 3 + 1] = outNormals[i * 3 + 1]! + ny;
                    outNormals[i * 3 + 2] = outNormals[i * 3 + 2]! + nz;
                }
            }
        }
        for (let i = 0; i < missingNormal.length; i++) {
            if (missingNormal[i]) {
                const len = Math.hypot(outNormals[i * 3]!, outNormals[i * 3 + 1]!, outNormals[i * 3 + 2]!);
                if (len > 0) {
                    outNormals[i * 3] = outNormals[i * 3]! / len;
                    outNormals[i * 3 + 1] = outNormals[i * 3 + 1]! / len;
                    outNormals[i * 3 + 2] = outNormals[i * 3 + 2]! / len;
                } else {
                    outNormals[i * 3 + 2] = 1;
                }
            }
        }
    }

    const positions = new Float32Array(outPositions);
    const normals = new Float32Array(outNormals);
    const uvs = new Float32Array(outUvs);
    const indices = new Uint32Array(outIndices);
    const tangents = computeTangents(positions, normals, uvs, indices, positions.length / 3);

    return new Geometry({positions, normals, uvs, indices, tangents});
}

/**
 * Fetch an OBJ file from a URL and parse it into a Geometry.
 */
export async function loadOBJFromURL(url: string): Promise<Geometry> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`OBJ: failed to fetch '${url}' (${response.status})`);
    }
    const text = await response.text();
    return parseOBJ(text);
}
