// Builds packages/site/public/models/donut/donut.glb: a glazed donut with sprinkles on a lace doily, made to show
// what loadGltf reads. Deterministic (seeded); no dependencies.
//
//   node scripts/make-donut.mjs
//
// The file exercises: a named node hierarchy (Donut > Dough, Icing, Sprinkles > Sprinkle 001…, and Doily),
// ~140 sprinkle nodes sharing five meshes that share one geometry, embedded PNG textures (baked dough color, lace
// alpha), an alpha-masked double-sided material, and normalized uint16 texture coordinates.
import {mkdirSync, writeFileSync} from "node:fs";
import {crc32, deflateSync} from "node:zlib";

const OUT_DIR = new URL("../packages/site/public/models/donut/", import.meta.url);

// ─── Small math ───────────────────────────────────────────────────────────────

const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const smoothstep = (a, b, x) => {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
};
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const normalize = (a) => scale(a, 1 / (Math.hypot(...a) || 1));
/** sRGB 0..1 → linear: glTF color factors are linear. */
const linear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

/** mulberry32: a small seeded PRNG, so the donut is the same on every run. */
function prng(seed) {
    return () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ─── The donut surface ────────────────────────────────────────────────────────
// A torus lying in XZ (Y up): u goes around the ring, v around the tube (0 = outer equator, π/2 = top).

const R = 0.64; // ring radius
const r = 0.36; // tube radius
const SQUASH = 0.8; // donuts are flatter than tori

/** Small lumps so the dough doesn't look machined. */
const lumps = (u, v) =>
    0.012 * Math.sin(5 * u + 2 * v + 0.4) + 0.009 * Math.sin(9 * u - 3 * v + 1.7) + 0.005 * Math.sin(17 * u + 7 * v);

function dough(u, v) {
    const rr = r + lumps(u, v);
    const ring = R + rr * Math.cos(v);
    return [ring * Math.cos(u), rr * Math.sin(v) * SQUASH, ring * Math.sin(u)];
}

/** Outward unit normal of a surface function f(u, v) by central differences (periodic: no seam). */
function surfaceNormal(f, u, v, e = 1e-4) {
    const du = sub(f(u + e, v), f(u - e, v));
    const dv = sub(f(u, v + e), f(u, v - e));
    return normalize(cross(dv, du));
}

// Icing: the top of the tube, from a wavy outer edge with drips over to the inner edge.
const dripPhase = prng(7);
const DRIPS = Array.from({length: 9}, () => ({
    at: dripPhase() * TAU,
    len: 0.25 + dripPhase() * 0.45,
    w: 10 + dripPhase() * 14,
}));
function outerEdge(u) {
    let v = 0.2 + 0.06 * Math.sin(3 * u + 0.5) + 0.04 * Math.sin(7 * u + 2.1);
    for (const d of DRIPS) {
        const x = Math.atan2(Math.sin(u - d.at), Math.cos(u - d.at)); // wrapped distance
        v -= d.len * Math.exp(-(x * x) * d.w * d.w * 0.5); // a rounded drip down the outside
    }
    return v;
}
const innerEdge = (u) => Math.PI - 0.32 - 0.07 * Math.sin(4 * u + 1.2) - 0.04 * Math.sin(11 * u);
const ICING = 0.03;

function icingAt(u, t) {
    const v = outerEdge(u) + (innerEdge(u) - outerEdge(u)) * t;
    const base = dough(u, v);
    const n = surfaceNormal(dough, u, v);
    const thick = ICING * smoothstep(0, 0.12, t) * smoothstep(0, 0.08, 1 - t) + 0.003;
    return add(base, scale(n, thick));
}

// ─── Mesh builders ────────────────────────────────────────────────────────────

/** A (nu + 1) × (nv + 1) grid over f(s, t), s and t in 0..1; uv = (s, t) scaled; indices wound outward. */
function grid(f, nu, nv, {uvScale = [1, 1], normal}) {
    const positions = [];
    const normals = [];
    const uvs = [];
    for (let j = 0; j <= nv; j++) {
        for (let i = 0; i <= nu; i++) {
            const s = i / nu;
            const t = j / nv;
            positions.push(...f(s, t));
            normals.push(...normal(s, t));
            uvs.push(s * uvScale[0], t * uvScale[1]);
        }
    }
    const indices = [];
    for (let j = 0; j < nv; j++) {
        for (let i = 0; i < nu; i++) {
            const a = j * (nu + 1) + i;
            const b = a + 1;
            const c = a + nu + 1;
            const d = c + 1;
            indices.push(a, c, b, b, c, d);
        }
    }
    return {positions, normals, uvs, indices};
}

/** Flips winding where it disagrees with the normals (so every grid comes out facing outward). */
function orient(mesh) {
    const {positions: p, normals: n, indices: idx} = mesh;
    for (let k = 0; k < idx.length; k += 3) {
        const [a, b, c] = [idx[k], idx[k + 1], idx[k + 2]];
        const pa = [p[a * 3], p[a * 3 + 1], p[a * 3 + 2]];
        const face = cross(
            sub([p[b * 3], p[b * 3 + 1], p[b * 3 + 2]], pa),
            sub([p[c * 3], p[c * 3 + 1], p[c * 3 + 2]], pa),
        );
        if (dot(face, [n[a * 3], n[a * 3 + 1], n[a * 3 + 2]]) < 0) {
            idx[k + 1] = c;
            idx[k + 2] = b;
        }
    }
    return mesh;
}

const doughMesh = orient(
    grid((s, t) => dough(s * TAU, t * TAU), 128, 48, {normal: (s, t) => surfaceNormal(dough, s * TAU, t * TAU)}),
);

const icingMesh = orient(
    grid((s, t) => icingAt(s * TAU, t), 160, 28, {
        uvScale: [4, 1],
        normal: (s, t) => surfaceNormal((u, tt) => icingAt(u, tt), s * TAU, clamp(t, 0.002, 0.998)),
    }),
);

/** A capsule along X: a lathe of a stadium profile. */
function capsule(length, radius, around = 10, cap = 4) {
    const profile = []; // [x, radius]
    for (let k = 0; k <= cap; k++) {
        const a = (Math.PI / 2) * (1 - k / cap);
        profile.push([-length / 2 - Math.sin(a) * radius, Math.cos(a) * radius]);
    }
    for (let k = 0; k <= cap; k++) {
        const a = (Math.PI / 2) * (k / cap);
        profile.push([length / 2 + Math.sin(a) * radius, Math.cos(a) * radius]);
    }
    return orient(
        grid(
            (s, t) => {
                const [x, rad] = profile[Math.round(t * (profile.length - 1))];
                return [x, rad * Math.cos(s * TAU), rad * Math.sin(s * TAU)];
            },
            around,
            profile.length - 1,
            {
                normal: (s, t) => {
                    const k = Math.round(t * (profile.length - 1));
                    const [x, rad] = profile[k];
                    const end = x < 0 ? -length / 2 : length / 2;
                    const axial = Math.abs(x) > length / 2 ? x - end : 0;
                    return normalize([axial, rad * Math.cos(s * TAU), rad * Math.sin(s * TAU)]);
                },
            },
        ),
    );
}
const sprinkleMesh = capsule(0.07, 0.0135);

const DOILY_RADIUS = 1.5;
const doilyY = -r * SQUASH - 0.012;
const doilyMesh = grid(
    (s, t) => {
        const a = s * TAU;
        const rad = t * DOILY_RADIUS;
        return [rad * Math.cos(a), doilyY, rad * Math.sin(a)];
    },
    96,
    24,
    {normal: () => [0, 1, 0]},
);
// planar UVs: the lace texture spans the disc
for (let i = 0; i < doilyMesh.uvs.length; i += 2) {
    const p = doilyMesh.positions;
    const v = i / 2;
    doilyMesh.uvs[i] = 0.5 + p[v * 3] / (2 * DOILY_RADIUS);
    doilyMesh.uvs[i + 1] = 0.5 + p[v * 3 + 2] / (2 * DOILY_RADIUS);
}
orient(doilyMesh);

// ─── Textures ─────────────────────────────────────────────────────────────────

function png(width, height, pixel) {
    const raw = Buffer.alloc((width * 4 + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (width * 4 + 1)] = 0; // filter: none
        for (let x = 0; x < width; x++) {
            const [cr, cg, cb, ca] = pixel(x, y);
            const o = y * (width * 4 + 1) + 1 + x * 4;
            raw[o] = clamp(Math.round(cr * 255), 0, 255);
            raw[o + 1] = clamp(Math.round(cg * 255), 0, 255);
            raw[o + 2] = clamp(Math.round(cb * 255), 0, 255);
            raw[o + 3] = clamp(Math.round(ca * 255), 0, 255);
        }
    }
    const chunk = (type, data) => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(body));
        return Buffer.concat([len, body, crc]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8; // bit depth
    header[9] = 6; // RGBA
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", header),
        chunk("IDAT", deflateSync(raw, {level: 9})),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}

const speck = prng(11);
const SPECKS = new Float32Array(256 * 128).map(() => speck());

// Dough: browned top and bottom, the pale ring around the outer equator where it floated in the fryer.
const crust = hex("#b5682f");
const pale = hex("#f0cf95");
const deep = hex("#8a4a20");
const doughPng = png(256, 128, (x, y) => {
    const v = (y / 128) * TAU;
    const belt = Math.exp(-((Math.sin(v) / 0.22) ** 2)) * smoothstep(-0.3, 0.6, Math.cos(v));
    const browned = smoothstep(0.3, 1, Math.abs(Math.sin(v))) * 0.35;
    const n = SPECKS[y * 256 + x] * 0.08 - 0.04;
    return [0, 1, 2].map((c) => crust[c] * (1 - belt) + pale[c] * belt - (crust[c] - deep[c]) * browned + n).concat(1);
});

// Lace: scalloped rim, rings of round holes and a petal rosette; alpha cuts the holes.
const lacePng = png(512, 512, (x, y) => {
    const px = (x + 0.5) / 256 - 1;
    const py = (y + 0.5) / 256 - 1;
    const d = Math.hypot(px, py);
    const a = Math.atan2(py, px);
    let alpha = d < 0.9 + 0.07 * Math.abs(Math.cos(a * 14)) ? 1 : 0; // scalloped edge: rounded arcs
    const hole = (ringR, count, size, phase = 0) => {
        const k = Math.round((a / TAU) * count - phase) + phase;
        const ha = (k / count) * TAU;
        return Math.hypot(px - ringR * Math.cos(ha), py - ringR * Math.sin(ha)) < size;
    };
    if (hole(0.86, 48, 0.022) || hole(0.76, 36, 0.03, 0.5) || hole(0.64, 24, 0.038)) alpha = 0;
    const petal = Math.abs(Math.sin(a * 8)) * 0.18 + 0.3;
    if (d > 0.45 && d < 0.55 && Math.abs(d - (0.5 + 0.03 * Math.sin(a * 16))) < 0.012) alpha = 0;
    if (d < 0.4 && d > petal * 0.6 && d < petal && Math.abs(Math.sin(a * 8)) > 0.92) alpha = 0;
    return [0.9, 0.86, 0.8, alpha]; // cream
});

// ─── glTF assembly ────────────────────────────────────────────────────────────

const chunks = [];
let byteLength = 0;
const bufferViews = [];
const accessors = [];

function view(bytes, target) {
    const pad = (4 - (byteLength % 4)) % 4;
    if (pad) {
        chunks.push(Buffer.alloc(pad));
        byteLength += pad;
    }
    bufferViews.push({buffer: 0, byteOffset: byteLength, byteLength: bytes.byteLength, ...(target ? {target} : {})});
    chunks.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    byteLength += bytes.byteLength;
    return bufferViews.length - 1;
}

function accessor(array, type, componentType, extra = {}) {
    const size = {SCALAR: 1, VEC2: 2, VEC3: 3}[type];
    accessors.push({
        bufferView: view(array, extra.target),
        componentType,
        count: array.length / size,
        type,
        ...extra.fields,
    });
    return accessors.length - 1;
}

function addGeometry(mesh, {quantizeUvs = false} = {}) {
    const pos = new Float32Array(mesh.positions);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3) {
        for (let c = 0; c < 3; c++) {
            min[c] = Math.min(min[c], pos[i + c]);
            max[c] = Math.max(max[c], pos[i + c]);
        }
    }
    const vertexCount = pos.length / 3;
    const uvs = quantizeUvs
        ? // core glTF allows normalized unsigned shorts for TEXCOORD_n: half the size of floats
          new Uint16Array(mesh.uvs.map((v) => Math.round(clamp(v, 0, 1) * 65535)))
        : new Float32Array(mesh.uvs);
    return {
        POSITION: accessor(pos, "VEC3", 5126, {target: 34962, fields: {min, max}}),
        NORMAL: accessor(new Float32Array(mesh.normals), "VEC3", 5126, {target: 34962}),
        TEXCOORD_0: accessor(uvs, "VEC2", quantizeUvs ? 5123 : 5126, {
            target: 34962,
            fields: quantizeUvs ? {normalized: true} : {},
        }),
        indices: accessor(
            vertexCount < 65536 ? new Uint16Array(mesh.indices) : new Uint32Array(mesh.indices),
            "SCALAR",
            vertexCount < 65536 ? 5123 : 5125,
            {target: 34963},
        ),
    };
}

const doughGeo = addGeometry(doughMesh);
// The icing's UVs span 0..4 around the ring (no texture reads them, but keep floats where values exceed 1).
const icingGeo = addGeometry(icingMesh);
const sprinkleGeo = addGeometry(sprinkleMesh, {quantizeUvs: true});
const doilyGeo = addGeometry(doilyMesh, {quantizeUvs: true});

const images = [
    {name: "dough", mimeType: "image/png", bufferView: view(doughPng)},
    {name: "lace", mimeType: "image/png", bufferView: view(lacePng)},
];
const samplers = [{magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497}];
const textures = [
    {sampler: 0, source: 0},
    {sampler: 0, source: 1},
];

const lin = (h) => [...hex(h).map(linear), 1];
const materials = [
    {
        name: "Dough",
        pbrMetallicRoughness: {baseColorTexture: {index: 0}, metallicFactor: 0, roughnessFactor: 0.78},
    },
    {
        name: "Pink icing",
        pbrMetallicRoughness: {baseColorFactor: lin("#e85d97"), metallicFactor: 0, roughnessFactor: 0.28},
    },
    {
        name: "Lace",
        pbrMetallicRoughness: {baseColorTexture: {index: 1}, metallicFactor: 0, roughnessFactor: 0.9},
        alphaMode: "MASK",
        alphaCutoff: 0.5,
        doubleSided: true,
    },
];
const SPRINKLE_COLORS = [
    ["White", "#fbf7ee"],
    ["Yellow", "#ffd23f"],
    ["Blue", "#3a86ff"],
    ["Green", "#3fd17a"],
    ["Orange", "#ff7a2f"],
];
const sprinkleMaterial0 = materials.length;
for (const [name, color] of SPRINKLE_COLORS) {
    materials.push({
        name: `${name} sprinkle`,
        pbrMetallicRoughness: {baseColorFactor: lin(color), metallicFactor: 0, roughnessFactor: 0.45},
    });
}

const primitive = (geo, material) => {
    const {indices, ...attributes} = geo;
    return {attributes, indices, material};
};
const meshes = [
    {name: "Dough", primitives: [primitive(doughGeo, 0)]},
    {name: "Icing", primitives: [primitive(icingGeo, 1)]},
    {name: "Doily", primitives: [primitive(doilyGeo, 2)]},
];
const sprinkleMesh0 = meshes.length;
SPRINKLE_COLORS.forEach(([name], i) => {
    // five meshes, one per color, all reading the same accessors: one geometry in the file and in Glaze
    meshes.push({name: `${name} sprinkle`, primitives: [primitive(sprinkleGeo, sprinkleMaterial0 + i)]});
});

/** Unit quaternion of the rotation whose columns are x, y, z. */
function quatFromBasis(x, y, z) {
    const [m00, m10, m20] = x;
    const [m01, m11, m21] = y;
    const [m02, m12, m22] = z;
    const trace = m00 + m11 + m22;
    let q;
    if (trace > 0) {
        const s = Math.sqrt(trace + 1) * 2;
        q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4];
    } else if (m00 > m11 && m00 > m22) {
        const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
        q = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
    } else if (m11 > m22) {
        const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
        q = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s];
    } else {
        const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
        q = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s];
    }
    return normalize4(q);
}
const normalize4 = (q) => {
    const l = Math.hypot(...q);
    return q.map((c) => c / l);
};

const nodes = [];
const node = (n) => (nodes.push(n), nodes.length - 1);

// Sprinkles scattered over the icing (not too close to its edges), lying on the surface at random angles.
const rand = prng(42);
const sprinkleNodes = [];
const placed = [];
for (let tries = 0; sprinkleNodes.length < 200 && tries < 20000; tries++) {
    const u = rand() * TAU;
    const t = 0.12 + rand() * 0.76;
    const p = icingAt(u, t);
    if (placed.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 0.062)) continue;
    placed.push(p);
    const n = surfaceNormal((uu, tt) => icingAt(uu, tt), u, t);
    const spin = rand() * TAU;
    const helper = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const t1 = normalize(cross(helper, n));
    const t2 = cross(n, t1);
    const along = add(scale(t1, Math.cos(spin)), scale(t2, Math.sin(spin))); // the sprinkle's long axis (X)
    const side = cross(n, along);
    const color = Math.floor(rand() * SPRINKLE_COLORS.length);
    sprinkleNodes.push(
        node({
            name: `Sprinkle ${String(sprinkleNodes.length + 1).padStart(3, "0")}`,
            mesh: sprinkleMesh0 + color,
            translation: add(p, scale(n, 0.006)).map((c) => Math.round(c * 1e5) / 1e5),
            rotation: quatFromBasis(along, n, scale(side, -1)).map((c) => Math.round(c * 1e6) / 1e6),
        }),
    );
}

const doughNode = node({name: "Dough", mesh: 0});
const icingNode = node({name: "Icing", mesh: 1});
const sprinklesNode = node({name: "Sprinkles", children: sprinkleNodes});
const donutNode = node({name: "Donut", children: [doughNode, icingNode, sprinklesNode], translation: [0, -doilyY, 0]});
const doilyNode = node({name: "Doily", mesh: 2, translation: [0, -doilyY, 0]});

const json = {
    asset: {version: "2.0", generator: "glaze scripts/make-donut.mjs"},
    scene: 0,
    scenes: [{name: "Donut on a doily", nodes: [donutNode, doilyNode]}],
    nodes,
    meshes,
    materials,
    textures,
    samplers,
    images,
    accessors,
    bufferViews,
    buffers: [{byteLength}],
};

// ─── GLB container ────────────────────────────────────────────────────────────

const pad4 = (buf, fill) => (buf.length % 4 ? Buffer.concat([buf, Buffer.alloc(4 - (buf.length % 4), fill)]) : buf);
const binChunk = pad4(Buffer.concat(chunks), 0);
json.buffers[0].byteLength = binChunk.length;
const jsonFinal = pad4(Buffer.from(JSON.stringify(json)), 0x20);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonFinal.length + 8 + binChunk.length, 8);
const chunkHeader = (length, type) => {
    const b = Buffer.alloc(8);
    b.writeUInt32LE(length, 0);
    b.writeUInt32LE(type, 4);
    return b;
};
const glb = Buffer.concat([
    header,
    chunkHeader(jsonFinal.length, 0x4e4f534a),
    jsonFinal,
    chunkHeader(binChunk.length, 0x004e4942),
    binChunk,
]);

mkdirSync(OUT_DIR, {recursive: true});
writeFileSync(new URL("donut.glb", OUT_DIR), glb);
console.log(
    `donut.glb: ${(glb.length / 1024).toFixed(0)} KiB, ${nodes.length} nodes, ${meshes.length} meshes, ` +
        `${materials.length} materials, ${sprinkleNodes.length} sprinkles`,
);
