import assert from "node:assert/strict";
import {describe, test} from "node:test";

import {mat4, quat, vec3} from "gl-matrix";

import {box3, sphere} from "./bounds";
import {ray} from "./ray";

const near = (a: ArrayLike<number>, b: ArrayLike<number>, eps = 1e-5) =>
    a.length === b.length && Array.from(a).every((v, i) => Math.abs(v - b[i]!) < eps);
const close = (a: number | null, b: number, eps = 1e-5) => a !== null && Math.abs(a - b) < eps;

describe("ray.intersectBox", () => {
    const b = box3.fromValues([-1, -1, -1], [1, 1, 1]);

    test("hits the near face", () => {
        assert.ok(close(ray.intersectBox(ray.fromValues([0, 0, 5], [0, 0, -1]), b), 4));
    });
    test("misses beside and behind", () => {
        assert.equal(ray.intersectBox(ray.fromValues([2, 0, 5], [0, 0, -1]), b), null);
        assert.equal(ray.intersectBox(ray.fromValues([0, 0, 5], [0, 0, 1]), b), null);
    });
    test("0 from inside", () => {
        assert.equal(ray.intersectBox(ray.fromValues([0, 0, 0], [1, 0, 0]), b), 0);
    });
    test("axis-parallel ray outside a slab misses", () => {
        assert.equal(ray.intersectBox(ray.fromValues([0, 3, 5], [0, 0, -1]), b), null);
    });
});

describe("ray.intersectSphere", () => {
    const s = sphere.fromValues([0, 0, 0], 1);
    test("hits the surface", () => {
        assert.ok(close(ray.intersectSphere(ray.fromValues([0, 0, 5], [0, 0, -1]), s), 4));
    });
    test("scales t by an unnormalised direction", () => {
        assert.ok(close(ray.intersectSphere(ray.fromValues([0, 0, 5], [0, 0, -2]), s), 2));
    });
    test("misses and 0 inside", () => {
        assert.equal(ray.intersectSphere(ray.fromValues([0, 2, 5], [0, 0, -1]), s), null);
        assert.equal(ray.intersectSphere(ray.fromValues([0, 0, 5], [0, 0, 1]), s), null);
        assert.equal(ray.intersectSphere(ray.fromValues([0, 0, 0.5], [0, 0, 1]), s), 0);
    });
});

describe("ray.intersectTriangle", () => {
    const a = vec3.fromValues(-1, -1, 0);
    const b = vec3.fromValues(1, -1, 0);
    const c = vec3.fromValues(0, 1, 0); // counter-clockwise seen from +Z
    test("hits with barycentrics", () => {
        const bary = vec3.create();
        const t = ray.intersectTriangle(ray.fromValues([0, 0, 3], [0, 0, -1]), a, b, c, false, bary);
        assert.ok(close(t, 3));
        const p = vec3.create();
        vec3.scaleAndAdd(p, p, a, bary[0]);
        vec3.scaleAndAdd(p, p, b, bary[1]);
        vec3.scaleAndAdd(p, p, c, bary[2]);
        assert.ok(near(p, [0, 0, 0]));
    });
    test("back-face culling", () => {
        const back = ray.fromValues([0, 0, -3], [0, 0, 1]);
        assert.ok(close(ray.intersectTriangle(back, a, b, c), 3));
        assert.equal(ray.intersectTriangle(back, a, b, c, true), null);
    });
    test("misses outside the edges", () => {
        assert.equal(ray.intersectTriangle(ray.fromValues([1, 1, 3], [0, 0, -1]), a, b, c), null);
    });
});

describe("ray.transformMat4", () => {
    test("t found in local space equals t in world space", () => {
        const world = mat4.fromRotationTranslationScale(
            mat4.create(),
            quat.fromEuler(quat.create(), 20, 40, -10),
            [3, 1, -2],
            [2, 2, 2],
        );
        const localSphere = sphere.fromValues([0, 0, 0], 1);
        const worldSphere = sphere.transformMat4(sphere.create(), localSphere, world);
        const r = ray.fromValues(
            [10, 4, 7],
            vec3.normalize(vec3.create(), vec3.subtract(vec3.create(), worldSphere.center, [10, 4, 7])),
        );
        const tWorld = ray.intersectSphere(r, worldSphere)!;
        const local = ray.transformMat4(ray.create(), r, mat4.invert(mat4.create(), world)!);
        assert.ok(close(ray.intersectSphere(local, localSphere), tWorld, 1e-4));
    });
});

describe("ray.fromNdc", () => {
    test("perspective: the centre ray runs down the camera's -Z from the near plane", () => {
        const proj = mat4.perspectiveZO(mat4.create(), Math.PI / 3, 1.5, 0.1, 100);
        const view = mat4.lookAt(mat4.create(), [0, 0, 5], [0, 0, 0], [0, 1, 0]);
        const inv = mat4.invert(mat4.create(), mat4.multiply(mat4.create(), proj, view))!;
        const r = ray.fromNdc(ray.create(), inv, 0, 0);
        assert.ok(near(r.origin, [0, 0, 4.9], 1e-4));
        assert.ok(near(r.direction, [0, 0, -1]));
    });

    test("perspective: a corner ray passes through the frustum corner", () => {
        const fov = Math.PI / 2;
        const proj = mat4.perspectiveZO(mat4.create(), fov, 1, 1, 100);
        const inv = mat4.invert(mat4.create(), proj)!;
        const r = ray.fromNdc(ray.create(), inv, 1, 1);
        assert.ok(near(r.origin, [1, 1, -1], 1e-4));
        assert.ok(near(r.direction, vec3.normalize(vec3.create(), [1, 1, -1])));
    });

    test("orthographic: rays are parallel and offset", () => {
        const proj = mat4.orthoZO(mat4.create(), -2, 2, -1, 1, 0.1, 50);
        const inv = mat4.invert(mat4.create(), proj)!;
        const r = ray.fromNdc(ray.create(), inv, 0.5, -1);
        assert.ok(near(r.origin, [1, -1, -0.1], 1e-4));
        assert.ok(near(r.direction, [0, 0, -1]));
    });
});

describe("ray.intersectPlane", () => {
    test("hits a ground plane from above and below, misses parallel or away", () => {
        const ground = vec3.fromValues(0, 0, 0);
        const up = vec3.fromValues(0, 1, 0);
        assert.ok(close(ray.intersectPlane(ray.fromValues([1, 4, 2], [0, -2, 0]), ground, up), 2));
        assert.ok(close(ray.intersectPlane(ray.fromValues([0, -3, 0], [0, 1, 0]), ground, up), 3));
        assert.equal(ray.intersectPlane(ray.fromValues([0, 1, 0], [1, 0, 0]), ground, up), null);
        assert.equal(ray.intersectPlane(ray.fromValues([0, 1, 0], [0, 1, 0]), ground, up), null);
    });
});

describe("ray edge cases", () => {
    test("an empty box is never hit", () => {
        const r = {origin: vec3.fromValues(0, 0, 0), direction: vec3.normalize(vec3.create(), [1, 1, 1])};
        assert.equal(ray.intersectBox(r, box3.create()), null);
    });

    test("a picking ray through an infinite (or huge) far plane stays finite", () => {
        for (const far of [Infinity, 1e7]) {
            const proj = mat4.perspectiveZO(mat4.create(), Math.PI / 3, 1.5, 0.05, far);
            const inv = mat4.invert(mat4.create(), proj)!;
            const r = ray.fromNdc(ray.create(), inv, 0.3, -0.2);
            assert.ok(Array.from(r.direction).every(Number.isFinite), `${far}: ${r.direction}`);
            assert.ok(Math.abs(vec3.length(r.direction) - 1) < 1e-5);
            // the same direction as a well-conditioned projection gives
            const ref = ray.fromNdc(
                ray.create(),
                mat4.invert(mat4.create(), mat4.perspectiveZO(mat4.create(), Math.PI / 3, 1.5, 0.05, 100))!,
                0.3,
                -0.2,
            );
            assert.ok(vec3.dot(r.direction, ref.direction) > 0.99999);
        }
    });
});
