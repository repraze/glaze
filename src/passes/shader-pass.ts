import { Pass, PassOutputSpec, PassRenderContext } from "../pass";

// ─── WGSL helpers ────────────────────────────────────────────────────────────

const VERTEX_SHADER = /* wgsl */ `
struct QuadInput {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> QuadInput {
    // Fullscreen triangle (covers the viewport with 3 vertices)
    var positions = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>( 3.0, -1.0),
        vec2<f32>(-1.0,  3.0),
    );
    var p = positions[vi];
    var out: QuadInput;
    out.pos = vec4<f32>(p, 0.0, 1.0);
    // UV: top-left = (0,0), bottom-right = (1,1)
    out.uv = vec2<f32>((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5);
    return out;
}
`;

const GLOBALS_DECL = /* wgsl */ `
struct GlobalsUniform {
    time: f32,
    _pad0: f32,
    resolution: vec2<f32>,
};

@group(0) @binding(0) var<uniform> globals: GlobalsUniform;
`;

function buildInputTextureDecls(count: number): string {
    if (count === 0) return "";
    const lines: string[] = [`@group(1) @binding(0) var inputSampler: sampler;`];
    for (let i = 0; i < count; i++) {
        lines.push(`@group(1) @binding(${i + 1}) var input${i}: texture_2d<f32>;`);
    }
    return lines.join("\n");
}

// ─── Globals uniform layout (std140-compatible) ───────────────────────────────
// time: f32   -> offset 0
// _pad0: f32  -> offset 4
// resolution: vec2<f32> -> offset 8
// Total: 16 bytes

const GLOBALS_BUFFER_SIZE = 16;

// ─── ShaderPass ───────────────────────────────────────────────────────────────

export interface ShaderPassOptions {
    fragmentShader: string;
    outputSpecs?: PassOutputSpec[];
    /** Number of input textures to receive from the previous pass (default 0). */
    inputCount?: number;
}

export class ShaderPass extends Pass {
    readonly outputSpecs: PassOutputSpec[];
    readonly inputCount: number;

    private readonly fragmentShaderSource: string;

    private device!: GPUDevice;
    private canvasFormat!: GPUTextureFormat;
    private pipeline!: GPURenderPipeline;

    private globalsBuffer!: GPUBuffer;
    private globalsBindGroup!: GPUBindGroup;

    private inputBindGroup: GPUBindGroup | null = null;
    private inputTextures: GPUTextureView[] = [];

    private sampler!: GPUSampler;

    private startTime = performance.now();
    private width = 1;
    private height = 1;

    constructor(options: ShaderPassOptions) {
        super();
        this.fragmentShaderSource = options.fragmentShader;
        this.outputSpecs = options.outputSpecs ?? [];
        this.inputCount = options.inputCount ?? 0;
    }

    initialize(device: GPUDevice, canvasFormat: GPUTextureFormat): void {
        this.device = device;
        this.canvasFormat = canvasFormat;
        this.startTime = performance.now();

        this.sampler = device.createSampler({
            magFilter: "linear",
            minFilter: "linear",
            addressModeU: "clamp-to-edge",
            addressModeV: "clamp-to-edge",
        });

        this.globalsBuffer = device.createBuffer({
            size: GLOBALS_BUFFER_SIZE,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        this.buildPipeline();
    }

    resize(width: number, height: number): void {
        this.width = width;
        this.height = height;
    }

    render(ctx: PassRenderContext): void {
        this.updateGlobals(ctx.device);

        // Rebuild the input bind group when the upstream textures change.
        if (ctx.inputs !== this.inputTextures) {
            this.inputTextures = ctx.inputs;
            this.inputBindGroup = this.buildInputBindGroup(ctx.inputs);
        }

        const outputTargets = this.resolveOutputTargets(ctx);

        const pass = ctx.encoder.beginRenderPass({
            colorAttachments: outputTargets,
        });

        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, this.globalsBindGroup);
        if (this.inputBindGroup) pass.setBindGroup(1, this.inputBindGroup);
        pass.draw(3);
        pass.end();
    }

    private buildPipeline(): void {
        const shaderSource = [
            VERTEX_SHADER,
            GLOBALS_DECL,
            buildInputTextureDecls(this.inputCount),
            this.fragmentShaderSource,
        ].join("\n");

        const shaderModule = this.device.createShaderModule({ code: shaderSource });

        const globalsLayout = this.device.createBindGroupLayout({
            label: "ShaderPass:globals",
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.VERTEX,
                    buffer: { type: "uniform" },
                },
            ],
        });

        const bindGroupLayouts: GPUBindGroupLayout[] = [globalsLayout];

        if (this.inputCount > 0) {
            const inputLayoutEntries: GPUBindGroupLayoutEntry[] = [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
            ];
            for (let i = 0; i < this.inputCount; i++) {
                inputLayoutEntries.push({
                    binding: i + 1,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture: { sampleType: "float" },
                });
            }
            bindGroupLayouts.push(
                this.device.createBindGroupLayout({
                    label: "ShaderPass:inputs",
                    entries: inputLayoutEntries,
                }),
            );
        }

        const pipelineLayout = this.device.createPipelineLayout({ bindGroupLayouts });

        const outputFormats = this.resolveOutputFormats();

        this.pipeline = this.device.createRenderPipeline({
            label: "ShaderPass",
            layout: pipelineLayout,
            vertex: { module: shaderModule, entryPoint: "vs_main" },
            fragment: {
                module: shaderModule,
                entryPoint: "fs_main",
                targets: outputFormats.map((fmt) => ({ format: fmt })),
            },
            primitive: { topology: "triangle-list" },
        });

        this.globalsBindGroup = this.device.createBindGroup({
            layout: globalsLayout,
            entries: [{ binding: 0, resource: { buffer: this.globalsBuffer } }],
        });
    }

    private resolveOutputFormats(): GPUTextureFormat[] {
        if (this.outputSpecs.length > 0) {
            return this.outputSpecs.map((s) => s.format);
        }
        return [this.canvasFormat];
    }

    private buildInputBindGroup(inputs: GPUTextureView[]): GPUBindGroup | null {
        if (this.inputCount === 0) return null;

        const layout = this.pipeline.getBindGroupLayout(1);
        const entries: GPUBindGroupEntry[] = [
            { binding: 0, resource: this.sampler },
        ];
        for (let i = 0; i < this.inputCount; i++) {
            const view = inputs[i];
            if (!view) throw new Error(`ShaderPass: expected input texture at index ${i}`);
            entries.push({ binding: i + 1, resource: view });
        }

        return this.device.createBindGroup({ layout, entries });
    }

    private resolveOutputTargets(ctx: PassRenderContext): GPURenderPassColorAttachment[] {
        const targetViews: GPUTextureView[] = [];

        if (ctx.outputs !== null) {
            targetViews.push(...ctx.outputs);
        } else if (ctx.canvasView !== null) {
            targetViews.push(ctx.canvasView);
        } else {
            throw new Error("ShaderPass: no render target available");
        }

        return targetViews.map((view) => ({
            view,
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: "clear" as GPULoadOp,
            storeOp: "store" as GPUStoreOp,
        }));
    }

    private updateGlobals(device: GPUDevice): void {
        const t = (performance.now() - this.startTime) / 1000;
        const data = new Float32Array(4);
        data[0] = t;
        data[1] = 0; // padding
        data[2] = this.width;
        data[3] = this.height;
        device.queue.writeBuffer(this.globalsBuffer, 0, data);
    }
}
