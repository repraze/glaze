import {COLOR_WGSL, type ColorSpace} from "../color";
import type {PassInputSlot, PassOutputSlot, PassRenderContext} from "../pass";
import {Pass} from "../pass";

// ─── WGSL ─────────────────────────────────────────────────────────────────────

const SHADER = /* wgsl */ `
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

@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTex: texture_2d<f32>;

@fragment
fn fs_main(in: QuadInput) -> @location(0) vec4<f32> {
    return clamp(textureSample(inputTex, inputSampler, in.uv), vec4<f32>(0.0), vec4<f32>(1.0));
}

@fragment
fn fs_encode(in: QuadInput) -> @location(0) vec4<f32> {
    let c = clamp(textureSample(inputTex, inputSampler, in.uv), vec4<f32>(0.0), vec4<f32>(1.0));
    return vec4<f32>(linearToSrgb(c.rgb), c.a);
}
${COLOR_WGSL}
`;

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Normalized viewport rect. All values are in [0, 1] relative to canvas size.
 * Follows the same convention as Unity's Camera.rect.
 */
export interface ViewportRect {
    /** Left edge, 0 = canvas left, 1 = canvas right. */
    x: number;
    /** Top edge, 0 = canvas top, 1 = canvas bottom. */
    y: number;
    w: number;
    h: number;
}

export interface SplitViewSlot {
    /** Name of the input texture slot. */
    input: string;
    /** Normalized position and size of this view on the canvas. */
    rect: ViewportRect;
    /**
     * `"linear-srgb"` encodes the texture for the screen (the scene's color, albedo and emissive);
     * `"srgb"` (default) shows its values as they are (normals, positions, anything already encoded).
     */
    colorSpace?: ColorSpace;
}

export interface SplitViewPassOptions {
    slots: SplitViewSlot[];
}

// ─── SplitViewPass ────────────────────────────────────────────────────────────

/**
 * Renders multiple input textures into different regions of the canvas.
 * Each slot specifies an input texture name and a normalized viewport rect.
 * Zero declared output slots — always renders to canvas via canvasSlot.
 */
export class SplitViewPass extends Pass {
    readonly inputSlots: PassInputSlot[];
    readonly outputSlots: PassOutputSlot[] = [];

    private readonly slots: SplitViewSlot[];

    private device!: GPUDevice;
    private canvasFormat!: GPUTextureFormat;
    private pipeline!: GPURenderPipeline;
    private encodePipeline!: GPURenderPipeline;
    private sampler!: GPUSampler;
    private canvasWidth = 1;
    private canvasHeight = 1;

    /** Bind group cache keyed by GPUTextureView reference. */
    private bindGroupCache = new WeakMap<GPUTextureView, GPUBindGroup>();

    constructor(options: SplitViewPassOptions) {
        super();
        this.slots = options.slots;
        // De-duplicate input names (multiple slots may share the same texture).
        const seen = new Set<string>();
        this.inputSlots = [];
        for (const slot of this.slots) {
            if (!seen.has(slot.input)) {
                seen.add(slot.input);
                this.inputSlots.push({name: slot.input, optional: true});
            }
        }
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

        const shaderModule = device.createShaderModule({code: SHADER});
        const bindGroupLayout = device.createBindGroupLayout({
            label: "SplitViewPass",
            entries: [
                {binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {type: "filtering"}},
                {binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {sampleType: "float"}},
            ],
        });

        const layout = device.createPipelineLayout({bindGroupLayouts: [bindGroupLayout]});
        const pipeline = (entryPoint: string) =>
            device.createRenderPipeline({
                label: `SplitViewPass:${entryPoint}`,
                layout,
                vertex: {module: shaderModule, entryPoint: "vs_main"},
                fragment: {module: shaderModule, entryPoint, targets: [{format: canvasFormat}]},
                primitive: {topology: "triangle-list"},
            });
        this.pipeline = pipeline("fs_main");
        this.encodePipeline = pipeline("fs_encode");
    }

    resize(width: number, height: number): void {
        this.canvasWidth = width;
        this.canvasHeight = height;
    }

    render(ctx: PassRenderContext): void {
        const canvasView = Object.values(ctx.outputs)[0];
        if (!canvasView) {
            throw new Error("SplitViewPass: no canvas output available");
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

        const cw = ctx.width;
        const ch = ctx.height;

        for (const slot of this.slots) {
            const inputView = ctx.inputs[slot.input];
            if (!inputView) {
                continue;
            }

            const x = Math.floor(slot.rect.x * cw);
            const y = Math.floor(slot.rect.y * ch);
            const w = Math.max(1, Math.floor(slot.rect.w * cw));
            const h = Math.max(1, Math.floor(slot.rect.h * ch));

            pass.setPipeline(slot.colorSpace === "linear-srgb" ? this.encodePipeline : this.pipeline);
            pass.setViewport(x, y, w, h, 0, 1);
            pass.setScissorRect(x, y, w, h);
            pass.setBindGroup(0, this.getBindGroup(inputView));
            pass.draw(3);
        }

        pass.end();
    }

    private getBindGroup(view: GPUTextureView): GPUBindGroup {
        let bg = this.bindGroupCache.get(view);
        if (!bg) {
            bg = this.device.createBindGroup({
                layout: this.pipeline.getBindGroupLayout(0),
                entries: [
                    {binding: 0, resource: this.sampler},
                    {binding: 1, resource: view},
                ],
            });
            this.bindGroupCache.set(view, bg);
        }
        return bg;
    }
}
