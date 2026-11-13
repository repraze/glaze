import assert from "node:assert/strict";
import {describe, test} from "node:test";

import {mat4, vec3, vec4} from "gl-matrix";

import {Geometry} from "../geometry/geometry";
import {PBRMaterial} from "../material/material";
import {Entity} from "./entity";
import {Skin, SkinnedMesh} from "./skin";

/** A two-joint chain along +Y (root at the origin, tip at y = 1) and a single-vertex "geometry" at y = 2. */
function setup() {
    const root = new Entity();
    const tip = new Entity();
    tip.position[1] = 1;
    root.add(tip);
    root.updateWorldMatrix(null);
    // bind pose: inverse of each joint's world matrix as it is now
    const ibm = new Float32Array(32);
    ibm.set(mat4.invert(mat4.create(), root.worldMatrix)!, 0);
    ibm.set(mat4.invert(mat4.create(), tip.worldMatrix)!, 16);
    const geometry = new Geometry({
        positions: new Float32Array([0, 2, 0]),
        normals: new Float32Array([0, 0, 1]),
        uvs: new Float32Array([0, 0]),
        indices: new Uint32Array([0, 0, 0]),
        joints: new Uint16Array([1, 0, 0, 0]),
        weights: new Float32Array([1, 0, 0, 0]),
    });
    const mesh = new SkinnedMesh(geometry, new PBRMaterial(), new Skin([root, tip], ibm));
    return {root, tip, mesh};
}

const skinned = (mesh: SkinnedMesh, joint: number, p: [number, number, number]) => {
    const m = mesh.jointMatrices.subarray(joint * 16, joint * 16 + 16);
    const world = vec4.transformMat4(vec4.create(), [...p, 1], m);
    return vec3.fromValues(world[0], world[1], world[2]);
};

describe("SkinnedMesh", () => {
    test("bind pose: joint matrices are identity", () => {
        const {mesh} = setup();
        mesh.updateWorldMatrix(null);
        const m = mesh.updateJointMatrices();
        assert.ok(mat4.equals(m.subarray(16, 32), mat4.create()));
    });

    test("a vertex follows its joint: bending the tip 90° about Z swings it", () => {
        const {root, tip, mesh} = setup();
        tip.setEuler(0, 0, Math.PI / 2);
        root.updateWorldMatrix(null);
        mesh.updateWorldMatrix(null);
        mesh.updateJointMatrices();
        const p = skinned(mesh, 1, [0, 2, 0]);
        assert.ok(vec3.distance(p, [-1, 1, 0]) < 1e-5, `${p}`);
    });

    test("the mesh's own placement doesn't add to the joints' (glTF: the skin defines the pose)", () => {
        const {root, mesh} = setup();
        mesh.position[0] = 5; // ignored: joints place the vertices
        root.updateWorldMatrix(null);
        mesh.updateWorldMatrix(null);
        mesh.updateJointMatrices();
        const p = skinned(mesh, 1, [0, 2, 0]);
        assert.ok(vec3.distance(p, [0, 2, 0]) < 1e-5, `${p}`);
    });

    test("picking: no collider by default; geometry needs both joints and weights", () => {
        assert.equal(setup().mesh.collider, null);
        assert.throws(
            () =>
                new Geometry({
                    positions: new Float32Array(3),
                    normals: new Float32Array(3),
                    uvs: new Float32Array(2),
                    indices: new Uint32Array(3),
                    joints: new Uint16Array(4),
                }),
        );
    });

    test("skin buffer: 4 uint16 joints then 4 float weights, 24 bytes a vertex", () => {
        const {mesh} = setup();
        const buf = mesh.geometry.buildSkinBuffer()!;
        assert.equal(buf.byteLength, 24);
        assert.deepEqual(Array.from(new Uint16Array(buf, 0, 4)), [1, 0, 0, 0]);
        assert.deepEqual(Array.from(new Float32Array(buf, 8, 4)), [1, 0, 0, 0]);
    });
});
