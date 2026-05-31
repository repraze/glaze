import {Pass, PassOutputSpec} from "./pass";

interface ManagedTexture {
    texture: GPUTexture;
    view: GPUTextureView;
    spec: PassOutputSpec;
    /** True if dimensions are fixed (spec.width and spec.height both set). */
    fixed: boolean;
}

export class Renderer {
    readonly device: GPUDevice;
    readonly adapter: GPUAdapter;
    readonly context: GPUCanvasContext;
    readonly format: GPUTextureFormat;

    private width: number;
    private height: number;
    private animationId: number | null = null;

    /** Cached output textures per pass, keyed by pass instance. */
    private passTextures = new Map<Pass, ManagedTexture[]>();
    /** Tracks which passes have been initialized. */
    private initializedPasses = new Set<Pass>();

    private constructor(
        adapter: GPUAdapter,
        device: GPUDevice,
        context: GPUCanvasContext,
        format: GPUTextureFormat,
        width: number,
        height: number,
    ) {
        this.adapter = adapter;
        this.device = device;
        this.context = context;
        this.format = format;
        this.width = width;
        this.height = height;
    }

    static async init(canvas: HTMLCanvasElement): Promise<Renderer> {
        if (!navigator.gpu) throw new Error("WebGPU is not supported in this environment.");

        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) throw new Error("No suitable GPU adapter found.");

        const device = await adapter.requestDevice();

        const context = canvas.getContext("webgpu");
        if (!context) throw new Error("Failed to obtain WebGPU context from canvas.");

        const format = navigator.gpu.getPreferredCanvasFormat();
        context.configure({device, format, alphaMode: "opaque"});

        return new Renderer(adapter, device, context, format, canvas.width, canvas.height);
    }

    resize(width: number, height: number): void {
        if (this.width === width && this.height === height) return;
        this.width = width;
        this.height = height;

        for (const [pass, textures] of this.passTextures) {
            const fresh: ManagedTexture[] = [];
            for (const mt of textures) {
                if (mt.fixed) {
                    fresh.push(mt);
                } else {
                    mt.texture.destroy();
                    fresh.push(this.createTexture(mt.spec, width, height));
                }
            }
            this.passTextures.set(pass, fresh);
            const [outW, outH] = this.outputDims(fresh, width, height);
            pass.resize(outW, outH);
        }

        // Canvas-rendering passes have no entry in passTextures — resize them too.
        for (const pass of this.initializedPasses) {
            if (!this.passTextures.has(pass)) {
                pass.resize(width, height);
            }
        }
    }

    renderFrame(passes: Pass[]): void {
        this.ensurePasses(passes);

        const encoder = this.device.createCommandEncoder();
        const canvasView = this.context.getCurrentTexture().createView();

        let inputs: GPUTextureView[] = [];
        for (let i = 0; i < passes.length; i++) {
            const pass = passes[i]!;
            const isLast = i === passes.length - 1;
            const textures = this.passTextures.get(pass) ?? [];
            const outputs = textures.length > 0 ? textures.map((t) => t.view) : null;

            pass.render({
                device: this.device,
                encoder,
                inputs,
                outputs,
                canvasView: isLast && outputs === null ? canvasView : null,
                width: this.width,
                height: this.height,
            });

            inputs = outputs ?? [];
        }

        this.device.queue.submit([encoder.finish()]);
    }

    /**
     * Start an animation loop.
     *
     * @param passes - Either a fixed `Pass[]` array or a per-frame callback that
     *   returns the passes to render (useful for updating scene state each frame).
     */
    startAnimation(passes: Pass[] | (() => Pass[])): () => void {
        let stopped = false;

        const loop = () => {
            if (stopped) return;
            const resolved = typeof passes === "function" ? passes() : passes;
            this.renderFrame(resolved);
            this.animationId = requestAnimationFrame(loop);
        };

        this.animationId = requestAnimationFrame(loop);

        return () => {
            stopped = true;
            if (this.animationId !== null) {
                cancelAnimationFrame(this.animationId);
                this.animationId = null;
            }
        };
    }

    destroy(): void {
        if (this.animationId !== null) {
            cancelAnimationFrame(this.animationId);
        }
        this.context.unconfigure();
        for (const textures of this.passTextures.values()) {
            for (const mt of textures) {
                mt.texture.destroy();
            }
        }
        this.passTextures.clear();
        this.device.destroy();
    }

    private ensurePasses(passes: Pass[]): void {
        for (const pass of passes) {
            if (this.initializedPasses.has(pass)) continue;

            pass.initialize(this.device, this.format);
            this.initializedPasses.add(pass);

            if (pass.outputSpecs.length > 0) {
                const textures = pass.outputSpecs.map((spec) => this.createTexture(spec, this.width, this.height));
                this.passTextures.set(pass, textures);
            }

            // Call resize with the pass's actual render-target dimensions, not always canvas.
            const textures = this.passTextures.get(pass) ?? [];
            const [outW, outH] = this.outputDims(textures, this.width, this.height);
            pass.resize(outW, outH);
        }
    }

    private createTexture(spec: PassOutputSpec, canvasW: number, canvasH: number): ManagedTexture {
        const fixed = spec.width !== undefined && spec.height !== undefined;
        const w = spec.width ?? Math.max(1, Math.ceil(canvasW / (spec.widthDivisor ?? 1)));
        const h = spec.height ?? Math.max(1, Math.ceil(canvasH / (spec.heightDivisor ?? 1)));

        const texture = this.device.createTexture({
            size: {width: w, height: h},
            format: spec.format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
        });

        return {texture, view: texture.createView(), spec, fixed};
    }

    private outputDims(textures: ManagedTexture[], canvasW: number, canvasH: number): [number, number] {
        if (textures.length > 0) {
            return [textures[0]!.texture.width, textures[0]!.texture.height];
        }
        return [canvasW, canvasH];
    }
}
