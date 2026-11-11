import assert from "node:assert/strict";
import {describe, test} from "node:test";

import {parseOBJ} from "./obj";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const EPS = 1e-6;
function near(a: number, b: number): boolean { return Math.abs(a - b) < EPS; }

// ─── Basic parsing ────────────────────────────────────────────────────────────

describe("parseOBJ — basic", () => {
    test("returns zero vertices for empty string", () => {
        const geo = parseOBJ("");
        assert.equal(geo.vertexCount, 0);
        assert.equal(geo.indexCount,  0);
    });

    test("ignores comment lines", () => {
        const geo = parseOBJ("# this is a comment\n# another comment");
        assert.equal(geo.vertexCount, 0);
    });

    test("ignores blank lines", () => {
        const geo = parseOBJ("\n   \n\n");
        assert.equal(geo.vertexCount, 0);
    });

    test("handles Windows CRLF line endings", () => {
        const obj = "v 1 0 0\r\nv 0 1 0\r\nv 0 0 1\r\nvn 0 0 1\r\nvn 0 0 1\r\nvn 0 0 1\r\nf 1//1 2//2 3//3\r\n";
        const geo = parseOBJ(obj);
        assert.equal(geo.vertexCount, 3);
    });

    test("ignores mtllib and usemtl directives", () => {
        const obj = "mtllib mat.mtl\nusemtl MyMat\nv 1 0 0\nv 0 1 0\nv 0 0 1\nvn 0 0 1\nvn 0 0 1\nvn 0 0 1\nf 1//1 2//2 3//3\n";
        const geo = parseOBJ(obj);
        assert.equal(geo.vertexCount, 3);
    });
});

// ─── Triangle with all attributes ────────────────────────────────────────────

describe("parseOBJ — triangle", () => {
    // v 1 0 0 / v 0 1 0 / v 0 0 1, normals pointing up, UVs at corners
    const OBJ = [
        "v 1 0 0",
        "v 0 1 0",
        "v 0 0 1",
        "vn 0 1 0",
        "vn 0 1 0",
        "vn 0 1 0",
        "vt 0.0 0.0",
        "vt 1.0 0.0",
        "vt 0.0 1.0",
        "f 1/1/1 2/2/2 3/3/3",
    ].join("\n");

    test("produces 3 vertices and 3 indices", () => {
        const geo = parseOBJ(OBJ);
        assert.equal(geo.vertexCount, 3);
        assert.equal(geo.indexCount,  3);
    });

    test("positions are correct", () => {
        const geo = parseOBJ(OBJ);
        assert.ok(near(geo.positions[0]!, 1), "v0.x"); // (1,0,0)
        assert.ok(near(geo.positions[1]!, 0), "v0.y");
        assert.ok(near(geo.positions[2]!, 0), "v0.z");
        assert.ok(near(geo.positions[3]!, 0), "v1.x"); // (0,1,0)
        assert.ok(near(geo.positions[4]!, 1), "v1.y");
    });

    test("normals are correct", () => {
        const geo = parseOBJ(OBJ);
        assert.ok(near(geo.normals[0]!, 0));  // nx
        assert.ok(near(geo.normals[1]!, 1));  // ny
        assert.ok(near(geo.normals[2]!, 0));  // nz
    });

    test("UV V-coordinate is flipped (1 - v)", () => {
        const geo = parseOBJ(OBJ);
        // vt 0.0 0.0 → stored as (0.0, 1.0)
        assert.ok(near(geo.uvs[0]!, 0.0), "u0");
        assert.ok(near(geo.uvs[1]!, 1.0), "v0 flipped");
        // vt 1.0 0.0 → stored as (1.0, 1.0)
        assert.ok(near(geo.uvs[2]!, 1.0), "u1");
        assert.ok(near(geo.uvs[3]!, 1.0), "v1 flipped");
        // vt 0.0 1.0 → stored as (0.0, 0.0)
        assert.ok(near(geo.uvs[4]!, 0.0), "u2");
        assert.ok(near(geo.uvs[5]!, 0.0), "v2 flipped");
    });

    test("indices reference correct vertices", () => {
        const geo = parseOBJ(OBJ);
        assert.deepEqual(Array.from(geo.indices), [0, 1, 2]);
    });
});

// ─── Fan triangulation ────────────────────────────────────────────────────────

describe("parseOBJ — quad triangulation", () => {
    // A square quad face (4 verts) → 2 triangles = 6 indices
    const OBJ = [
        "v 0 0 0",
        "v 1 0 0",
        "v 1 1 0",
        "v 0 1 0",
        "vn 0 0 1",
        "f 1//1 2//1 3//1 4//1",
    ].join("\n");

    test("produces 4 unique vertices and 6 indices (2 triangles)", () => {
        const geo = parseOBJ(OBJ);
        assert.equal(geo.vertexCount, 4);
        assert.equal(geo.indexCount,  6);
    });

    test("fan triangulation: indices are [0,1,2, 0,2,3]", () => {
        const geo = parseOBJ(OBJ);
        assert.deepEqual(Array.from(geo.indices), [0, 1, 2, 0, 2, 3]);
    });
});

// ─── Vertex deduplication ─────────────────────────────────────────────────────

describe("parseOBJ — vertex deduplication", () => {
    test("shares vertex index when pos/uv/norm triplet is the same", () => {
        // Two triangles sharing edge verts 1 and 2
        const obj = [
            "v 0 0 0",
            "v 1 0 0",
            "v 0 1 0",
            "v 1 1 0",
            "vn 0 0 1",
            "f 1//1 2//1 3//1",
            "f 2//1 4//1 3//1",
        ].join("\n");
        const geo = parseOBJ(obj);
        // Verts 2 and 3 are shared → 4 unique output vertices total
        assert.equal(geo.vertexCount, 4);
        assert.equal(geo.indexCount,  6);
    });
});

// ─── Missing attribute handling ───────────────────────────────────────────────

describe("parseOBJ — missing attributes", () => {
    test("computes flat normals when no vn present", () => {
        // Triangle in XY plane → normal should be (0,0,±1)
        const obj = [
            "v 0 0 0",
            "v 1 0 0",
            "v 0 1 0",
            "vt 0 0",
            "vt 1 0",
            "vt 0 1",
            "f 1/1 2/2 3/3",
        ].join("\n");
        const geo = parseOBJ(obj);
        const nz = Math.abs(geo.normals[2]!);
        assert.ok(nz > 0.99, `expected |nz| ≈ 1, got ${nz}`);
    });

    test("sets (0, 1) UVs when no vt present (f x//n form)", () => {
        // No vt lines → uvIdx=0 → srcUvs empty → u=0, v=1-0=1 (V-flip of zero)
        const obj = [
            "v 0 0 0",
            "v 1 0 0",
            "v 0 1 0",
            "vn 0 0 1",
            "f 1//1 2//1 3//1",
        ].join("\n");
        const geo = parseOBJ(obj);
        assert.equal(geo.uvs.length, 6);
        for (let i = 0; i < 3; i++) {
            assert.equal(geo.uvs[i * 2]!,     0, `u${i}`);
            assert.equal(geo.uvs[i * 2 + 1]!, 1, `v${i}`);
        }
    });
});
