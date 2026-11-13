import assert from "node:assert/strict";
import {describe, test} from "node:test";

import {mat4, vec3, vec4} from "gl-matrix";

import {OrthographicCamera, PerspectiveCamera} from "./camera";
import {type Cascade, cascadeSplits, fitCascades} from "./shadow-cascades";

function cameraFit(position: [number, number, number], target: [number, number, number]) {
    const camera = new PerspectiveCamera({fov: Math.PI / 4, near: 0.1, far: 100});
    vec3.set(camera.position, ...position);
    camera.lookAt(target);
    camera.updateWorldMatrix(null);
    const vp = camera.getViewProjectionMatrix(16 / 9);
    return {camera, inv: mat4.invert(mat4.create(), vp)!};
}

const lightDirection = vec3.normalize(vec3.create(), [-0.4, -1, -0.3]);

describe("cascadeSplits", () => {
    test("end at far, increase, and are logarithmic at balance 1", () => {
        const s = cascadeSplits(0.1, 40, 4, 1);
        assert.equal(s.length, 4);
        assert.ok(Math.abs(s[3]! - 40) < 1e-9);
        assert.ok(s[0]! < s[1]! && s[1]! < s[2]!);
        assert.ok(Math.abs(s[1]! / s[0]! - s[2]! / s[1]!) < 1e-9); // constant ratio
        assert.deepEqual(cascadeSplits(10, 50, 4, 0), [20, 30, 40, 50]);
    });
});

describe("fitCascades", () => {
    const fit = (inv: mat4, cascades = 4) => {
        const out: Cascade[] = [];
        const count = fitCascades(out, {
            invViewProjection: inv,
            near: 0.1,
            far: 100,
            lightDirection,
            cascades,
            maxDistance: 30,
            splitBalance: 0.8,
            mapSize: 1024,
            casterStart: -50,
        });
        return {out, count};
    };

    test("every point of each slice lands inside its shadow map", () => {
        const {camera, inv} = cameraFit([3, 4, 8], [0, 0, 0]);
        const {out, count} = fit(inv);
        assert.equal(count, 4);
        assert.equal(out[3]!.far, 30);
        const m = camera.worldMatrix;
        const forward = vec3.normalize(vec3.create(), [-m[8]!, -m[9]!, -m[10]!]);
        const eye = vec3.fromValues(3, 4, 8);
        let near = 0.1;
        for (const cascade of out.slice(0, count)) {
            // sample points along the corner rays at both ends of the slice
            for (const depth of [near, cascade.far]) {
                for (const [x, y] of [
                    [-1, -1],
                    [1, -1],
                    [-1, 1],
                    [1, 1],
                    [0, 0],
                ] as const) {
                    const n = vec4.transformMat4(vec4.create(), [x, y, 0, 1], inv);
                    const p0 = vec3.scale(vec3.create(), n as unknown as vec3, 1 / n[3]);
                    const ray = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), p0, eye));
                    const p = vec3.scaleAndAdd(vec3.create(), eye, ray, depth / vec3.dot(ray, forward));
                    const clip = vec4.transformMat4(vec4.create(), [p[0], p[1], p[2], 1], cascade.matrix);
                    for (const k of [0, 1]) {
                        assert.ok(Math.abs(clip[k]!) <= 1.0001, `cascade ends ${cascade.far}: ${clip[k]}`);
                    }
                    assert.ok(clip[2]! >= 0 && clip[2]! <= 1, `depth ${clip[2]}`);
                }
            }
            near = cascade.far;
        }
    });

    test("near cascades are finer", () => {
        const {inv} = cameraFit([3, 4, 8], [0, 0, 0]);
        const {out} = fit(inv);
        assert.ok(out[0]!.texel < out[1]!.texel && out[1]!.texel < out[3]!.texel);
    });

    test("stable: turning the camera keeps each cascade's size; moving it keeps the texel grid", () => {
        const a = fit(cameraFit([3, 4, 8], [0, 0, 0]).inv).out;
        const b = fit(cameraFit([3, 4, 8], [2, 1, -1]).inv).out;
        for (let i = 0; i < 4; i++) {
            assert.equal(a[i]!.radius, b[i]!.radius);
        }
        const c = fit(cameraFit([3.37, 4, 8.11], [0.37, 0, 0.11]).inv).out;
        for (let i = 0; i < 4; i++) {
            for (const k of [0, 1]) {
                const cells = c[i]!.center[k]! / c[i]!.texel;
                assert.ok(Math.abs(cells - Math.round(cells)) < 1e-6);
            }
        }
    });

    test("casters up the light stay inside the depth range", () => {
        const {inv} = cameraFit([3, 4, 8], [0, 0, 0]);
        const {out} = fit(inv, 1);
        // a point far up the light from the view (t = -50 along the light)
        const p = vec3.scale(vec3.create(), lightDirection, -49);
        const clip = vec4.transformMat4(vec4.create(), [p[0], p[1], p[2], 1], out[0]!.matrix);
        assert.ok(clip[2]! >= 0, `depth ${clip[2]}`);
    });
});

describe("fitCascades edge cases", () => {
    const finite = (cascades: Cascade[], count: number) => {
        assert.ok(count > 0);
        for (const c of cascades.slice(0, count)) {
            assert.ok(Number.isFinite(c.radius) && c.radius > 0, `radius ${c.radius}`);
            assert.ok(Array.from(c.matrix).every(Number.isFinite));
        }
    };
    const fitWith = (inv: mat4, near: number, far: number) => {
        const out: Cascade[] = [];
        const count = fitCascades(out, {
            invViewProjection: inv,
            near,
            far,
            lightDirection,
            cascades: 3,
            maxDistance: 30,
            splitBalance: 0.8,
            mapSize: 1024,
            casterStart: -50,
        });
        return {out, count};
    };

    test("an infinite far plane", () => {
        const camera = new PerspectiveCamera({fov: Math.PI / 4, near: 0.1, far: Infinity});
        vec3.set(camera.position, 3, 4, 8);
        camera.lookAt([0, 0, 0]);
        camera.updateWorldMatrix(null);
        const inv = mat4.invert(mat4.create(), camera.getViewProjectionMatrix(16 / 9))!;
        const {out, count} = fitWith(inv, 0.1, Infinity);
        finite(out, count);
        assert.equal(out[count - 1]!.far, 30);
    });

    test("an orthographic camera starting behind 0", () => {
        assert.ok(cascadeSplits(-10, 30, 4, 1).every(Number.isFinite));
        const camera = new OrthographicCamera({left: -5, right: 5, top: 5, bottom: -5, near: -10, far: 50});
        vec3.set(camera.position, 3, 4, 8);
        camera.lookAt([0, 0, 0]);
        camera.updateWorldMatrix(null);
        const inv = mat4.invert(mat4.create(), camera.getViewProjectionMatrix(1))!;
        const {out, count} = fitWith(inv, -10, 50);
        finite(out, count);
    });
});
