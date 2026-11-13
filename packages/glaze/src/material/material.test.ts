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
        assert.equal(data.byteLength, 64);
        assert.deepEqual(Array.from(data), [1, 1, 1, 1, 0.5, 0, 0, 1, 0, 0, 0, 0, 1, 0.5, 0, 0]);
    });

    test("packs factors, normal scale and occlusion strength at their offsets", () => {
        const mat = new PBRMaterial({
            color: [0.25, 0.5, 0.75],
            roughness: 0.125,
            metallic: 0.875,
            emissive: [0.5, 0.25, 0, 1],
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
        near(data.slice(8, 12), [srgbToLinear(0.5), srgbToLinear(0.25), 0, 1]); // emissive
        assert.equal(data[12], 0.5); // occlusionStrength
    });
});
