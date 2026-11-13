import {Badge} from "@repraze/kernelkit/components/badge";
import {cn} from "@repraze/kernelkit/lib/utils";
import {ArrowDownIcon, ArrowRightIcon} from "lucide-react";
import {Fragment} from "react";

export type PipelineStage = "scene" | "deferred" | "post" | "blit" | "canvas";

const STAGES: {id: PipelineStage; title: string; caption: string; items: string[]; edge?: string}[] = [
    {
        id: "scene",
        title: "Scene",
        caption: "what to draw",
        items: ["Camera", "Lights", "Meshes", "Materials"],
        edge: "scene",
    },
    {
        id: "deferred",
        title: "DeferredScenePass",
        caption: "G-buffer, shadows, then lighting",
        items: ["albedo", "normal", "worldPos", "emissive", "depth"],
        edge: "color",
    },
    {
        id: "post",
        title: "ShaderPass · EffectPass",
        caption: "fullscreen WGSL, uniforms",
        items: ["dither", "noise", "your shader"],
        edge: "output",
    },
    {
        id: "blit",
        title: "BlitPass",
        caption: "tone map to the canvas",
        items: ["aces", "reinhard", "none"],
        edge: "canvasSlot",
    },
    {id: "canvas", title: "Canvas", caption: "the swap chain", items: ["GPUCanvasContext"]},
];

/**
 * The frame as Glaze runs it: one RenderGraph per frame, passes in order, named textures between them.
 * Built from tokens and Badges (no Mermaid in the site), so it follows the theme and stacks on phones.
 */
export function PipelineDiagram({highlight, className}: {highlight?: PipelineStage; className?: string}) {
    return (
        <figure
            data-slot="pipeline-diagram"
            className={cn("@container flex flex-col gap-3 rounded-xl border border-border bg-card p-4", className)}
        >
            <figcaption className="font-mono text-xs text-muted-foreground uppercase">
                Renderer · one RenderGraph per frame
            </figcaption>
            {/* a row only when the diagram itself is wide (the home page), stacked in the docs column and on phones */}
            <ol className="flex flex-col items-stretch gap-2 @5xl:flex-row">
                {STAGES.map((stage) => (
                    <Fragment key={stage.id}>
                        <li
                            className={cn(
                                "flex min-w-0 flex-1 flex-col gap-2 rounded-lg border border-border bg-background p-3",
                                highlight === stage.id && "border-primary-text bg-primary-tint",
                            )}
                        >
                            <div className="flex flex-col gap-0.5">
                                <span
                                    className={cn(
                                        "font-mono text-xs font-semibold break-words",
                                        highlight === stage.id && "text-primary-text",
                                    )}
                                >
                                    {stage.title}
                                </span>
                                <span className="text-xs text-muted-foreground">{stage.caption}</span>
                            </div>
                            <div className="flex flex-wrap gap-1">
                                {stage.items.map((item) => (
                                    <Badge key={item} variant="outline">
                                        {item}
                                    </Badge>
                                ))}
                            </div>
                        </li>
                        {stage.edge ? (
                            <li
                                aria-hidden
                                className="flex items-center justify-center gap-1 text-muted-foreground @5xl:flex-col @5xl:self-center"
                            >
                                <ArrowDownIcon className="size-4 @5xl:hidden" />
                                <ArrowRightIcon className="hidden size-4 @5xl:block" />
                                <span className="font-mono text-[10px]">{stage.edge}</span>
                            </li>
                        ) : null}
                    </Fragment>
                ))}
            </ol>
        </figure>
    );
}
