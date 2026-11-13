// Builds packages/site/public/models/clockwork/clockwork.glb: a small desk toy with node animations, for the
// glTF animation docs. Deterministic, no dependencies: `node scripts/make-clockwork.mjs`.
//
// Two clips over the same nodes, to crossfade between:
//   "Run"  (2 s): the pendulum swings (LINEAR rotation), the ball bounces (CUBICSPLINE translation) and
//                 squashes (LINEAR scale), the gears turn (LINEAR rotation, quarter-turn keys), the lamp blinks
//                 (STEP scale).
//   "Idle" (4 s): a slow sway, slow gears, the ball resting, the lamp off.

import {mkdirSync, writeFileSync} from "node:fs";

const OUT_DIR = new URL("../packages/site/public/models/clockwork/", import.meta.url);
const TAU = Math.PI * 2;
const r6 = (v) => Math.round(v * 1e6) / 1e6;

// ─── Geometry ─────────────────────────────────────────────────────────────────

/** An axis-aligned box centred on the origin, flat-shaded (24 vertices). */
function box(sx, sy, sz) {
    const positions = [];
    const normals = [];
    const uvs = [];
    const indices = [];
    const faces = [
        [
            [1, 0, 0],
            [0, 0, -1],
            [0, 1, 0],
        ],
        [
            [-1, 0, 0],
            [0, 0, 1],
            [0, 1, 0],
        ],
        [
            [0, 1, 0],
            [1, 0, 0],
            [0, 0, -1],
        ],
        [
            [0, -1, 0],
            [1, 0, 0],
            [0, 0, 1],
        ],
        [
            [0, 0, 1],
            [1, 0, 0],
            [0, 1, 0],
        ],
        [
            [0, 0, -1],
            [-1, 0, 0],
            [0, 1, 0],
        ],
    ];
    const half = [sx / 2, sy / 2, sz / 2];
    for (const [n, u, v] of faces) {
        const base = positions.length / 3;
        for (const [a, b] of [
            [-1, -1],
            [1, -1],
            [1, 1],
            [-1, 1],
        ]) {
            for (let c = 0; c < 3; c++) {
                positions.push((n[c] + a * u[c] + b * v[c]) * half[c]);
            }
            normals.push(...n);
            uvs.push((a + 1) / 2, (1 - b) / 2);
        }
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    return {positions, normals, uvs, indices};
}

/** A UV sphere. */
function sphere(radius, around = 32, rings = 16) {
    const positions = [];
    const normals = [];
    const uvs = [];
    const indices = [];
    for (let j = 0; j <= rings; j++) {
        const v = j / rings;
        const phi = v * Math.PI;
        for (let i = 0; i <= around; i++) {
            const u = i / around;
            const theta = u * TAU;
            const n = [Math.sin(phi) * Math.cos(theta), Math.cos(phi), -Math.sin(phi) * Math.sin(theta)];
            positions.push(...n.map((c) => c * radius));
            normals.push(...n);
            uvs.push(u, v);
        }
    }
    for (let j = 0; j < rings; j++) {
        for (let i = 0; i < around; i++) {
            const a = j * (around + 1) + i;
            const b = a + around + 1;
            indices.push(a, b, a + 1, a + 1, b, b + 1);
        }
    }
    return {positions, normals, uvs, indices};
}

/** A gear lying in the XY plane (axis Z): a disc with `teeth` rectangular teeth, flat-shaded. */
function gear(radius, depth, teeth) {
    const out = {positions: [], normals: [], uvs: [], indices: []};
    const profile = []; // outline points around Z
    const steps = teeth * 4;
    for (let i = 0; i < steps; i++) {
        const a = (i / steps) * TAU;
        const r = i % 4 < 2 ? radius : radius * 0.82;
        profile.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    const half = depth / 2;
    // caps (a fan around the centre)
    for (const side of [1, -1]) {
        const base = out.positions.length / 3;
        out.positions.push(0, 0, side * half);
        out.normals.push(0, 0, side);
        out.uvs.push(0.5, 0.5);
        for (const [x, y] of profile) {
            out.positions.push(x, y, side * half);
            out.normals.push(0, 0, side);
            out.uvs.push(0.5 + x / (2 * radius), 0.5 - y / (2 * radius));
        }
        for (let i = 0; i < profile.length; i++) {
            const a = base + 1 + i;
            const b = base + 1 + ((i + 1) % profile.length);
            out.indices.push(...(side > 0 ? [base, a, b] : [base, b, a]));
        }
    }
    // rim: one quad per outline edge, flat
    for (let i = 0; i < profile.length; i++) {
        const [x0, y0] = profile[i];
        const [x1, y1] = profile[(i + 1) % profile.length];
        const len = Math.hypot(x1 - x0, y1 - y0) || 1;
        const n = [(y1 - y0) / len, -(x1 - x0) / len, 0];
        const base = out.positions.length / 3;
        out.positions.push(x0, y0, half, x1, y1, half, x1, y1, -half, x0, y0, -half);
        for (let k = 0; k < 4; k++) {
            out.normals.push(...n);
            out.uvs.push(k === 1 || k === 2 ? 1 : 0, k < 2 ? 0 : 1);
        }
        out.indices.push(base, base + 3, base + 2, base, base + 2, base + 1);
    }
    return out;
}

/**
 * A tube along +Y from `y0`, `bones` segments of `segment` each, skinned to a chain of bones: each ring follows
 * the two bones it sits between, blended by height.
 */
function stalk(x, y0, z, radius, segment, bones, around = 12, ringsPerBone = 6) {
    const out = {positions: [], normals: [], uvs: [], indices: [], joints: [], weights: []};
    const rings = bones * ringsPerBone;
    for (let j = 0; j <= rings; j++) {
        const t = j / ringsPerBone; // in bones
        const y = y0 + t * segment;
        const bone = Math.min(Math.floor(t), bones - 1);
        const f = Math.min(t - bone, 1);
        // blend toward the next bone over the upper half of each segment
        const w = Math.max(0, (f - 0.5) * 2);
        const next = Math.min(bone + 1, bones - 1);
        const taper = 1 - 0.35 * (j / rings);
        for (let i = 0; i <= around; i++) {
            const a = (i / around) * TAU;
            const n = [Math.cos(a), 0, -Math.sin(a)];
            out.positions.push(r6(x + n[0] * radius * taper), r6(y), r6(z + n[2] * radius * taper));
            out.normals.push(r6(n[0]), 0, r6(n[2]));
            out.uvs.push(i / around, j / rings);
            out.joints.push(bone, next, 0, 0);
            out.weights.push(r6(1 - w), r6(w), 0, 0);
        }
    }
    for (let j = 0; j < rings; j++) {
        for (let i = 0; i < around; i++) {
            const a = j * (around + 1) + i;
            const b = a + around + 1;
            out.indices.push(a, a + 1, b, a + 1, b + 1, b);
        }
    }
    return out;
}

// ─── Animation helpers ────────────────────────────────────────────────────────

/** Quaternion [x, y, z, w] for `angle` about a unit axis. */
const axisAngle = (axis, angle) => [...axis.map((c) => c * Math.sin(angle / 2)), Math.cos(angle / 2)].map(r6);

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

const SIZES = {SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16};

function accessor(array, type, componentType, {target, fields = {}} = {}) {
    accessors.push({
        bufferView: view(array, target),
        componentType,
        count: array.length / SIZES[type],
        type,
        ...fields,
    });
    return accessors.length - 1;
}

/** min/max of a flat float array with `size` components. */
function bounds(values, size) {
    const min = Array(size).fill(Infinity);
    const max = Array(size).fill(-Infinity);
    for (let i = 0; i < values.length; i += size) {
        for (let c = 0; c < size; c++) {
            min[c] = Math.min(min[c], values[i + c]);
            max[c] = Math.max(max[c], values[i + c]);
        }
    }
    return {min: min.map(r6), max: max.map(r6)};
}

function addGeometry(mesh) {
    const pos = new Float32Array(mesh.positions);
    return {
        POSITION: accessor(pos, "VEC3", 5126, {target: 34962, fields: bounds(pos, 3)}),
        NORMAL: accessor(new Float32Array(mesh.normals), "VEC3", 5126, {target: 34962}),
        TEXCOORD_0: accessor(new Float32Array(mesh.uvs), "VEC2", 5126, {target: 34962}),
        ...(mesh.joints
            ? {
                  JOINTS_0: accessor(new Uint8Array(mesh.joints), "VEC4", 5121, {target: 34962}),
                  WEIGHTS_0: accessor(new Float32Array(mesh.weights), "VEC4", 5126, {target: 34962}),
              }
            : {}),
        indices: accessor(new Uint16Array(mesh.indices), "SCALAR", 5123, {target: 34963}),
    };
}

const linear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const hex = (h) => [1, 3, 5].map((i) => r6(linear(parseInt(h.slice(i, i + 2), 16) / 255)));

const materials = [
    {
        name: "Walnut",
        pbrMetallicRoughness: {baseColorFactor: [...hex("#6b4226"), 1], metallicFactor: 0, roughnessFactor: 0.55},
    },
    {
        name: "Brass",
        pbrMetallicRoughness: {baseColorFactor: [...hex("#d4a547"), 1], metallicFactor: 1, roughnessFactor: 0.3},
    },
    {
        name: "Brushed Brass",
        pbrMetallicRoughness: {baseColorFactor: [...hex("#c9973c"), 1], metallicFactor: 0.85, roughnessFactor: 0.55},
    },
    {
        name: "Steel",
        pbrMetallicRoughness: {baseColorFactor: [...hex("#b9c0c8"), 1], metallicFactor: 1, roughnessFactor: 0.25},
    },
    {
        name: "Rubber",
        pbrMetallicRoughness: {baseColorFactor: [...hex("#e2483d"), 1], metallicFactor: 0, roughnessFactor: 0.6},
    },
    {
        name: "Lamp",
        pbrMetallicRoughness: {baseColorFactor: [...hex("#2a2a2a"), 1], metallicFactor: 0, roughnessFactor: 0.4},
        emissiveFactor: hex("#ffc04d"),
        extensions: {KHR_materials_emissive_strength: {emissiveStrength: 4}},
    },
];

const meshes = [];
/** A one-primitive mesh; `targets` adds morph targets (position deltas, flat), with weights starting at 0. */
function mesh(name, geometry, material, targets = []) {
    const {indices, ...attributes} = geometry;
    const primitive = {attributes, indices, material};
    if (targets.length > 0) {
        primitive.targets = targets.map((deltas) => {
            const d = new Float32Array(deltas);
            return {POSITION: accessor(d, "VEC3", 5126, {fields: bounds(d, 3)})};
        });
    }
    meshes.push({name, primitives: [primitive], ...(targets.length > 0 ? {weights: targets.map(() => 0)} : {})});
    return meshes.length - 1;
}

/** "Ridges": a sphere's vertices pushed out along their normals by a ribbed pattern around Y (a pumpkin). */
function ridges(geometry, depth, ribs) {
    const out = [];
    for (let i = 0; i < geometry.positions.length; i += 3) {
        const [nx, ny, nz] = geometry.normals.slice(i, i + 3);
        const theta = Math.atan2(nz, nx);
        const side = Math.sqrt(Math.max(0, 1 - ny * ny)); // none at the poles
        const push = depth * side * (0.5 + 0.5 * Math.cos(ribs * theta));
        out.push(r6(nx * push), r6(ny * push * 0.3), r6(nz * push));
    }
    return out;
}

const baseMesh = mesh("Base", addGeometry(box(3.2, 0.24, 1.6)), 0);
const postMesh = mesh("Post", addGeometry(box(0.12, 2.2, 0.12)), 0);
const beamMesh = mesh("Beam", addGeometry(box(0.9, 0.1, 0.12)), 0);
const rodMesh = mesh("Rod", addGeometry(box(0.035, 1.3, 0.035)), 3);
const bobMesh = mesh("Bob", addGeometry(sphere(0.2)), 1);
const gearBigMesh = mesh("Gear Big", addGeometry(gear(0.5, 0.12, 12)), 2);
const gearSmallMesh = mesh("Gear Small", addGeometry(gear(0.3, 0.12, 8)), 2);
const ballMesh = mesh("Ball", addGeometry(sphere(0.18)), 4);
const lampMesh = mesh("Lamp", addGeometry(sphere(0.09, 20, 10)), 5);
const STALK = {x: 0.15, y: 0.24, z: 0.5, segment: 0.3, bones: 4};
const stalkMesh = mesh("Stalk", addGeometry(stalk(STALK.x, STALK.y, STALK.z, 0.05, STALK.segment, STALK.bones)), 3);
const bulbShape = sphere(0.11, 32, 16);
const bulbMesh = mesh("Bulb", addGeometry(bulbShape), 4, [ridges(bulbShape, 0.05, 8)]);

const nodes = [];
function node(def) {
    nodes.push(def);
    return nodes.length - 1;
}

// the pendulum hangs from a pivot at the top of the post: rotating the pivot swings it
const rod = node({name: "Rod", mesh: rodMesh, translation: [0, -0.65, 0]});
const bob = node({name: "Bob", mesh: bobMesh, translation: [0, -1.35, 0]});
const pivot = node({name: "Pivot", children: [rod, bob], translation: [-0.9, 2.12, 0]});
const post = node({name: "Post", mesh: postMesh, translation: [-1.25, 1.22, 0]});
const beam = node({name: "Beam", mesh: beamMesh, translation: [-0.9, 2.27, 0]});
const gearBig = node({name: "Gear Big", mesh: gearBigMesh, translation: [0.55, 0.9, -0.35]});
const gearSmall = node({name: "Gear Small", mesh: gearSmallMesh, translation: [1.32, 0.68, -0.35]});
const ball = node({name: "Ball", mesh: ballMesh, translation: [1.15, 0.3, 0.45]});
const lamp = node({name: "Lamp", mesh: lampMesh, translation: [-1.25, 2.4, 0]});
const base = node({name: "Base", mesh: baseMesh, translation: [0, 0.12, 0]});

// the stalk's skeleton: a chain of bones up the tube; the bulb rides the last one (a rigid child of a joint)
const bulb = node({name: "Bulb", mesh: bulbMesh, translation: [0, STALK.segment + 0.08, 0]});
const boneNodes = [];
for (let i = STALK.bones - 1; i >= 0; i--) {
    const children = i === STALK.bones - 1 ? [bulb] : [boneNodes[0]];
    const translation = i === 0 ? [STALK.x, STALK.y, STALK.z] : [0, STALK.segment, 0];
    boneNodes.unshift(node({name: `Bone ${i + 1}`, translation, children}));
}
// inverse bind matrices: bone i sits at (x, y0 + i·segment, z) in the bind pose, unrotated
const inverseBind = new Float32Array(STALK.bones * 16);
for (let i = 0; i < STALK.bones; i++) {
    inverseBind.set(
        [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -STALK.x, -(STALK.y + i * STALK.segment), -STALK.z, 1],
        i * 16,
    );
}
const skins = [{name: "Stalk", joints: boneNodes, inverseBindMatrices: accessor(inverseBind, "MAT4", 5126)}];
const stalkNode = node({name: "Stalk", mesh: stalkMesh, skin: 0});

const toy = node({
    name: "Clockwork",
    children: [base, post, beam, pivot, gearBig, gearSmall, ball, lamp, boneNodes[0], stalkNode],
});

// ─── Animations ───────────────────────────────────────────────────────────────

const animations = [];

/** One clip: `channels` are [node, path, interpolation, times, values (flat)]. */
function clip(name, channels) {
    const samplers = [];
    const out = [];
    for (const [target, path, interpolation, times, values] of channels) {
        const t = new Float32Array(times);
        const input = accessor(t, "SCALAR", 5126, {fields: bounds(t, 1)});
        const type = path === "rotation" ? "VEC4" : path === "weights" ? "SCALAR" : "VEC3";
        const output = accessor(new Float32Array(values), type, 5126);
        samplers.push({input, output, interpolation});
        out.push({sampler: samplers.length - 1, target: {node: target, path}});
    }
    animations.push({name, samplers, channels: out});
}

/** Rotation keys about `axis`: `turns` full turns over `duration`, a key every quarter turn (slerp-safe). */
function spin(axis, turns, duration) {
    const quarters = Math.round(Math.abs(turns) * 4);
    const times = [];
    const values = [];
    for (let i = 0; i <= quarters; i++) {
        times.push(r6((i / quarters) * duration));
        values.push(...axisAngle(axis, Math.sign(turns) * (i / 4) * TAU));
    }
    return [times, values];
}

/** A bone's wave: rotation about Z (and a little X) by ±amplitude, `phase` behind the bone below it. */
function wave(amplitude, period, phase, keys = 24) {
    const times = [];
    const values = [];
    for (let i = 0; i <= keys; i++) {
        const t = (i / keys) * period;
        const a = (t / period) * TAU - phase;
        const q = mulQuat(
            axisAngle([0, 0, 1], amplitude * Math.sin(a)),
            axisAngle([1, 0, 0], amplitude * 0.4 * Math.cos(a)),
        );
        times.push(r6(t));
        values.push(...q.map(r6));
    }
    return [times, values];
}

function mulQuat(a, b) {
    return [
        a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
        a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
        a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
        a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ];
}

/** Pendulum keys: a swing of ±amplitude over `period`, sampled finely (LINEAR between). */
function swing(amplitude, period, keys = 24) {
    const times = [];
    const values = [];
    for (let i = 0; i <= keys; i++) {
        const t = (i / keys) * period;
        times.push(r6(t));
        values.push(...axisAngle([0, 0, 1], amplitude * Math.sin((t / period) * TAU)));
    }
    return [times, values];
}

const BALL_REST = 0.3;
const BALL_TOP = 1.5;
// a bounce as a cubic spline: in-tangent, value, out-tangent per key (units per second)
// t=0 on the ground going up fast, t=0.5 at the top (flat), t=1 back down fast
const bounceTimes = [0, 0.5, 1, 1.5, 2];
const v0 = 4 * (BALL_TOP - BALL_REST); // a parabola's take-off speed for its height and half-period of 0.5 s
const bounceValues = [];
for (const [i, y] of [BALL_REST, BALL_TOP, BALL_REST, BALL_TOP, BALL_REST].entries()) {
    const up = i % 2 === 0;
    const inT = up ? -v0 : 0;
    const outT = up ? v0 : 0;
    bounceValues.push(0, inT, 0, 1.15, y, 0.45, 0, outT, 0);
}

// squash on landing: scale keys around each ground contact
const squashTimes = [0, 0.08, 0.2, 0.8, 0.92, 1, 1.08, 1.2, 1.8, 1.92, 2];
const squashValues = [];
for (const t of squashTimes) {
    const phase = t % 1;
    const nearGround = phase < 0.08 || phase > 0.92;
    squashValues.push(...(nearGround ? [1.25, 0.7, 1.25] : [1, 1, 1]));
}

const lampOn = [1, 1, 1];
const lampOff = [0.001, 0.001, 0.001];

clip("Run", [
    [pivot, "rotation", "LINEAR", ...swing(0.55, 2)],
    [gearBig, "rotation", "LINEAR", ...spin([0, 0, 1], -1, 2)],
    [gearSmall, "rotation", "LINEAR", ...spin([0, 0, 1], 1.5, 2)],
    [ball, "translation", "CUBICSPLINE", bounceTimes, bounceValues],
    [ball, "scale", "LINEAR", squashTimes, squashValues],
    ...boneNodes.map((bone, i) => [bone, "rotation", "LINEAR", ...wave(0.32, 2, i * 0.7)]),
    // the bulb's ridges swell twice a cycle (a morph target weight)
    [bulb, "weights", "LINEAR", [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2], [0, 1, 0.2, 1, 0, 1, 0.2, 1, 0]],
    [
        lamp,
        "scale",
        "STEP",
        [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2],
        [...lampOn, ...lampOff, ...lampOn, ...lampOff, ...lampOn, ...lampOff, ...lampOn, ...lampOff, ...lampOn],
    ],
]);

clip("Idle", [
    [pivot, "rotation", "LINEAR", ...swing(0.12, 4)],
    [gearBig, "rotation", "LINEAR", ...spin([0, 0, 1], -0.25, 4)],
    [gearSmall, "rotation", "LINEAR", ...spin([0, 0, 1], (0.375 * 4) / 3, 4)],
    [ball, "translation", "LINEAR", [0, 4], [1.15, BALL_REST, 0.45, 1.15, BALL_REST, 0.45]],
    [ball, "scale", "LINEAR", [0, 4], [1, 1, 1, 1, 1, 1]],
    [lamp, "scale", "STEP", [0, 4], [...lampOff, ...lampOff]],
    ...boneNodes.map((bone, i) => [bone, "rotation", "LINEAR", ...wave(0.08, 4, i * 0.5)]),
    [bulb, "weights", "LINEAR", [0, 4], [0, 0]],
]);

// ─── GLB ──────────────────────────────────────────────────────────────────────

const json = {
    asset: {version: "2.0", generator: "glaze scripts/make-clockwork.mjs"},
    extensionsUsed: ["KHR_materials_emissive_strength"],
    scene: 0,
    scenes: [{name: "Clockwork", nodes: [toy]}],
    nodes,
    meshes,
    materials,
    animations,
    skins,
    accessors,
    bufferViews,
    buffers: [{byteLength}],
};

const pad4 = (buf, fill) => (buf.length % 4 ? Buffer.concat([buf, Buffer.alloc(4 - (buf.length % 4), fill)]) : buf);
const binChunk = pad4(Buffer.concat(chunks), 0);
json.buffers[0].byteLength = binChunk.length;
const jsonChunk = pad4(Buffer.from(JSON.stringify(json)), 0x20);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);
const chunkHeader = (length, type) => {
    const b = Buffer.alloc(8);
    b.writeUInt32LE(length, 0);
    b.writeUInt32LE(type, 4);
    return b;
};
const glb = Buffer.concat([
    header,
    chunkHeader(jsonChunk.length, 0x4e4f534a),
    jsonChunk,
    chunkHeader(binChunk.length, 0x004e4942),
    binChunk,
]);

mkdirSync(OUT_DIR, {recursive: true});
writeFileSync(new URL("clockwork.glb", OUT_DIR), glb);
console.log(
    `clockwork.glb: ${(glb.length / 1024).toFixed(0)} KiB, ${nodes.length} nodes, ${meshes.length} meshes, ` +
        `${animations.length} animations (${animations.map((a) => `${a.name}: ${a.channels.length} channels`).join(", ")})`,
);
