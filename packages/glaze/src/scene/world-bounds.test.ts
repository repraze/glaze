import assert from "node:assert/strict";
import {describe, test} from "node:test";

import {vec3} from "gl-matrix";

import {createCube} from "../geometry/shapes";
import {PBRMaterial} from "../material/material";
import {box3} from "../math/bounds";
import {Entity} from "./entity";
import {Mesh} from "./mesh";
import {computeWorldBounds} from "./world-bounds";

describe("computeWorldBounds", () => {
    test("unions transformed meshes of a subtree, skipping disabled ones", () => {
        const root = new Entity();
        vec3.set(root.scale, 2, 2, 2);
        const a = new Mesh(createCube({size: 1}), new PBRMaterial());
        vec3.set(a.position, 3, 0, 0);
        const off = new Mesh(createCube({size: 1}), new PBRMaterial());
        vec3.set(off.position, -50, 0, 0);
        off.enabled = false;
        root.add(a)
            .add(new Mesh(createCube({size: 1}), new PBRMaterial()))
            .add(off);
        const b = computeWorldBounds(root);
        assert.deepEqual(Array.from(b.min), [-1, -1, -1]);
        assert.deepEqual(Array.from(b.max), [7, 1, 1]);
        assert.ok(box3.isEmpty(computeWorldBounds(new Entity())));
    });
});
