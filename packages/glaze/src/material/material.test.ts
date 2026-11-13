import assert from "node:assert/strict";
import {describe, test} from "node:test";

import {srgbToLinear} from "../color";
import type {Texture} from "../texture";
import {packMaterialUniforms, PBRMaterial} from "./material";

// map resolution compares identities only, so stand-in objects work without a GPU
const fakeTexture = (name: string) => ({name}) as unknown as Texture;

describe("PBRMaterial — maps", () => {
    test("no maps: occlusion and metallic-roughness fall back to the white default", () => {
        const mat = new PBRMaterial();
        assert.equal(mat.resolvedOcclusionMap, null);
        assert.equal(mat.resolvedMetallicRoughnessMap, null);
    });

    test("a packed ORM map feeds both occlusion and metallic-roughness", () => {
        const mat = new PBRMaterial();
        const orm = fakeTexture("orm");
        mat.ormMap = orm;
        assert.equal(mat.resolvedOcclusionMap, orm);
        assert.equal(mat.resolvedMetallicRoughnessMap, orm);
    });

    test("separate maps: metallic-roughness alone leaves occlusion at its default", () => {
        const mat = new PBRMaterial();
        const mr = fakeTexture("mr");
        mat.metallicRoughnessMap = mr;
        assert.equal(mat.resolvedMetallicRoughnessMap, mr);
        assert.equal(mat.resolvedOcclusionMap, null);
    });

    test("separate maps override the matching channels of an ORM map", () => {
        const mat = new PBRMaterial();
        const orm = fakeTexture("orm");
        const occlusion = fakeTexture("occlusion");
        mat.ormMap = orm;
        mat.occlusionMap = occlusion;
        assert.equal(mat.resolvedOcclusionMap, occlusion);
        assert.equal(mat.resolvedMetallicRoughnessMap, orm);
    });
});

describe("PBRMaterial — uniforms", () => {
    test("defaults", () => {
        const mat = new PBRMaterial();
        assert.equal(mat.normalScale, 1);
        assert.equal(mat.occlusionStrength, 1);
        const data = packMaterialUniforms(mat);
        assert.equal(data.byteLength, 256);
        assert.deepEqual(Array.from(data.subarray(0, 16)), [1, 1, 1, 1, 0.5, 0, 0, 1, 0, 0, 0, 0, 1, 0.5, 0, 0]);
        // every map untransformed: rows (1, 0, 0, uvSet 0) and (0, 1, 0, 0)
        for (let m = 0; m < 6; m++) {
            assert.deepEqual(Array.from(data.subarray(16 + m * 8, 24 + m * 8)), [1, 0, 0, 0, -0, 1, 0, 0]);
        }
    });

    test("packs a map's UV transform (translation · rotation · scale) and UV set", () => {
        const mat = new PBRMaterial();
        mat.normalMap = {transform: {offset: [0.25, 0.5], scale: [2, 3], rotation: Math.PI / 2, uvSet: 1}} as never;
        const t = Array.from(packMaterialUniforms(mat).subarray(24, 32)); // map 1: normal
        const r = (v: number) => Math.round(v * 1e6) / 1e6 + 0; // + 0: no -0
        assert.deepEqual(t.map(r), [0, 3, 0.25, 1, -2, 0, 0.5, 0]);
    });

    test("packs factors, normal scale and occlusion strength at their offsets", () => {
        const mat = new PBRMaterial({
            color: [0.25, 0.5, 0.75],
            roughness: 0.125,
            metallic: 0.875,
            emissive: [0.5, 0.25, 0],
            emissiveIntensity: 2,
            normalScale: 2,
            occlusionStrength: 0.5,
        });
        mat.heightScale = 0.0625;
        const data = packMaterialUniforms(mat);
        // colors are given in sRGB and packed as linear light
        const near = (actual: ArrayLike<number>, expected: number[]) =>
            expected.forEach((e, i) => assert.ok(Math.abs(actual[i]! - e) < 1e-6, `${i}: ${actual[i]} ≠ ${e}`));
        near(data.slice(0, 4), [srgbToLinear(0.25), srgbToLinear(0.5), srgbToLinear(0.75), 1]); // albedo
        assert.equal(data[4], 0.125); // roughness
        assert.equal(data[5], 0.875); // metallic
        assert.equal(data[6], 0.0625); // heightScale
        assert.equal(data[7], 2); // normalScale
        near(data.slice(8, 12), [srgbToLinear(0.5) * 2, srgbToLinear(0.25) * 2, 0, 0]); // emissive × intensity, linear
        assert.equal(data[12], 0.5); // occlusionStrength
    });
});
