import assert from "node:assert/strict";
import {describe, test} from "node:test";

import {linearToSrgb} from "../color";
import {type GltfMaterialDescriptor, parseGLB, planGltfMaterial} from "./glb";

// ─── Test binary builder ──────────────────────────────────────────────────────

function makeGLB(json: object, bin?: Uint8Array): ArrayBuffer {
    const jsonStr = JSON.stringify(json);
    const jsonPad = (4 - (jsonStr.length % 4)) % 4;
    const jsonBuf = new TextEncoder().encode(jsonStr + " ".repeat(jsonPad));

    const binBuf = bin ?? new Uint8Array(0);
    const binPad = binBuf.length > 0 ? (4 - (binBuf.length % 4)) % 4 : 0;
    const binPadded = new Uint8Array(binBuf.length + binPad);
    binPadded.set(binBuf);

    const hasBin = binBuf.length > 0;
    const total = 12 + 8 + jsonBuf.length + (hasBin ? 8 + binPadded.length : 0);
    const out = new ArrayBuffer(total);
    const dv = new DataView(out);

    dv.setUint32(0, 0x46546c67, true); // magic "glTF"
    dv.setUint32(4, 2, true); // version
    dv.setUint32(8, total, true); // total length

    dv.setUint32(12, jsonBuf.length, true); // JSON chunk length
    dv.setUint32(16, 0x4e4f534a, true); // JSON chunk type
    new Uint8Array(out, 20, jsonBuf.length).set(jsonBuf);

    if (hasBin) {
        const off = 20 + jsonBuf.length;
        dv.setUint32(off, binPadded.length, true); // BIN chunk length
        dv.setUint32(off + 4, 0x004e4942, true); // BIN chunk type
        new Uint8Array(out, off + 8, binPadded.length).set(binPadded);
    }

    return out;
}

// Minimal GLB JSON + binary for a triangle (3 VEC3 float32 positions, no index buffer)
function makeTriangleGLB(extra?: object): ArrayBuffer {
    // positions: (1,0,0), (0,1,0), (0,0,1)
    const positions = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const json = {
        accessors: [{bufferView: 0, byteOffset: 0, componentType: 5126, count: 3, type: "VEC3"}],
        bufferViews: [{buffer: 0, byteOffset: 0, byteLength: 36}],
        buffers: [{byteLength: 36}],
        meshes: [{primitives: [{attributes: {POSITION: 0}}]}],
        ...extra,
    };
    return makeGLB(json, new Uint8Array(positions.buffer));
}

// ─── Header validation ────────────────────────────────────────────────────────

describe("parseGLB — header", () => {
    test("throws on wrong magic number", () => {
        const buf = new ArrayBuffer(12);
        new DataView(buf).setUint32(0, 0xdeadbeef, true);
        assert.throws(() => parseGLB(buf), /invalid magic/i);
    });

    test("throws on unsupported version", () => {
        const buf = new ArrayBuffer(12);
        const dv = new DataView(buf);
        dv.setUint32(0, 0x46546c67, true); // correct magic
        dv.setUint32(4, 1, true); // version 1 (unsupported)
        assert.throws(() => parseGLB(buf), /unsupported version/i);
    });

    test("throws when first chunk is not JSON", () => {
        const buf = new ArrayBuffer(20);
        const dv = new DataView(buf);
        dv.setUint32(0, 0x46546c67, true);
        dv.setUint32(4, 2, true);
        dv.setUint32(8, 20, true);
        dv.setUint32(12, 0, true);
        dv.setUint32(16, 0x004e4942, true); // BIN type instead of JSON
        assert.throws(() => parseGLB(buf), /not JSON/i);
    });
});

// ─── Geometry extraction ──────────────────────────────────────────────────────

describe("parseGLB — geometry", () => {
    test("returns empty array for GLB with no meshes", () => {
        const glb = makeGLB({accessors: [], bufferViews: [], buffers: [], meshes: []});
        assert.deepEqual(parseGLB(glb), []);
    });

    test("parses triangle positions correctly", () => {
        const glb = makeTriangleGLB();
        const result = parseGLB(glb);
        assert.equal(result.length, 1);
        const geo = result[0]!.geometry;
        assert.equal(geo.vertexCount, 3);
        assert.ok(Math.abs(geo.positions[0]! - 1) < 1e-6, "v0.x = 1");
        assert.ok(Math.abs(geo.positions[4]! - 1) < 1e-6, "v1.y = 1");
        assert.ok(Math.abs(geo.positions[8]! - 1) < 1e-6, "v2.z = 1");
    });

    test("generates sequential indices when no index buffer", () => {
        const glb = makeTriangleGLB();
        const geo = parseGLB(glb)[0]!.geometry;
        assert.equal(geo.indexCount, 3);
        assert.deepEqual(Array.from(geo.indices), [0, 1, 2]);
    });

    test("reads index buffer when present", () => {
        const positions = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
        const indices = new Uint16Array([2, 1, 0]);
        const bin = new Uint8Array(positions.byteLength + indices.byteLength);
        bin.set(new Uint8Array(positions.buffer), 0);
        bin.set(new Uint8Array(indices.buffer), positions.byteLength);

        const json = {
            accessors: [
                {bufferView: 1, byteOffset: 0, componentType: 5123 /* u16 */, count: 3, type: "SCALAR"},
                {bufferView: 0, byteOffset: 0, componentType: 5126, count: 3, type: "VEC3"},
            ],
            bufferViews: [
                {buffer: 0, byteOffset: 0, byteLength: positions.byteLength},
                {buffer: 0, byteOffset: positions.byteLength, byteLength: indices.byteLength},
            ],
            buffers: [{byteLength: bin.byteLength}],
            meshes: [{primitives: [{attributes: {POSITION: 1}, indices: 0}]}],
        };
        const geo = parseGLB(makeGLB(json, bin))[0]!.geometry;
        assert.equal(geo.indexCount, 3);
        // no NORMAL: flat shaded, so each corner is its own vertex, read in the index buffer's order
        assert.deepEqual(Array.from(geo.positions), [0, 0, 1, 0, 1, 0, 1, 0, 0]);
    });

    test("computes flat normals when the NORMAL accessor is absent (glTF spec)", () => {
        const geo = parseGLB(makeTriangleGLB())[0]!.geometry;
        assert.equal(geo.normals.length, 9); // 3 vertices × 3
        for (let i = 0; i < 9; i += 3) {
            assert.ok(Math.abs(Math.hypot(geo.normals[i]!, geo.normals[i + 1]!, geo.normals[i + 2]!) - 1) < 1e-6);
        }
    });

    test("fills zero UVs when TEXCOORD_0 absent", () => {
        const geo = parseGLB(makeTriangleGLB())[0]!.geometry;
        assert.equal(geo.uvs.length, 6); // 3 vertices × 2
        assert.ok(geo.uvs.every((v) => v === 0));
    });

    test("skips primitives with non-triangle mode", () => {
        const glb = makeTriangleGLB({
            meshes: [{primitives: [{attributes: {POSITION: 0}, mode: 1 /* LINES */}]}],
        });
        assert.deepEqual(parseGLB(glb), []);
    });

    test("skips primitive when POSITION attribute missing", () => {
        const glb = makeGLB({
            meshes: [{primitives: [{attributes: {}}]}],
        });
        assert.deepEqual(parseGLB(glb), []);
    });

    test("handles multiple primitives in one mesh", () => {
        const positions = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
        const json = {
            accessors: [{bufferView: 0, byteOffset: 0, componentType: 5126, count: 3, type: "VEC3"}],
            bufferViews: [{buffer: 0, byteOffset: 0, byteLength: 36}],
            buffers: [{byteLength: 36}],
            meshes: [{primitives: [{attributes: {POSITION: 0}}, {attributes: {POSITION: 0}}]}],
        };
        const result = parseGLB(makeGLB(json, new Uint8Array(positions.buffer)));
        assert.equal(result.length, 2);
    });
});

// ─── Material extraction ──────────────────────────────────────────────────────

describe("parseGLB — material", () => {
    test("material is null when primitive has no material index", () => {
        const result = parseGLB(makeTriangleGLB());
        assert.equal(result[0]!.material, null);
    });

    test("material is null when materials array absent but index referenced", () => {
        // material index 0 but no materials array → extractMaterial returns defaults
        // This covers graceful degradation
        const glb = makeTriangleGLB({
            meshes: [{primitives: [{attributes: {POSITION: 0}, material: 0}]}],
        });
        const mat = parseGLB(glb)[0]!.material;
        assert.notEqual(mat, null);
        assert.deepEqual(mat!.baseColorFactor, [1, 1, 1, 1]);
    });

    test("extracts name from material", () => {
        const glb = makeTriangleGLB({
            materials: [{name: "duck-skin"}],
            meshes: [{primitives: [{attributes: {POSITION: 0}, material: 0}]}],
        });
        assert.equal(parseGLB(glb)[0]!.material!.name, "duck-skin");
    });

    test("extracts baseColorFactor", () => {
        const glb = makeTriangleGLB({
            materials: [{pbrMetallicRoughness: {baseColorFactor: [0.8, 0.6, 0.4, 1.0]}}],
            meshes: [{primitives: [{attributes: {POSITION: 0}, material: 0}]}],
        });
        assert.deepEqual(parseGLB(glb)[0]!.material!.baseColorFactor, [0.8, 0.6, 0.4, 1.0]);
    });

    test("extracts metallicFactor and roughnessFactor", () => {
        const glb = makeTriangleGLB({
            materials: [{pbrMetallicRoughness: {metallicFactor: 0.0, roughnessFactor: 0.7}}],
            meshes: [{primitives: [{attributes: {POSITION: 0}, material: 0}]}],
        });
        const mat = parseGLB(glb)[0]!.material!;
        assert.equal(mat.metallicFactor, 0.0);
        assert.equal(mat.roughnessFactor, 0.7);
    });

    test("defaults metallicFactor and roughnessFactor to 1.0 (GLTF spec)", () => {
        const glb = makeTriangleGLB({
            materials: [{}],
            meshes: [{primitives: [{attributes: {POSITION: 0}, material: 0}]}],
        });
        const mat = parseGLB(glb)[0]!.material!;
        assert.equal(mat.metallicFactor, 1.0);
        assert.equal(mat.roughnessFactor, 1.0);
    });

    test("extracts emissiveFactor", () => {
        const glb = makeTriangleGLB({
            materials: [{emissiveFactor: [0.1, 0.2, 0.3]}],
            meshes: [{primitives: [{attributes: {POSITION: 0}, material: 0}]}],
        });
        assert.deepEqual(parseGLB(glb)[0]!.material!.emissiveFactor, [0.1, 0.2, 0.3]);
    });

    test("defaults emissiveFactor to [0,0,0]", () => {
        const glb = makeTriangleGLB({
            materials: [{}],
            meshes: [{primitives: [{attributes: {POSITION: 0}, material: 0}]}],
        });
        assert.deepEqual(parseGLB(glb)[0]!.material!.emissiveFactor, [0, 0, 0]);
    });

    test("null texture slots when no textures referenced", () => {
        const glb = makeTriangleGLB({
            materials: [{}],
            meshes: [{primitives: [{attributes: {POSITION: 0}, material: 0}]}],
        });
        const mat = parseGLB(glb)[0]!.material!;
        assert.equal(mat.baseColorTexture, null);
        assert.equal(mat.normalTexture, null);
        assert.equal(mat.emissiveTexture, null);
        assert.equal(mat.occlusionTexture, null);
        assert.equal(mat.metallicRoughnessTexture, null);
    });

    test("extracts external URI baseColorTexture", () => {
        const glb = makeTriangleGLB({
            images: [{uri: "DuckCM.png"}],
            textures: [{source: 0}],
            materials: [{pbrMetallicRoughness: {baseColorTexture: {index: 0}}}],
            meshes: [{primitives: [{attributes: {POSITION: 0}, material: 0}]}],
        });
        const src = parseGLB(glb)[0]!.material!.baseColorTexture;
        assert.ok(src !== null);
        assert.equal(src!.type, "uri");
        assert.equal((src as {type: "uri"; uri: string}).uri, "DuckCM.png");
    });

    test("extracts embedded baseColorTexture from bufferView", () => {
        // Triangle positions in first 36 bytes, fake image bytes after
        const positions = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
        const imgBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG magic header
        const bin = new Uint8Array(positions.byteLength + imgBytes.length);
        bin.set(new Uint8Array(positions.buffer), 0);
        bin.set(imgBytes, positions.byteLength);

        const json = {
            accessors: [{bufferView: 0, byteOffset: 0, componentType: 5126, count: 3, type: "VEC3"}],
            bufferViews: [
                {buffer: 0, byteOffset: 0, byteLength: 36},
                {buffer: 0, byteOffset: 36, byteLength: imgBytes.length},
            ],
            images: [{bufferView: 1, mimeType: "image/png"}],
            textures: [{source: 0}],
            materials: [{pbrMetallicRoughness: {baseColorTexture: {index: 0}}}],
            buffers: [{byteLength: bin.byteLength}],
            meshes: [{primitives: [{attributes: {POSITION: 0}, material: 0}]}],
        };
        const src = parseGLB(makeGLB(json, bin))[0]!.material!.baseColorTexture!;
        assert.equal(src.type, "embedded");
        const emb = src as {type: "embedded"; data: Uint8Array; mimeType: string};
        assert.equal(emb.mimeType, "image/png");
        assert.equal(emb.data.length, imgBytes.length);
        assert.deepEqual(Array.from(emb.data), Array.from(imgBytes));
    });

    test("embedded image data is an independent copy, not a view into the original buffer", () => {
        const positions = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
        const imgBytes = new Uint8Array([0xaa, 0xbb]);
        const bin = new Uint8Array(positions.byteLength + imgBytes.length);
        bin.set(new Uint8Array(positions.buffer), 0);
        bin.set(imgBytes, positions.byteLength);

        const json = {
            accessors: [{bufferView: 0, byteOffset: 0, componentType: 5126, count: 3, type: "VEC3"}],
            bufferViews: [
                {buffer: 0, byteOffset: 0, byteLength: 36},
                {buffer: 0, byteOffset: 36, byteLength: 2},
            ],
            images: [{bufferView: 1, mimeType: "image/png"}],
            textures: [{source: 0}],
            materials: [{pbrMetallicRoughness: {baseColorTexture: {index: 0}}}],
            buffers: [{byteLength: bin.byteLength}],
            meshes: [{primitives: [{attributes: {POSITION: 0}, material: 0}]}],
        };
        const glbBuf = makeGLB(json, bin);
        const src = parseGLB(glbBuf)[0]!.material!.baseColorTexture!;
        const emb = src as {type: "embedded"; data: Uint8Array; mimeType: string};
        // data should not share an ArrayBuffer with glbBuf
        assert.notEqual(emb.data.buffer, glbBuf);
    });
});

// ─── Material mapping ─────────────────────────────────────────────────────────

/** A triangle whose material uses `material`, over three URI images a.png, b.png, c.png. */
function materialGLB(material: object, textures: object[] = [{source: 0}, {source: 1}, {source: 2}]) {
    return parseGLB(
        makeTriangleGLB({
            images: [{uri: "a.png"}, {uri: "b.png"}, {uri: "c.png"}],
            textures,
            materials: [material],
            meshes: [{primitives: [{attributes: {POSITION: 0}, material: 0}]}],
        }),
    )[0]!.material!;
}

const uri = (source: unknown) => (source as {uri: string} | null)?.uri ?? null;

describe("parseGLB — material scalars", () => {
    test("reads normal scale, occlusion strength and emissive strength", () => {
        const m = materialGLB({
            normalTexture: {index: 0, scale: 0.5},
            occlusionTexture: {index: 1, strength: 0.25},
            extensions: {KHR_materials_emissive_strength: {emissiveStrength: 4}},
        });
        assert.equal(m.normalScale, 0.5);
        assert.equal(m.occlusionStrength, 0.25);
        assert.equal(m.emissiveStrength, 4);
    });

    test("defaults scale, strengths and texCoords per the spec", () => {
        const m = materialGLB({});
        assert.equal(m.normalScale, 1);
        assert.equal(m.occlusionStrength, 1);
        assert.equal(m.emissiveStrength, 1);
        assert.deepEqual(m.texCoords, {baseColor: 0, normal: 0, emissive: 0, occlusion: 0, metallicRoughness: 0});
    });

    test("records each texture's texCoord", () => {
        const m = materialGLB({occlusionTexture: {index: 0, texCoord: 1}});
        assert.equal(m.texCoords!.occlusion, 1);
    });

    test("slots that reference the same image share one source object", () => {
        // two texture entries, one image: still the same source
        const m = materialGLB(
            {pbrMetallicRoughness: {metallicRoughnessTexture: {index: 0}}, occlusionTexture: {index: 1}},
            [{source: 2}, {source: 2}],
        );
        assert.ok(m.occlusionTexture);
        assert.equal(m.occlusionTexture, m.metallicRoughnessTexture);
    });
});

describe("planGltfMaterial", () => {
    test("separate occlusion and metallic-roughness textures go to separate maps", () => {
        const plan = planGltfMaterial(
            materialGLB({pbrMetallicRoughness: {metallicRoughnessTexture: {index: 0}}, occlusionTexture: {index: 1}}),
        );
        assert.equal(uri(plan.metallicRoughnessMap), "a.png");
        assert.equal(uri(plan.occlusionMap), "b.png");
        assert.equal(plan.ormMap, null);
    });

    test("occlusion packed into the metallic-roughness image becomes one ORM map", () => {
        const plan = planGltfMaterial(
            materialGLB({pbrMetallicRoughness: {metallicRoughnessTexture: {index: 0}}, occlusionTexture: {index: 0}}),
        );
        assert.equal(uri(plan.ormMap), "a.png");
        assert.equal(plan.metallicRoughnessMap, null);
        assert.equal(plan.occlusionMap, null);
    });

    test("metallic-roughness without occlusion never feeds occlusion (its red channel is unspecified)", () => {
        const plan = planGltfMaterial(materialGLB({pbrMetallicRoughness: {metallicRoughnessTexture: {index: 0}}}));
        assert.equal(uri(plan.metallicRoughnessMap), "a.png");
        assert.equal(plan.ormMap, null);
        assert.equal(plan.occlusionMap, null);
        assert.equal(plan.options.occlusionStrength, 1);
    });

    test("occlusion strength is carried through", () => {
        const plan = planGltfMaterial(materialGLB({occlusionTexture: {index: 1, strength: 0.3}}));
        assert.equal(uri(plan.occlusionMap), "b.png");
        assert.equal(plan.options.occlusionStrength, 0.3);
    });

    test("a texture on another UV set is skipped, so occlusion falls back to 1", () => {
        const plan = planGltfMaterial(
            materialGLB({
                pbrMetallicRoughness: {metallicRoughnessTexture: {index: 0}},
                occlusionTexture: {index: 0, texCoord: 1, strength: 0.5},
            }),
        );
        assert.equal(plan.occlusionMap, null);
        assert.equal(plan.ormMap, null);
        assert.equal(uri(plan.metallicRoughnessMap), "a.png");
        assert.equal(plan.options.occlusionStrength, 1);
        assert.deepEqual(plan.skipped, ["occlusion"]);
    });

    test("factors: metallic and roughness as-is, colors from linear to sRGB, emissive strength as intensity", () => {
        const plan = planGltfMaterial(
            materialGLB({
                pbrMetallicRoughness: {baseColorFactor: [0.2, 0.5, 1, 1], metallicFactor: 0.3, roughnessFactor: 0.7},
                emissiveFactor: [0.1, 0, 0.25],
                extensions: {KHR_materials_emissive_strength: {emissiveStrength: 2}},
                normalTexture: {index: 2, scale: 0.4},
            }),
        );
        const close = (a: ArrayLike<number>, b: number[]) =>
            b.forEach((v, i) => assert.ok(Math.abs(a[i]! - v) < 1e-6, `${a[i]} ≈ ${v}`));
        assert.equal(plan.options.metallic, 0.3);
        assert.equal(plan.options.roughness, 0.7);
        close(plan.options.color, [linearToSrgb(0.2), linearToSrgb(0.5), 1]);
        close(plan.options.emissive!, [linearToSrgb(0.1), 0, linearToSrgb(0.25)]);
        assert.equal(plan.options.emissiveIntensity, 2);
        assert.equal(plan.options.normalScale, 0.4);
        assert.equal(uri(plan.normalMap), "c.png");
    });

    test("an empty material gets the spec defaults and no maps", () => {
        const plan = planGltfMaterial(materialGLB({}));
        assert.ok(Array.from(plan.options.color).every((c) => Math.abs(c - 1) < 1e-9));
        assert.deepEqual(plan.options, {
            color: plan.options.color,
            metallic: 1,
            roughness: 1,
            emissive: [0, 0, 0],
            emissiveIntensity: 1,
            normalScale: 1,
            occlusionStrength: 1,
            opacity: 1,
            alphaMode: "opaque",
            alphaCutoff: 0.5,
            doubleSided: false,
        });
        for (const map of [
            plan.albedoMap,
            plan.normalMap,
            plan.emissiveMap,
            plan.ormMap,
            plan.metallicRoughnessMap,
            plan.occlusionMap,
        ]) {
            assert.equal(map, null);
        }
    });

    test("accepts a hand-built descriptor without the optional fields", () => {
        const descriptor: GltfMaterialDescriptor = {
            name: "",
            baseColorFactor: [1, 1, 1, 1],
            metallicFactor: 0,
            roughnessFactor: 0.5,
            emissiveFactor: [0, 0, 0],
            baseColorTexture: null,
            normalTexture: null,
            emissiveTexture: null,
            occlusionTexture: null,
            metallicRoughnessTexture: {type: "uri", uri: "mr.png"},
        };
        const plan = planGltfMaterial(descriptor);
        assert.equal(uri(plan.metallicRoughnessMap), "mr.png");
        assert.equal(plan.options.normalScale, 1);
    });
});

// ─── Node transforms ──────────────────────────────────────────────────────────

describe("parseGLB — nodes", () => {
    const withNodes = (nodes: object[], scenes: object[] = [{nodes: [0]}]) =>
        parseGLB(makeTriangleGLB({nodes, scenes, scene: 0}));

    test("bakes a node's translation and scale into positions", () => {
        const geo = withNodes([{mesh: 0, translation: [10, 0, 0], scale: [2, 2, 2]}])[0]!.geometry;
        assert.deepEqual(Array.from(geo.positions), [12, 0, 0, 10, 2, 0, 10, 0, 2]);
    });

    test("composes parent and child transforms", () => {
        const geo = withNodes([
            {children: [1], translation: [0, 5, 0]},
            {mesh: 0, translation: [1, 0, 0]},
        ])[0]!.geometry;
        assert.deepEqual(Array.from(geo.positions.slice(0, 3)), [2, 5, 0]);
    });

    test("one primitive per node that uses a mesh", () => {
        const result = withNodes([{children: [1, 2]}, {mesh: 0}, {mesh: 0, translation: [0, 0, 3]}]);
        assert.equal(result.length, 2);
        assert.equal(result[1]!.geometry.positions[2], 3);
        // the untransformed instance is unaffected by the transformed one
        assert.equal(result[0]!.geometry.positions[2], 0);
    });

    test("a mirroring transform reverses the winding", () => {
        const geo = withNodes([{mesh: 0, scale: [-1, 1, 1]}])[0]!.geometry;
        assert.deepEqual(Array.from(geo.indices), [0, 2, 1]);
        assert.equal(geo.positions[0], -1);
    });

    test("nodes outside the default scene are not drawn", () => {
        const result = withNodes([{mesh: 0}, {mesh: 0}], [{nodes: [1]}]);
        assert.equal(result.length, 1);
    });
});
