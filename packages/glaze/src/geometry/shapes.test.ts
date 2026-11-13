import assert from "node:assert/strict";
import {describe, test} from "node:test";

import {computeTangents, type Geometry} from "./geometry";
import {
    createCone,
    createCube,
    createCylinder,
    createIcosphere,
    createPlane,
    createQuad,
    createSphere,
    createTorus,
} from "./shapes";

// Glaze's UV convention (glTF's): (0, 0) is the image's first row, top-left; v runs down.

/** UV of the vertex at `position` (first match). */
function uvAt(geo: Geometry, [x, y, z]: [number, number, number]): [number, number] {
    for (let i = 0; i < geo.vertexCount; i++) {
        const p = geo.positions;
        if (
            Math.abs(p[i * 3]! - x) < 1e-6 &&
            Math.abs(p[i * 3 + 1]! - y) < 1e-6 &&
            Math.abs(p[i * 3 + 2]! - z) < 1e-6
        ) {
            return [geo.uvs[i * 2]!, geo.uvs[i * 2 + 1]!];
        }
    }
    throw new Error(`no vertex at ${x}, ${y}, ${z}`);
}

/** The image row a v coordinate samples, for an image `height` rows tall uploaded top row first. */
const rowOf = (v: number, height: number) => Math.min(height - 1, Math.floor(v * height));

describe("UV convention", () => {
    test("a quad's top-left corner maps to the image's first row, first column", () => {
        // the quad lies in XZ facing +y; seen from above with -z up, its top-left corner is (-x, -z)
        const quad = createQuad({width: 2, height: 2});
        const [u, v] = uvAt(quad, [-1, 0, -1]);
        assert.deepEqual([u, v], [0, 0]);
        assert.equal(rowOf(v, 256), 0);
        assert.deepEqual(uvAt(quad, [1, 0, -1]), [1, 0]); // top-right
        assert.deepEqual(uvAt(quad, [-1, 0, 1]), [0, 1]); // bottom-left: last row
        assert.equal(rowOf(uvAt(quad, [-1, 0, 1])[1], 256), 255);
    });

    test("a cube's front face reads upright: top-left is (0, 0)", () => {
        const cube = createCube({size: 2});
        // front face (+z): top-left seen from the front is (-1, +1, +1); several faces share that corner
        const front = (i: number) => cube.normals[i * 3 + 2] === 1;
        const corner = (x: number, y: number) => {
            for (let i = 0; i < cube.vertexCount; i++) {
                if (front(i) && cube.positions[i * 3] === x && cube.positions[i * 3 + 1] === y) {
                    return [cube.uvs[i * 2], cube.uvs[i * 2 + 1]];
                }
            }
            throw new Error("missing corner");
        };
        assert.deepEqual(corner(-1, 1), [0, 0]);
        assert.deepEqual(corner(1, 1), [1, 0]);
        assert.deepEqual(corner(-1, -1), [0, 1]);
    });

    test("a sphere's v runs from the north pole (0) to the south pole (1)", () => {
        const sphere = createSphere({radius: 1});
        assert.equal(uvAt(sphere, [0, 1, 0])[1], 0);
        assert.equal(uvAt(sphere, [0, -1, 0])[1], 1);
    });

    // every factory: seen from outside, u runs right and v runs down, so the mapping is never mirrored
    const shapes: [string, Geometry][] = [
        ["cube", createCube({widthSegments: 2, heightSegments: 2, depthSegments: 2})],
        ["plane", createPlane({widthSegments: 3, heightSegments: 3})],
        ["sphere", createSphere()],
        ["icosphere", createIcosphere({subdivisions: 2})],
        ["cylinder", createCylinder({heightSegments: 2})],
        ["cone", createCone()],
        ["torus", createTorus()],
    ];
    for (const [name, geo] of shapes) {
        test(`${name}: (dP/du) × (-dP/dv) faces outward on every textured triangle`, () => {
            const {positions: p, uvs, indices: idx, normals: n} = geo;
            let checked = 0;
            for (let t = 0; t < idx.length; t += 3) {
                const [a, b, c] = [idx[t]!, idx[t + 1]!, idx[t + 2]!];
                const e1 = [0, 1, 2].map((k) => p[b * 3 + k]! - p[a * 3 + k]!);
                const e2 = [0, 1, 2].map((k) => p[c * 3 + k]! - p[a * 3 + k]!);
                const [du1, dv1] = [uvs[b * 2]! - uvs[a * 2]!, uvs[b * 2 + 1]! - uvs[a * 2 + 1]!];
                const [du2, dv2] = [uvs[c * 2]! - uvs[a * 2]!, uvs[c * 2 + 1]! - uvs[a * 2 + 1]!];
                const det = du1 * dv2 - du2 * dv1;
                if (Math.abs(det) < 1e-9) {
                    continue; // degenerate in UV space (poles, apex)
                }
                const dPdu = [0, 1, 2].map((k) => (dv2 * e1[k]! - dv1 * e2[k]!) / det);
                const dPdv = [0, 1, 2].map((k) => (du1 * e2[k]! - du2 * e1[k]!) / det);
                const up = dPdv.map((x) => -x);
                const cross = [
                    dPdu[1]! * up[2]! - dPdu[2]! * up[1]!,
                    dPdu[2]! * up[0]! - dPdu[0]! * up[2]!,
                    dPdu[0]! * up[1]! - dPdu[1]! * up[0]!,
                ];
                const normal = [0, 1, 2].map((k) => n[a * 3 + k]! + n[b * 3 + k]! + n[c * 3 + k]!);
                const dot = cross[0]! * normal[0]! + cross[1]! * normal[1]! + cross[2]! * normal[2]!;
                assert.ok(dot > 0, `${name} triangle ${t / 3} is mirrored`);
                checked++;
            }
            assert.ok(checked > 0);
        });
    }
});

describe("computeTangents", () => {
    test("glTF handedness: the bitangent cross(N, T) * w points to the image's top", () => {
        // a quad in XY facing +z, (0,0) at its top-left (-1, +1)
        const positions = new Float32Array([-1, 1, 0, 1, 1, 0, -1, -1, 0, 1, -1, 0]);
        const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
        const uvs = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
        const indices = new Uint32Array([0, 2, 1, 1, 2, 3]);
        const t = computeTangents(positions, normals, uvs, indices, 4);
        for (let i = 0; i < 4; i++) {
            assert.deepEqual(Array.from(t.slice(i * 4, i * 4 + 3)), [1, 0, 0], "tangent along +u = +x");
            // cross((0,0,1), (1,0,0)) = (0,1,0): with w = +1 the bitangent is +y, the image's top
            assert.equal(t[i * 4 + 3], 1);
        }
    });

    test("a horizontally mirrored mapping gets w = -1", () => {
        const positions = new Float32Array([-1, 1, 0, 1, 1, 0, -1, -1, 0, 1, -1, 0]);
        const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
        const uvs = new Float32Array([1, 0, 0, 0, 1, 1, 0, 1]);
        const indices = new Uint32Array([0, 2, 1, 1, 2, 3]);
        const t = computeTangents(positions, normals, uvs, indices, 4);
        assert.equal(t[0], -1); // tangent along +u = -x
        assert.equal(t[3], -1); // cross(N, T) = -y, so w = -1 keeps the bitangent at +y
    });
});

describe("segment counts are sanitized", () => {
    test("zero, fractional and too-small counts still give valid geometry", () => {
        for (const g of [
            createSphere({widthSegments: 0, heightSegments: 1}),
            createPlane({widthSegments: 2.5, heightSegments: 0}),
            createCylinder({radialSegments: 1.2, heightSegments: 0, height: 0}),
            createTorus({radialSegments: 0, tubularSegments: 2}),
        ]) {
            assert.ok(g.indices.length > 0);
            assert.ok(Array.from(g.positions).every(Number.isFinite));
            assert.ok(Array.from(g.normals).every(Number.isFinite));
            const n = g.positions.length / 3;
            assert.ok(Array.from(g.indices).every((i) => i < n));
        }
    });
});

describe("computeTangents across a mirrored UV seam", () => {
    test("a vertex shared by mirrored triangles keeps a unit tangent (the two sides don't cancel)", () => {
        // two triangles sharing the edge 0-1, the second with its UVs mirrored in u
        const positions = new Float32Array([0, 0, 0, 0, 1, 0, 1, 0, 0, -1, 0, 0]);
        const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
        const uvs = new Float32Array([0, 1, 0, 0, 1, 1, 1, 1]);
        const indices = new Uint32Array([0, 2, 1, 0, 1, 3]);
        const t = computeTangents(positions, normals, uvs, indices, 4);
        for (const v of [0, 1]) {
            assert.ok(Math.abs(Math.hypot(t[v * 4]!, t[v * 4 + 1]!, t[v * 4 + 2]!) - 1) < 1e-5, `vertex ${v}`);
        }
    });
});
