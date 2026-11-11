import type {Pass} from "./pass";

/** Opaque reference to a named output slot of a specific pass in a RenderGraph. */
export interface TextureHandle {
    readonly _nodeId: number;
    readonly _slot: string;
}

export interface RenderGraphNode {
    readonly id: number;
    readonly pass: Pass;
    /** Maps each input slot name to the TextureHandle that feeds it. */
    readonly inputs: Record<string, TextureHandle>;
    /**
     * Output slot name that maps to the swap-chain canvas view instead of a
     * managed texture.  null when no output goes directly to the canvas.
     */
    readonly canvasSlot: string | null;
}

/**
 * Describes a directed acyclic graph of render passes.
 *
 * Build the graph by calling addPass in topological order (each call returns
 * handles for that pass's outputs, which can be wired into later passes).
 *
 * @example
 * ```ts
 * const graph = new RenderGraph();
 * const { color } = graph.addPass(deferredPass);
 * graph.addPass(tonemapPass, { hdr: color }, { canvasSlot: 'output' });
 * renderer.renderFrame(graph);
 * ```
 */
export class RenderGraph {
    private nodes: RenderGraphNode[] = [];
    private nextId = 0;

    /**
     * Register a pass in the graph.
     *
     * @param pass      - The pass to add.
     * @param inputs    - Maps each input slot name to an upstream TextureHandle.
     * @param options   - canvasSlot: name of the output slot that renders to the
     *                    swap chain instead of a managed texture.
     * @returns A record mapping each output slot name to a TextureHandle that
     *          downstream passes can reference.
     */
    addPass<Out extends string>(
        pass: Pass<Out>,
        inputs?: Record<string, TextureHandle>,
        options?: {canvasSlot?: string},
    ): Record<Out, TextureHandle> {
        const id = this.nextId++;
        this.nodes.push({
            id,
            pass,
            inputs: inputs ?? {},
            canvasSlot: options?.canvasSlot ?? null,
        });

        const handles = {} as Record<Out, TextureHandle>;
        for (const slot of pass.outputSlots) {
            handles[slot.name] = {_nodeId: id, _slot: slot.name};
        }
        return handles;
    }

    /** Returns nodes in the order they were added (caller is responsible for topological order). */
    getNodes(): readonly RenderGraphNode[] {
        return this.nodes;
    }
}
