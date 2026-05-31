import {Geometry, computeTangents} from "./geometry";

// ─── Internal builder helpers ─────────────────────────────────────────────────

interface RawGeometry {
    positions: number[];
    normals: number[];
    uvs: number[];
    indices: number[];
}

function toGeometry(raw: RawGeometry): Geometry {
    const positions = new Float32Array(raw.positions);
    const normals   = new Float32Array(raw.normals);
    const uvs       = new Float32Array(raw.uvs);
    const indices   = new Uint32Array(raw.indices);
    const tangents  = computeTangents(positions, normals, uvs, indices, positions.length / 3);
    return new Geometry({positions, normals, uvs, indices, tangents});
}

/**
 * Recompute normals as per-face flat normals.
 * Expands the geometry so no vertices are shared between triangles.
 */
function applyFlatShading(raw: RawGeometry): RawGeometry {
    const out: RawGeometry = {positions: [], normals: [], uvs: [], indices: []};

    for (let tri = 0; tri < raw.indices.length / 3; tri++) {
        const ia = raw.indices[tri * 3 + 0]!;
        const ib = raw.indices[tri * 3 + 1]!;
        const ic = raw.indices[tri * 3 + 2]!;

        const ax = raw.positions[ia * 3]!, ay = raw.positions[ia * 3 + 1]!, az = raw.positions[ia * 3 + 2]!;
        const bx = raw.positions[ib * 3]!, by = raw.positions[ib * 3 + 1]!, bz = raw.positions[ib * 3 + 2]!;
        const cx = raw.positions[ic * 3]!, cy = raw.positions[ic * 3 + 1]!, cz = raw.positions[ic * 3 + 2]!;

        const ux = bx - ax, uy = by - ay, uz = bz - az;
        const vx = cx - ax, vy = cy - ay, vz = cz - az;

        let nx = uy * vz - uz * vy;
        let ny = uz * vx - ux * vz;
        let nz = ux * vy - uy * vx;
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (len > 0) { nx /= len; ny /= len; nz /= len; }

        const base = out.positions.length / 3;

        out.positions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
        out.normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
        out.uvs.push(
            raw.uvs[ia * 2]!, raw.uvs[ia * 2 + 1]!,
            raw.uvs[ib * 2]!, raw.uvs[ib * 2 + 1]!,
            raw.uvs[ic * 2]!, raw.uvs[ic * 2 + 1]!,
        );
        out.indices.push(base, base + 1, base + 2);
    }

    return out;
}

// ─── Cube ─────────────────────────────────────────────────────────────────────

export interface CubeOptions {
    size?: number;
    widthSegments?: number;
    heightSegments?: number;
    depthSegments?: number;
    flat?: boolean;
}

export function createCube({
    size = 1,
    widthSegments = 1,
    heightSegments = 1,
    depthSegments = 1,
    flat = false,
}: CubeOptions = {}): Geometry {
    const raw: RawGeometry = {positions: [], normals: [], uvs: [], indices: []};
    const hw = size / 2;

    const faces: Array<{
        u: [number, number, number];
        v: [number, number, number];
        n: [number, number, number];
        o: [number, number, number];
        su: number;
        sv: number;
    }> = [
        {u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1],  o: [-hw, -hw, hw],  su: widthSegments, sv: heightSegments},
        {u: [-1, 0, 0], v: [0, 1, 0], n: [0, 0, -1], o: [hw, -hw, -hw],  su: widthSegments, sv: heightSegments},
        {u: [1, 0, 0], v: [0, 0, -1], n: [0, 1, 0],  o: [-hw, hw, hw],   su: widthSegments, sv: depthSegments},
        {u: [1, 0, 0], v: [0, 0, 1],  n: [0, -1, 0], o: [-hw, -hw, -hw], su: widthSegments, sv: depthSegments},
        {u: [0, 0, -1], v: [0, 1, 0], n: [1, 0, 0],  o: [hw, -hw, hw],   su: depthSegments, sv: heightSegments},
        {u: [0, 0, 1],  v: [0, 1, 0], n: [-1, 0, 0], o: [-hw, -hw, -hw], su: depthSegments, sv: heightSegments},
    ];

    for (const face of faces) {
        const {u, v, n, o, su, sv} = face;
        const base = raw.positions.length / 3;

        for (let j = 0; j <= sv; j++) {
            for (let i = 0; i <= su; i++) {
                const s = i / su;
                const t = j / sv;
                raw.positions.push(
                    o[0] + u[0] * s * size + v[0] * t * size,
                    o[1] + u[1] * s * size + v[1] * t * size,
                    o[2] + u[2] * s * size + v[2] * t * size,
                );
                raw.normals.push(n[0], n[1], n[2]);
                raw.uvs.push(s, t);
            }
        }

        for (let j = 0; j < sv; j++) {
            for (let i = 0; i < su; i++) {
                const a = base + j * (su + 1) + i;
                const b = a + 1;
                const c = base + (j + 1) * (su + 1) + i;
                const d = c + 1;
                raw.indices.push(a, b, c, b, d, c);
            }
        }
    }

    return toGeometry(flat ? applyFlatShading(raw) : raw);
}

// ─── Plane ────────────────────────────────────────────────────────────────────

export interface PlaneOptions {
    width?: number;
    height?: number;
    widthSegments?: number;
    heightSegments?: number;
    flat?: boolean;
}

export function createPlane({
    width = 1,
    height = 1,
    widthSegments = 1,
    heightSegments = 1,
    flat = false,
}: PlaneOptions = {}): Geometry {
    const raw: RawGeometry = {positions: [], normals: [], uvs: [], indices: []};
    const hw = width / 2, hh = height / 2;

    for (let j = 0; j <= heightSegments; j++) {
        for (let i = 0; i <= widthSegments; i++) {
            const x = (i / widthSegments) * width - hw;
            const z = (j / heightSegments) * height - hh;
            raw.positions.push(x, 0, z);
            raw.normals.push(0, 1, 0);
            raw.uvs.push(i / widthSegments, j / heightSegments);
        }
    }

    for (let j = 0; j < heightSegments; j++) {
        for (let i = 0; i < widthSegments; i++) {
            const a = j * (widthSegments + 1) + i;
            const b = a + 1;
            const c = (j + 1) * (widthSegments + 1) + i;
            const d = c + 1;
            raw.indices.push(a, c, b, b, c, d);
        }
    }

    return toGeometry(flat ? applyFlatShading(raw) : raw);
}

// ─── Quad ─────────────────────────────────────────────────────────────────────

export interface QuadOptions {
    width?: number;
    height?: number;
    flat?: boolean;
}

export function createQuad({width = 1, height = 1, flat = false}: QuadOptions = {}): Geometry {
    return createPlane({width, height, widthSegments: 1, heightSegments: 1, flat});
}

// ─── Sphere (UV sphere) ───────────────────────────────────────────────────────

export interface SphereOptions {
    radius?: number;
    widthSegments?: number;
    heightSegments?: number;
    flat?: boolean;
}

export function createSphere({
    radius = 1,
    widthSegments = 32,
    heightSegments = 16,
    flat = false,
}: SphereOptions = {}): Geometry {
    const raw: RawGeometry = {positions: [], normals: [], uvs: [], indices: []};

    for (let j = 0; j <= heightSegments; j++) {
        const polar = (j / heightSegments) * Math.PI;
        const sinPolar = Math.sin(polar);
        const cosPolar = Math.cos(polar);

        for (let i = 0; i <= widthSegments; i++) {
            const azimuth = (i / widthSegments) * 2 * Math.PI;
            const sinAz = Math.sin(azimuth);
            const cosAz = Math.cos(azimuth);

            const nx = cosAz * sinPolar;
            const ny = cosPolar;
            const nz = sinAz * sinPolar;

            raw.positions.push(nx * radius, ny * radius, nz * radius);
            raw.normals.push(nx, ny, nz);
            raw.uvs.push(i / widthSegments, j / heightSegments);
        }
    }

    for (let j = 0; j < heightSegments; j++) {
        for (let i = 0; i < widthSegments; i++) {
            const a = j * (widthSegments + 1) + i;
            const b = a + 1;
            const c = (j + 1) * (widthSegments + 1) + i;
            const d = c + 1;
            if (j !== 0) raw.indices.push(a, b, c);
            if (j !== heightSegments - 1) raw.indices.push(b, d, c);
        }
    }

    return toGeometry(flat ? applyFlatShading(raw) : raw);
}

// ─── Icosphere ────────────────────────────────────────────────────────────────

export interface IcosphereOptions {
    radius?: number;
    subdivisions?: number;
    flat?: boolean;
}

export function createIcosphere({
    radius = 1,
    subdivisions = 2,
    flat = false,
}: IcosphereOptions = {}): Geometry {
    const t = (1 + Math.sqrt(5)) / 2;

    let verts: [number, number, number][] = [
        [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
        [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
        [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
    ];

    verts = verts.map(([x, y, z]) => {
        const l = Math.sqrt(x * x + y * y + z * z);
        return [x / l, y / l, z / l];
    });

    let faces: [number, number, number][] = [
        [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
        [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
        [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
        [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
    ];

    const midCache = new Map<string, number>();

    function getMidpoint(i: number, j: number): number {
        const key = `${Math.min(i, j)}_${Math.max(i, j)}`;
        const cached = midCache.get(key);
        if (cached !== undefined) return cached;

        const a = verts[i]!;
        const b = verts[j]!;
        let mx = (a[0] + b[0]) / 2;
        let my = (a[1] + b[1]) / 2;
        let mz = (a[2] + b[2]) / 2;
        const l = Math.sqrt(mx * mx + my * my + mz * mz);
        mx /= l; my /= l; mz /= l;

        const idx = verts.length;
        verts.push([mx, my, mz]);
        midCache.set(key, idx);
        return idx;
    }

    for (let s = 0; s < subdivisions; s++) {
        const next: [number, number, number][] = [];
        for (const [a, b, c] of faces) {
            const ab = getMidpoint(a, b);
            const bc = getMidpoint(b, c);
            const ca = getMidpoint(c, a);
            next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
        }
        faces = next;
    }

    const raw: RawGeometry = {positions: [], normals: [], uvs: [], indices: []};

    for (const [x, y, z] of verts) {
        raw.positions.push(x * radius, y * radius, z * radius);
        raw.normals.push(x, y, z);
        const u = 0.5 + Math.atan2(z, x) / (2 * Math.PI);
        const v = 0.5 - Math.asin(y) / Math.PI;
        raw.uvs.push(u, v);
    }

    for (const [a, b, c] of faces) {
        raw.indices.push(a, b, c);
    }

    return toGeometry(flat ? applyFlatShading(raw) : raw);
}

// ─── Cylinder ─────────────────────────────────────────────────────────────────

export interface CylinderOptions {
    radiusTop?: number;
    radiusBottom?: number;
    height?: number;
    radialSegments?: number;
    heightSegments?: number;
    openEnded?: boolean;
    flat?: boolean;
}

export function createCylinder({
    radiusTop = 1,
    radiusBottom = 1,
    height = 1,
    radialSegments = 16,
    heightSegments = 1,
    openEnded = false,
    flat = false,
}: CylinderOptions = {}): Geometry {
    const raw: RawGeometry = {positions: [], normals: [], uvs: [], indices: []};
    const hh = height / 2;

    const slope = (radiusBottom - radiusTop) / height;
    for (let j = 0; j <= heightSegments; j++) {
        const t = j / heightSegments;
        const y = hh - t * height;
        const r = radiusTop + t * (radiusBottom - radiusTop);

        for (let i = 0; i <= radialSegments; i++) {
            const theta = (i / radialSegments) * 2 * Math.PI;
            const cosT = Math.cos(theta);
            const sinT = Math.sin(theta);

            raw.positions.push(r * cosT, y, r * sinT);

            const nl = Math.sqrt(1 + slope * slope);
            raw.normals.push(cosT / nl, slope / nl, sinT / nl);
            raw.uvs.push(i / radialSegments, t);
        }
    }

    const ringVerts = radialSegments + 1;
    for (let j = 0; j < heightSegments; j++) {
        for (let i = 0; i < radialSegments; i++) {
            const a = j * ringVerts + i;
            const b = a + 1;
            const c = (j + 1) * ringVerts + i;
            const d = c + 1;
            raw.indices.push(a, b, c, b, d, c);
        }
    }

    if (!openEnded) {
        const topCenter = raw.positions.length / 3;
        raw.positions.push(0, hh, 0);
        raw.normals.push(0, 1, 0);
        raw.uvs.push(0.5, 0.5);
        for (let i = 0; i <= radialSegments; i++) {
            const theta = (i / radialSegments) * 2 * Math.PI;
            raw.positions.push(radiusTop * Math.cos(theta), hh, radiusTop * Math.sin(theta));
            raw.normals.push(0, 1, 0);
            raw.uvs.push(0.5 + Math.cos(theta) * 0.5, 0.5 + Math.sin(theta) * 0.5);
        }
        for (let i = 0; i < radialSegments; i++) {
            raw.indices.push(topCenter, topCenter + 2 + i, topCenter + 1 + i);
        }

        const botCenter = raw.positions.length / 3;
        raw.positions.push(0, -hh, 0);
        raw.normals.push(0, -1, 0);
        raw.uvs.push(0.5, 0.5);
        for (let i = 0; i <= radialSegments; i++) {
            const theta = (i / radialSegments) * 2 * Math.PI;
            raw.positions.push(radiusBottom * Math.cos(theta), -hh, radiusBottom * Math.sin(theta));
            raw.normals.push(0, -1, 0);
            raw.uvs.push(0.5 + Math.cos(theta) * 0.5, 0.5 + Math.sin(theta) * 0.5);
        }
        for (let i = 0; i < radialSegments; i++) {
            raw.indices.push(botCenter, botCenter + 1 + i, botCenter + 2 + i);
        }
    }

    return toGeometry(flat ? applyFlatShading(raw) : raw);
}

// ─── Cone ─────────────────────────────────────────────────────────────────────

export interface ConeOptions {
    radius?: number;
    height?: number;
    radialSegments?: number;
    heightSegments?: number;
    openEnded?: boolean;
    flat?: boolean;
}

export function createCone({
    radius = 1,
    height = 1,
    radialSegments = 16,
    heightSegments = 1,
    openEnded = false,
    flat = false,
}: ConeOptions = {}): Geometry {
    return createCylinder({
        radiusTop: 0,
        radiusBottom: radius,
        height,
        radialSegments,
        heightSegments,
        openEnded,
        flat,
    });
}

// ─── Torus ────────────────────────────────────────────────────────────────────

export interface TorusOptions {
    radius?: number;
    tube?: number;
    radialSegments?: number;
    tubularSegments?: number;
    arc?: number;
    flat?: boolean;
}

export function createTorus({
    radius = 1,
    tube = 0.4,
    radialSegments = 16,
    tubularSegments = 32,
    arc = 2 * Math.PI,
    flat = false,
}: TorusOptions = {}): Geometry {
    const raw: RawGeometry = {positions: [], normals: [], uvs: [], indices: []};

    for (let j = 0; j <= radialSegments; j++) {
        const phi = (j / radialSegments) * 2 * Math.PI;
        const cosPhi = Math.cos(phi);
        const sinPhi = Math.sin(phi);

        for (let i = 0; i <= tubularSegments; i++) {
            const theta = (i / tubularSegments) * arc;
            const cosTheta = Math.cos(theta);
            const sinTheta = Math.sin(theta);

            const cx = (radius + tube * cosPhi) * cosTheta;
            const cy = tube * sinPhi;
            const cz = (radius + tube * cosPhi) * sinTheta;

            raw.positions.push(cx, cy, cz);

            const nx = cosPhi * cosTheta;
            const ny = sinPhi;
            const nz = cosPhi * sinTheta;
            raw.normals.push(nx, ny, nz);
            raw.uvs.push(i / tubularSegments, j / radialSegments);
        }
    }

    const ringVerts = tubularSegments + 1;
    for (let j = 0; j < radialSegments; j++) {
        for (let i = 0; i < tubularSegments; i++) {
            const a = j * ringVerts + i;
            const b = a + 1;
            const c = (j + 1) * ringVerts + i;
            const d = c + 1;
            raw.indices.push(a, c, b, b, c, d);
        }
    }

    return toGeometry(flat ? applyFlatShading(raw) : raw);
}
