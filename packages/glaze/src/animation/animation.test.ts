import assert from "node:assert/strict";
import {describe, test} from "node:test";

import {quat} from "gl-matrix";

import {Entity} from "../scene/entity";
import {AnimationClip, type AnimationTrack, findKey, sampleTrack} from "./clip";
import {AnimationMixer} from "./mixer";

const close = (actual: ArrayLike<number>, expected: number[], eps = 1e-5) =>
    expected.forEach((e, i) => assert.ok(Math.abs(actual[i]! - e) < eps, `[${i}] ${actual[i]} ≈ ${e}`));

function track(
    target: Entity,
    path: AnimationTrack["path"],
    times: number[],
    values: number[],
    interpolation: AnimationTrack["interpolation"] = "LINEAR",
): AnimationTrack {
    return {target, path, times: Float32Array.from(times), values: Float32Array.from(values), interpolation};
}

describe("findKey", () => {
    const times = Float32Array.from([0, 1, 2, 4]);
    test("finds the interval, clamped at both ends, with or without a hint", () => {
        assert.equal(findKey(times, -1), 0);
        assert.equal(findKey(times, 0.5), 0);
        assert.equal(findKey(times, 1), 1);
        assert.equal(findKey(times, 3.9), 2);
        assert.equal(findKey(times, 9), 3);
        assert.equal(findKey(times, 1.5, 1), 1); // hint right
        assert.equal(findKey(times, 2.5, 1), 2); // one ahead
        assert.equal(findKey(times, 0.2, 2), 0); // wrong hint: binary search
    });
});

describe("sampleTrack", () => {
    const e = new Entity();
    test("linear, step and the ends", () => {
        const t = track(e, "translation", [0, 2], [0, 0, 0, 2, 4, 6]);
        const out = [0, 0, 0];
        sampleTrack(t, 1, out);
        close(out, [1, 2, 3]);
        sampleTrack(t, 5, out);
        close(out, [2, 4, 6]);
        sampleTrack({...t, interpolation: "STEP"}, 1.9, out);
        close(out, [0, 0, 0]);
    });

    test("rotations slerp along the shortest arc and stay unit length", () => {
        const a = quat.create();
        const b = quat.setAxisAngle(quat.create(), [0, 1, 0], Math.PI / 2);
        const t = track(e, "rotation", [0, 1], [...a, ...b]);
        const out = [0, 0, 0, 0];
        sampleTrack(t, 0.5, out);
        close(out, [...quat.setAxisAngle(quat.create(), [0, 1, 0], Math.PI / 4)]);
        // the same end rotation written as -q: still the short way
        sampleTrack(track(e, "rotation", [0, 1], [...a, ...Array.from(b, (v) => -v)]), 0.5, out);
        const angle = 2 * Math.acos(Math.min(1, Math.abs(out[3]!)));
        assert.ok(Math.abs(angle - Math.PI / 4) < 1e-5);
    });

    test("cubic spline: hits the keys, uses tangents scaled by the interval", () => {
        // one component per key: [in, value, out] ×3 for vec3; flat tangents → smoothstep between 0 and 1
        const keys = [0, 0, 0, /*v*/ 0, 0, 0, 0, 0, 0, /**/ 0, 0, 0, /*v*/ 1, 1, 1, 0, 0, 0];
        const t = track(e, "translation", [0, 2], keys, "CUBICSPLINE");
        const out = [0, 0, 0];
        sampleTrack(t, 0, out);
        close(out, [0, 0, 0]);
        sampleTrack(t, 1, out);
        close(out, [0.5, 0.5, 0.5]);
        sampleTrack(t, 0.5, out);
        close(out, [0.15625, 0.15625, 0.15625]); // 3s² - 2s³ at s = 0.25
        // a slope of 1 per second at both keys over 2 s: a straight line
        const line = [1, 1, 1, 0, 0, 0, 1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1];
        sampleTrack(track(e, "translation", [0, 2], line, "CUBICSPLINE"), 0.5, out);
        close(out, [0.5, 0.5, 0.5]);
    });
});

describe("AnimationMixer", () => {
    function setup() {
        const e = new Entity();
        e.position[1] = 5; // rest pose
        const clip = new AnimationClip("move", [track(e, "translation", [0, 2], [0, 0, 0, 2, 0, 0])]);
        const mixer = new AnimationMixer();
        return {e, clip, mixer};
    }

    test("repeat wraps, once holds the last frame, pingpong comes back", () => {
        const {e, clip, mixer} = setup();
        const action = mixer.clipAction(clip).play();
        mixer.update(1);
        close(e.position, [1, 0, 0]);
        mixer.update(1.5); // 2.5 → 0.5
        close(e.position, [0.5, 0, 0]);
        action.time = 0;
        action.loop = "once";
        mixer.update(3);
        close(e.position, [2, 0, 0]);
        assert.ok(action.finished);
        action.loop = "pingpong";
        action.time = 0;
        mixer.update(3); // 3 → back at 1
        close(e.position, [1, 0, 0]);
    });

    test("paused holds; stopped no longer counts; half weight blends with the rest pose", () => {
        const {e, clip, mixer} = setup();
        const action = mixer.clipAction(clip).play();
        mixer.update(1);
        action.pause();
        mixer.update(1);
        close(e.position, [1, 0, 0]);
        action.weight = 0.5;
        mixer.update(0);
        close(e.position, [0.5, 2.5, 0]); // halfway between (1, 0, 0) and the rest (0, 5, 0)
    });

    test("crossfade: weights move from one action to the other, the first stops at the end", () => {
        const e = new Entity();
        const left = new AnimationClip("left", [track(e, "translation", [0, 1], [-1, 0, 0, -1, 0, 0])]);
        const right = new AnimationClip("right", [track(e, "translation", [0, 1], [1, 0, 0, 1, 0, 0])]);
        const mixer = new AnimationMixer();
        const a = mixer.clipAction(left).play();
        mixer.update(0.1);
        close(e.position, [-1, 0, 0]);
        const b = a.crossFadeTo(mixer.clipAction(right), 1);
        mixer.update(0.5);
        close(e.position, [0, 0, 0]);
        mixer.update(0.5);
        close(e.position, [1, 0, 0]);
        assert.equal(a.enabled, false);
        assert.equal(b.weight, 1);
    });

    test("rotations blend on the same hemisphere", () => {
        const e = new Entity();
        const q = quat.setAxisAngle(quat.create(), [0, 0, 1], 0.4);
        const neg = Array.from(q, (v) => -v);
        const a = new AnimationClip("a", [track(e, "rotation", [0], [...q])]);
        const b = new AnimationClip("b", [track(e, "rotation", [0], neg)]);
        const mixer = new AnimationMixer();
        mixer.clipAction(a).play().weight = 0.5;
        mixer.clipAction(b).play().weight = 0.5;
        mixer.update(0);
        const same = Math.abs(quat.dot(e.quaternion, q));
        assert.ok(same > 0.99999, `${same}`);
    });
});

describe("AnimationMixer robustness", () => {
    test("a crossfade turned back halfway resumes from the current weights", () => {
        const e = new Entity();
        const left = new AnimationClip("left", [track(e, "translation", [0, 1], [-1, 0, 0, -1, 0, 0])]);
        const right = new AnimationClip("right", [track(e, "translation", [0, 1], [1, 0, 0, 1, 0, 0])]);
        const mixer = new AnimationMixer();
        const a = mixer.clipAction(left).play();
        const b = mixer.clipAction(right);
        a.crossFadeTo(b, 1);
        mixer.update(0.25); // a 0.75, b 0.25
        b.crossFadeTo(a, 1);
        mixer.update(0);
        close(e.position, [-0.5, 0, 0]); // no jump: still 0.75 / 0.25
        mixer.update(0.125);
        close(e.position, [-0.75, 0, 0]); // a 0.875
        mixer.update(0.125);
        close(e.position, [-1, 0, 0]);
        assert.equal(b.enabled, false);
    });

    test("a NaN delta is ignored; pingpong time stays wrapped", () => {
        const e = new Entity();
        const clip = new AnimationClip("move", [track(e, "translation", [0, 2], [0, 0, 0, 2, 0, 0])]);
        const mixer = new AnimationMixer();
        const action = mixer.clipAction(clip).play();
        action.loop = "pingpong";
        mixer.update(1);
        mixer.update(Number.NaN);
        close(e.position, [1, 0, 0]);
        mixer.update(4000.5); // 4001.5 → 1.5 into a 4 s period
        assert.ok(action.time < 4);
        close(e.position, [1.5, 0, 0]);
    });
});
