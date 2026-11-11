import assert from "node:assert/strict";
import {describe, test} from "node:test";

import {
    bounce,
    clamp,
    easeIn,
    easeInOut,
    easeOut,
    lerp,
    oscillate,
    pingpong,
    smootherstep,
    smoothstep,
} from "./animation";

const EPS = 1e-9;

function near(a: number, b: number, eps = EPS): boolean {
    return Math.abs(a - b) < eps;
}

// ── lerp ─────────────────────────────────────────────────────────────────────

describe("lerp", () => {
    test("returns a at t=0", () => assert.equal(lerp(3, 7, 0), 3));
    test("returns b at t=1", () => assert.equal(lerp(3, 7, 1), 7));
    test("returns midpoint at t=0.5", () => assert.equal(lerp(0, 10, 0.5), 5));
    test("is unclamped — extrapolates beyond [0,1]", () => assert.equal(lerp(0, 10, 2), 20));
});

// ── clamp ─────────────────────────────────────────────────────────────────────

describe("clamp", () => {
    test("returns min when below", () => assert.equal(clamp(-5, 0, 1), 0));
    test("returns max when above", () => assert.equal(clamp(5, 0, 1), 1));
    test("passes through when in range", () => assert.equal(clamp(0.5, 0, 1), 0.5));
    test("passes through min boundary", () => assert.equal(clamp(0, 0, 1), 0));
    test("passes through max boundary", () => assert.equal(clamp(1, 0, 1), 1));
});

// ── smoothstep ────────────────────────────────────────────────────────────────

describe("smoothstep", () => {
    test("returns 0 at t=0", () => assert.equal(smoothstep(0), 0));
    test("returns 1 at t=1", () => assert.equal(smoothstep(1), 1));
    test("returns 0.5 at t=0.5", () => assert.equal(smoothstep(0.5), 0.5));
    test("clamps below 0", () => assert.equal(smoothstep(-1), 0));
    test("clamps above 1", () => assert.equal(smoothstep(2), 1));
    test("is monotonically increasing", () => {
        for (let i = 0; i < 99; i++) {
            const a = smoothstep(i / 100);
            const b = smoothstep((i + 1) / 100);
            assert.ok(b >= a, `not monotonic at ${i}/100`);
        }
    });
    test("has zero derivative at endpoints (S-curve)", () => {
        const d0 = (smoothstep(1e-5) - smoothstep(0)) / 1e-5;
        const d1 = (smoothstep(1) - smoothstep(1 - 1e-5)) / 1e-5;
        assert.ok(near(d0, 0, 1e-3), `derivative near 0 should be ~0, got ${d0}`);
        assert.ok(near(d1, 0, 1e-3), `derivative near 1 should be ~0, got ${d1}`);
    });
});

// ── smootherstep ──────────────────────────────────────────────────────────────

describe("smootherstep", () => {
    test("returns 0 at t=0", () => assert.equal(smootherstep(0), 0));
    test("returns 1 at t=1", () => assert.equal(smootherstep(1), 1));
    test("returns 0.5 at t=0.5", () => assert.equal(smootherstep(0.5), 0.5));
    test("clamps below 0", () => assert.equal(smootherstep(-1), 0));
    test("clamps above 1", () => assert.equal(smootherstep(2), 1));
    test("is monotonically increasing", () => {
        for (let i = 0; i < 99; i++) {
            const a = smootherstep(i / 100);
            const b = smootherstep((i + 1) / 100);
            assert.ok(b >= a, `not monotonic at ${i}/100`);
        }
    });
});

// ── easeIn ────────────────────────────────────────────────────────────────────

describe("easeIn", () => {
    test("returns 0 at t=0", () => assert.equal(easeIn(0), 0));
    test("returns 1 at t=1", () => assert.equal(easeIn(1), 1));
    test("quadratic default: 0.25 at t=0.5", () => assert.ok(near(easeIn(0.5), 0.25)));
    test("cubic: 0.125 at t=0.5", () => assert.ok(near(easeIn(0.5, 3), 0.125)));
    test("clamps below 0", () => assert.equal(easeIn(-1), 0));
    test("clamps above 1", () => assert.equal(easeIn(2), 1));
    test("starts slow (below diagonal)", () => assert.ok(easeIn(0.5) < 0.5));
});

// ── easeOut ───────────────────────────────────────────────────────────────────

describe("easeOut", () => {
    test("returns 0 at t=0", () => assert.equal(easeOut(0), 0));
    test("returns 1 at t=1", () => assert.equal(easeOut(1), 1));
    test("quadratic default: 0.75 at t=0.5", () => assert.ok(near(easeOut(0.5), 0.75)));
    test("clamps below 0", () => assert.equal(easeOut(-1), 0));
    test("clamps above 1", () => assert.equal(easeOut(2), 1));
    test("ends slow (above diagonal)", () => assert.ok(easeOut(0.5) > 0.5));
    test("easeIn and easeOut are complementary", () => {
        for (const t of [0.1, 0.3, 0.7, 0.9]) {
            assert.ok(near(easeOut(t), 1 - easeIn(1 - t)), `complementary failed at ${t}`);
        }
    });
});

// ── easeInOut ─────────────────────────────────────────────────────────────────

describe("easeInOut", () => {
    test("returns 0 at t=0", () => assert.equal(easeInOut(0), 0));
    test("returns 1 at t=1", () => assert.equal(easeInOut(1), 1));
    test("returns 0.5 at t=0.5 (symmetric)", () => assert.ok(near(easeInOut(0.5), 0.5)));
    test("clamps below 0", () => assert.equal(easeInOut(-1), 0));
    test("clamps above 1", () => assert.equal(easeInOut(2), 1));
    test("is symmetric around (0.5, 0.5)", () => {
        for (const t of [0.1, 0.2, 0.3, 0.4]) {
            assert.ok(near(easeInOut(t), 1 - easeInOut(1 - t), 1e-9), `symmetry failed at ${t}`);
        }
    });
    test("is monotonically increasing", () => {
        for (let i = 0; i < 99; i++) {
            const a = easeInOut(i / 100);
            const b = easeInOut((i + 1) / 100);
            assert.ok(b >= a, `not monotonic at ${i}/100`);
        }
    });
});

// ── pingpong ──────────────────────────────────────────────────────────────────

describe("pingpong", () => {
    test("returns 0 at t=0", () => assert.ok(near(pingpong(0), 0)));
    test("returns 0.5 at t=0.5", () => assert.ok(near(pingpong(0.5), 0.5)));
    test("returns 1 at t=1", () => assert.ok(near(pingpong(1), 1)));
    test("returns 0.5 at t=1.5", () => assert.ok(near(pingpong(1.5), 0.5)));
    test("returns 0 at t=2", () => assert.ok(near(pingpong(2), 0)));
    test("returns 1 at t=3", () => assert.ok(near(pingpong(3), 1)));
    test("handles negative t (wraps correctly)", () => {
        assert.ok(near(pingpong(-1), 1));
        assert.ok(near(pingpong(-2), 0));
    });
    test("output is always in [0, 1]", () => {
        for (let t = -4; t <= 4; t += 0.13) {
            const v = pingpong(t);
            assert.ok(v >= 0 && v <= 1, `out of range at t=${t}: ${v}`);
        }
    });
});

// ── oscillate ─────────────────────────────────────────────────────────────────

describe("oscillate", () => {
    test("returns sin(t) with default freq=1", () => {
        assert.ok(near(oscillate(0), 0));
        assert.ok(near(oscillate(Math.PI / 2), 1));
        assert.ok(near(oscillate(Math.PI), 0, 1e-15));
    });
    test("freq scales the input", () => {
        assert.ok(near(oscillate(1, 2), Math.sin(2)));
    });
    test("output is in [-1, 1]", () => {
        for (let t = 0; t < 20; t += 0.37) {
            const v = oscillate(t);
            assert.ok(v >= -1 && v <= 1, `out of range at t=${t}: ${v}`);
        }
    });
});

// ── bounce ────────────────────────────────────────────────────────────────────

describe("bounce", () => {
    test("returns 0 at t=0", () => assert.ok(near(bounce(0), 0)));
    test("returns 1 at t=PI/2", () => assert.ok(near(bounce(Math.PI / 2), 1)));
    test("output is always >= 0", () => {
        for (let t = 0; t < 20; t += 0.37) {
            assert.ok(bounce(t) >= 0, `negative value at t=${t}`);
        }
    });
    test("freq scales like oscillate", () => {
        assert.ok(near(bounce(1, 2), Math.abs(Math.sin(2))));
    });
});
