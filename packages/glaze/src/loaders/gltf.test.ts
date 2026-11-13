import assert from "node:assert/strict";
import {describe, test} from "node:test";

import {quat, vec3} from "gl-matrix";

import {AnimationMixer} from "../animation/mixer";
import {linearToSrgb} from "../color";
import {PointLight, SpotLight} from "../scene/light";
import {Mesh} from "../scene/mesh";
import {SkinnedMesh} from "../scene/skin";
import {readAccessor} from "./glb";
import {parseGltf} from "./gltf";

const near = (a: ArrayLike<number>, b: ArrayLike<number>, eps = 1e-5) =>
    a.length === b.length && Array.from(a).every((v, i) => Math.abs(v - b[i]!) < eps);

/** One triangle (positions, normals, u16-normalized UVs, indices) packed into a base64 data URI buffer. */
function triangleGltf(extra: (json: Record<string, unknown>) => void = () => {}) {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
    const uvs = new Uint16Array([0, 0, 65535, 0, 0, 32768]);
    const indices = new Uint16Array([0, 1, 2]);
    const parts = [positions, normals, uvs, indices].map((a) => new Uint8Array(a.buffer));
    const total = parts.reduce((n, p) => n + p.length, 0);
    const bytes = new Uint8Array(total + ((4 - (total % 4)) % 4));
    let offset = 0;
    const views = parts.map((p) => {
        bytes.set(p, offset);
        const view = {buffer: 0, byteOffset: offset, byteLength: p.length};
        offset += p.length;
        return view;
    });
    const json: Record<string, unknown> = {
        asset: {version: "2.0"},
        buffers: [
            {
                byteLength: bytes.length,
                uri: `data:application/octet-stream;base64,${Buffer.from(bytes).toString("base64")}`,
            },
        ],
        bufferViews: views,
        accessors: [
            {bufferView: 0, componentType: 5126, count: 3, type: "VEC3"},
            {bufferView: 1, componentType: 5126, count: 3, type: "VEC3"},
            {bufferView: 2, componentType: 5123, count: 3, type: "VEC2", normalized: true},
            {bufferView: 3, componentType: 5123, count: 3, type: "SCALAR"},
        ],
        materials: [
            {
                name: "Icing",
                pbrMetallicRoughness: {baseColorFactor: [1, 0.5, 0.5, 0.8]},
                alphaMode: "BLEND",
                doubleSided: true,
            },
        ],
        meshes: [
            {name: "Tri", primitives: [{attributes: {POSITION: 0, NORMAL: 1, TEXCOORD_0: 2}, indices: 3, material: 0}]},
            {
                name: "Pair",
                primitives: [
                    {attributes: {POSITION: 0, NORMAL: 1}, indices: 3},
                    {attributes: {POSITION: 0, NORMAL: 1}, indices: 3, material: 0},
                ],
            },
        ],
        nodes: [
            {name: "Donut", children: [1, 2, 3], translation: [0, 1, 0]},
            {name: "Sprinkle A", mesh: 0, translation: [1, 0, 0], rotation: [0, 0.7071068, 0, 0.7071068]},
            {name: "Sprinkle B", mesh: 0, scale: [2, 2, 2]},
            {name: "Parts", mesh: 1, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1]},
            {name: "Unused", mesh: 0},
        ],
        scenes: [{name: "Kitchen", nodes: [0]}],
        scene: 0,
    };
    extra(json);
    return new TextEncoder().encode(JSON.stringify(json)).buffer as ArrayBuffer;
}

const noDevice = {} as GPUDevice; // no textures in these files: the GPU is never touched

describe("parseGltf", () => {
    test("builds the node tree with names, transforms and the default scene", async () => {
        const model = await parseGltf(noDevice, triangleGltf());
        assert.equal(model.root.name, "Kitchen");
        assert.deepEqual(
            model.root.children.map((e) => e.name),
            ["Donut"],
        );
        const donut = model.root.find("Donut")!;
        assert.deepEqual(
            donut.children.map((e) => e.name),
            ["Sprinkle A", "Sprinkle B", "Parts"],
        );
        assert.ok(near(donut.position, [0, 1, 0]));
        const a = model.root.find("Sprinkle A")!;
        assert.ok(a instanceof Mesh, "a one-primitive node is the Mesh itself");
        assert.ok(near(a.quaternion, quat.fromValues(0, 0.7071068, 0, 0.7071068)));
        assert.ok(near(a.getWorldPosition(), [1, 1, 0]));
        assert.ok(near(model.root.find("Sprinkle B")!.scale, [2, 2, 2]));
        assert.ok(near(model.root.find("Parts")!.position, vec3.fromValues(5, 6, 7)));
        assert.equal(model.nodes.length, 5);
        assert.equal(model.nodes[4]!.parent, null, "nodes outside the scene are built, not attached");
    });

    test("shares geometry between nodes using one mesh, and materials between primitives", async () => {
        const model = await parseGltf(noDevice, triangleGltf());
        const a = model.root.find("Sprinkle A") as Mesh;
        const b = model.root.find("Sprinkle B") as Mesh;
        assert.equal(a.geometry, b.geometry);
        assert.equal(a.material, b.material);
        assert.equal(model.materials.length, 1);
        const parts = model.root.find("Parts")!;
        assert.ok(!(parts instanceof Mesh), "two primitives: a group of Mesh children");
        assert.deepEqual(
            parts.children.map((e) => e.name),
            ["Pair#0", "Pair#1"],
        );
        assert.equal((parts.children[1] as Mesh).material, model.materials[0]);
        assert.equal(model.meshes.length, 5);
    });

    test("materials carry alpha mode, opacity and double-sidedness", async () => {
        const [mat] = (await parseGltf(noDevice, triangleGltf())).materials;
        assert.equal(mat!.alphaMode, "blend");
        assert.ok(Math.abs(mat!.opacity - 0.8) < 1e-6);
        assert.equal(mat!.doubleSided, true);
    });

    test("normalized integer UVs become 0..1 floats", async () => {
        const model = await parseGltf(noDevice, triangleGltf());
        const uvs = (model.root.find("Sprinkle A") as Mesh).geometry.uvs;
        assert.ok(near(uvs, [0, 0, 1, 0, 0, 32768 / 65535]));
    });

    test("external buffers are fetched through resolveUri", async () => {
        const inline = JSON.parse(new TextDecoder().decode(triangleGltf())) as {buffers: {uri: string}[]};
        const data = inline.buffers[0]!.uri;
        const bytes = triangleGltf((json) => {
            (json.buffers as {uri: string}[])[0]!.uri = "donut.bin";
        });
        const requested: string[] = [];
        const realFetch = globalThis.fetch;
        globalThis.fetch = (async (url: string) => {
            requested.push(url);
            return new Response(Buffer.from(data.split(",")[1]!, "base64"));
        }) as typeof fetch;
        try {
            const model = await parseGltf(noDevice, bytes, {resolveUri: (uri) => `https://cdn.test/models/${uri}`});
            assert.deepEqual(requested, ["https://cdn.test/models/donut.bin"]);
            assert.equal(model.meshes.length, 5);
        } finally {
            globalThis.fetch = realFetch;
        }
    });

    test("reads animations: tracks on the node entities, normalized rotations, interpolation", async () => {
        const model = await parseGltf(
            noDevice,
            triangleGltf((json) => {
                // a second buffer: times (f32), translations (f32), rotations (i16 normalized)
                const times = new Float32Array([0, 2]);
                const moves = new Float32Array([0, 0, 0, 4, 0, 0]);
                const turn = new Int16Array([0, 0, 0, 32767, 0, 32767, 0, 0]); // identity → 180° about Y
                const bytes = new Uint8Array(8 + 24 + 16);
                bytes.set(new Uint8Array(times.buffer), 0);
                bytes.set(new Uint8Array(moves.buffer), 8);
                bytes.set(new Uint8Array(turn.buffer), 32);
                (json.buffers as unknown[]).push({
                    byteLength: bytes.length,
                    uri: `data:application/octet-stream;base64,${Buffer.from(bytes).toString("base64")}`,
                });
                const views = json.bufferViews as unknown[];
                const accessors = json.accessors as unknown[];
                views.push({buffer: 1, byteOffset: 0, byteLength: 8}, {buffer: 1, byteOffset: 8, byteLength: 24});
                views.push({buffer: 1, byteOffset: 32, byteLength: 16});
                accessors.push(
                    {bufferView: views.length - 3, componentType: 5126, count: 2, type: "SCALAR"},
                    {bufferView: views.length - 2, componentType: 5126, count: 2, type: "VEC3"},
                    {bufferView: views.length - 1, componentType: 5122, count: 2, type: "VEC4", normalized: true},
                );
                const a = accessors.length;
                json.animations = [
                    {
                        name: "Spin",
                        samplers: [
                            {input: a - 3, output: a - 2},
                            {input: a - 3, output: a - 1, interpolation: "STEP"},
                            {input: a - 3, output: a - 3},
                        ],
                        channels: [
                            {sampler: 0, target: {node: 2, path: "translation"}},
                            {sampler: 1, target: {node: 2, path: "rotation"}},
                            {sampler: 2, target: {node: 2, path: "weights"}},
                        ],
                    },
                ];
            }),
        );
        assert.equal(model.animations.length, 1);
        const clip = model.animations[0]!;
        assert.equal(clip.name, "Spin");
        assert.equal(clip.duration, 2);
        assert.equal(clip.tracks.length, 3);
        assert.equal(clip.tracks[2]!.path, "weights");
        const sprinkle = model.root.find("Sprinkle B")!;
        assert.equal(clip.tracks[0]!.target, sprinkle);

        const mixer = new AnimationMixer();
        mixer.clipAction(clip).play();
        mixer.update(1);
        assert.ok(near(sprinkle.position, [2, 0, 0]));
        assert.ok(near(sprinkle.quaternion, [0, 0, 0, 1])); // STEP: still the first key
        mixer.update(0.999);
        assert.ok(near(sprinkle.position, [3.998, 0, 0], 1e-3));
    });

    test("reads skins: skinned nodes become SkinnedMeshes on the file's joints, weights normalized", async () => {
        const model = await parseGltf(
            noDevice,
            triangleGltf((json) => {
                const joints = new Uint8Array([1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0]);
                const weights = new Uint8Array([255, 0, 0, 0, 200, 50, 0, 0, 100, 100, 0, 0]); // last: sums to 0.78
                const bytes = new Uint8Array(24);
                bytes.set(joints, 0);
                bytes.set(weights, 12);
                (json.buffers as unknown[]).push({
                    byteLength: bytes.length,
                    uri: `data:application/octet-stream;base64,${Buffer.from(bytes).toString("base64")}`,
                });
                const views = json.bufferViews as unknown[];
                const accessors = json.accessors as unknown[];
                views.push({buffer: 1, byteOffset: 0, byteLength: 12}, {buffer: 1, byteOffset: 12, byteLength: 12});
                accessors.push(
                    {bufferView: views.length - 2, componentType: 5121, count: 3, type: "VEC4"},
                    {bufferView: views.length - 1, componentType: 5121, count: 3, type: "VEC4", normalized: true},
                );
                const mesh = (json.meshes as {primitives: {attributes: Record<string, number>}[]}[])[0]!;
                mesh.primitives[0]!.attributes.JOINTS_0 = accessors.length - 2;
                mesh.primitives[0]!.attributes.WEIGHTS_0 = accessors.length - 1;
                json.skins = [{joints: [0, 1]}];
                (json.nodes as Record<string, unknown>[])[2]!.skin = 0;
            }),
        );
        const skinnedNode = model.root.find("Sprinkle B")!;
        assert.ok(skinnedNode instanceof SkinnedMesh);
        assert.equal(skinnedNode.skin, model.skins[0]);
        assert.deepEqual(
            model.skins[0]!.joints.map((j) => j.name),
            ["Donut", "Sprinkle A"],
        );
        // the same mesh on a node without a skin stays a plain Mesh
        assert.ok(!(model.root.find("Sprinkle A") instanceof SkinnedMesh));
        const w = skinnedNode.geometry.weights!;
        assert.ok(near(w.subarray(8, 12), [0.5, 0.5, 0, 0]));
        assert.deepEqual(Array.from(skinnedNode.geometry.joints!.subarray(0, 4)), [1, 0, 0, 0]);
        assert.ok(
            near(model.skins[0]!.inverseBindMatrices.subarray(0, 16), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
        );
    });

    test("reads morph targets (sparse deltas), default weights, and weights animations", async () => {
        const model = await parseGltf(
            noDevice,
            triangleGltf((json) => {
                // sparse: one element (vertex 2) moves by (0, 0, 1); times and a weights track 0 → 1
                const bytes = new Uint8Array(4 + 12 + 8 + 8);
                new Uint32Array(bytes.buffer, 0, 1)[0] = 2;
                new Float32Array(bytes.buffer, 4, 3).set([0, 0, 1]);
                new Float32Array(bytes.buffer, 16, 2).set([0, 1]);
                new Float32Array(bytes.buffer, 24, 2).set([0, 1]);
                (json.buffers as unknown[]).push({
                    byteLength: bytes.length,
                    uri: `data:application/octet-stream;base64,${Buffer.from(bytes).toString("base64")}`,
                });
                const views = json.bufferViews as unknown[];
                const accessors = json.accessors as unknown[];
                const v = views.length;
                views.push(
                    {buffer: 1, byteOffset: 0, byteLength: 4},
                    {buffer: 1, byteOffset: 4, byteLength: 12},
                    {buffer: 1, byteOffset: 16, byteLength: 8},
                    {buffer: 1, byteOffset: 24, byteLength: 8},
                );
                const a = accessors.length;
                accessors.push(
                    {
                        componentType: 5126,
                        count: 3,
                        type: "VEC3",
                        sparse: {count: 1, indices: {bufferView: v, componentType: 5125}, values: {bufferView: v + 1}},
                    },
                    {bufferView: v + 2, componentType: 5126, count: 2, type: "SCALAR"},
                    {bufferView: v + 3, componentType: 5126, count: 2, type: "SCALAR"},
                );
                const mesh = (json.meshes as {primitives: Record<string, unknown>[]; weights?: number[]}[])[0]!;
                mesh.primitives[0]!.targets = [{POSITION: a}];
                mesh.weights = [0.25];
                (json.nodes as Record<string, unknown>[])[2]!.weights = [0.5];
                json.animations = [
                    {
                        samplers: [{input: a + 1, output: a + 2}],
                        channels: [{sampler: 0, target: {node: 2, path: "weights"}}],
                    },
                ];
            }),
        );
        const a = model.root.find("Sprinkle A") as Mesh;
        const b = model.root.find("Sprinkle B") as Mesh;
        assert.deepEqual(Array.from(a.geometry.morphTargets![0]!.positions), [0, 0, 0, 0, 0, 0, 0, 0, 1]);
        assert.equal(a.morphWeights[0], 0.25); // the mesh's default
        assert.equal(b.morphWeights[0], 0.5); // the node's own
        const mixer = new AnimationMixer();
        mixer.clipAction(model.animations[0]!).play();
        mixer.update(0.75);
        assert.ok(Math.abs(b.morphWeights[0]! - 0.75) < 1e-6);
        assert.equal(a.morphWeights[0], 0.25); // other nodes untouched
    });

    test("refuses files that require an extension it can't read", async () => {
        await assert.rejects(
            parseGltf(
                noDevice,
                triangleGltf((json) => {
                    json.extensionsUsed = json.extensionsRequired = ["KHR_draco_mesh_compression"];
                }),
            ),
            /KHR_draco_mesh_compression/,
        );
        // supported ones load
        await parseGltf(
            noDevice,
            triangleGltf((json) => {
                json.extensionsRequired = ["KHR_mesh_quantization"];
            }),
        );
    });

    test("a mirroring node matrix keeps its mirror (negative scale) and rotation", async () => {
        const c = Math.cos(0.5);
        const sn = Math.sin(0.5);
        // a 0.5 rad turn about Y, then X scaled by -1 (column-major)
        const matrix = [-c, 0, sn, 0, 0, 1, 0, 0, sn, 0, c, 0, 1, 2, 3, 1];
        const model = await parseGltf(
            noDevice,
            triangleGltf((json) => {
                (json.nodes as Record<string, unknown>[])[3]!.matrix = matrix;
            }),
        );
        const parts = model.root.find("Parts")!;
        parts.updateLocalMatrix();
        assert.ok(parts.scale[0] < 0);
        assert.ok(near(parts.localMatrix, matrix));
    });
});

describe("readAccessor", () => {
    test("normalizes a sparse accessor of integers that has no buffer view", () => {
        const bytes = new Uint8Array(8);
        new Uint32Array(bytes.buffer, 0, 1)[0] = 1;
        new Int8Array(bytes.buffer, 4, 3).set([0, -127, 127]);
        const json = {
            bufferViews: [
                {buffer: 0, byteOffset: 0, byteLength: 4},
                {buffer: 0, byteOffset: 4, byteLength: 3},
            ],
            accessors: [
                {
                    componentType: 5120,
                    normalized: true,
                    count: 2,
                    type: "VEC3",
                    sparse: {count: 1, indices: {bufferView: 0, componentType: 5125}, values: {bufferView: 1}},
                },
            ],
        };
        const values = readAccessor(json as never, [bytes.buffer], 0);
        assert.deepEqual(Array.from(values), [0, 0, 0, 0, -1, 1]);
    });
});

describe("parseGltf primitives", () => {
    test("a strip becomes a counter-clockwise list; no NORMAL gives flat normals", async () => {
        const model = await parseGltf(
            noDevice,
            triangleGltf((json) => {
                // the triangle as a strip of 3 (one triangle), without normals
                const prim = (json.meshes as {primitives: Record<string, unknown>[]}[])[0]!.primitives[0]!;
                prim.mode = 5;
                delete (prim.attributes as Record<string, number>).NORMAL;
            }),
        );
        const mesh = model.root.find("Sprinkle A") as Mesh;
        assert.equal(mesh.geometry.indices.length, 3);
        for (let i = 0; i < 3; i++) {
            assert.ok(near(mesh.geometry.normals.subarray(i * 3, i * 3 + 3), [0, 0, 1]));
        }
    });

    test("reads COLOR_0 (normalized RGB, alpha 1) and TEXCOORD_1", async () => {
        const model = await parseGltf(
            noDevice,
            triangleGltf((json) => {
                const bytes = new Uint8Array(12 + 24);
                bytes.set([255, 0, 0, 0, 0, 255, 0, 0, 0, 0, 255, 0], 0); // 3 × RGB u8, padded to 4
                new Float32Array(bytes.buffer, 12, 6).set([0, 0, 1, 0, 0, 1]);
                (json.buffers as unknown[]).push({
                    byteLength: bytes.length,
                    uri: `data:application/octet-stream;base64,${Buffer.from(bytes).toString("base64")}`,
                });
                const views = json.bufferViews as unknown[];
                const accessors = json.accessors as unknown[];
                const v = views.length;
                views.push(
                    {buffer: 1, byteOffset: 0, byteLength: 12, byteStride: 4},
                    {buffer: 1, byteOffset: 12, byteLength: 24},
                );
                const a = accessors.length;
                accessors.push(
                    {bufferView: v, componentType: 5121, normalized: true, count: 3, type: "VEC3"},
                    {bufferView: v + 1, componentType: 5126, count: 3, type: "VEC2"},
                );
                const prim = (json.meshes as {primitives: {attributes: Record<string, number>}[]}[])[0]!.primitives[0]!;
                prim.attributes.COLOR_0 = a;
                prim.attributes.TEXCOORD_1 = a + 1;
            }),
        );
        const g = (model.root.find("Sprinkle A") as Mesh).geometry;
        assert.ok(near(g.colors!, [1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1]));
        assert.ok(near(g.uvs1!, [0, 0, 1, 0, 0, 1]));
        assert.ok(g.hasExtras);
    });

    test("reads KHR_lights_punctual lights as children of their nodes", async () => {
        const model = await parseGltf(
            noDevice,
            triangleGltf((json) => {
                json.extensions = {
                    KHR_lights_punctual: {
                        lights: [
                            {type: "point", name: "Bulb", color: [1, 0.5, 0], intensity: 20, range: 6},
                            {type: "spot", intensity: 50, spot: {innerConeAngle: 0.2, outerConeAngle: 0.5}},
                        ],
                    },
                };
                const nodes = json.nodes as Record<string, unknown>[];
                nodes[1]!.extensions = {KHR_lights_punctual: {light: 0}};
                nodes[2]!.extensions = {KHR_lights_punctual: {light: 1}};
            }),
        );
        assert.equal(model.lights.length, 2);
        const [bulb, spot] = model.lights as [PointLight, SpotLight];
        assert.ok(bulb instanceof PointLight && spot instanceof SpotLight);
        assert.equal(bulb.name, "Bulb");
        assert.equal(bulb.parent, model.root.find("Sprinkle A"));
        assert.equal(bulb.intensity, 20);
        assert.equal(bulb.range, 6);
        assert.ok(near(bulb.color, [1, linearToSrgb(0.5), 0]));
        assert.equal(spot.range, Infinity);
        assert.ok(Math.abs(spot.outerAngle - 0.5) < 1e-9 && Math.abs(spot.innerAngle - 0.2) < 1e-9);
        assert.ok(near(spot.quaternion, [0, 0, 0, 1])); // shines along its node's -Z
    });
});
