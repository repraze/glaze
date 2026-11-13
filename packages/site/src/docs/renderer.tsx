import {RenderGraph, ShaderPass} from "@repraze/glaze";
import {Table, TableBody, TableCell, TableRow} from "@repraze/kernelkit/components/table";
import {useState} from "react";

import {ControlSlider, ControlSwitch, DemoStage} from "@/glaze/demo-stage";
import {GlazeCanvas, useLatest} from "@/glaze/glaze-canvas";
import {perTheme, type SceneColors, useSceneColors, wgslColor} from "@/glaze/scene-colors";
import {Code, defineDoc} from "@/lib/doc-kit";

export const doc = defineDoc({
    title: "Renderer",
    category: "Pipeline",
    description:
        "The Renderer owns the GPU device and the canvas context. It runs a render graph per frame, creates and resizes the textures between passes, and initialises each pass the first time it sees it.",
    engineFile: "renderer.ts",
    order: 0,
    demos: [
        {
            title: "Resolution and resize",
            description:
                "Each cell is one pixel of the drawing buffer. Lower the render scale: the frame callback resizes the canvas and calls renderer.resize, and every canvas-sized texture follows.",
            component: Resolution,
            layout: "full",
        },
        {
            title: "Device and context",
            description:
                "The renderer's public fields: the adapter, the device and the format the canvas was configured with.",
            component: DeviceInfo,
            layout: "full",
        },
    ],
    notes: Notes,
    sections: [{id: "lifecycle", title: "Lifecycle"}],
    props: [
        {
            component: "Renderer",
            rows: [
                {
                    name: "Renderer.init(canvas, options?)",
                    type: "Promise<Renderer>",
                    description:
                        "Requests the adapter and device, configures the canvas context. Throws without WebGPU or when no adapter is granted.",
                },
                {
                    name: "options.alphaMode",
                    type: "GPUCanvasAlphaMode",
                    default: '"opaque"',
                    description: '"premultiplied" lets the page show through transparent pixels.',
                },
                {
                    name: "renderFrame(graph, time?)",
                    type: "void",
                    description:
                        "Encodes every pass into one command buffer and submits it. time (seconds) reaches every pass; default: since init.",
                },
                {
                    name: "startAnimation(graph | ({time, delta}) => graph)",
                    type: "() => void",
                    description: "requestAnimationFrame loop; the callback form runs before each frame. Returns stop.",
                },
                {
                    name: "resize(width, height)",
                    type: "void",
                    description:
                        "Recreates canvas-sized textures and tells each pass its new size. Fixed-size outputs keep theirs.",
                },
                {
                    name: "destroy()",
                    type: "void",
                    description: "Stops the loop, frees the textures and destroys the device.",
                },
                {
                    name: "device",
                    type: "GPUDevice",
                    description: "For your own buffers and textures (Texture.fromPixels…).",
                },
                {name: "adapter", type: "GPUAdapter", description: "The adapter the device came from."},
                {name: "context", type: "GPUCanvasContext", description: "The configured canvas context."},
                {name: "format", type: "GPUTextureFormat", description: "The preferred canvas format, as configured."},
            ],
        },
    ],
});

export function Resolution() {
    const colors = useSceneColors();
    const [scale, setScale] = useState(0.25);
    const [grid, setGrid] = useState(true);
    const live = useLatest({scale, grid});
    return (
        <DemoStage
            controls={
                <>
                    <ControlSlider
                        label="Render scale"
                        value={scale}
                        onChange={setScale}
                        min={0.05}
                        max={1}
                        step={0.05}
                        format={(v) => `${Math.round(v * 100)}%`}
                    />
                    <ControlSwitch label="Pixel grid" checked={grid} onChange={setGrid} />
                </>
            }
        >
            <GlazeCanvas
                label="A radial ripple drawn at a reduced resolution, so each pixel shows as a square"
                maxPixelRatio={1}
                pixelated
                setup={({renderer, canvas}) => {
                    const ripple = (grid: number, c: SceneColors) => /* wgsl */ `
                        @fragment
                        fn fs_main(in: QuadInput) -> @location(0) vec4<f32> {
                            let p = (in.uv - 0.5) * vec2<f32>(globals.resolution.x / globals.resolution.y, 1.0);
                            let ring = 0.5 + 0.5 * sin(length(p) * 24.0 - globals.time * 3.0);
                            let checker = f32((u32(in.pos.x) + u32(in.pos.y)) % 2u);
                            let base = mix(${wgslColor(c.background)}, ${wgslColor(c.accent)}, ring);
                            return vec4<f32>(base * (1.0 - ${grid.toFixed(2)} * checker), 1.0);
                        }
                    `;
                    // passes are created once per theme (colors are baked in); the graph picks one per frame
                    const passesFor = perTheme((c) => ({
                        withGrid: new ShaderPass({fragmentShader: ripple(0.18, c)}),
                        plain: new ShaderPass({fragmentShader: ripple(0, c)}),
                    }));

                    return () => {
                        const {scale, grid} = live.current;
                        const width = Math.max(1, Math.round(canvas.clientWidth * scale));
                        const height = Math.max(1, Math.round(canvas.clientHeight * scale));
                        if (canvas.width !== width || canvas.height !== height) {
                            canvas.width = width;
                            canvas.height = height;
                            renderer.resize(width, height);
                        }
                        const graph = new RenderGraph();
                        const {withGrid, plain} = passesFor(colors.current);
                        graph.addPass(grid ? withGrid : plain, {}, {canvasSlot: "canvas"});
                        return graph;
                    };
                }}
            />
        </DemoStage>
    );
}

export function DeviceInfo() {
    const colors = useSceneColors();
    const [rows, setRows] = useState<[string, string][]>([]);
    return (
        <DemoStage
            controls={
                <div className="overflow-hidden rounded-lg border border-border">
                    <Table>
                        <TableBody>
                            {(rows.length ? rows : [["status", "waiting for the device"] as [string, string]]).map(
                                ([name, value]) => (
                                    <TableRow key={name}>
                                        <TableCell className="text-muted-foreground">{name}</TableCell>
                                        <TableCell className="font-mono text-xs whitespace-normal">{value}</TableCell>
                                    </TableRow>
                                ),
                            )}
                        </TableBody>
                    </Table>
                </div>
            }
        >
            <GlazeCanvas
                label="A slowly drifting field of the site's accent and blue, drawn by the renderer described beside it"
                setup={({renderer}) => {
                    setRows([
                        ["vendor", renderer.adapter.info.vendor || "unknown"],
                        ["architecture", renderer.adapter.info.architecture || "unknown"],
                        ["format", renderer.format],
                        ["max texture", `${renderer.device.limits.maxTextureDimension2D}px`],
                        ["max buffer", `${Math.round(renderer.device.limits.maxBufferSize / 2 ** 20)} MiB`],
                    ]);
                    const field = perTheme(
                        (c) =>
                            new ShaderPass({
                                fragmentShader: /* wgsl */ `
                                    @fragment
                                    fn fs_main(in: QuadInput) -> @location(0) vec4<f32> {
                                        let t = globals.time * 0.4;
                                        let a = 0.5 + 0.5 * sin(t + in.uv.x * 3.0);
                                        let b = 0.5 + 0.5 * cos(t * 0.7 + in.uv.y * 2.5);
                                        let hue = mix(${wgslColor(c.accent)}, ${wgslColor(c.fill)}, a);
                                        return vec4<f32>(mix(${wgslColor(c.background)}, hue, b), 1.0);
                                    }
                                `,
                            }),
                    );
                    return () => {
                        const graph = new RenderGraph();
                        graph.addPass(field(colors.current), {}, {canvasSlot: "canvas"});
                        return graph;
                    };
                }}
            />
        </DemoStage>
    );
}

function Notes() {
    return (
        <section id="lifecycle" className="flex scroll-mt-24 flex-col gap-3">
            <h2 className="font-mono text-xl font-semibold">Lifecycle</h2>
            <p className="text-sm text-muted-foreground">
                The first time a graph contains a pass, the renderer calls its{" "}
                <code className="font-mono text-foreground">initialize(device, format)</code>, allocates its output
                textures and calls <code className="font-mono text-foreground">resize</code>. Textures are keyed by node
                and slot, so a graph rebuilt every frame in the same order reuses them. Passes are shared objects:
                create them once, outside the frame callback.
            </p>
            <Code
                code={`const renderer = await Renderer.init(canvas, {alphaMode: "premultiplied"});

renderer.renderFrame(graph);               // one frame, e.g. a still or a test
const stop = renderer.startAnimation(graph); // or a loop
renderer.resize(width, height);            // after the canvas changed size
stop();
renderer.destroy();                        // frees textures, destroys the device`}
            />
        </section>
    );
}
