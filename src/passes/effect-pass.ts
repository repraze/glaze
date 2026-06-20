import type {PassInputSlot, PassOutputSlot, PassOutputSpec, PassRenderContext} from "../pass";
import {Pass} from "../pass";
import type {TextureUniform, Uniform} from "../uniform";

// ─── WGSL boilerplate ─────────────────────────────────────────────────────────

const VERTEX_SHADER = /* wgsl */ `
struct QuadInput {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> QuadInput {
    var positions = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>( 3.0, -1.0),
        vec2<f32>(-1.0,  3.0),
    );
    var p = positions[vi];
    var out: QuadInput;
    out.pos = vec4<f32>(p, 0.0, 1.0);
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

// time(f32) + _pad(f32) + resolution(vec2) = 16 bytes
const GLOBALS_BUFFER_SIZE = 16;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EffectPassInputSlot {
    name: string;
    depth?: boolean;
}

export interface EffectPassOptions {
    /**
     * Only the @fragment fn fs_main(in: QuadInput).
     * The vertex shader, globals, uniform struct, and texture declarations are auto-prepended.
     */
    fragmentShader: string;
    /**
     * Named output slots. Empty (default) renders directly to canvas via canvasSlot.
     */
    outputs?: {name: string; spec: PassOutputSpec}[];
    /**
     * Render-graph input textures wired via graph.addPass(pass, {name: handle}).
     * Auto-declares: inputSampler + named texture bindings. Access as {name} / inputSampler.
     */
    inputs?: EffectPassInputSlot[];
    /**
     * Named per-frame uniforms — auto-generates EffectUniform struct. Access in shader as effect.{key}.
     * Update by setting uniform.value each frame.
     */
    uniforms?: Record<string, Uniform>;
    /**
     * Named external textures (not from render graph). Set textureUniform.texture = gpuTexture after loading.
     * Access in shader as {key} / {key}_sampler.
     */
    textures?: Record<string, TextureUniform>;
    /** Clear color (default: transparent 0,0,0,0). */
    clearColor?: {r: number; g: number; b: number; a: number};
    /**
     * Sampler filter mode for render-graph inputs (default: "linear").
     * Use "nearest" when input texels map 1:1 to output cells (e.g., noise texture for code rain).
     */
    inputFilter?: "linear" | "nearest";
}

// ─── EffectPass ───────────────────────────────────────────────────────────────

export class EffectPass extends Pass {
    readonly inputSlots: PassInputSlot[];
    readonly outputSlots: PassOutputSlot[];

    private readonly opts: EffectPassOptions;
    private readonly inputDefs: EffectPassInputSlot[];
    private readonly uniformEntries: [string, Uniform][];
    private readonly textureEntries: [string, TextureUniform][];

    // Dynamically-assigned bind group indices (set in buildPipeline, -1 = not used)
    private inputsGroup = -1;
    private uniformsGroup = -1;
    private texturesGroup = -1;

    private device!: GPUDevice;
    private canvasFormat!: GPUTextureFormat;
    private pipeline!: GPURenderPipeline;

    private globalsBuffer!: GPUBuffer;
    private globalsBindGroup!: GPUBindGroup;

    private inputSampler!: GPUSampler;
    private inputBindGroup: GPUBindGroup | null = null;
    private lastInputViews: GPUTextureView[] = [];

    private uniformBuffer: GPUBuffer | null = null;
    private uniformBufferSize = 0;
    private uniformOffsets: number[] = [];
    private uniformBindGroup: GPUBindGroup | null = null;

    private textureSamplers: GPUSampler[] = [];
    private textureBindGroup: GPUBindGroup | null = null;
    private lastTextureRefs: (GPUTexture | null)[] = [];

    private startTime = performance.now();
    private width = 1;
    private height = 1;

    constructor(options: EffectPassOptions) {
        super();
        this.opts = options;
        this.inputDefs = options.inputs ?? [];
        this.uniformEntries = Object.entries(options.uniforms ?? {});
        this.textureEntries = Object.entries(options.textures ?? {});

        this.inputSlots = this.inputDefs.map((s) => ({name: s.name}));
        this.outputSlots = options.outputs ?? [];
    }

    initialize(device: GPUDevice, canvasFormat: GPUTextureFormat): void {
        this.device = device;
        this.canvasFormat = canvasFormat;
        this.startTime = performance.now();

        this.globalsBuffer = device.createBuffer({
            size: GLOBALS_BUFFER_SIZE,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        const inputFilter = this.opts.inputFilter ?? "linear";
        this.inputSampler = device.createSampler({
            magFilter: inputFilter,
            minFilter: inputFilter,
            addressModeU: "clamp-to-edge",
            addressModeV: "clamp-to-edge",
        });

        if (this.uniformEntries.length > 0) {
            this.uniformBufferSize = this.computeUniformLayout();
            this.uniformBuffer = device.createBuffer({
                size: this.uniformBufferSize,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            });
        }

        this.textureSamplers = this.textureEntries.map(([, u]) =>
            device.createSampler({
                magFilter: u.filter,
                minFilter: u.filter,
                addressModeU: "clamp-to-edge",
                addressModeV: "clamp-to-edge",
            }),
        );
        this.lastTextureRefs = this.textureEntries.map(() => null);

        this.buildPipeline();
    }

    resize(width: number, height: number): void {
        this.width = width;
        this.height = height;
    }

    render(ctx: PassRenderContext): void {
        this.writeGlobals(ctx.device);
        this.writeUniforms(ctx.device);

        if (this.inputDefs.length > 0) {
            const views = this.inputDefs.map((s) => ctx.inputs[s.name]!);
            if (!this.inputViewsMatch(views)) {
                this.lastInputViews = views;
                this.inputBindGroup = this.buildInputBindGroup(views);
            }
        }

        if (this.textureEntries.length > 0) {
            let dirty = false;
            for (let i = 0; i < this.textureEntries.length; i++) {
                const tex = this.textureEntries[i]![1].texture;
                if (tex !== this.lastTextureRefs[i]) {
                    this.lastTextureRefs[i] = tex;
                    dirty = true;
                }
            }
            if (dirty) {
                this.textureBindGroup = this.buildTextureBindGroup();
            }
            // Skip draw until all textures are loaded
            if (!this.textureBindGroup) {
                return;
            }
        }

        const targets = this.resolveOutputTargets(ctx);
        const pass = ctx.encoder.beginRenderPass({colorAttachments: targets});
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, this.globalsBindGroup);
        if (this.inputsGroup >= 0 && this.inputBindGroup) {
            pass.setBindGroup(this.inputsGroup, this.inputBindGroup);
        }
        if (this.uniformsGroup >= 0 && this.uniformBindGroup) {
            pass.setBindGroup(this.uniformsGroup, this.uniformBindGroup);
        }
        if (this.texturesGroup >= 0 && this.textureBindGroup) {
            pass.setBindGroup(this.texturesGroup, this.textureBindGroup);
        }
        pass.draw(3);
        pass.end();
    }

    override destroy(): void {
        this.globalsBuffer?.destroy();
        this.uniformBuffer?.destroy();
    }

    // ─── Uniform layout ────────────────────────────────────────────────────────

    private computeUniformLayout(): number {
        let offset = 0;
        this.uniformOffsets = [];
        for (const [, u] of this.uniformEntries) {
            offset = Math.ceil(offset / u.align) * u.align;
            this.uniformOffsets.push(offset);
            offset += u.size;
        }
        return Math.ceil(Math.max(offset, 1) / 16) * 16;
    }

    // ─── WGSL generation ───────────────────────────────────────────────────────

    private buildWgslDecls(inputsGroup: number, uniformsGroup: number, texturesGroup: number): string {
        const parts: string[] = [];

        if (this.inputDefs.length > 0) {
            parts.push(`@group(${inputsGroup}) @binding(0) var inputSampler: sampler;`);
            for (let i = 0; i < this.inputDefs.length; i++) {
                const def = this.inputDefs[i]!;
                const texType = def.depth ? "texture_depth_2d" : "texture_2d<f32>";
                parts.push(`@group(${inputsGroup}) @binding(${i + 1}) var ${def.name}: ${texType};`);
            }
        }

        if (this.uniformEntries.length > 0) {
            parts.push("struct EffectUniform {");
            for (const [name, u] of this.uniformEntries) {
                parts.push(`    ${name}: ${u.wgslType},`);
            }
            parts.push("};");
            parts.push(`@group(${uniformsGroup}) @binding(0) var<uniform> effect: EffectUniform;`);
        }

        if (this.textureEntries.length > 0) {
            for (let i = 0; i < this.textureEntries.length; i++) {
                const [name] = this.textureEntries[i]!;
                parts.push(`@group(${texturesGroup}) @binding(${i * 2}) var ${name}_sampler: sampler;`);
                parts.push(`@group(${texturesGroup}) @binding(${i * 2 + 1}) var ${name}: texture_2d<f32>;`);
            }
        }

        return parts.join("\n");
    }

    // ─── Pipeline ──────────────────────────────────────────────────────────────

    private buildPipeline(): void {
        const device = this.device;

        // Assign contiguous group indices — no gaps, no empty layouts needed
        let nextGroup = 1;
        this.inputsGroup = this.inputDefs.length > 0 ? nextGroup++ : -1;
        this.uniformsGroup = this.uniformEntries.length > 0 ? nextGroup++ : -1;
        this.texturesGroup = this.textureEntries.length > 0 ? nextGroup++ : -1;

        const wgsl = [
            VERTEX_SHADER,
            GLOBALS_DECL,
            this.buildWgslDecls(this.inputsGroup, this.uniformsGroup, this.texturesGroup),
            this.opts.fragmentShader,
        ].join("\n");

        const shaderModule = device.createShaderModule({code: wgsl});

        // ── Bind group layouts ─────────────────────────────────────────────────
        const globalsLayout = device.createBindGroupLayout({
            label: "EffectPass:globals",
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                    buffer: {type: "uniform"},
                },
            ],
        });
        const bindGroupLayouts: GPUBindGroupLayout[] = [globalsLayout];

        if (this.inputsGroup >= 0) {
            const inputSamplerType: GPUSamplerBindingType =
                (this.opts.inputFilter ?? "linear") === "nearest" ? "non-filtering" : "filtering";
            const entries: GPUBindGroupLayoutEntry[] = [
                {binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {type: inputSamplerType}},
            ];
            for (let i = 0; i < this.inputDefs.length; i++) {
                entries.push({
                    binding: i + 1,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture: this.inputDefs[i]!.depth ? {sampleType: "depth"} : {sampleType: "float"},
                });
            }
            bindGroupLayouts.push(device.createBindGroupLayout({label: "EffectPass:inputs", entries}));
        }

        if (this.uniformsGroup >= 0) {
            const uniformLayout = device.createBindGroupLayout({
                label: "EffectPass:uniforms",
                entries: [{binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: {type: "uniform"}}],
            });
            bindGroupLayouts.push(uniformLayout);
            this.uniformBindGroup = device.createBindGroup({
                layout: uniformLayout,
                entries: [{binding: 0, resource: {buffer: this.uniformBuffer!}}],
            });
        }

        if (this.texturesGroup >= 0) {
            const entries: GPUBindGroupLayoutEntry[] = [];
            for (let i = 0; i < this.textureEntries.length; i++) {
                const samplerType: GPUSamplerBindingType =
                    this.textureEntries[i]![1].filter === "linear" ? "filtering" : "non-filtering";
                entries.push({binding: i * 2, visibility: GPUShaderStage.FRAGMENT, sampler: {type: samplerType}});
                entries.push({binding: i * 2 + 1, visibility: GPUShaderStage.FRAGMENT, texture: {sampleType: "float"}});
            }
            bindGroupLayouts.push(device.createBindGroupLayout({label: "EffectPass:textures", entries}));
        }

        const pipelineLayout = device.createPipelineLayout({bindGroupLayouts});
        const outputFormats =
            this.outputSlots.length > 0 ? this.outputSlots.map((s) => s.spec.format) : [this.canvasFormat];

        this.pipeline = device.createRenderPipeline({
            label: "EffectPass",
            layout: pipelineLayout,
            vertex: {module: shaderModule, entryPoint: "vs_main"},
            fragment: {
                module: shaderModule,
                entryPoint: "fs_main",
                targets: outputFormats.map((fmt) => ({format: fmt})),
            },
            primitive: {topology: "triangle-list"},
        });

        this.globalsBindGroup = device.createBindGroup({
            layout: globalsLayout,
            entries: [{binding: 0, resource: {buffer: this.globalsBuffer}}],
        });
    }

    // ─── Bind group builders ───────────────────────────────────────────────────

    private buildInputBindGroup(views: GPUTextureView[]): GPUBindGroup {
        const layout = this.pipeline.getBindGroupLayout(this.inputsGroup);
        const entries: GPUBindGroupEntry[] = [{binding: 0, resource: this.inputSampler}];
        for (let i = 0; i < this.inputDefs.length; i++) {
            const view = views[i];
            if (!view) {
                throw new Error(`EffectPass: missing input '${this.inputDefs[i]!.name}'`);
            }
            entries.push({binding: i + 1, resource: view});
        }
        return this.device.createBindGroup({layout, entries});
    }

    private buildTextureBindGroup(): GPUBindGroup | null {
        for (const [, u] of this.textureEntries) {
            if (!u.texture) {
                return null;
            } // wait until all textures are loaded
        }
        const layout = this.pipeline.getBindGroupLayout(this.texturesGroup);
        const entries: GPUBindGroupEntry[] = [];
        for (let i = 0; i < this.textureEntries.length; i++) {
            entries.push({binding: i * 2, resource: this.textureSamplers[i]!});
            entries.push({binding: i * 2 + 1, resource: this.textureEntries[i]![1].texture!.createView()});
        }
        return this.device.createBindGroup({layout, entries});
    }

    private inputViewsMatch(views: GPUTextureView[]): boolean {
        if (!this.inputBindGroup) {
            return false;
        }
        if (views.length !== this.lastInputViews.length) {
            return false;
        }
        return views.every((v, i) => v === this.lastInputViews[i]);
    }

    // ─── Per-frame writes ──────────────────────────────────────────────────────

    private writeGlobals(device: GPUDevice): void {
        const t = (performance.now() - this.startTime) / 1000;
        const data = new Float32Array(4);
        data[0] = t;
        data[1] = 0;
        data[2] = this.width;
        data[3] = this.height;
        device.queue.writeBuffer(this.globalsBuffer, 0, data);
    }

    private writeUniforms(device: GPUDevice): void {
        if (!this.uniformBuffer || this.uniformEntries.length === 0) {
            return;
        }
        const buf = new ArrayBuffer(this.uniformBufferSize);
        const view = new DataView(buf);
        for (let i = 0; i < this.uniformEntries.length; i++) {
            this.uniformEntries[i]![1].writeToView(view, this.uniformOffsets[i]!);
        }
        device.queue.writeBuffer(this.uniformBuffer, 0, buf);
    }

    // ─── Output helpers ────────────────────────────────────────────────────────

    private resolveOutputTargets(ctx: PassRenderContext): GPURenderPassColorAttachment[] {
        const clearValue = this.opts.clearColor ?? {r: 0, g: 0, b: 0, a: 0};
        const views =
            this.outputSlots.length > 0
                ? this.outputSlots.map((s) => {
                      const v = ctx.outputs[s.name];
                      if (!v) {
                          throw new Error(`EffectPass: output '${s.name}' not available`);
                      }
                      return v;
                  })
                : (() => {
                      const vals = Object.values(ctx.outputs);
                      if (vals.length === 0) {
                          throw new Error("EffectPass: no render target available");
                      }
                      return vals as GPUTextureView[];
                  })();

        return views.map((view) => ({
            view,
            clearValue,
            loadOp: "clear" as GPULoadOp,
            storeOp: "store" as GPUStoreOp,
        }));
    }
}
