import assert from "node:assert/strict";
import {describe, test} from "node:test";

import {vec3} from "gl-matrix";

import {color, color4, linearToSrgb, setColor, srgbToLinear} from "./color.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const EPS = 1e-5;

function near(a: number, b: number, eps = EPS): boolean {
    return Math.abs(a - b) < eps;
}

function assertColor3(
    actual: readonly [number, number, number],
    expected: readonly [number, number, number],
    label = "",
): void {
    assert.ok(near(actual[0], expected[0]), `${label} r: ${actual[0]} ≠ ${expected[0]}`);
    assert.ok(near(actual[1], expected[1]), `${label} g: ${actual[1]} ≠ ${expected[1]}`);
    assert.ok(near(actual[2], expected[2]), `${label} b: ${actual[2]} ≠ ${expected[2]}`);
}

function assertColor4(
    actual: readonly [number, number, number, number],
    expected: readonly [number, number, number, number],
    label = "",
): void {
    assert.ok(near(actual[0], expected[0]), `${label} r: ${actual[0]} ≠ ${expected[0]}`);
    assert.ok(near(actual[1], expected[1]), `${label} g: ${actual[1]} ≠ ${expected[1]}`);
    assert.ok(near(actual[2], expected[2]), `${label} b: ${actual[2]} ≠ ${expected[2]}`);
    assert.ok(near(actual[3], expected[3]), `${label} a: ${actual[3]} ≠ ${expected[3]}`);
}

// ─── color() ─────────────────────────────────────────────────────────────────

describe("color", () => {
    describe("hex parsing", () => {
        test("black and white are exact", () => {
            assertColor3(color("#000000"), [0, 0, 0], "#000000");
            assertColor3(color("#ffffff"), [1, 1, 1], "#ffffff");
        });

        test("pure red/green/blue are exact", () => {
            assertColor3(color("#ff0000"), [1, 0, 0], "#ff0000");
            assertColor3(color("#00ff00"), [0, 1, 0], "#00ff00");
            assertColor3(color("#0000ff"), [0, 0, 1], "#0000ff");
        });

        test("#rrggbb divides each byte by 255 (raw sRGB, no gamma)", () => {
            // 0x80 = 128; 128/255 ≈ 0.50196 — NOT the gamma-expanded 0.21586
            const mid = color("#808080");
            const expected = 128 / 255;
            assert.ok(near(mid[0], expected, EPS), `r: ${mid[0]} ≠ ${expected}`);
            assert.ok(near(mid[1], expected, EPS), `g: ${mid[1]} ≠ ${expected}`);
            assert.ok(near(mid[2], expected, EPS), `b: ${mid[2]} ≠ ${expected}`);
        });

        test("known byte values round-trip exactly", () => {
            // 0x40 = 64; 64/255 ≈ 0.25098
            const c = color("#404040");
            const expected = 64 / 255;
            assert.ok(near(c[0], expected, EPS));
        });

        test("#rgb shorthand expands correctly", () => {
            assertColor3(color("#fff"), [1, 1, 1], "#fff");
            assertColor3(color("#000"), [0, 0, 0], "#000");
            // #f80 expands to #ff8800
            const expanded = color("#ff8800");
            assertColor3(color("#f80"), expanded, "#f80");
        });

        test("#rgba shorthand ignores alpha for color()", () => {
            // #f00f = r:ff g:00 b:00 a:ff
            assertColor3(color("#f00f"), color("#ff0000"), "#f00f rgb");
            // #f008 = r:ff g:00 b:00 a:88
            assertColor3(color("#f008"), color("#ff0000"), "#f008 rgb");
        });

        test("#rrggbbaa ignores alpha for color()", () => {
            assertColor3(color("#ff000080"), color("#ff0000"), "#ff000080 rgb");
        });

        test("case insensitive", () => {
            assertColor3(color("#FF0000"), [1, 0, 0], "#FF0000");
            assertColor3(color("#FFFFFF"), [1, 1, 1], "#FFFFFF");
            assertColor3(color("#aAbBcC"), color("#aabbcc"), "mixed case");
        });
    });

    describe("tuple passthrough", () => {
        test("returns exact values unchanged", () => {
            assertColor3(color([0.5, 0.25, 0.75]), [0.5, 0.25, 0.75]);
            assertColor3(color([0, 0, 0]), [0, 0, 0]);
            assertColor3(color([1, 1, 1]), [1, 1, 1]);
        });

        test("no transformation applied to tuple input", () => {
            assert.equal(color([0.5, 0.5, 0.5])[0], 0.5);
        });
    });

    describe("error cases", () => {
        test("throws for non-hex string", () => {
            assert.throws(() => color("red"), /Unsupported/);
            assert.throws(() => color("rgb(255,0,0)"), /Unsupported/);
        });

        test("throws for invalid hex length", () => {
            assert.throws(() => color("#12345"), /Invalid/);
            assert.throws(() => color("#1234567"), /Invalid/);
            assert.throws(() => color("#"), /Invalid/);
        });

        test("throws for non-hex digits", () => {
            assert.throws(() => color("#zz0000"), /Invalid/);
            assert.throws(() => color("#ggg"), /Invalid/);
        });
    });
});

// ─── color4() ────────────────────────────────────────────────────────────────

describe("color4", () => {
    describe("hex with alpha from string", () => {
        test("#rrggbb defaults alpha to 1", () => {
            assertColor4(color4("#ff0000"), [1, 0, 0, 1], "#ff0000");
            assertColor4(color4("#000000"), [0, 0, 0, 1], "#000000");
        });

        test("#rrggbbaa parses alpha channel", () => {
            assertColor4(color4("#ff0000ff"), [1, 0, 0, 1], "#ff0000ff");
            const half = color4("#ff000080");
            assert.ok(near(half[3], 0x80 / 255, 1e-4), `alpha: ${half[3]}`);
        });

        test("#rgba shorthand parses alpha", () => {
            assertColor4(color4("#f00f"), [1, 0, 0, 1], "#f00f");
            const c2 = color4("#f008");
            assert.ok(near(c2[3], 0x88 / 255, 1e-4), `alpha: ${c2[3]}`);
        });

        test("alpha param overrides string alpha", () => {
            const c = color4("#ff0000ff", 0.5);
            assert.ok(near(c[3], 0.5), `overridden alpha: ${c[3]}`);
        });
    });

    describe("3-tuple input", () => {
        test("defaults alpha to 1", () => {
            assertColor4(color4([0.5, 0.25, 0.75]), [0.5, 0.25, 0.75, 1]);
        });

        test("alpha param sets alpha", () => {
            assertColor4(color4([0.5, 0.25, 0.75], 0.5), [0.5, 0.25, 0.75, 0.5]);
        });
    });

    describe("4-tuple passthrough", () => {
        test("returns values unchanged", () => {
            assertColor4(color4([0.5, 0.25, 0.75, 0.8]), [0.5, 0.25, 0.75, 0.8]);
        });

        test("alpha param overrides 4-tuple alpha", () => {
            const c = color4([0.5, 0.25, 0.75, 0.8], 0.1);
            assert.ok(near(c[3], 0.1), `overridden alpha: ${c[3]}`);
        });
    });
});

// ─── setColor() ──────────────────────────────────────────────────────────────

describe("setColor", () => {
    test("writes raw sRGB values from hex into vec3", () => {
        const v = vec3.create();
        setColor(v, "#ff0000");
        assert.ok(near(v[0]!, 1, EPS), `r: ${v[0]}`);
        assert.ok(near(v[1]!, 0, EPS), `g: ${v[1]}`);
        assert.ok(near(v[2]!, 0, EPS), `b: ${v[2]}`);
    });

    test("writes 128/255 for #808080 (no gamma expansion)", () => {
        const v = vec3.create();
        setColor(v, "#808080");
        const expected = 128 / 255;
        assert.ok(near(v[0]!, expected, EPS), `mid-grey r: ${v[0]} ≠ ${expected}`);
    });

    test("writes tuple values directly", () => {
        const v = vec3.create();
        setColor(v, [0.3, 0.5, 0.7]);
        assert.ok(near(v[0]!, 0.3, EPS));
        assert.ok(near(v[1]!, 0.5, EPS));
        assert.ok(near(v[2]!, 0.7, EPS));
    });

    test("mutates and returns the same vec3", () => {
        const v = vec3.create();
        const result = setColor(v, "#ffffff");
        assert.strictEqual(result, v);
    });

    test("throws for unsupported format", () => {
        const v = vec3.create();
        assert.throws(() => setColor(v, "white"), /Unsupported/);
    });
});

// ─── Transfer function utilities ─────────────────────────────────────────────

describe("srgbToLinear / linearToSrgb", () => {
    test("black and white are fixed points", () => {
        assert.ok(near(srgbToLinear(0), 0));
        assert.ok(near(srgbToLinear(1), 1));
        assert.ok(near(linearToSrgb(0), 0));
        assert.ok(near(linearToSrgb(1), 1));
    });

    test("srgbToLinear and linearToSrgb are inverses", () => {
        for (const v of [0.1, 0.2, 0.5, 0.75, 0.9]) {
            assert.ok(near(srgbToLinear(linearToSrgb(v)), v, 1e-5), `round-trip failed at ${v}`);
            assert.ok(near(linearToSrgb(srgbToLinear(v)), v, 1e-5), `round-trip failed at ${v}`);
        }
    });

    test("srgbToLinear maps 0.5 sRGB to ~0.214 linear", () => {
        // Known reference: sRGB 0.5 → linear ≈ 0.21404
        const linear = srgbToLinear(0.5);
        assert.ok(near(linear, 0.21404, 1e-4), `srgbToLinear(0.5) = ${linear}`);
    });

    test("uses linear segment for small values", () => {
        // c ≤ 0.04045 → c / 12.92
        const c = 0.02;
        assert.ok(near(srgbToLinear(c), c / 12.92, EPS));
    });
});
