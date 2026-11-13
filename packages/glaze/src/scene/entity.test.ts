import assert from "node:assert/strict";
import {describe, test} from "node:test";

import {quat, vec3} from "gl-matrix";

import {Entity} from "./entity";

const near = (a: ArrayLike<number>, b: ArrayLike<number>, eps = 1e-5) =>
    a.length === b.length && Array.from(a).every((v, i) => Math.abs(v - b[i]!) < eps);

describe("Entity rotation", () => {
    test("setEuler matches the previous Euler path (quat.fromEuler in degrees)", () => {
        const e = new Entity().setEuler(0.3, 1.2, -0.4);
        const expected = quat.fromEuler(
            quat.create(),
            0.3 * (180 / Math.PI),
            1.2 * (180 / Math.PI),
            -0.4 * (180 / Math.PI),
        );
        assert.ok(near(e.quaternion, expected));
    });

    test("rotateY accumulates", () => {
        const e = new Entity().rotateY(0.25).rotateY(0.25);
        assert.ok(near(e.quaternion, new Entity().setEuler(0, 0.5, 0).quaternion));
    });
});

describe("Entity.lookAt", () => {
    test("points -Z at the target", () => {
        const e = new Entity();
        vec3.set(e.position, 1, 2, 3);
        e.lookAt([4, -1, 7]);
        const expected = vec3.normalize(vec3.create(), [3, -3, 4]);
        assert.ok(near(e.getWorldDirection(), expected));
    });

    test("keeps +Y up when looking level", () => {
        const e = new Entity().lookAt([5, 0, 0]);
        const up = vec3.transformQuat(vec3.create(), [0, 1, 0], e.quaternion);
        assert.ok(near(up, [0, 1, 0]));
    });

    test("compensates for a rotated, translated, scaled parent", () => {
        const parent = new Entity().setEuler(0.4, 1.1, -0.2);
        vec3.set(parent.position, -2, 1, 0.5);
        vec3.set(parent.scale, 2, 2, 2);
        const child = new Entity();
        vec3.set(child.position, 0.5, 0, -1);
        parent.add(child);

        const target = vec3.fromValues(3, 4, -5);
        child.lookAt(target);
        const eye = child.getWorldPosition();
        const expected = vec3.normalize(vec3.create(), vec3.subtract(vec3.create(), target, eye));
        assert.ok(near(child.getWorldDirection(), expected));
    });

    test("target at the entity's position leaves the rotation unchanged", () => {
        const e = new Entity().setEuler(0.1, 0.2, 0.3);
        const before = quat.clone(e.quaternion);
        e.lookAt([0, 0, 0]);
        assert.ok(near(e.quaternion, before));
    });
});

describe("Entity world queries", () => {
    test("are fresh without a scene traversal", () => {
        const parent = new Entity().setEuler(0, Math.PI / 2, 0);
        vec3.set(parent.position, 10, 0, 0);
        const child = new Entity();
        vec3.set(child.position, 0, 0, -1);
        parent.add(child);
        // Rotating +90° about Y maps local -Z to world -X.
        assert.ok(near(child.getWorldPosition(), [9, 0, 0]));
        assert.ok(near(child.getWorldDirection(), [-1, 0, 0]));
    });

    test("getWorldScale composes", () => {
        const parent = new Entity();
        vec3.set(parent.scale, 2, 3, 4);
        const child = new Entity();
        vec3.set(child.scale, 0.5, 0.5, 0.5);
        parent.add(child);
        assert.ok(near(child.getWorldScale(), [1, 1.5, 2]));
    });

    test("add reparents", () => {
        const a = new Entity();
        const b = new Entity();
        const c = new Entity();
        a.add(c);
        b.add(c);
        assert.equal(a.children.length, 0);
        assert.equal(c.parent, b);
    });
});

describe("Entity.lookAlong", () => {
    test("points -Z along the direction, whatever its length", () => {
        const e = new Entity().lookAlong([0, 0, 10]);
        assert.ok(near(e.getWorldDirection(), [0, 0, 1]));
    });

    for (const dir of [
        [0, -1, 0],
        [0, 1, 0],
        [0, -5, 1e-7],
    ] as const) {
        test(`stays a valid rotation when parallel to up: [${dir.join(", ")}]`, () => {
            const e = new Entity().lookAlong(dir);
            assert.ok(Array.from(e.quaternion).every(Number.isFinite));
            assert.ok(Math.abs(quat.length(e.quaternion) - 1) < 1e-5);
            assert.ok(near(e.getWorldDirection(), vec3.normalize(vec3.create(), dir)));
        });
    }

    test("a camera straight above its target still looks at it", () => {
        const e = new Entity();
        vec3.set(e.position, 0, 10, 0);
        e.lookAt([0, 0, 0]);
        assert.ok(near(e.getWorldDirection(), [0, -1, 0]));
    });

    test("a zero direction leaves the rotation unchanged", () => {
        const e = new Entity().setEuler(0.1, 0.2, 0.3);
        const before = quat.clone(e.quaternion);
        e.lookAlong([0, 0, 0]);
        assert.ok(near(e.quaternion, before));
    });
});
