import type {ColorRgb, ColorRgba} from "../color";
import type {Texture} from "../texture";

// ─── Base ─────────────────────────────────────────────────────────────────────

export abstract class Material {
    /** Unique type tag used for pipeline sharing. */
    abstract readonly type: string;

    /** Release GPU resources. */
    destroy(): void {}
}

// ─── PBRMaterial ──────────────────────────────────────────────────────────────

export interface PBRMaterialOptions {
    color?: ColorRgb;
    roughness?: number;
    metallic?: number;
    emissive?: ColorRgba;
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
    /** Render back faces too, lit from their own side. Default false. */
    doubleSided?: boolean;
}

/**
 * How a material's alpha (albedo map alpha × opacity) is used, after glTF's alphaMode:
 * - "opaque": ignored.
 * - "mask": a cutout: below alphaCutoff the surface is absent (leaves, lace, fences).
 * - "blend": see-through. The deferred pass dithers it (each pixel kept with probability alpha), a stable
 *   screen-door transparency that needs no sorting and still writes depth and shadows-free G-buffer data.
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
const MATERIAL_BUFFER_SIZE = 64;

/**
 * Pack the material's scalars into its uniform buffer layout (see above). GPU-free, exported for tests.
 * @internal
 */
export function packMaterialUniforms(mat: PBRMaterial, out = new Float32Array(MATERIAL_BUFFER_SIZE / 4)): Float32Array {
    out[0] = mat.color[0];
    out[1] = mat.color[1];
    out[2] = mat.color[2];
    out[3] = mat.opacity;
    out[4] = mat.roughness;
    out[5] = mat.metallic;
    out[6] = mat.heightScale;
    out[7] = mat.normalScale;
    out[8] = mat.emissive[0];
    out[9] = mat.emissive[1];
    out[10] = mat.emissive[2];
    out[11] = mat.emissive[3];
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
    emissive: ColorRgba;

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

    private buffer: GPUBuffer | null = null;
    private bindGroup: GPUBindGroup | null = null;
    private _boundMaps: (Texture | null)[] = [];
    private dirty = true;

    constructor({
        color = [1, 1, 1],
        roughness = 0.5,
        metallic = 0.0,
        emissive = [0, 0, 0, 0],
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

    /** Call after changing any scalar property to force a buffer update on the next render. */
    markDirty(): void {
        this.dirty = true;
    }

    getOrCreateBindGroup(
        device: GPUDevice,
        bindGroupLayout: GPUBindGroupLayout,
        defaultWhiteView: GPUTextureView,
        defaultNormalView: GPUTextureView,
        sampler: GPUSampler,
    ): GPUBindGroup {
        if (!this.buffer) {
            this.buffer = device.createBuffer({
                label: "PBRMaterial",
                size: MATERIAL_BUFFER_SIZE,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            });
            this.dirty = true;
        }

        if (this.dirty) {
            device.queue.writeBuffer(this.buffer, 0, packMaterialUniforms(this));
            this.dirty = false;
        }

        // Recreate bind group when any map changes.
        const metallicRoughness = this.resolvedMetallicRoughnessMap;
        const occlusion = this.resolvedOcclusionMap;
        const maps = [this.albedoMap, this.normalMap, this.emissiveMap, metallicRoughness, this.heightMap, occlusion];
        if (this._boundMaps.length !== maps.length || maps.some((map, i) => map !== this._boundMaps[i])) {
            this.bindGroup = null;
            this._boundMaps = maps;
        }

        if (!this.bindGroup) {
            this.bindGroup = device.createBindGroup({
                label: "PBRMaterial",
                layout: bindGroupLayout,
                entries: [
                    {binding: 0, resource: {buffer: this.buffer}},
                    {binding: 1, resource: this.albedoMap?.view ?? defaultWhiteView},
                    {binding: 2, resource: sampler},
                    {binding: 3, resource: this.normalMap?.view ?? defaultNormalView},
                    {binding: 4, resource: this.emissiveMap?.view ?? defaultWhiteView},
                    {binding: 5, resource: metallicRoughness?.view ?? defaultWhiteView},
                    {binding: 6, resource: this.heightMap?.view ?? defaultWhiteView},
                    {binding: 7, resource: occlusion?.view ?? defaultWhiteView},
                ],
            });
        }

        return this.bindGroup;
    }

    destroy(): void {
        this.buffer?.destroy();
        this.buffer = null;
        this.bindGroup = null;
        this._boundMaps = [];
    }
}

/** @deprecated Use PBRMaterial */
export const StandardMaterial = PBRMaterial;
/** @deprecated Use PBRMaterialOptions */
export type StandardMaterialOptions = PBRMaterialOptions;
