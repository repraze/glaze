import assert from "node:assert/strict";
import {describe, test} from "node:test";

import {quat, vec3} from "gl-matrix";

import {AnimationMixer} from "../animation/mixer";
import {Mesh} from "../scene/mesh";
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

    test("reads animations: tracks on the node entities, normalized rotations, interpolation; weights skipped", async () => {
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
        assert.equal(clip.tracks.length, 2); // weights skipped
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
});
