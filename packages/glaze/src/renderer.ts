import type {Pass, PassOutputSpec} from "./pass";
import type {RenderGraph, RenderGraphNode} from "./render-graph";

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

/** How long (in frames) a pass can go unused before the renderer releases the textures it made for it. */
const EVICT_AFTER_FRAMES = 120;

/** What the renderer keeps for each pass it has initialized. */
interface PassState {
    /** Managed output textures by slot name (canvas outputs have none). */
    textures: Map<string, ManagedTexture>;
    /** The canvas size its canvas-sized textures were made for. */
    width: number;
    height: number;
    /** The size last given to `pass.resize`. */
    passWidth: number;
    passHeight: number;
    /** The last frame it was rendered in. */
    lastFrame: number;
}

export interface RendererOptions {
    alphaMode?: GPUCanvasAlphaMode;
    /** Extra device features to require (init fails if the adapter lacks one). */
    requiredFeatures?: GPUFeatureName[];
    /** Device limits to require, over the ones Glaze raises on its own. */
    requiredLimits?: Record<string, number>;
}

/**
 * Limits raised to what the adapter allows: large models (morph targets, big vertex buffers) need more than the
 * defaults, and the default 32 bytes per pixel leaves no room for more G-buffer targets.
 */
const RAISED_LIMITS = ["maxBufferSize", "maxStorageBufferBindingSize", "maxColorAttachmentBytesPerSample"] as const;

/** Features turned on when the adapter has them: 32-bit float textures can then be filtered. */
const OPTIONAL_FEATURES: GPUFeatureName[] = ["float32-filterable"];

export class Renderer {
    readonly device: GPUDevice;
    readonly adapter: GPUAdapter;
    readonly context: GPUCanvasContext;
    readonly format: GPUTextureFormat;

    /**
     * Called once if the GPU device is lost (a driver reset, the GPU process crashing, too much memory...). The
     * renderer stops drawing: every GPU resource belonged to that device, so recover by creating a new Renderer
     * and new passes, materials and textures.
     */
    onDeviceLost: ((info: GPUDeviceLostInfo) => void) | null = null;

    private width: number;
    private height: number;
    private isLost = false;
    private frame = 0;
    private warnedSize = false;
    /** Stops for every running animation loop. */
    private readonly loops = new Set<() => void>();
    /** Origin of the default frame clock (`renderFrame` without a time). */
    private readonly clockStart = performance.now();

    /** Per initialized pass: its managed textures and sizes (keyed by the Pass instance, whatever graph has it). */
    private readonly passes = new Map<Pass, PassState>();

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
        void device.lost.then((info) => {
            this.isLost = true;
            this.stopLoops();
            if (info.reason !== "destroyed") {
                console.error(`[glaze] GPU device lost (${info.reason}): ${info.message}`);
                this.onDeviceLost?.(info);
            }
        });
    }

    static async init(canvas: HTMLCanvasElement, options: RendererOptions = {}): Promise<Renderer> {
        if (!navigator.gpu) {
            throw new Error("WebGPU is not supported in this environment.");
        }

        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
            throw new Error("No suitable GPU adapter found.");
        }

        const requiredLimits: Record<string, number> = {};
        for (const name of RAISED_LIMITS) {
            requiredLimits[name] = adapter.limits[name];
        }
        const device = await adapter.requestDevice({
            requiredFeatures: [
                ...OPTIONAL_FEATURES.filter((feature) => adapter.features.has(feature)),
                ...(options.requiredFeatures ?? []),
            ],
            requiredLimits: {...requiredLimits, ...options.requiredLimits},
        });
        device.addEventListener("uncapturederror", (event) => {
            console.error("[glaze] uncaptured WebGPU error:", (event as GPUUncapturedErrorEvent).error);
        });
        const context = canvas.getContext("webgpu");
        if (!context) {
            throw new Error("Failed to obtain WebGPU context from canvas.");
        }

        const format = navigator.gpu.getPreferredCanvasFormat();
        context.configure({device, format, alphaMode: options.alphaMode ?? "opaque"});

        return new Renderer(adapter, device, context, format, canvas.width, canvas.height);
    }

    /** True once the GPU device is lost (see `onDeviceLost`): frames are skipped from then on. */
    get lost(): boolean {
        return this.isLost;
    }

    /**
     * Renders one frame of `graph`, at the canvas's size: set `canvas.width` / `height` and render targets follow
     * (passes get `resize` calls; fixed-size outputs keep theirs). `time` (seconds) is handed to every pass as `ctx.time`, which shader passes
     * expose as `globals.time`: pass your own clock to pause, freeze (reduced motion) or scrub animation. It
     * defaults to seconds since the renderer was created.
     */
    renderFrame(graph: RenderGraph, time: number = (performance.now() - this.clockStart) / 1000): void {
        if (this.isLost) {
            return;
        }
        const canvas = this.context.canvas;
        this.fitCanvas(canvas);
        if (canvas.width === 0 || canvas.height === 0) {
            return;
        }
        // the canvas texture is the canvas's size: render targets follow it
        this.width = canvas.width;
        this.height = canvas.height;
        this.frame++;

        const nodes = graph.getNodes();
        for (const node of nodes) {
            this.preparePass(node);
        }

        const encoder = this.device.createCommandEncoder();
        const canvasView = this.context.getCurrentTexture().createView();

        for (const node of nodes) {
            const {pass, inputs: inputHandles, canvasSlot} = node;
            const state = this.passes.get(pass)!;

            // Resolve named input views from the upstream passes' textures (use bindingView).
            const inputViews: Record<string, GPUTextureView> = {};
            for (const slot of pass.inputSlots) {
                const handle = inputHandles[slot.name];
                if (handle) {
                    const source = nodes[handle._nodeId];
                    const mt =
                        source?.id === handle._nodeId
                            ? this.passes.get(source.pass)?.textures.get(handle._slot)
                            : undefined;
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
            for (const slot of pass.outputSlots) {
                if (slot.name === canvasSlot) {
                    outputViews[slot.name] = canvasView;
                } else {
                    const mt = state.textures.get(slot.name);
                    if (mt) {
                        outputViews[slot.name] = mt.view;
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
                width: state.passWidth,
                height: state.passHeight,
                time,
            });
        }

        this.device.queue.submit([encoder.finish()]);
        if (this.frame % 60 === 0) {
            this.evictUnused();
        }
    }

    /**
     * Start an animation loop. Returns a function that stops it.
     *
     * @param graph - Either a fixed `RenderGraph` or a per-frame callback that
     *   returns the graph to render (useful for updating scene state each frame). The callback receives
     *   `{time, delta}` in seconds; the same `time` reaches every pass.
     * @param options - `maxDelta` (default 0.1 s): the most time one frame can advance. After a pause (a hidden
     *   tab, a breakpoint) animation resumes where it was instead of jumping ahead.
     */
    startAnimation(
        graph: RenderGraph | ((frame: AnimationFrame) => RenderGraph),
        {maxDelta = 0.1}: {maxDelta?: number} = {},
    ): () => void {
        let id: number | null = null;
        let last: number | null = null;
        let time = 0;

        const stop = () => {
            if (id !== null) {
                cancelAnimationFrame(id);
                id = null;
            }
            this.loops.delete(stop);
        };
        const loop = (now: number) => {
            id = requestAnimationFrame(loop); // first: a throwing callback doesn't end the loop silently later
            const delta = last === null ? 0 : Math.min(Math.max((now - last) / 1000, 0), maxDelta);
            last = now;
            time += delta;
            const resolved = typeof graph === "function" ? graph({time, delta}) : graph;
            this.renderFrame(resolved, time);
        };

        this.loops.add(stop);
        id = requestAnimationFrame(loop);
        return stop;
    }

    /** Stops animation loops, then destroys every pass it initialized, their textures and the device. */
    destroy(): void {
        this.stopLoops();
        this.context.unconfigure();
        for (const [pass, state] of this.passes) {
            for (const mt of state.textures.values()) {
                mt.texture.destroy();
            }
            pass.destroy();
        }
        this.passes.clear();
        this.device.destroy();
    }

    private stopLoops(): void {
        for (const stop of [...this.loops]) {
            stop();
        }
    }

    /** Keeps the canvas within the device's largest texture size (a 5K display at 2× DPR would exceed 8192). */
    private fitCanvas(canvas: HTMLCanvasElement | OffscreenCanvas): void {
        const max = this.device.limits.maxTextureDimension2D;
        if (canvas.width <= max && canvas.height <= max) {
            return;
        }
        const scale = max / Math.max(canvas.width, canvas.height);
        canvas.width = Math.min(max, Math.floor(canvas.width * scale));
        canvas.height = Math.min(max, Math.floor(canvas.height * scale));
        if (!this.warnedSize) {
            this.warnedSize = true;
            console.warn(
                `[glaze] canvas larger than the GPU allows (${max}px): rendering at ${canvas.width}×${canvas.height}`,
            );
        }
    }

    /** Initializes a pass the first time it shows up, and (re)makes its textures for this graph and size. */
    private preparePass(node: RenderGraphNode): void {
        const {pass} = node;
        let state = this.passes.get(pass);
        if (state === undefined) {
            pass.initialize(this.device, this.format);
            state = {textures: new Map(), width: 0, height: 0, passWidth: -1, passHeight: -1, lastFrame: 0};
            this.passes.set(pass, state);
        }
        state.lastFrame = this.frame;

        const resized = state.width !== this.width || state.height !== this.height;
        state.width = this.width;
        state.height = this.height;
        let passW = this.width;
        let passH = this.height;
        for (const slot of pass.outputSlots) {
            if (slot.name === node.canvasSlot) {
                continue;
            }
            let mt = state.textures.get(slot.name);
            if (mt !== undefined && resized && !mt.fixed) {
                mt.texture.destroy();
                mt = undefined;
            }
            if (mt === undefined) {
                mt = this.createTexture(slot.spec, this.width, this.height);
                state.textures.set(slot.name, mt);
            }
            passW = mt.texture.width;
            passH = mt.texture.height;
        }
        if (passW !== state.passWidth || passH !== state.passHeight) {
            state.passWidth = passW;
            state.passHeight = passH;
            pass.resize(passW, passH);
        }
    }

    /**
     * Releases the textures of passes no graph has rendered for a while (a pass replaced by a new one, say). Such a
     * pass is initialized again if it ever comes back.
     */
    private evictUnused(): void {
        for (const [pass, state] of this.passes) {
            if (this.frame - state.lastFrame > EVICT_AFTER_FRAMES) {
                for (const mt of state.textures.values()) {
                    mt.texture.destroy();
                }
                pass.destroy();
                this.passes.delete(pass);
            }
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
