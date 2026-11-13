import {COLOR_WGSL, type ColorSpace} from "../color";
import type {PassInputSlot, PassOutputSlot, PassRenderContext} from "../pass";
import {Pass} from "../pass";

// ─── WGSL ─────────────────────────────────────────────────────────────────────

const VERTEX_SHADER = /* wgsl */ `
struct QuadInput {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> QuadInput {
    // Fullscreen triangle from vertex_index (arithmetic — NOT array indexing).
    // Indexing a var array by vertex_index miscompiles to zero on some mobile GPU
    // drivers (Adreno/Mali), collapsing the triangle to nothing → black output.
    let t = vec2<f32>(f32((vi << 1u) & 2u), f32(vi & 2u));
    var out: QuadInput;
    out.pos = vec4<f32>(t * 2.0 - 1.0, 0.0, 1.0);
    out.uv = vec2<f32>(t.x, 1.0 - t.y);
    return out;
}
`;

function buildFragmentShader(toneMapping: ToneMapping, encode: boolean): string {
    return /* wgsl */ `
struct BlitUniform {
    exposure: f32, // linear multiplier, 2^stops
};

@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTex: texture_2d<f32>;
@group(0) @binding(2) var<uniform> blit: BlitUniform;

${TONE_MAP_FN[toneMapping]}
${COLOR_WGSL}

@fragment
fn fs_main(in: QuadInput) -> @location(0) vec4<f32> {
    let color = textureSample(inputTex, inputSampler, in.uv);
    let mapped = applyToneMap(color.rgb * blit.exposure);
    return vec4<f32>(${encode ? "linearToSrgb(mapped)" : "mapped"}, color.a);
}
`;
}

// Every curve takes and returns linear light (sRGB primaries); the encode comes after.
const TONE_MAP_FN: Record<ToneMapping, string> = {
    none: /* wgsl */ `fn applyToneMap(c: vec3<f32>) -> vec3<f32> { return clamp(c, vec3<f32>(0.0), vec3<f32>(1.0)); }`,

    // Krzysztof Narkowicz's fit of the ACES filmic curve.
    aces: /* wgsl */ `
fn applyToneMap(c: vec3<f32>) -> vec3<f32> {
    let a = 2.51;
    let b = 0.03;
    let d = 2.43;
    let e = 0.59;
    let f = 0.14;
    return clamp((c * (a * c + b)) / (c * (d * c + e) + f), vec3<f32>(0.0), vec3<f32>(1.0));
}`,

    reinhard: /* wgsl */ `
fn applyToneMap(c: vec3<f32>) -> vec3<f32> {
    return clamp(c / (c + vec3<f32>(1.0)), vec3<f32>(0.0), vec3<f32>(1.0));
}`,

    // AgX (Troy Sobotka), Benjamin Wrensch's polynomial fit, as three.js ships it: in Rec.2020, highlights go to
    // white instead of skewing hue.
    agx: /* wgsl */ `
fn agxContrast(x: vec3<f32>) -> vec3<f32> {
    let x2 = x * x;
    let x4 = x2 * x2;
    return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

fn applyToneMap(c: vec3<f32>) -> vec3<f32> {
    let srgbToRec2020 = mat3x3<f32>(
        vec3<f32>(0.6274, 0.0691, 0.0164),
        vec3<f32>(0.3293, 0.9195, 0.0880),
        vec3<f32>(0.0433, 0.0113, 0.8956),
    );
    let rec2020ToSrgb = mat3x3<f32>(
        vec3<f32>(1.6605, -0.1246, -0.0182),
        vec3<f32>(-0.5876, 1.1329, -0.1006),
        vec3<f32>(-0.0728, -0.0083, 1.1187),
    );
    let inset = mat3x3<f32>(
        vec3<f32>(0.856627153315983, 0.137318972929847, 0.11189821299995),
        vec3<f32>(0.0951212405381588, 0.761241990602591, 0.0767994186031903),
        vec3<f32>(0.0482516061458583, 0.101439036467562, 0.811302368396859),
    );
    let outset = mat3x3<f32>(
        vec3<f32>(1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
        vec3<f32>(-0.11060664309660323, 1.157823702216272, -0.11060664309660294),
        vec3<f32>(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405),
    );
    let minEv = -12.47393;
    let maxEv = 4.026069;
    var x = inset * (srgbToRec2020 * c);
    x = (log2(max(x, vec3<f32>(1e-10))) - minEv) / (maxEv - minEv);
    x = agxContrast(clamp(x, vec3<f32>(0.0), vec3<f32>(1.0)));
    x = pow(max(outset * x, vec3<f32>(0.0)), vec3<f32>(2.2));
    return clamp(rec2020ToSrgb * x, vec3<f32>(0.0), vec3<f32>(1.0));
}`,

    // Khronos PBR Neutral: colors below about 0.76 pass through untouched (a base color reads as itself under
    // white light), only highlights are compressed. For products, food, anything whose color must stay true.
    neutral: /* wgsl */ `
fn applyToneMap(c: vec3<f32>) -> vec3<f32> {
    let startCompression = 0.8 - 0.04;
    let desaturation = 0.15;
    let x = min(c.r, min(c.g, c.b));
    let offset = select(0.04, x - 6.25 * x * x, x < 0.08);
    var color = c - offset;
    let peak = max(color.r, max(color.g, color.b));
    if (peak < startCompression) {
        return clamp(color, vec3<f32>(0.0), vec3<f32>(1.0));
    }
    let d = 1.0 - startCompression;
    let newPeak = 1.0 - d * d / (peak + d - startCompression);
    color = color * (newPeak / peak);
    let g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
    return clamp(mix(color, vec3<f32>(newPeak), g), vec3<f32>(0.0), vec3<f32>(1.0));
}`,
};

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * How light above 1 becomes a screen color (Blender's "view transform"):
 *
 * - `"none"`: clip. Flat, graphic, exact: a color lit at 1 shows as itself, highlights burn out to the hue.
 * - `"neutral"`: Khronos PBR Neutral. As `"none"` below ~0.76, then highlights roll off: true colors, no clipping.
 * - `"agx"`: filmic, the Blender default. Wide latitude, bright colors desaturate to white like film; softer.
 * - `"aces"`: filmic with more contrast and saturation, highlights shift hue a little.
 * - `"reinhard"`: the simple `c / (c + 1)`, flat and greyish; mostly for comparison.
 *
 * The curve applies to the whole image, background included: only `"none"` shows `scene.backgroundColor` exactly.
 */
export type ToneMapping = "none" | "neutral" | "agx" | "aces" | "reinhard";

export interface BlitPassOptions {
    /** Name of the input texture slot to read from. Defaults to "color". */
    input?: string;
    /** See {@link ToneMapping}. Defaults to "none". */
    toneMapping?: ToneMapping;
    /** Brightness in stops before tone mapping: +1 doubles the light, -1 halves it. Defaults to 0. */
    exposure?: number;
    /**
     * What the input holds. `"linear-srgb"` (default: DeferredScenePass's color) is tone mapped, then encoded to
     * sRGB for the screen. `"srgb"`: already encoded (a 2D pass's output), copied as is.
     */
    inputColorSpace?: ColorSpace;
}

// ─── BlitPass ─────────────────────────────────────────────────────────────────

/**
 * Puts one input texture on the canvas: exposure, tone mapping, then the sRGB encode the screen expects (skipped
 * for an `"srgb"` input, and when the canvas format is itself `-srgb`). {@link toneMapping} and {@link exposure}
 * can change every frame (one pipeline per tone mapping, built on first use).
 */
export class BlitPass extends Pass {
    readonly inputSlots: PassInputSlot[];
    readonly outputSlots: PassOutputSlot[] = [];

    toneMapping: ToneMapping;
    /** Stops, see {@link BlitPassOptions.exposure}. */
    exposure: number;

    private readonly inputName: string;
    private readonly inputColorSpace: ColorSpace;

    private device!: GPUDevice;
    private canvasFormat!: GPUTextureFormat;
    private bindGroupLayout!: GPUBindGroupLayout;
    private pipelineLayout!: GPUPipelineLayout;
    private readonly pipelines = new Map<ToneMapping, GPURenderPipeline>();
    private sampler!: GPUSampler;
    private uniformBuffer!: GPUBuffer;
    private readonly uniformData = new Float32Array(4);
    private lastExposure = NaN;

    private bindGroup: GPUBindGroup | null = null;
    private lastInputView: GPUTextureView | null = null;

    constructor(options: BlitPassOptions = {}) {
        super();
        this.inputName = options.input ?? "color";
        this.toneMapping = options.toneMapping ?? "none";
        this.exposure = options.exposure ?? 0;
        this.inputColorSpace = options.inputColorSpace ?? "linear-srgb";
        this.inputSlots = [{name: this.inputName}];
    }

    initialize(device: GPUDevice, canvasFormat: GPUTextureFormat): void {
        this.device = device;
        this.canvasFormat = canvasFormat;
        this.pipelines.clear();
        this.bindGroup = null;
        this.lastInputView = null;
        this.lastExposure = NaN;

        this.sampler = device.createSampler({
            magFilter: "nearest",
            minFilter: "nearest",
            addressModeU: "clamp-to-edge",
            addressModeV: "clamp-to-edge",
        });

        this.uniformBuffer = device.createBuffer({
            label: "BlitPass:uniforms",
            size: this.uniformData.byteLength,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        this.bindGroupLayout = device.createBindGroupLayout({
            label: "BlitPass",
            entries: [
                {binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {type: "filtering"}},
                {binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {sampleType: "float"}},
                {binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: {type: "uniform"}},
            ],
        });
        this.pipelineLayout = device.createPipelineLayout({bindGroupLayouts: [this.bindGroupLayout]});
        this.pipelineFor(this.toneMapping);
    }

    override destroy(): void {
        this.uniformBuffer?.destroy();
    }

    resize(_width: number, _height: number): void {}

    render(ctx: PassRenderContext): void {
        const inputView = ctx.inputs[this.inputName];
        if (!inputView) {
            throw new Error(`BlitPass: input '${this.inputName}' not found`);
        }

        if (inputView !== this.lastInputView) {
            this.lastInputView = inputView;
            this.bindGroup = this.device.createBindGroup({
                layout: this.bindGroupLayout,
                entries: [
                    {binding: 0, resource: this.sampler},
                    {binding: 1, resource: inputView},
                    {binding: 2, resource: {buffer: this.uniformBuffer}},
                ],
            });
        }

        if (this.exposure !== this.lastExposure) {
            this.lastExposure = this.exposure;
            this.uniformData[0] = Math.pow(2, this.exposure);
            this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);
        }

        const canvasView = Object.values(ctx.outputs)[0];
        if (!canvasView) {
            throw new Error("BlitPass: no canvas output available");
        }

        const pass = ctx.encoder.beginRenderPass({
            colorAttachments: [
                {
                    view: canvasView,
                    clearValue: {r: 0, g: 0, b: 0, a: 1},
                    loadOp: "clear",
                    storeOp: "store",
                },
            ],
        });
        pass.setPipeline(this.pipelineFor(this.toneMapping));
        pass.setBindGroup(0, this.bindGroup!);
        pass.draw(3);
        pass.end();
    }

    private pipelineFor(toneMapping: ToneMapping): GPURenderPipeline {
        let pipeline = this.pipelines.get(toneMapping);
        if (pipeline === undefined) {
            const encode = this.inputColorSpace === "linear-srgb" && !this.canvasFormat.endsWith("-srgb");
            const module = this.device.createShaderModule({
                label: `BlitPass:${toneMapping}`,
                code: VERTEX_SHADER + buildFragmentShader(toneMapping, encode),
            });
            pipeline = this.device.createRenderPipeline({
                label: `BlitPass:${toneMapping}`,
                layout: this.pipelineLayout,
                vertex: {module, entryPoint: "vs_main"},
                fragment: {module, entryPoint: "fs_main", targets: [{format: this.canvasFormat}]},
                primitive: {topology: "triangle-list"},
            });
            this.pipelines.set(toneMapping, pipeline);
        }
        return pipeline;
    }
}
