import {type ColorRgb, srgbToLinear} from "../color";
import type {Texture} from "../texture";

// ─── Base ─────────────────────────────────────────────────────────────────────

export abstract class Material {
    /** Unique type tag used for pipeline sharing. */
    abstract readonly type: string;
}

// ─── PBRMaterial ──────────────────────────────────────────────────────────────

export interface PBRMaterialOptions {
    color?: ColorRgb;
    roughness?: number;
    metallic?: number;
    /** Light the surface gives off, sRGB like `color` (black: none). */
    emissive?: ColorRgb;
    /** Multiplies {@link emissive} in linear light: 2 is twice the light, for glows above 1. Default 1. */
    emissiveIntensity?: number;
    /** Scales the tangent-space XY of the normal map (glTF `normalTexture.scale`). Default 1. */
    normalScale?: number;
    /** How much the occlusion map darkens ambient light, 0..1 (glTF `occlusionTexture.strength`). Default 1. */
    occlusionStrength?: number;
    /** Multiplies the albedo map's alpha (glTF baseColorFactor alpha). Default 1. */
    opacity?: number;
    /** How alpha is used. Default "opaque". */
    alphaMode?: AlphaMode;
    /** "mask": fragments with alpha below this are cut. Default 0.5. */
    alphaCutoff?: number;
    /** Render back faces too, lit from their own side (and cast shadows from both). Default false. */
    doubleSided?: boolean;
}

/**
 * How a material's alpha (albedo map alpha × opacity) is used, after glTF's alphaMode:
 * - "opaque": ignored.
 * - "mask": a cutout: below alphaCutoff the surface is absent (leaves, lace, fences).
 * - "blend": see-through (glass, fades, ghosts). Drawn after the lit scene, farthest mesh first, with the same
 *   lights, shadows and environment; it doesn't write depth, so see-through surfaces never hide each other.
 *   Sorting is per mesh, by its bounds' center: split a mesh that wraps around another. Double-sided ones draw
 *   their back faces, then their front faces.
 *
 * Shadows follow alpha too: "mask" casts the cut-out shape, "blend" a partial shadow as dense as its alpha.
 * Opaque casters keep the cheapest shadow pass (depth only).
 */
export type AlphaMode = "opaque" | "mask" | "blend";

/**
 * Uniform struct layout (std140, 64 bytes):
 *
 *   albedo:            vec4<f32>  offset  0  (16 bytes)
 *   roughness:         f32        offset 16  ( 4 bytes)
 *   metallic:          f32        offset 20  ( 4 bytes)
 *   heightScale:       f32        offset 24  ( 4 bytes)
 *   normalScale:       f32        offset 28  ( 4 bytes)
 *   emissive:          vec4<f32>  offset 32  (16 bytes)
 *   occlusionStrength: f32        offset 48  ( 4 bytes)
 *   alphaCutoff:       f32        offset 52  ( 4 bytes)
 *   _pad:              vec2<f32>  offset 56  ( 8 bytes)
 */
export const MATERIAL_BUFFER_SIZE = 64;

/**
 * Pack the material's scalars into its uniform buffer layout (see above). GPU-free, exported for tests.
 * @internal
 */
export function packMaterialUniforms(mat: PBRMaterial, out = new Float32Array(MATERIAL_BUFFER_SIZE / 4)): Float32Array {
    // colors are set in sRGB, lit in linear light
    out[0] = srgbToLinear(mat.color[0]);
    out[1] = srgbToLinear(mat.color[1]);
    out[2] = srgbToLinear(mat.color[2]);
    out[3] = mat.opacity;
    out[4] = mat.roughness;
    out[5] = mat.metallic;
    out[6] = mat.heightScale;
    out[7] = mat.normalScale;
    out[8] = srgbToLinear(mat.emissive[0]) * mat.emissiveIntensity;
    out[9] = srgbToLinear(mat.emissive[1]) * mat.emissiveIntensity;
    out[10] = srgbToLinear(mat.emissive[2]) * mat.emissiveIntensity;
    out[11] = 0;
    out[12] = mat.occlusionStrength;
    out[13] = mat.alphaCutoff;
    return out;
}

/**
 * Bind group bindings:
 *   0: uniform buffer (MaterialUniforms)
 *   1: albedoMap      texture_2d<f32>
 *   2: matSampler     sampler         (shared for all maps)
 *   3: normalMap      texture_2d<f32>
 *   4: emissiveMap    texture_2d<f32>
 *   5: metallicRoughness texture_2d<f32>  (G=roughness, B=metallic): metallicRoughnessMap ?? ormMap
 *   6: heightMap      texture_2d<f32>  (R=height 0=low 1=high)
 *   7: occlusion      texture_2d<f32>  (R=occlusion):                occlusionMap ?? ormMap
 *
 * All maps fall back to a neutral 1×1 default when null:
 *   albedoMap    → white  (multiplier 1, uses mat albedo as-is)
 *   emissiveMap  → white  (multiplier 1, uses mat emissive as-is)
 *   metallic-roughness → white (roughness scale=1, metallic scale=1)
 *   occlusion    → white  (AO=1)
 *   normalMap    → flat   [128,128,255,255] → (0,0,1) in tangent space
 *   heightMap    → white  (heightScale=0 guard disables POM when no map set)
 */
export class PBRMaterial extends Material {
    readonly type = "pbr";

    color: ColorRgb;
    roughness: number;
    metallic: number;
    emissive: ColorRgb;
    emissiveIntensity: number;

    albedoMap: Texture | null = null;
    normalMap: Texture | null = null;
    emissiveMap: Texture | null = null;
    /**
     * Packed occlusion-roughness-metallic: R=occlusion, G=roughness, B=metallic (glTF's packed layout).
     * Supplies both the occlusion and the metallic-roughness inputs unless a separate map overrides one.
     */
    ormMap: Texture | null = null;
    /**
     * glTF metallic-roughness map: G=roughness, B=metallic (R is ignored). Overrides {@link ormMap}'s G and B.
     * Multiplied by {@link roughness} and {@link metallic}.
     */
    metallicRoughnessMap: Texture | null = null;
    /** Ambient occlusion in R (1 = unoccluded). Overrides {@link ormMap}'s R; scaled by {@link occlusionStrength}. */
    occlusionMap: Texture | null = null;
    /** 0 ignores the occlusion map, 1 applies it fully. */
    occlusionStrength: number;
    /** Scales the normal map's tangent-space XY; 1 = as authored, 0 = flat. */
    normalScale: number;
    /** R=height (0=low, 1=high). Used for parallax occlusion mapping when heightScale > 0. */
    heightMap: Texture | null = null;
    heightScale: number = 0;
    /** Multiplies the albedo map's alpha. */
    opacity: number;
    alphaMode: AlphaMode;
    alphaCutoff: number;
    doubleSided: boolean;

    constructor({
        color = [1, 1, 1],
        roughness = 0.5,
        metallic = 0.0,
        emissive = [0, 0, 0],
        emissiveIntensity = 1,
        normalScale = 1,
        occlusionStrength = 1,
        opacity = 1,
        alphaMode = "opaque",
        alphaCutoff = 0.5,
        doubleSided = false,
    }: PBRMaterialOptions = {}) {
        super();
        this.color = color;
        this.roughness = roughness;
        this.metallic = metallic;
        this.emissive = emissive;
        this.emissiveIntensity = emissiveIntensity;
        this.normalScale = normalScale;
        this.occlusionStrength = occlusionStrength;
        this.opacity = opacity;
        this.alphaMode = alphaMode;
        this.alphaCutoff = alphaCutoff;
        this.doubleSided = doubleSided;
    }

    /** The texture sampled for roughness (G) and metallic (B): {@link metallicRoughnessMap}, else {@link ormMap}. */
    get resolvedMetallicRoughnessMap(): Texture | null {
        return this.metallicRoughnessMap ?? this.ormMap;
    }

    /** The texture sampled for occlusion (R): {@link occlusionMap}, else {@link ormMap}. */
    get resolvedOcclusionMap(): Texture | null {
        return this.occlusionMap ?? this.ormMap;
    }
}
