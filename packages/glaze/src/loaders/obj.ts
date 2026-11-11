import {computeTangents, Geometry} from "../geometry/geometry";

// ─── OBJ parser ───────────────────────────────────────────────────────────────

/**
 * Parse an OBJ text string into a single Geometry.
 * Supports: `v` (positions), `vn` (normals), `vt` (UVs), `f` (faces).
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

    // Cache for (pos/uv/norm) triplet → output vertex index
    const vertexCache = new Map<string, number>();

    function getVertex(posIdx: number, uvIdx: number, normIdx: number): number {
        const key = `${posIdx}/${uvIdx}/${normIdx}`;
        const cached = vertexCache.get(key);
        if (cached !== undefined) {
            return cached;
        }

        const idx = outPositions.length / 3;

        const pi = (posIdx - 1) * 3;
        outPositions.push(srcPositions[pi] ?? 0, srcPositions[pi + 1] ?? 0, srcPositions[pi + 2] ?? 0);

        const ni = (normIdx - 1) * 3;
        outNormals.push(srcNormals[ni] ?? 0, srcNormals[ni + 1] ?? 0, srcNormals[ni + 2] ?? 1);

        const ui = (uvIdx - 1) * 2;
        outUvs.push(srcUvs[ui] ?? 0, 1 - (srcUvs[ui + 1] ?? 0)); // flip V for GL convention

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
                const [p, t, n] = token.split("/").map((s) => parseInt(s || "0", 10));
                return getVertex(p ?? 1, t ?? 0, n ?? 0);
            });
            for (let i = 1; i < faceVerts.length - 1; i++) {
                outIndices.push(faceVerts[0]!, faceVerts[i]!, faceVerts[i + 1]!);
            }
        }
    }

    // If no normals were present, compute flat normals
    if (srcNormals.length === 0) {
        const vertCount = outPositions.length / 3;
        const positions = new Float32Array(outPositions);
        const indices = new Uint32Array(outIndices);
        for (let i = 0; i < vertCount * 3; i++) {
            outNormals[i] = 0;
        }
        for (let t = 0; t < indices.length / 3; t++) {
            const i0 = indices[t * 3]!,
                i1 = indices[t * 3 + 1]!,
                i2 = indices[t * 3 + 2]!;
            const ax = positions[i0 * 3]!,
                ay = positions[i0 * 3 + 1]!,
                az = positions[i0 * 3 + 2]!;
            const bx = positions[i1 * 3]!,
                by = positions[i1 * 3 + 1]!,
                bz = positions[i1 * 3 + 2]!;
            const cx = positions[i2 * 3]!,
                cy = positions[i2 * 3 + 1]!,
                cz = positions[i2 * 3 + 2]!;
            const ux = bx - ax,
                uy = by - ay,
                uz = bz - az;
            const vx = cx - ax,
                vy = cy - ay,
                vz = cz - az;
            let nx = uy * vz - uz * vy,
                ny = uz * vx - ux * vz,
                nz = ux * vy - uy * vx;
            const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
            if (len > 0) {
                nx /= len;
                ny /= len;
                nz /= len;
            }
            for (const i of [i0, i1, i2]) {
                outNormals[i * 3] = nx;
                outNormals[i * 3 + 1] = ny;
                outNormals[i * 3 + 2] = nz;
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
