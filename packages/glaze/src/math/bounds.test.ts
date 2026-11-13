import assert from "node:assert/strict";
import {describe, test} from "node:test";

import {mat4, quat, vec3} from "gl-matrix";

import {createCube, createSphere} from "../geometry/shapes";
import {box3, sphere} from "./bounds";

const near = (a: ArrayLike<number>, b: ArrayLike<number>, eps = 1e-5) =>
    a.length === b.length && Array.from(a).every((v, i) => Math.abs(v - b[i]!) < eps);

describe("box3", () => {
    test("create is empty; fromPositions bounds every point", () => {
        assert.ok(box3.isEmpty(box3.create()));
        const b = box3.fromPositions(box3.create(), [1, 2, 3, -1, 5, 0, 0, -2, 7]);
        assert.ok(near(b.min, [-1, -2, 0]));
        assert.ok(near(b.max, [1, 5, 7]));
    });

    test("fromPositions honours a stride", () => {
        const b = box3.fromPositions(box3.create(), [1, 1, 1, 99, -1, -1, -1, 99], 4);
        assert.ok(near(b.min, [-1, -1, -1]));
        assert.ok(near(b.max, [1, 1, 1]));
    });

    test("center, size, contains, union, intersects", () => {
        const a = box3.fromValues([0, 0, 0], [2, 4, 6]);
        assert.ok(near(box3.getCenter(vec3.create(), a), [1, 2, 3]));
        assert.ok(near(box3.getSize(vec3.create(), a), [2, 4, 6]));
        assert.ok(box3.containsPoint(a, [1, 1, 1]));
        assert.ok(!box3.containsPoint(a, [3, 1, 1]));
        const b = box3.fromValues([1, 1, 1], [5, 5, 5]);
        assert.ok(box3.intersectsBox(a, b));
        assert.ok(!box3.intersectsBox(a, box3.fromValues([3, 0, 0], [4, 1, 1])));
        const u = box3.union(box3.create(), a, b);
        assert.ok(near(u.min, [0, 0, 0]) && near(u.max, [5, 5, 6]));
    });

    test("transformMat4 matches the box around the 8 transformed corners", () => {
        const b = box3.fromValues([-1, -2, -0.5], [3, 1, 2]);
        const m = mat4.fromRotationTranslationScale(
            mat4.create(),
            quat.fromEuler(quat.create(), 30, -50, 70),
            [4, -1, 2],
            [2, 0.5, -1.5],
        );
        const expected = box3.create();
        for (const x of [b.min[0], b.max[0]]) {
            for (const y of [b.min[1], b.max[1]]) {
                for (const z of [b.min[2], b.max[2]]) {
                    const p = vec3.transformMat4(vec3.create(), [x, y, z], m);
                    box3.expandByPoint(expected, expected, p);
                }
            }
        }
        const got = box3.transformMat4(box3.create(), b, m);
        assert.ok(near(got.min, expected.min) && near(got.max, expected.max));
        // in place
        const same = box3.clone(b);
        box3.transformMat4(same, same, m);
        assert.ok(near(same.min, expected.min) && near(same.max, expected.max));
    });

    test("an empty box stays empty under transforms", () => {
        assert.ok(box3.isEmpty(box3.transformMat4(box3.create(), box3.create(), mat4.create())));
    });
});

describe("sphere", () => {
    test("fromPositions contains every point", () => {
        const pts = [1, 0, 0, -1, 0, 0, 0, 3, 0, 0, 0, -2];
        const s = sphere.fromPositions(sphere.create(), pts);
        for (let i = 0; i < pts.length; i += 3) {
            assert.ok(vec3.distance(s.center, pts.slice(i, i + 3) as unknown as vec3) <= s.radius + 1e-6);
        }
    });

    test("transformMat4 scales the radius by the largest axis scale", () => {
        const s = sphere.fromValues([1, 0, 0], 2);
        const m = mat4.fromRotationTranslationScale(mat4.create(), quat.create(), [0, 5, 0], [1, 3, -2]);
        const t = sphere.transformMat4(sphere.create(), s, m);
        assert.ok(near(t.center, [1, 5, 0]));
        assert.ok(Math.abs(t.radius - 6) < 1e-6);
    });

    test("empty in, empty out", () => {
        assert.ok(sphere.isEmpty(sphere.fromPositions(sphere.create(), [])));
    });
});

describe("Geometry bounds", () => {
    test("a cube's box is its size; the cache refreshes after markChanged", () => {
        const g = createCube({size: 2});
        assert.ok(near(g.boundingBox.min, [-1, -1, -1]) && near(g.boundingBox.max, [1, 1, 1]));
        assert.equal(g.boundingBox, g.boundingBox);
        g.positions[0] = 10;
        g.markChanged();
        assert.equal(g.boundingBox.max[0], 10);
    });

    test("a sphere's bounding sphere has its radius", () => {
        const g = createSphere({radius: 0.75});
        assert.ok(Math.abs(g.boundingSphere.radius - 0.75) < 1e-5);
    });
});

describe("sphere.inFrustum", () => {
    const proj = mat4.perspectiveZO(mat4.create(), Math.PI / 2, 1, 0.1, 10);
    const view = mat4.lookAt(mat4.create(), [0, 0, 0], [0, 0, -1], [0, 1, 0]);
    const vp = mat4.multiply(mat4.create(), proj, view);
    test("inside, touching and outside each plane", () => {
        assert.ok(sphere.inFrustum([0, 0, -5], 0.1, vp));
        assert.ok(!sphere.inFrustum([0, 0, 5], 1, vp)); // behind
        assert.ok(!sphere.inFrustum([0, 0, -12], 1, vp)); // past far
        assert.ok(sphere.inFrustum([0, 0, -10.5], 1, vp)); // straddles far
        assert.ok(!sphere.inFrustum([8, 0, -5], 1, vp)); // right of the 45° side
        assert.ok(sphere.inFrustum([5.5, 0, -5], 1, vp)); // straddles it
        assert.ok(!sphere.inFrustum([0, -8, -5], 1, vp));
        assert.ok(!sphere.inFrustum([-8, 0, -5], 1, vp));
        assert.ok(!sphere.inFrustum([0, 8, -5], 1, vp));
    });
});
