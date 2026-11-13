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
    /** Half-float pixels (from `fromFloat32` / `fromHDR`): values above 1, already linear light. */
    readonly hdr: boolean;
    private readonly tex: GPUTexture;

    private constructor(tex: GPUTexture, colorSpace: ColorSpace) {
        this.tex = tex;
        this.width = tex.width;
        this.height = tex.height;
        this.hdr = tex.format === HDR_FORMAT;
        this.colorSpace = this.hdr ? "linear-srgb" : colorSpace;
        this.view = tex.createView();
        // half floats hold linear light already: both views read them as they are
        this.srgbView = this.hdr ? this.view : tex.createView({format: SRGB_FORMAT});
    }

    /** The GPU texture (for passes that process it, like an environment's prefiltering). */
    get texture(): GPUTexture {
        return this.tex;
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

    /**
     * An HDR texture from linear float RGBA (4 floats a pixel), stored as half floats: environments and skies
     * brighter than 1 (a sun in the sky lights like one). Mip levels are generated.
     */
    static fromFloat32(
        device: GPUDevice,
        data: Float32Array,
        width: number,
        height: number,
        {mipmaps = true}: Pick<TextureOptions, "mipmaps"> = {},
    ): Texture {
        const tex = device.createTexture({
            size: {width, height},
            format: HDR_FORMAT,
            mipLevelCount: mipmaps ? mipLevelCount(width, height) : 1,
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        });
        const half = new Uint16Array(width * height * 4);
        for (let i = 0; i < half.length; i++) {
            half[i] = toHalf(data[i] ?? 0);
        }
        device.queue.writeTexture({texture: tex}, half, {bytesPerRow: width * 8}, {width, height});
        generateMipmaps(device, tex, "linear-srgb");
        return new Texture(tex, "linear-srgb");
    }

    /** A Radiance `.hdr` (RGBE) image as an HDR texture: the usual format for environment maps. */
    static async fromHDR(
        device: GPUDevice,
        url: string,
        options: Pick<TextureOptions, "mipmaps"> = {},
    ): Promise<Texture> {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Texture: failed to fetch '${url}' (${response.status})`);
        }
        const {data, width, height} = parseRGBE(await response.arrayBuffer());
        return Texture.fromFloat32(device, data, width, height, options);
    }

    static async fromURL(device: GPUDevice, url: string, options: TextureOptions = {}): Promise<Texture> {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Texture: failed to fetch '${url}' (${response.status})`);
        }
        return Texture.fromBlob(device, await response.blob(), options);
    }

    static async fromBlob(device: GPUDevice, blob: Blob, options: TextureOptions = {}): Promise<Texture> {
        // Pixels as stored: no color-space conversion or premultiplication (normal and ORM maps are data). An image
        // larger than the GPU allows is scaled down to fit.
        const max = device.limits.maxTextureDimension2D;
        let bitmap = await createImageBitmap(blob, {colorSpaceConversion: "none", premultiplyAlpha: "none"});
        if (bitmap.width > max || bitmap.height > max) {
            const scale = max / Math.max(bitmap.width, bitmap.height);
            const resized = await createImageBitmap(bitmap, {
                colorSpaceConversion: "none",
                premultiplyAlpha: "none",
                resizeWidth: Math.max(1, Math.floor(bitmap.width * scale)),
                resizeHeight: Math.max(1, Math.floor(bitmap.height * scale)),
                resizeQuality: "high",
            });
            bitmap.close();
            bitmap = resized;
        }
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
const HDR_FORMAT = "rgba16float";

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** A float's IEEE half bits (round to nearest; overflow to infinity, tiny values to subnormals or zero). */
export function toHalf(value: number): number {
    f32[0] = value;
    const x = u32[0]!;
    const sign = (x >>> 16) & 0x8000;
    const exponent = ((x >>> 23) & 0xff) - 127 + 15;
    let mantissa = x & 0x7fffff;
    if (((x >>> 23) & 0xff) === 0xff) {
        return sign | 0x7c00 | (mantissa !== 0 ? 0x200 : 0); // inf / NaN
    }
    if (exponent >= 0x1f) {
        return sign | 0x7c00;
    }
    if (exponent <= 0) {
        if (exponent < -10) {
            return sign;
        }
        mantissa |= 0x800000;
        const shift = 14 - exponent;
        return sign | ((mantissa + (1 << (shift - 1))) >>> shift);
    }
    const half = sign | (exponent << 10) | (mantissa >>> 13);
    return half + ((mantissa >>> 12) & 1); // round (a carry into the exponent is still correct)
}

/** Decodes a Radiance .hdr file (RGBE, flat or run-length encoded scanlines) to linear float RGBA, top row first. */
export function parseRGBE(buffer: ArrayBuffer): {data: Float32Array; width: number; height: number} {
    const bytes = new Uint8Array(buffer);
    let pos = 0;
    const line = (): string => {
        let s = "";
        while (pos < bytes.length && bytes[pos] !== 0x0a) {
            s += String.fromCharCode(bytes[pos++]!);
        }
        pos++;
        return s;
    };
    if (!line().startsWith("#?")) {
        throw new Error("HDR: not a Radiance file");
    }
    for (let l = line(); l !== ""; l = line()) {
        if (l.startsWith("FORMAT=") && l !== "FORMAT=32-bit_rle_rgbe") {
            throw new Error(`HDR: unsupported ${l}`);
        }
    }
    const size = /^-Y (\d+) \+X (\d+)$/.exec(line().trim());
    if (size === null) {
        throw new Error("HDR: only -Y H +X W images are supported");
    }
    const height = Number(size[1]);
    const width = Number(size[2]);
    const data = new Float32Array(width * height * 4);
    const scan = new Uint8Array(width * 4);
    for (let y = 0; y < height; y++) {
        const rle =
            width >= 8 && width < 0x8000 && bytes[pos] === 2 && bytes[pos + 1] === 2 && (bytes[pos + 2]! & 0x80) === 0;
        if (rle) {
            pos += 4;
            for (let c = 0; c < 4; c++) {
                for (let x = 0; x < width;) {
                    let count = bytes[pos++]!;
                    if (count > 128) {
                        count -= 128;
                        const v = bytes[pos++]!;
                        for (let k = 0; k < count; k++) {
                            scan[x++ * 4 + c] = v;
                        }
                    } else {
                        for (let k = 0; k < count; k++) {
                            scan[x++ * 4 + c] = bytes[pos++]!;
                        }
                    }
                }
            }
        } else {
            scan.set(bytes.subarray(pos, pos + width * 4));
            pos += width * 4;
        }
        for (let x = 0; x < width; x++) {
            const e = scan[x * 4 + 3]!;
            const f = e === 0 ? 0 : Math.pow(2, e - 136); // 2^(e - 128) / 256
            const o = (y * width + x) * 4;
            data[o] = scan[x * 4]! * f;
            data[o + 1] = scan[x * 4 + 1]! * f;
            data[o + 2] = scan[x * 4 + 2]! * f;
            data[o + 3] = 1;
        }
    }
    return {data, width, height};
}

function createTexture(device: GPUDevice, width: number, height: number, {mipmaps = true}: TextureOptions): GPUTexture {
    return device.createTexture({
        size: {width, height},
        format: "rgba8unorm",
        viewFormats: [SRGB_FORMAT],
        mipLevelCount: mipmaps ? mipLevelCount(width, height) : 1,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
}

// ─── Mip generation: each level a box-filtered downsample of the one above ─────

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

// The source texels under this one, weighted by overlap (3 per axis when the source size is odd: no row or column
// is dropped), averaged with premultiplied alpha: a see-through texel's color doesn't bleed into its neighbours.
@fragment fn fs(in: VsOut) -> @location(0) vec4<f32> {
    let srcSize = vec2<f32>(textureDimensions(src));
    let dstSize = max(floor(srcSize * 0.5), vec2<f32>(1.0));
    let scale   = srcSize / dstSize;
    let lo      = floor(in.pos.xy) * scale; // this texel's footprint in the source: [lo, lo + scale)
    var sum   = vec4<f32>(0.0);
    var plain = vec3<f32>(0.0);
    var total = 0.0;
    for (var j = 0; j < 3; j++) {
        for (var i = 0; i < 3; i++) {
            let texel = floor(lo) + vec2<f32>(f32(i), f32(j));
            let overlap = clamp(min(texel + 1.0, lo + scale) - max(texel, lo), vec2<f32>(0.0), vec2<f32>(1.0));
            let w = overlap.x * overlap.y;
            if (w > 0.0) {
                let c = textureLoad(src, vec2<i32>(min(texel, srcSize - 1.0)), 0);
                sum   += vec4<f32>(c.rgb * c.a, c.a) * w;
                plain += c.rgb * w;
                total += w;
            }
        }
    }
    let alpha = sum.a / total;
    // fully transparent: keep the plain average (nothing to weight by)
    let rgb = select(plain / total, sum.rgb / max(sum.a, 1e-6), sum.a > 1e-6);
    return vec4<f32>(rgb, alpha);
}
`;

type MipFormat = "rgba8unorm" | typeof SRGB_FORMAT | typeof HDR_FORMAT;
const mipPipelines = new WeakMap<GPUDevice, Map<MipFormat, {pipeline: GPURenderPipeline}>>();

/**
 * Fills levels 1… of an rgba8unorm texture from level 0 (no-op for a single level). For `"srgb"` (default) the
 * texture must allow `rgba8unorm-srgb` views: levels are filtered in linear light, so they don't darken.
 */
export function generateMipmaps(device: GPUDevice, texture: GPUTexture, colorSpace: ColorSpace = "srgb"): void {
    if (texture.mipLevelCount <= 1) {
        return;
    }
    const format: MipFormat =
        texture.format === HDR_FORMAT ? HDR_FORMAT : colorSpace === "srgb" ? SRGB_FORMAT : "rgba8unorm";
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
        };
        perFormat.set(format, cached);
    }
    const {pipeline} = cached;
    const encoder = device.createCommandEncoder({label: "Texture:mipmaps"});
    for (let level = 1; level < texture.mipLevelCount; level++) {
        const bindGroup = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [{binding: 0, resource: texture.createView({format, baseMipLevel: level - 1, mipLevelCount: 1})}],
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
