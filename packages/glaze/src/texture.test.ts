import assert from "node:assert/strict";
import {describe, test} from "node:test";

import {parseRGBE, toHalf} from "./texture";

describe("toHalf", () => {
    test("exact values, rounding, overflow and tiny numbers", () => {
        assert.equal(toHalf(0), 0);
        assert.equal(toHalf(1), 0x3c00);
        assert.equal(toHalf(-2), 0xc000);
        assert.equal(toHalf(0.5), 0x3800);
        assert.equal(toHalf(65504), 0x7bff); // largest half
        assert.equal(toHalf(1e6), 0x7c00); // overflow: infinity
        assert.equal(toHalf(1e-9), 0); // underflow
        assert.equal(toHalf(2 ** -24), 1); // smallest subnormal
        assert.equal(toHalf(1 + 2 ** -11), 0x3c00 + 1); // ties round up here (no tie-to-even needed for maps)
    });
});

describe("parseRGBE", () => {
    const header = (w: number, h: number) =>
        new TextEncoder().encode(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${h} +X ${w}\n`);
    test("flat scanlines", () => {
        const head = header(2, 1);
        const bytes = new Uint8Array(head.length + 8);
        bytes.set(head);
        bytes.set([128, 64, 0, 129, 255, 255, 255, 0], head.length); // (128,64,0)·2^(1-8), then black
        const {data, width, height} = parseRGBE(bytes.buffer);
        assert.equal(width, 2);
        assert.equal(height, 1);
        assert.deepEqual(Array.from(data), [1, 0.5, 0, 1, 0, 0, 0, 1]);
    });

    test("run-length encoded scanlines", () => {
        const head = header(8, 1);
        // per channel: a run of 8 (count 128 + 8) of one value
        const body = [2, 2, 0, 8, 136, 128, 136, 128, 136, 0, 136, 129];
        const bytes = new Uint8Array(head.length + body.length);
        bytes.set(head);
        bytes.set(body, head.length);
        const {data} = parseRGBE(bytes.buffer);
        for (let x = 0; x < 8; x++) {
            assert.deepEqual(Array.from(data.subarray(x * 4, x * 4 + 4)), [1, 1, 0, 1]);
        }
    });
});
