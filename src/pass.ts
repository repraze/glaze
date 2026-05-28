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

export interface PassRenderContext {
    device: GPUDevice;
    encoder: GPUCommandEncoder;
    /** Texture views produced by the previous pass, in declaration order. */
    inputs: GPUTextureView[];
    /**
     * Views to render into. Non-null when `outputSpecs.length > 0`.
     * Each view corresponds to one entry in `outputSpecs`.
     */
    outputs: GPUTextureView[] | null;
    /**
     * View of the current canvas frame. Non-null when this is the last pass
     * (`outputSpecs` is empty), meaning the pass renders to the swap chain.
     */
    canvasView: GPUTextureView | null;
    width: number;
    height: number;
}

export abstract class Pass {
    /**
     * Textures this pass will write to. An empty array means the pass writes
     * directly to the canvas swap chain (must be the last pass in the chain).
     */
    abstract readonly outputSpecs: PassOutputSpec[];

    /** Number of input texture views this pass expects from the previous pass. */
    abstract readonly inputCount: number;

    /** Called once when the GPU device is ready. */
    abstract initialize(device: GPUDevice, canvasFormat: GPUTextureFormat): void;

    /** Called whenever the canvas (or the pass's canvas-sized textures) change dimensions. */
    abstract resize(width: number, height: number): void;

    /** Encode all GPU commands for one frame. */
    abstract render(ctx: PassRenderContext): void;

    destroy(): void {}
}
