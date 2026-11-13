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
    const tonemapFn = TONE_MAP_FN[toneMapping];
    return /* wgsl */ `
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTex: texture_2d<f32>;

${tonemapFn}
${COLOR_WGSL}

@fragment
fn fs_main(in: QuadInput) -> @location(0) vec4<f32> {
    let color = textureSample(inputTex, inputSampler, in.uv);
    let mapped = applyToneMap(color.rgb);
    return vec4<f32>(${encode ? "linearToSrgb(mapped)" : "mapped"}, color.a);
}
`;
}

const TONE_MAP_FN: Record<ToneMapping, string> = {
    none: `fn applyToneMap(c: vec3<f32>) -> vec3<f32> { return clamp(c, vec3<f32>(0.0), vec3<f32>(1.0)); }`,
    aces: `
fn applyToneMap(c: vec3<f32>) -> vec3<f32> {
    let a = 2.51;
    let b = 0.03;
    let d = 2.43;
    let e = 0.59;
    let f = 0.14;
    return clamp((c * (a * c + b)) / (c * (d * c + e) + f), vec3<f32>(0.0), vec3<f32>(1.0));
}`,
    reinhard: `
fn applyToneMap(c: vec3<f32>) -> vec3<f32> {
    return clamp(c / (c + vec3<f32>(1.0)), vec3<f32>(0.0), vec3<f32>(1.0));
}`,
};

// ─── Types ────────────────────────────────────────────────────────────────────

export type ToneMapping = "none" | "aces" | "reinhard";

export interface BlitPassOptions {
    /** Name of the input texture slot to read from. Defaults to "color". */
    input?: string;
    /** Tone mapping applied before writing to canvas. Defaults to "none". */
    toneMapping?: ToneMapping;
    /**
     * What the input holds. `"linear-srgb"` (default: DeferredScenePass's color) is tone mapped, then encoded to
     * sRGB for the screen. `"srgb"`: already encoded (a 2D pass's output), copied as is.
     */
    inputColorSpace?: ColorSpace;
}

// ─── BlitPass ─────────────────────────────────────────────────────────────────

/**
 * Puts one input texture on the canvas: tone mapping, then the sRGB encode the screen expects (skipped for an
 * `"srgb"` input, and when the canvas format is itself `-srgb`).
 * Zero declared output slots — always renders directly to the canvas via canvasSlot.
 */
export class BlitPass extends Pass {
    readonly inputSlots: PassInputSlot[];
    readonly outputSlots: PassOutputSlot[] = [];

    private readonly inputName: string;
    private readonly toneMapping: ToneMapping;
    private readonly inputColorSpace: ColorSpace;

    private device!: GPUDevice;
    private canvasFormat!: GPUTextureFormat;
    private pipeline!: GPURenderPipeline;
    private sampler!: GPUSampler;

    private bindGroup: GPUBindGroup | null = null;
    private lastInputView: GPUTextureView | null = null;

    constructor(options: BlitPassOptions = {}) {
        super();
        this.inputName = options.input ?? "color";
        this.toneMapping = options.toneMapping ?? "none";
        this.inputColorSpace = options.inputColorSpace ?? "linear-srgb";
        this.inputSlots = [{name: this.inputName}];
    }

    initialize(device: GPUDevice, canvasFormat: GPUTextureFormat): void {
        this.device = device;
        this.canvasFormat = canvasFormat;

        this.sampler = device.createSampler({
            magFilter: "nearest",
            minFilter: "nearest",
            addressModeU: "clamp-to-edge",
            addressModeV: "clamp-to-edge",
        });

        const shaderModule = device.createShaderModule({
            code:
                VERTEX_SHADER +
                buildFragmentShader(
                    this.toneMapping,
                    this.inputColorSpace === "linear-srgb" && !canvasFormat.endsWith("-srgb"),
                ),
        });

        const bindGroupLayout = device.createBindGroupLayout({
            label: "BlitPass",
            entries: [
                {binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {type: "filtering"}},
                {binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {sampleType: "float"}},
            ],
        });

        this.pipeline = device.createRenderPipeline({
            label: "BlitPass",
            layout: device.createPipelineLayout({bindGroupLayouts: [bindGroupLayout]}),
            vertex: {module: shaderModule, entryPoint: "vs_main"},
            fragment: {
                module: shaderModule,
                entryPoint: "fs_main",
                targets: [{format: canvasFormat}],
            },
            primitive: {topology: "triangle-list"},
        });
    }

    resize(_width: number, _height: number): void {}

    render(ctx: PassRenderContext): void {
        const inputView = ctx.inputs[this.inputName];
        if (!inputView) {
            throw new Error(`BlitPass: input '${this.inputName}' not found`);
        }

        if (inputView !== this.lastInputView) {
            this.lastInputView = inputView;
            const layout = this.pipeline.getBindGroupLayout(0);
            this.bindGroup = this.device.createBindGroup({
                layout,
                entries: [
                    {binding: 0, resource: this.sampler},
                    {binding: 1, resource: inputView},
                ],
            });
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
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, this.bindGroup!);
        pass.draw(3);
        pass.end();
    }
}
