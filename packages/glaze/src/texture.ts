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

/** What happens past a texture's edge: tile, stretch the edge texels, or tile mirrored. */
export type WrapMode = "repeat" | "clamp" | "mirror";
/** How texels blend: smoothly, or the nearest one (pixel art). */
export type FilterMode = "linear" | "nearest";

/** How a texture is sampled. Change the fields any time; the next frame uses them. */
export interface TextureSampling {
    wrapU: WrapMode;
    wrapV: WrapMode;
    /** Up close (magnified). Default "linear". */
    magFilter: FilterMode;
    /** Far away (minified), and between mip levels. Default "linear". */
    minFilter: FilterMode;
    /** Anisotropic filtering, 1 to 16 (sharper at a slant). Default 8; only with linear filters. */
    anisotropy: number;
}

/**
 * Where a material samples a texture (glTF's KHR_texture_transform and texCoord): which UV set, then scaled,
 * rotated (radians, counter-clockwise) and offset, in that order. Change the fields any time.
 */
export interface UvTransform {
    offset: [number, number];
    scale: [number, number];
    rotation: number;
    /** 0: the geometry's `uvs`, 1: its `uvs1` (the first set when it has none). */
    uvSet: 0 | 1;
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
    /** Wrap and filter modes (default: repeat, linear, anisotropy 8). */
    sampling: TextureSampling = {
        wrapU: "repeat",
        wrapV: "repeat",
        magFilter: "linear",
        minFilter: "linear",
        anisotropy: 8,
    };
    /** Which UV set and how it is transformed (default: the first set, untransformed). */
    transform: UvTransform = {offset: [0, 0], scale: [1, 1], rotation: 0, uvSet: 0};
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

    /**
     * Another Texture on the same pixels, with its own sampling and transform (as glTF materials use one image
     * several ways). Destroying either destroys the pixels both read.
     */
    withSettings({
        sampling,
        transform,
    }: {
        sampling?: Partial<TextureSampling>;
        transform?: Partial<UvTransform>;
    }): Texture {
        const copy = new Texture(this.tex, this.colorSpace);
        copy.sampling = {...this.sampling, ...sampling};
        copy.transform = {...this.transform, ...transform};
        return copy;
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
