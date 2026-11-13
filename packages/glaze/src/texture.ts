import type {ColorSpace} from "./color";

export interface TextureOptions {
    /**
     * Build a full mip chain (default true): textures seen small or at a slant are filtered instead of shimmering.
     * Off for data you sample exactly (lookup tables, pixel art).
     */
    mipmaps?: boolean;
    /**
     * What the pixels hold (default `"srgb"`): colors, as images store them. `"linear-srgb"` for data (normal,
     * roughness / metallic, occlusion, height maps): mip levels average the stored values instead of light.
     * Either way the texture has both views: {@link Texture.view} reads the stored values, {@link Texture.srgbView}
     * decodes sRGB to linear as it samples.
     */
    colorSpace?: ColorSpace;
}

/** Number of mip levels down to 1 x 1. */
export function mipLevelCount(width: number, height: number): number {
    return Math.floor(Math.log2(Math.max(width, height, 1))) + 1;
}

/**
 * An RGBA8 texture for materials and environments, uploaded once. Mip levels are generated on the GPU.
 */
export class Texture {
    /** The stored values (data maps). */
    readonly view: GPUTextureView;
    /** The same pixels decoded from sRGB to linear light as they are sampled (albedo, emissive, environments). */
    readonly srgbView: GPUTextureView;
    readonly width: number;
    readonly height: number;
    readonly colorSpace: ColorSpace;
    private readonly tex: GPUTexture;

    private constructor(tex: GPUTexture, colorSpace: ColorSpace) {
        this.tex = tex;
        this.width = tex.width;
        this.height = tex.height;
        this.colorSpace = colorSpace;
        this.view = tex.createView();
        this.srgbView = tex.createView({format: SRGB_FORMAT});
    }

    get mipLevelCount(): number {
        return this.tex.mipLevelCount;
    }

    static fromPixels(
        device: GPUDevice,
        data: Uint8Array,
        width: number,
        height: number,
        options: TextureOptions = {},
    ): Texture {
        const tex = createTexture(device, width, height, options);
        device.queue.writeTexture({texture: tex}, data, {bytesPerRow: width * 4}, {width, height});
        generateMipmaps(device, tex, options.colorSpace);
        return new Texture(tex, options.colorSpace ?? "srgb");
    }

    static async fromURL(device: GPUDevice, url: string, options: TextureOptions = {}): Promise<Texture> {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Texture: failed to fetch '${url}' (${response.status})`);
        }
        return Texture.fromBlob(device, await response.blob(), options);
    }

    static async fromBlob(device: GPUDevice, blob: Blob, options: TextureOptions = {}): Promise<Texture> {
        // Pixels as stored: no color-space conversion or premultiplication (normal and ORM maps are data).
        const bitmap = await createImageBitmap(blob, {colorSpaceConversion: "none", premultiplyAlpha: "none"});
        const tex = createTexture(device, bitmap.width, bitmap.height, options);
        device.queue.copyExternalImageToTexture(
            {source: bitmap},
            {texture: tex},
            {width: bitmap.width, height: bitmap.height},
        );
        bitmap.close();
        generateMipmaps(device, tex, options.colorSpace);
        return new Texture(tex, options.colorSpace ?? "srgb");
    }

    destroy(): void {
        this.tex.destroy();
    }
}

const SRGB_FORMAT = "rgba8unorm-srgb";

function createTexture(device: GPUDevice, width: number, height: number, {mipmaps = true}: TextureOptions): GPUTexture {
    return device.createTexture({
        size: {width, height},
        format: "rgba8unorm",
        viewFormats: [SRGB_FORMAT],
        mipLevelCount: mipmaps ? mipLevelCount(width, height) : 1,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
}

// ─── Mip generation: each level is a linear downsample of the one above ───────

const MIP_SHADER = /* wgsl */ `
struct VsOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };

@vertex fn vs(@builtin(vertex_index) i: u32) -> VsOut {
    let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
    var out: VsOut;
    out.pos = vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
    out.uv = vec2<f32>(p.x, 1.0 - p.y);
    return out;
}

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;

@fragment fn fs(in: VsOut) -> @location(0) vec4<f32> {
    return textureSampleLevel(src, smp, in.uv, 0.0);
}
`;

type MipFormat = "rgba8unorm" | typeof SRGB_FORMAT;
const mipPipelines = new WeakMap<GPUDevice, Map<MipFormat, {pipeline: GPURenderPipeline; sampler: GPUSampler}>>();

/**
 * Fills levels 1… of an rgba8unorm texture from level 0 (no-op for a single level). For `"srgb"` (default) the
 * texture must allow `rgba8unorm-srgb` views: levels are filtered in linear light, so they don't darken.
 */
export function generateMipmaps(device: GPUDevice, texture: GPUTexture, colorSpace: ColorSpace = "srgb"): void {
    if (texture.mipLevelCount <= 1) {
        return;
    }
    const format: MipFormat = colorSpace === "srgb" ? SRGB_FORMAT : "rgba8unorm";
    let perFormat = mipPipelines.get(device);
    if (perFormat === undefined) {
        perFormat = new Map();
        mipPipelines.set(device, perFormat);
    }
    let cached = perFormat.get(format);
    if (cached === undefined) {
        const module = device.createShaderModule({label: "Texture:mipmaps", code: MIP_SHADER});
        cached = {
            pipeline: device.createRenderPipeline({
                label: `Texture:mipmaps:${format}`,
                layout: "auto",
                vertex: {module, entryPoint: "vs"},
                fragment: {module, entryPoint: "fs", targets: [{format}]},
                primitive: {topology: "triangle-list"},
            }),
            sampler: device.createSampler({minFilter: "linear", magFilter: "linear"}),
        };
        perFormat.set(format, cached);
    }
    const {pipeline, sampler} = cached;
    const encoder = device.createCommandEncoder({label: "Texture:mipmaps"});
    for (let level = 1; level < texture.mipLevelCount; level++) {
        const bindGroup = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
                {binding: 0, resource: texture.createView({format, baseMipLevel: level - 1, mipLevelCount: 1})},
                {binding: 1, resource: sampler},
            ],
        });
        const pass = encoder.beginRenderPass({
            colorAttachments: [
                {
                    view: texture.createView({format, baseMipLevel: level, mipLevelCount: 1}),
                    loadOp: "clear",
                    storeOp: "store",
                },
            ],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.draw(3);
        pass.end();
    }
    device.queue.submit([encoder.finish()]);
}
