export interface PassOutputSpec {
    format: GPUTextureFormat;
    /** Fixed pixel width; if omitted the texture tracks canvas width (see widthDivisor). */
    width?: number;
    /** Fixed pixel height; if omitted the texture tracks canvas height (see heightDivisor). */
    height?: number;
    /**
     * When width is omitted, divide the canvas width by this value (rounded up).
     * Useful for downsampled textures whose aspect ratio matches the canvas.
     */
    widthDivisor?: number;
    /**
     * When height is omitted, divide the canvas height by this value (rounded up).
     * Useful for downsampled textures whose aspect ratio matches the canvas.
     */
    heightDivisor?: number;
}

export interface PassInputSlot {
    /** Name used to look up this input in PassRenderContext.inputs. */
    name: string;
    /** If true, the pass tolerates a missing view for this slot. */
    optional?: boolean;
}

export interface PassOutputSlot<Name extends string = string> {
    /** Name used in PassRenderContext.outputs and as TextureHandle slot identifier. */
    name: Name;
    spec: PassOutputSpec;
}

export interface PassRenderContext {
    device: GPUDevice;
    encoder: GPUCommandEncoder;
    /**
     * Texture views wired from upstream passes, keyed by input slot name.
     * For depth-format textures the view has aspect "depth-only".
     */
    inputs: Record<string, GPUTextureView>;
    /**
     * Render-attachment views for this pass's outputs, keyed by output slot name.
     * For a slot designated as the canvas output the view is the swap-chain texture view.
     */
    outputs: Record<string, GPUTextureView>;
    width: number;
    height: number;
    /** Seconds of animation time for this frame, the same for every pass (see `Renderer.renderFrame`). */
    time: number;
}

/** `Out` names the output slots, so `RenderGraph.addPass` can return a handle per name. */
export abstract class Pass<Out extends string = string> {
    /** Named input texture slots this pass reads from. */
    abstract readonly inputSlots: PassInputSlot[];

    /** Named output texture slots this pass writes to. */
    abstract readonly outputSlots: PassOutputSlot<Out>[];

    /**
     * Called when a renderer first uses the pass. A pass no graph has rendered for a while is destroyed (with
     * its textures), and initialized again if it comes back.
     */
    abstract initialize(device: GPUDevice, canvasFormat: GPUTextureFormat): void;

    /** Called whenever the canvas (or the pass's canvas-sized textures) change dimensions. */
    abstract resize(width: number, height: number): void;

    /** Encode all GPU commands for one frame. */
    abstract render(ctx: PassRenderContext): void;

    /** Releases the pass's GPU resources (the renderer calls it from `destroy`, or when the pass goes unused). */
    destroy(): void {}
}
