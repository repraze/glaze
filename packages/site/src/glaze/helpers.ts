import {
    createCone,
    createCube,
    createCylinder,
    createIcosphere,
    createPlane,
    createSphere,
    createTorus,
    type Entity,
    type Geometry,
    Texture,
} from "@repraze/glaze";
import {ACCENTS} from "@repraze/termicolor";
import {vec3} from "gl-matrix";

import {makeEnvCity, makeEnvPlane, makeEnvSky, makeEnvStudio} from "./environments";
import {
    makeBrickAlbedo,
    makeBrickHeight,
    makeBrickNormals,
    makeBrickOrm,
    makeTilesAlbedo,
    makeTilesHeight,
    makeTilesNormals,
    makeTilesOrm,
    makeTreadAlbedo,
    makeTreadHeight,
    makeTreadNormals,
    makeTreadOrm,
    makeWoodAlbedo,
    makeWoodHeight,
    makeWoodNormals,
    makeWoodOrm,
} from "./textures";

// ─── Shapes ───────────────────────────────────────────────────────────────────

export type ShapeKind = "cube" | "sphere" | "icosphere" | "torus" | "cone" | "cylinder" | "plane";

export const SHAPES: {value: ShapeKind; label: string}[] = [
    {value: "sphere", label: "Sphere"},
    {value: "icosphere", label: "Icosphere"},
    {value: "cube", label: "Cube"},
    {value: "torus", label: "Torus"},
    {value: "cone", label: "Cone"},
    {value: "cylinder", label: "Cylinder"},
    {value: "plane", label: "Plane"},
];

/** The lab's demo shapes, sized to sit in a unit view. Flat shading drops the segment counts. */
export function makeShape(kind: ShapeKind, flat = false): Geometry {
    switch (kind) {
        case "cube":
            return createCube({size: 1.2, flat});
        case "sphere":
            return createSphere({radius: 0.9, widthSegments: flat ? 12 : 48, heightSegments: flat ? 8 : 24, flat});
        case "icosphere":
            return createIcosphere({radius: 0.9, subdivisions: flat ? 1 : 4, flat});
        case "torus":
            return createTorus({
                radius: 0.8,
                tube: 0.3,
                radialSegments: flat ? 8 : 48,
                tubularSegments: flat ? 24 : 96,
                flat,
            });
        case "cone":
            return createCone({radius: 0.9, height: 1.6, radialSegments: flat ? 8 : 48, flat});
        case "cylinder":
            return createCylinder({
                radiusTop: 0.7,
                radiusBottom: 0.7,
                height: 1.5,
                radialSegments: flat ? 8 : 48,
                flat,
            });
        case "plane":
            return createPlane({width: 2, height: 2, widthSegments: 8, heightSegments: 8, flat});
    }
}

// ─── Camera ───────────────────────────────────────────────────────────────────

/** Place an entity (usually the camera) on a sphere around `target`, looking at it. Angles in degrees. */
export function orbit(
    entity: Entity,
    {
        distance,
        elevation = 20,
        azimuth = 0,
        target = [0, 0, 0],
    }: {distance: number; elevation?: number; azimuth?: number; target?: [number, number, number]},
): void {
    const el = (elevation * Math.PI) / 180;
    const az = (azimuth * Math.PI) / 180;
    vec3.set(
        entity.position,
        target[0] + distance * Math.cos(el) * Math.sin(az),
        target[1] + distance * Math.sin(el),
        target[2] + distance * Math.cos(el) * Math.cos(az),
    );
    entity.lookAt(target);
}

// ─── Colors ───────────────────────────────────────────────────────────────────

/** TermiColor's hues, for pickers (resolve them per mode with SceneColors.hues). */
export const HUE_OPTIONS = ACCENTS.map((value) => ({value, label: value[0]!.toUpperCase() + value.slice(1)}));

// ─── Textures ─────────────────────────────────────────────────────────────────

export type TextureSetId = "none" | "brick" | "tiles" | "wood" | "tread";

export const TEXTURE_SETS: {value: TextureSetId; label: string}[] = [
    {value: "none", label: "None"},
    {value: "brick", label: "Brick"},
    {value: "tiles", label: "Tiles"},
    {value: "wood", label: "Wood"},
    {value: "tread", label: "Tread plate"},
];

export interface PbrTextureSet {
    albedo: Texture;
    normal: Texture;
    orm: Texture;
    height: Texture;
}

/** The lab's four procedural PBR sets, 256×256, uploaded once. */
export function makeTextureSets(device: GPUDevice, size = 256): Map<TextureSetId, PbrTextureSet> {
    const up = (data: Uint8Array) => Texture.fromPixels(device, data, size, size);
    return new Map<TextureSetId, PbrTextureSet>([
        [
            "brick",
            {
                albedo: up(makeBrickAlbedo(size)),
                normal: up(makeBrickNormals(size)),
                orm: up(makeBrickOrm(size)),
                height: up(makeBrickHeight(size)),
            },
        ],
        [
            "tiles",
            {
                albedo: up(makeTilesAlbedo(size)),
                normal: up(makeTilesNormals(size)),
                orm: up(makeTilesOrm(size)),
                height: up(makeTilesHeight(size)),
            },
        ],
        [
            "wood",
            {
                albedo: up(makeWoodAlbedo(size)),
                normal: up(makeWoodNormals(size)),
                orm: up(makeWoodOrm(size)),
                height: up(makeWoodHeight(size)),
            },
        ],
        [
            "tread",
            {
                albedo: up(makeTreadAlbedo(size)),
                normal: up(makeTreadNormals(size)),
                orm: up(makeTreadOrm(size)),
                height: up(makeTreadHeight(size)),
            },
        ],
    ]);
}

export type EnvironmentId = "none" | "sky" | "plane" | "city" | "studio";

export const ENVIRONMENTS: {value: EnvironmentId; label: string}[] = [
    {value: "none", label: "None"},
    {value: "sky", label: "Sky"},
    {value: "plane", label: "Field"},
    {value: "city", label: "City"},
    {value: "studio", label: "Studio"},
];

/** The lab's equirectangular gradients (256×128), plus a warm studio, for `scene.environmentMap` / `backgroundMap`. */
export function makeEnvironments(device: GPUDevice): Map<EnvironmentId, Texture> {
    const w = 256;
    const h = 128;
    const up = (data: Uint8Array) => Texture.fromPixels(device, data, w, h);
    return new Map<EnvironmentId, Texture>([
        ["sky", up(makeEnvSky(w, h))],
        ["plane", up(makeEnvPlane(w, h))],
        ["city", up(makeEnvCity(w, h))],
        ["studio", up(makeEnvStudio(w, h))],
    ]);
}

export type PatternId = "checker" | "grid" | "stripes";

/** Greyscale test patterns (the dithering lab's): checkerboard, grid lines, stripes. RGBA8, size×size. */
export function makePattern(id: PatternId, size = 128): Uint8Array {
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const i = (y * size + x) * 4;
            const v =
                id === "checker"
                    ? (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0
                        ? 220
                        : 40
                    : id === "grid"
                      ? x % 16 === 0 || y % 16 === 0
                          ? 200
                          : 30
                      : Math.floor(y / 8) % 2 === 0
                        ? 200
                        : 60;
            data[i] = data[i + 1] = data[i + 2] = v;
            data[i + 3] = 255;
        }
    }
    return data;
}
