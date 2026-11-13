import assert from "node:assert/strict";
import {describe, test} from "node:test";

import {parseSTL} from "./stl";

/** One binary facet with a zero normal, optionally padded past its declared size. */
function binary(padding = 0, header = ""): ArrayBuffer {
    const buffer = new ArrayBuffer(84 + 50 + padding);
    new Uint8Array(buffer).set(new TextEncoder().encode(header));
    const view = new DataView(buffer);
    view.setUint32(80, 1, true);
    const vertices = [0, 0, 0, 1, 0, 0, 0, 1, 0];
    vertices.forEach((v, i) => view.setFloat32(84 + 12 + i * 4, v, true));
    return buffer;
}

describe("parseSTL", () => {
    test("binary: a zero facet normal becomes the triangle's", () => {
        const g = parseSTL(binary());
        assert.deepEqual(Array.from(g.normals.subarray(0, 3)), [0, 0, 1]);
    });

    test("binary with padding, and with a header that starts with 'solid'", () => {
        assert.equal(parseSTL(binary(16)).positions.length, 9);
        assert.equal(parseSTL(binary(0, "solid exported by a CAD tool")).positions.length, 9);
    });

    test("ASCII", () => {
        const text = `solid t
facet normal 0 0 0
outer loop
vertex 0 0 0
vertex 0 1 0
vertex 1 0 0
endloop
endfacet
endsolid t`;
        const g = parseSTL(new TextEncoder().encode(text).buffer as ArrayBuffer);
        assert.equal(g.positions.length, 9);
        assert.deepEqual(Array.from(g.normals.subarray(0, 3)), [0, 0, -1]);
    });
});
