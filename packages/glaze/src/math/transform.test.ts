import assert from "node:assert/strict";
import {describe, test} from "node:test";

import {mat4, quat, vec3} from "gl-matrix";

import {decompose, isMirrored} from "./transform";

describe("decompose", () => {
    test("a mirroring matrix comes back with a negative X scale and rebuilds exactly", () => {
        const q = quat.setAxisAngle(quat.create(), vec3.normalize(vec3.create(), [0.3, 1, 0.2]), 0.5);
        const m = mat4.fromRotationTranslationScale(mat4.create(), q, [1, 2, 3], [-2, 1, 0.5]);
        assert.ok(isMirrored(m));
        const p = vec3.create();
        const r = quat.create();
        const s = vec3.create();
        decompose(m, p, r, s);
        assert.ok(s[0] < 0);
        const back = mat4.fromRotationTranslationScale(mat4.create(), r, p, s);
        for (let i = 0; i < 16; i++) {
            assert.ok(Math.abs(back[i]! - m[i]!) < 1e-5, `[${i}] ${back[i]} vs ${m[i]}`);
        }
    });

    test("a plain matrix is untouched", () => {
        const q = quat.setAxisAngle(quat.create(), [0, 1, 0], 1);
        const m = mat4.fromRotationTranslationScale(mat4.create(), q, [0, 0, 0], [1, 2, 3]);
        assert.ok(!isMirrored(m));
        const r = quat.create();
        const s = vec3.create();
        decompose(m, null, r, s);
        assert.ok(Math.abs(Math.abs(quat.dot(r, q)) - 1) < 1e-6);
        assert.deepEqual(
            Array.from(s).map((v) => Math.round(v * 1e5) / 1e5),
            [1, 2, 3],
        );
    });
});
