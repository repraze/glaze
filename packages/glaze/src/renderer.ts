import type {Pass, PassOutputSpec} from "./pass";
import type {RenderGraph} from "./render-graph";

interface ManagedTexture {
    texture: GPUTexture;
    /** Full view for use as a render attachment (ctx.outputs). */
    view: GPUTextureView;
    /** View for use as a shader texture input. Depth-only view for depth formats; same as view otherwise. */
    bindingView: GPUTextureView;
    spec: PassOutputSpec;
    /** True when dimensions are fixed (spec.width and spec.height both set). */
    fixed: boolean;
}

function isDepthFormat(format: GPUTextureFormat): boolean {
    return (
        format === "depth16unorm" ||
        format === "depth24plus" ||
        format === "depth24plus-stencil8" ||
        format === "depth32float" ||
        format === "depth32float-stencil8"
    );
}

/** What a `startAnimation` callback receives: seconds since the loop started, and since the previous frame. */
export interface AnimationFrame {
    time: number;
    delta: number;
}

export class Renderer {
    readonly device: GPUDevice;
    readonly adapter: GPUAdapter;
    readonly context: GPUCanvasContext;
    readonly format: GPUTextureFormat;

    private width: number;
    private height: number;
    private animationId: number | null = null;
    /** Origin of the default frame clock (`renderFrame` without a time). */
    private readonly clockStart = performance.now();

    /** Managed output textures keyed by "<nodeId>:<slotName>". */
    private textureCache = new Map<string, ManagedTexture>();
    /** Tracks which passes have been initialized (keyed by Pass instance). */
    private initializedPasses = new Set<Pass>();
    /** Current graph — needed to know which nodes/passes to resize. */
    private currentGraph: RenderGraph | null = null;

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

    static async init(canvas: HTMLCanvasElement, options?: {alphaMode?: GPUCanvasAlphaMode}): Promise<Renderer> {
        if (!navigator.gpu) {
            throw new Error("WebGPU is not supported in this environment.");
        }

        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
            throw new Error("No suitable GPU adapter found.");
        }

        const device = await adapter.requestDevice();

        void device.lost.then((info) => {
            if (info.reason !== "destroyed") {
                console.error(`[glaze] GPU device lost (${info.reason}): ${info.message}`);
            }
        });
        device.addEventListener("uncapturederror", (event) => {
            console.error("[glaze] uncaptured WebGPU error:", (event as GPUUncapturedErrorEvent).error);
        });
        const context = canvas.getContext("webgpu");
        if (!context) {
            throw new Error("Failed to obtain WebGPU context from canvas.");
        }

        const format = navigator.gpu.getPreferredCanvasFormat();
        context.configure({device, format, alphaMode: options?.alphaMode ?? "opaque"});

        return new Renderer(adapter, device, context, format, canvas.width, canvas.height);
    }

    resize(width: number, height: number): void {
        if (this.width === width && this.height === height) {
            return;
        }
        this.width = width;
        this.height = height;

        if (!this.currentGraph) {
            return;
        }

        for (const node of this.currentGraph.getNodes()) {
            let passW = width,
                passH = height;

            for (const slot of node.pass.outputSlots) {
                if (slot.name === node.canvasSlot) {
                    continue;
                }
                const key = `${node.id}:${slot.name}`;
                const mt = this.textureCache.get(key);
                if (!mt) {
                    continue;
                }

                if (mt.fixed) {
                    passW = mt.texture.width;
                    passH = mt.texture.height;
                } else {
                    mt.texture.destroy();
                    const fresh = this.createTexture(slot.spec, width, height);
                    this.textureCache.set(key, fresh);
                    passW = fresh.texture.width;
                    passH = fresh.texture.height;
                }
            }

            node.pass.resize(passW, passH);
        }
    }

    /**
     * Renders one frame of `graph`. `time` (seconds) is handed to every pass as `ctx.time`, which shader passes
     * expose as `globals.time`: pass your own clock to pause, freeze (reduced motion) or scrub animation. It
     * defaults to seconds since the renderer was created.
     */
    renderFrame(graph: RenderGraph, time: number = (performance.now() - this.clockStart) / 1000): void {
        const canvas = this.context.canvas;
        if (canvas.width === 0 || canvas.height === 0) {
            return;
        }

        this.ensureGraph(graph);

        const encoder = this.device.createCommandEncoder();
        const canvasView = this.context.getCurrentTexture().createView();

        for (const node of graph.getNodes()) {
            const {pass, inputs: inputHandles, canvasSlot} = node;

            // Resolve named input views from the texture cache (use bindingView).
            const inputViews: Record<string, GPUTextureView> = {};
            for (const slot of pass.inputSlots) {
                const handle = inputHandles[slot.name];
                if (handle) {
                    const mt = this.textureCache.get(`${handle._nodeId}:${handle._slot}`);
                    if (mt) {
                        inputViews[slot.name] = mt.bindingView;
                    } else if (!slot.optional) {
                        throw new Error(`RenderGraph: missing required input '${slot.name}'`);
                    }
                } else if (!slot.optional) {
                    throw new Error(`RenderGraph: input '${slot.name}' not wired`);
                }
            }

            // Resolve named output views.
            const outputViews: Record<string, GPUTextureView> = {};
            let passW = this.width,
                passH = this.height;
            for (const slot of pass.outputSlots) {
                if (slot.name === canvasSlot) {
                    outputViews[slot.name] = canvasView;
                } else {
                    const mt = this.textureCache.get(`${node.id}:${slot.name}`);
                    if (mt) {
                        outputViews[slot.name] = mt.view;
                        passW = mt.texture.width;
                        passH = mt.texture.height;
                    }
                }
            }
            // Inject canvas view for canvasSlot even when it doesn't match an output slot
            // (supports passes with no declared output slots that render directly to canvas).
            if (canvasSlot !== null && !(canvasSlot in outputViews)) {
                outputViews[canvasSlot] = canvasView;
            }

            pass.render({
                device: this.device,
                encoder,
                inputs: inputViews,
                outputs: outputViews,
                width: passW,
                height: passH,
                time,
            });
        }

        this.device.queue.submit([encoder.finish()]);
    }

    /**
     * Start an animation loop.
     *
     * @param graph - Either a fixed `RenderGraph` or a per-frame callback that
     *   returns the graph to render (useful for updating scene state each frame). The callback receives
     *   `{time, delta}` in seconds since the loop started; the same `time` reaches every pass.
     */
    startAnimation(graph: RenderGraph | ((frame: AnimationFrame) => RenderGraph)): () => void {
        let stopped = false;
        let start: number | null = null;
        let last = 0;

        const loop = (now: number) => {
            if (stopped) {
                return;
            }
            start ??= now;
            const time = (now - start) / 1000;
            const delta = last === 0 ? 0 : time - last;
            last = time;
            const resolved = typeof graph === "function" ? graph({time, delta}) : graph;
            this.renderFrame(resolved, time);
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
        for (const mt of this.textureCache.values()) {
            mt.texture.destroy();
        }
        this.textureCache.clear();
        this.device.destroy();
    }

    private ensureGraph(graph: RenderGraph): void {
        if (this.currentGraph !== graph) {
            this.currentGraph = graph;
        }

        for (const node of graph.getNodes()) {
            if (this.initializedPasses.has(node.pass)) {
                continue;
            }

            node.pass.initialize(this.device, this.format);
            this.initializedPasses.add(node.pass);

            let passW = this.width,
                passH = this.height;
            for (const slot of node.pass.outputSlots) {
                if (slot.name === node.canvasSlot) {
                    continue;
                }
                const key = `${node.id}:${slot.name}`;
                const mt = this.createTexture(slot.spec, this.width, this.height);
                this.textureCache.set(key, mt);
                passW = mt.texture.width;
                passH = mt.texture.height;
            }

            node.pass.resize(passW, passH);
        }
    }

    private createTexture(spec: PassOutputSpec, canvasW: number, canvasH: number): ManagedTexture {
        const fixed = spec.width !== undefined && spec.height !== undefined;
        const w = spec.width ?? Math.max(1, Math.ceil(canvasW / (spec.widthDivisor ?? 1)));
        const h = spec.height ?? Math.max(1, Math.ceil(canvasH / (spec.heightDivisor ?? 1)));
        const depth = isDepthFormat(spec.format);

        const texture = this.device.createTexture({
            size: {width: w, height: h},
            format: spec.format,
            usage:
                GPUTextureUsage.RENDER_ATTACHMENT |
                GPUTextureUsage.TEXTURE_BINDING |
                (depth ? 0 : GPUTextureUsage.COPY_SRC),
        });

        const view = texture.createView();
        const bindingView = depth ? texture.createView({aspect: "depth-only"}) : view;

        return {texture, view, bindingView, spec, fixed};
    }
}
