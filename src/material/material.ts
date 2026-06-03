import {ColorRgb, ColorRgba} from "../color";
import {Texture} from "../texture";

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
}

/**
 * Uniform struct layout (std140, 48 bytes):
 *
 *   albedo:      vec4<f32>  offset  0  (16 bytes)
 *   roughness:   f32        offset 16  ( 4 bytes)
 *   metallic:    f32        offset 20  ( 4 bytes)
 *   heightScale: f32        offset 24  ( 4 bytes)
 *   _pad1:       f32        offset 28  ( 4 bytes)
 *   emissive:    vec4<f32>  offset 32  (16 bytes)
 */
const MATERIAL_BUFFER_SIZE = 48;

/**
 * Bind group bindings:
 *   0: uniform buffer (MaterialUniforms)
 *   1: albedoMap      texture_2d<f32>
 *   2: matSampler     sampler         (shared for all maps)
 *   3: normalMap      texture_2d<f32>
 *   4: emissiveMap    texture_2d<f32>
 *   5: ormMap         texture_2d<f32>  (R=occlusion, G=roughness, B=metallic)
 *   6: heightMap      texture_2d<f32>  (R=height 0=low 1=high)
 *
 * All maps fall back to a neutral 1×1 default when null:
 *   albedoMap    → white  (multiplier 1, uses mat albedo as-is)
 *   emissiveMap  → white  (multiplier 1, uses mat emissive as-is)
 *   ormMap       → white  (AO=1, roughness scale=1, metallic scale=1)
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
    /** RGB packed: R=occlusion, G=roughness, B=metallic. */
    ormMap: Texture | null = null;
    /** R=height (0=low, 1=high). Used for parallax occlusion mapping when heightScale > 0. */
    heightMap: Texture | null = null;
    heightScale: number = 0;

    private buffer: GPUBuffer | null = null;
    private bindGroup: GPUBindGroup | null = null;
    private _boundMaps: [Texture | null, Texture | null, Texture | null, Texture | null, Texture | null] = [null, null, null, null, null];
    private dirty = true;

    constructor({
        color = [1, 1, 1],
        roughness = 0.5,
        metallic = 0.0,
        emissive = [0, 0, 0, 0],
    }: PBRMaterialOptions = {}) {
        super();
        this.color = color;
        this.roughness = roughness;
        this.metallic = metallic;
        this.emissive = emissive;
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
            const data = new Float32Array(MATERIAL_BUFFER_SIZE / 4);
            data[0] = this.color[0];
            data[1] = this.color[1];
            data[2] = this.color[2];
            data[3] = 1.0;
            data[4] = this.roughness;
            data[5] = this.metallic;
            data[6] = this.heightScale;
            // data[7] = padding
            data[8]  = this.emissive[0];
            data[9]  = this.emissive[1];
            data[10] = this.emissive[2];
            data[11] = this.emissive[3];
            device.queue.writeBuffer(this.buffer, 0, data);
            this.dirty = false;
        }

        // Recreate bind group when any map changes.
        const maps: [Texture | null, Texture | null, Texture | null, Texture | null, Texture | null] = [
            this.albedoMap, this.normalMap, this.emissiveMap, this.ormMap, this.heightMap,
        ];
        if (
            maps[0] !== this._boundMaps[0] ||
            maps[1] !== this._boundMaps[1] ||
            maps[2] !== this._boundMaps[2] ||
            maps[3] !== this._boundMaps[3] ||
            maps[4] !== this._boundMaps[4]
        ) {
            this.bindGroup = null;
            this._boundMaps = [...maps];
        }

        if (!this.bindGroup) {
            this.bindGroup = device.createBindGroup({
                label: "PBRMaterial",
                layout: bindGroupLayout,
                entries: [
                    {binding: 0, resource: {buffer: this.buffer}},
                    {binding: 1, resource: this.albedoMap?.view   ?? defaultWhiteView},
                    {binding: 2, resource: sampler},
                    {binding: 3, resource: this.normalMap?.view   ?? defaultNormalView},
                    {binding: 4, resource: this.emissiveMap?.view ?? defaultWhiteView},
                    {binding: 5, resource: this.ormMap?.view      ?? defaultWhiteView},
                    {binding: 6, resource: this.heightMap?.view   ?? defaultWhiteView},
                ],
            });
        }

        return this.bindGroup;
    }

    destroy(): void {
        this.buffer?.destroy();
        this.buffer = null;
        this.bindGroup = null;
        this._boundMaps = [null, null, null, null, null];
    }
}

/** @deprecated Use PBRMaterial */
export const StandardMaterial = PBRMaterial;
/** @deprecated Use PBRMaterialOptions */
export type StandardMaterialOptions = PBRMaterialOptions;
