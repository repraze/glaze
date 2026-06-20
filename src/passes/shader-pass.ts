import type { PassInputSlot, PassOutputSlot, PassOutputSpec, PassRenderContext} from "../pass";
import {Pass} from "../pass";

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

// ─── Globals uniform layout (std140-compatible) ───────────────────────────────
// time: f32         -> offset 0
// _pad0: f32        -> offset 4
// resolution: vec2  -> offset 8
// Total: 16 bytes

const GLOBALS_BUFFER_SIZE = 16;

export interface ShaderPassInputSlot {
    name: string;
    /** Set to true for depth textures (texture_depth_2d instead of texture_2d<f32>). */
    depth?: boolean;
}

export interface ShaderPassOptions {
    fragmentShader: string;
    /**
     * Named input textures. Each maps to a WGSL binding in declaration order:
     * sampler at @group(1) @binding(0), then textures at @binding(1), @binding(2), …
     */
    inputs?: ShaderPassInputSlot[];
    /**
     * Named output slots. An empty array means the pass renders directly to canvas
     * (requires canvasSlot to be set in the RenderGraph.addPass call).
     */
    outputs?: {name: string; spec: PassOutputSpec}[];
}

export class ShaderPass extends Pass {
    readonly inputSlots: PassInputSlot[];
    readonly outputSlots: PassOutputSlot[];

    private readonly fragmentShaderSource: string;
    private readonly inputDefs: ShaderPassInputSlot[];

    private device!: GPUDevice;
    private canvasFormat!: GPUTextureFormat;
    private pipeline!: GPURenderPipeline;

    private globalsBuffer!: GPUBuffer;
    private globalsBindGroup!: GPUBindGroup;

    private inputBindGroup: GPUBindGroup | null = null;
    private lastInputViews: GPUTextureView[] = [];

    private sampler!: GPUSampler;

    private startTime = performance.now();
    private width = 1;
    private height = 1;

    constructor(options: ShaderPassOptions) {
        super();
        this.fragmentShaderSource = options.fragmentShader;
        this.inputDefs = options.inputs ?? [];
        this.inputSlots = this.inputDefs.map(s => ({name: s.name}));
        this.outputSlots = options.outputs ?? [];
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

        // Rebuild input bind group when upstream views change.
        const inputViews = this.inputDefs.map(s => ctx.inputs[s.name]!);
        if (!this.inputBindGroupIsCurrent(inputViews)) {
            this.lastInputViews = inputViews;
            this.inputBindGroup = this.buildInputBindGroup(inputViews);
        }

        const outputTargets = this.resolveOutputTargets(ctx);

        const pass = ctx.encoder.beginRenderPass({colorAttachments: outputTargets});
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, this.globalsBindGroup);
        if (this.inputBindGroup) pass.setBindGroup(1, this.inputBindGroup);
        pass.draw(3);
        pass.end();
    }

    private buildPipeline(): void {
        const inputDecls = this.buildInputTextureDecls();
        const shaderSource = [VERTEX_SHADER, GLOBALS_DECL, inputDecls, this.fragmentShaderSource].join("\n");
        const shaderModule = this.device.createShaderModule({code: shaderSource});

        const globalsLayout = this.device.createBindGroupLayout({
            label: "ShaderPass:globals",
            entries: [{
                binding: 0,
                visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.VERTEX,
                buffer: {type: "uniform"},
            }],
        });

        const bindGroupLayouts: GPUBindGroupLayout[] = [globalsLayout];

        if (this.inputDefs.length > 0) {
            const entries: GPUBindGroupLayoutEntry[] = [
                {binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {type: "filtering"}},
            ];
            for (let i = 0; i < this.inputDefs.length; i++) {
                const def = this.inputDefs[i]!;
                entries.push({
                    binding: i + 1,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture: def.depth
                        ? {sampleType: "depth"}
                        : {sampleType: "float"},
                });
            }
            bindGroupLayouts.push(
                this.device.createBindGroupLayout({label: "ShaderPass:inputs", entries}),
            );
        }

        const pipelineLayout = this.device.createPipelineLayout({bindGroupLayouts});
        const outputFormats = this.resolveOutputFormats();

        this.pipeline = this.device.createRenderPipeline({
            label: "ShaderPass",
            layout: pipelineLayout,
            vertex: {module: shaderModule, entryPoint: "vs_main"},
            fragment: {
                module: shaderModule,
                entryPoint: "fs_main",
                targets: outputFormats.map(fmt => ({format: fmt})),
            },
            primitive: {topology: "triangle-list"},
        });

        this.globalsBindGroup = this.device.createBindGroup({
            layout: globalsLayout,
            entries: [{binding: 0, resource: {buffer: this.globalsBuffer}}],
        });
    }

    private buildInputTextureDecls(): string {
        if (this.inputDefs.length === 0) return "";
        const lines: string[] = ["@group(1) @binding(0) var inputSampler: sampler;"];
        for (let i = 0; i < this.inputDefs.length; i++) {
            const def = this.inputDefs[i]!;
            const texType = def.depth ? "texture_depth_2d" : "texture_2d<f32>";
            lines.push(`@group(1) @binding(${i + 1}) var ${def.name}: ${texType};`);
        }
        return lines.join("\n");
    }

    private resolveOutputFormats(): GPUTextureFormat[] {
        if (this.outputSlots.length > 0) {
            return this.outputSlots.map(s => s.spec.format);
        }
        return [this.canvasFormat];
    }

    private inputBindGroupIsCurrent(views: GPUTextureView[]): boolean {
        if (!this.inputBindGroup) return false;
        if (views.length !== this.lastInputViews.length) return false;
        return views.every((v, i) => v === this.lastInputViews[i]);
    }

    private buildInputBindGroup(views: GPUTextureView[]): GPUBindGroup | null {
        if (this.inputDefs.length === 0) return null;
        const layout = this.pipeline.getBindGroupLayout(1);
        const entries: GPUBindGroupEntry[] = [{binding: 0, resource: this.sampler}];
        for (let i = 0; i < this.inputDefs.length; i++) {
            const view = views[i];
            if (!view) throw new Error(`ShaderPass: missing input '${this.inputDefs[i]!.name}'`);
            entries.push({binding: i + 1, resource: view});
        }
        return this.device.createBindGroup({layout, entries});
    }

    private resolveOutputTargets(ctx: PassRenderContext): GPURenderPassColorAttachment[] {
        const views = this.outputSlots.length > 0
            ? this.outputSlots.map(s => {
                const v = ctx.outputs[s.name];
                if (!v) throw new Error(`ShaderPass: output '${s.name}' not available`);
                return v;
            })
            : (() => {
                // canvas output: look for any output view (canvasSlot wired by graph)
                const views = Object.values(ctx.outputs);
                if (views.length === 0) throw new Error("ShaderPass: no render target available");
                return views as GPUTextureView[];
            })();

        return views.map(view => ({
            view,
            clearValue: {r: 0, g: 0, b: 0, a: 1},
            loadOp: "clear" as GPULoadOp,
            storeOp: "store" as GPUStoreOp,
        }));
    }

    private updateGlobals(device: GPUDevice): void {
        const t = (performance.now() - this.startTime) / 1000;
        const data = new Float32Array(4);
        data[0] = t;
        data[1] = 0;
        data[2] = this.width;
        data[3] = this.height;
        device.queue.writeBuffer(this.globalsBuffer, 0, data);
    }
}
