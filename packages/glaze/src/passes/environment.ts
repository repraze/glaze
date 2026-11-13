import type {Texture} from "../texture";

/** Levels of the prefiltered specular map: level i holds roughness i / (levels - 1). */
export const ENV_SPECULAR_LEVELS = 6;
const SPECULAR_WIDTH = 256;
const IRRADIANCE_WIDTH = 32;

/** An environment map ready for image-based lighting: blurred per roughness, and its diffuse irradiance. */
export interface PrefilteredEnvironment {
    /** Equirectangular, rgba16float, ENV_SPECULAR_LEVELS mips: sample at roughness · (levels - 1). */
    readonly specular: GPUTextureView;
    /** Equirectangular, rgba16float: the cosine-weighted average of the light around each normal (E / π). */
    readonly irradiance: GPUTextureView;
    destroy(): void;
}

const COMMON_WGSL = /* wgsl */ `
const PI: f32 = 3.14159265;

struct VsOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };

@vertex fn vs(@builtin(vertex_index) i: u32) -> VsOut {
    let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
    var out: VsOut;
    out.pos = vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
    out.uv  = vec2<f32>(p.x, 1.0 - p.y);
    return out;
}

struct Params {
    roughness:   f32,
    samples:     f32,
    sourceSize:  vec2<f32>,
    targetWidth: f32,
};

@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
@group(0) @binding(2) var<uniform> params: Params;

// the scene pass's equirect mapping (sampleEquirect) and its inverse
fn toUv(dir: vec3<f32>) -> vec2<f32> {
    let phi   = atan2(dir.z, dir.x);
    let theta = asin(clamp(dir.y, -1.0, 1.0));
    return vec2<f32>(phi / (2.0 * PI) + 0.5, 0.5 - theta / PI);
}

fn toDir(uv: vec2<f32>) -> vec3<f32> {
    let phi   = (uv.x - 0.5) * 2.0 * PI;
    let theta = (0.5 - uv.y) * PI;
    return vec3<f32>(cos(theta) * cos(phi), sin(theta), cos(theta) * sin(phi));
}

fn hammersley(i: u32, n: u32) -> vec2<f32> {
    var bits = (i << 16u) | (i >> 16u);
    bits = ((bits & 0x55555555u) << 1u) | ((bits & 0xAAAAAAAAu) >> 1u);
    bits = ((bits & 0x33333333u) << 2u) | ((bits & 0xCCCCCCCCu) >> 2u);
    bits = ((bits & 0x0F0F0F0Fu) << 4u) | ((bits & 0xF0F0F0F0u) >> 4u);
    bits = ((bits & 0x00FF00FFu) << 8u) | ((bits & 0xFF00FF00u) >> 8u);
    return vec2<f32>(f32(i) / f32(n), f32(bits) * 2.3283064365386963e-10);
}

fn basis(n: vec3<f32>) -> mat3x3<f32> {
    let up = select(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 1.0, 0.0), abs(n.y) < 0.999);
    let t  = normalize(cross(up, n));
    return mat3x3<f32>(t, cross(n, t), n);
}

// the solid angle one source texel covers, on average over the equirect
fn texelSolidAngle() -> f32 {
    return 4.0 * PI / (params.sourceSize.x * params.sourceSize.y);
}
`;

/** Specular: GGX-filtered, importance sampled with the mip that matches each sample's footprint (Karis 2013). */
const SPECULAR_WGSL = /* wgsl */ `
${COMMON_WGSL}

fn distributionGGX(NdotH: f32, a: f32) -> f32 {
    let a2 = a * a;
    let d  = NdotH * NdotH * (a2 - 1.0) + 1.0;
    return a2 / (PI * d * d);
}

@fragment fn fs(in: VsOut) -> @location(0) vec4<f32> {
    let N = toDir(in.uv);
    let a = params.roughness * params.roughness;
    if (params.roughness < 0.01) {
        // a mirror: the source itself, at the mip that matches this level's texel size
        let lod = log2(params.sourceSize.x / params.targetWidth);
        return vec4<f32>(textureSampleLevel(source, smp, toUv(N), max(lod, 0.0)).rgb, 1.0);
    }
    let frame = basis(N);
    let n = u32(params.samples);
    var color  = vec3<f32>(0.0);
    var weight = 0.0;
    for (var i = 0u; i < n; i++) {
        let xi = hammersley(i, n);
        // a half vector distributed as GGX around N (view = normal, the split-sum assumption)
        let cosTheta = sqrt((1.0 - xi.y) / (1.0 + (a * a - 1.0) * xi.y));
        let sinTheta = sqrt(1.0 - cosTheta * cosTheta);
        let phi = 2.0 * PI * xi.x;
        let H = frame * vec3<f32>(sinTheta * cos(phi), sinTheta * sin(phi), cosTheta);
        let L = normalize(2.0 * dot(N, H) * H - N);
        let NdotL = dot(N, L);
        if (NdotL > 0.0) {
            let pdf = distributionGGX(cosTheta, a) / 4.0; // D · NdotH / (4 · VdotH), with V = N
            let sampleAngle = 1.0 / (f32(n) * pdf + 1e-4);
            let lod = max(0.5 * log2(sampleAngle / texelSolidAngle()) + 1.0, 0.0);
            color  += textureSampleLevel(source, smp, toUv(L), lod).rgb * NdotL;
            weight += NdotL;
        }
    }
    return vec4<f32>(color / max(weight, 1e-4), 1.0);
}
`;

/** Irradiance: the cosine-weighted hemisphere average, from a blurry mip (it only needs the low frequencies). */
const IRRADIANCE_WGSL = /* wgsl */ `
${COMMON_WGSL}

@fragment fn fs(in: VsOut) -> @location(0) vec4<f32> {
    let N = toDir(in.uv);
    let frame = basis(N);
    let n = u32(params.samples);
    var color = vec3<f32>(0.0);
    let lod = max(log2(params.sourceSize.x / 64.0), 0.0);
    for (var i = 0u; i < n; i++) {
        let xi = hammersley(i, n);
        // cosine-distributed directions: their plain average is the cosine-weighted one
        let r = sqrt(xi.y);
        let phi = 2.0 * PI * xi.x;
        let L = frame * vec3<f32>(r * cos(phi), r * sin(phi), sqrt(1.0 - xi.y));
        color += textureSampleLevel(source, smp, toUv(L), lod).rgb;
    }
    return vec4<f32>(color / f32(n), 1.0);
}
`;

/**
 * Turns environment maps into what image-based lighting samples: a specular map blurred per roughness and a
 * diffuse irradiance map. Done once per Texture on the GPU, and cached.
 */
export class EnvironmentPrefilter {
    private readonly device: GPUDevice;
    private readonly cache = new WeakMap<Texture, PrefilteredEnvironment>();
    private readonly made = new Set<PrefilteredEnvironment>();
    private specularPipeline: GPURenderPipeline | null = null;
    private irradiancePipeline: GPURenderPipeline | null = null;
    private readonly sampler: GPUSampler;

    constructor(device: GPUDevice) {
        this.device = device;
        this.sampler = device.createSampler({
            label: "Environment:prefilter",
            magFilter: "linear",
            minFilter: "linear",
            mipmapFilter: "linear",
            addressModeU: "repeat",
            addressModeV: "clamp-to-edge",
        });
    }

    /** The prefiltered maps for an equirectangular environment texture (made on first use). */
    get(texture: Texture): PrefilteredEnvironment {
        let env = this.cache.get(texture);
        if (env === undefined) {
            env = this.prefilter(texture);
            this.cache.set(texture, env);
            this.made.add(env);
        }
        return env;
    }

    destroy(): void {
        for (const env of this.made) {
            env.destroy();
        }
        this.made.clear();
    }

    private pipeline(code: string, label: string): GPURenderPipeline {
        const module = this.device.createShaderModule({label, code});
        return this.device.createRenderPipeline({
            label,
            layout: "auto",
            vertex: {module, entryPoint: "vs"},
            fragment: {module, entryPoint: "fs", targets: [{format: "rgba16float"}]},
            primitive: {topology: "triangle-list"},
        });
    }

    private prefilter(texture: Texture): PrefilteredEnvironment {
        const {device} = this;
        this.specularPipeline ??= this.pipeline(SPECULAR_WGSL, "Environment:specular");
        this.irradiancePipeline ??= this.pipeline(IRRADIANCE_WGSL, "Environment:irradiance");
        const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
        const specular = device.createTexture({
            label: "Environment:specular",
            size: {width: SPECULAR_WIDTH, height: SPECULAR_WIDTH / 2},
            format: "rgba16float",
            mipLevelCount: ENV_SPECULAR_LEVELS,
            usage,
        });
        const irradiance = device.createTexture({
            label: "Environment:irradiance",
            size: {width: IRRADIANCE_WIDTH, height: IRRADIANCE_WIDTH / 2},
            format: "rgba16float",
            usage,
        });
        const source = texture.srgbView; // linear light: decoded sRGB, or half floats as they are
        const encoder = device.createCommandEncoder({label: "Environment:prefilter"});
        const buffers: GPUBuffer[] = [];
        const draw = (
            pipeline: GPURenderPipeline,
            target: GPUTextureView,
            targetWidth: number,
            roughness: number,
            samples: number,
        ) => {
            const params = device.createBuffer({size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
            device.queue.writeBuffer(
                params,
                0,
                new Float32Array([roughness, samples, texture.width, texture.height, targetWidth, 0, 0, 0]),
            );
            buffers.push(params);
            const pass = encoder.beginRenderPass({
                colorAttachments: [{view: target, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1]}],
            });
            pass.setPipeline(pipeline);
            pass.setBindGroup(
                0,
                device.createBindGroup({
                    layout: pipeline.getBindGroupLayout(0),
                    entries: [
                        {binding: 0, resource: source},
                        {binding: 1, resource: this.sampler},
                        {binding: 2, resource: {buffer: params}},
                    ],
                }),
            );
            pass.draw(3);
            pass.end();
        };
        for (let level = 0; level < ENV_SPECULAR_LEVELS; level++) {
            const roughness = level / (ENV_SPECULAR_LEVELS - 1);
            const view = specular.createView({baseMipLevel: level, mipLevelCount: 1});
            draw(this.specularPipeline, view, SPECULAR_WIDTH >> level, roughness, 32 + 96 * roughness);
        }
        draw(this.irradiancePipeline, irradiance.createView(), IRRADIANCE_WIDTH, 1, 256);
        device.queue.submit([encoder.finish()]);
        for (const b of buffers) {
            b.destroy(); // after the submit: the queued work keeps what it needs
        }
        return {
            specular: specular.createView(),
            irradiance: irradiance.createView(),
            destroy() {
                specular.destroy();
                irradiance.destroy();
            },
        };
    }
}
