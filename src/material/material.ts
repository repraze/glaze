import {ColorRgb, ColorRgba} from "../color";
import {Texture} from "../texture";

// ─── Base ─────────────────────────────────────────────────────────────────────

export abstract class Material {
    /** Unique type tag used for pipeline sharing. */
    abstract readonly type: string;

    /** Release GPU resources. */
    destroy(): void {}
}

// ─── StandardMaterial ────────────────────────────────────────────────────────

export interface StandardMaterialOptions {
    color?: ColorRgb;
    roughness?: number;
    metallic?: number;
    emissive?: ColorRgba;
}

/**
 * Uniform struct layout (std140):
 *
 *   albedo:    vec4<f32>  offset  0  (16 bytes)
 *   roughness: f32        offset 16  ( 4 bytes)
 *   metallic:  f32        offset 20  ( 4 bytes)
 *   _pad:      vec2<f32>  offset 24  ( 8 bytes)  — padding to align emissive
 *   emissive:  vec4<f32>  offset 32  (16 bytes)
 *   Total: 48 bytes
 */
const MATERIAL_BUFFER_SIZE = 48;

export class StandardMaterial extends Material {
    readonly type = "standard";

    color: ColorRgb;
    roughness: number;
    metallic: number;
    emissive: ColorRgba;
    albedoMap: Texture | null = null;

    private buffer: GPUBuffer | null = null;
    private bindGroup: GPUBindGroup | null = null;
    private _boundAlbedoMap: Texture | null = null;
    private dirty = true;

    constructor({
        color = [1, 1, 1],
        roughness = 0.5,
        metallic = 0.0,
        emissive = [0, 0, 0, 0],
    }: StandardMaterialOptions = {}) {
        super();
        this.color = color;
        this.roughness = roughness;
        this.metallic = metallic;
        this.emissive = emissive;
    }

    /** Call after changing any property to force a buffer update on the next render. */
    markDirty(): void {
        this.dirty = true;
    }

    getOrCreateBindGroup(
        device: GPUDevice,
        bindGroupLayout: GPUBindGroupLayout,
        defaultAlbedoView: GPUTextureView,
        sampler: GPUSampler,
    ): GPUBindGroup {
        if (!this.buffer) {
            this.buffer = device.createBuffer({
                label: "StandardMaterial",
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
            // data[6], data[7] = padding
            data[8] = this.emissive[0];
            data[9] = this.emissive[1];
            data[10] = this.emissive[2];
            data[11] = this.emissive[3];
            device.queue.writeBuffer(this.buffer, 0, data);
            this.dirty = false;
        }

        // Recreate bind group when albedoMap changes.
        if (this.albedoMap !== this._boundAlbedoMap) {
            this.bindGroup = null;
            this._boundAlbedoMap = this.albedoMap;
        }

        if (!this.bindGroup) {
            const albedoView = this.albedoMap?.view ?? defaultAlbedoView;
            this.bindGroup = device.createBindGroup({
                label: "StandardMaterial",
                layout: bindGroupLayout,
                entries: [
                    { binding: 0, resource: { buffer: this.buffer } },
                    { binding: 1, resource: albedoView },
                    { binding: 2, resource: sampler },
                ],
            });
        }

        return this.bindGroup;
    }

    destroy(): void {
        this.buffer?.destroy();
        this.buffer = null;
        this.bindGroup = null;
        this._boundAlbedoMap = null;
    }
}
