import {RenderGraph, ShaderPass} from "@repraze/glaze";
import {useState} from "react";

import {ControlSegmented, ControlSlider, DemoStage} from "@/glaze/demo-stage";
import {GlazeCanvas, useLatest} from "@/glaze/glaze-canvas";
import {perTheme, type SceneColors, useSceneColors, wgslColor} from "@/glaze/scene-colors";
import {Code, defineDoc} from "@/lib/doc-kit";

export const doc = defineDoc({
    title: "Render graph",
    category: "Pipeline",
    description:
        "A RenderGraph is the frame's recipe: passes in order, and the named textures that flow between them. Outputs can feed any later pass, several passes can feed one, and a downsampled texture is just an output spec.",
    engineFile: "render-graph.ts",
    order: 2,
    demos: [
        {
            title: "Multipass noise",
            description:
                "Ported from the repraze.com lab. Pass 1 writes one noise value per dot into a texture 1/dotSize of the canvas (widthDivisor). Pass 2 reads it at full resolution to draw blinking dots.",
            component: MultipassNoise,
            layout: "full",
        },
        {
            title: "Fan-in",
            description:
                "Two independent passes write two textures; a third reads both and blends them. Show either input on its own to see what flows through the graph.",
            component: FanIn,
            layout: "full",
        },
    ],
    notes: Notes,
    sections: [{id: "wiring", title: "Wiring"}],
    props: [
        {
            component: "RenderGraph",
            rows: [
                {
                    name: "addPass(pass, inputs?, options?)",
                    type: "Record<Out, TextureHandle>",
                    description: "Adds a node; returns one handle per output slot of the pass.",
                },
                {
                    name: "inputs",
                    type: "Record<string, TextureHandle>",
                    default: "{}",
                    description: "Input slot name → handle from an earlier pass.",
                },
                {
                    name: "options.canvasSlot",
                    type: "string",
                    description: "This node writes that slot to the swap chain instead of a managed texture.",
                },
                {name: "getNodes()", type: "readonly RenderGraphNode[]", description: "Nodes in insertion order."},
            ],
        },
        {
            component: "TextureHandle",
            rows: [
                {name: "_nodeId", type: "number", description: "Opaque: the node that writes the texture."},
                {name: "_slot", type: "string", description: "Opaque: the output slot."},
            ],
        },
    ],
});

function Notes() {
    return (
        <section id="wiring" className="flex scroll-mt-24 flex-col gap-3">
            <h2 className="font-mono text-xl font-semibold">Wiring</h2>
            <p className="text-sm text-muted-foreground">
                Add passes in dependency order (the graph runs them as added). Textures are owned by the renderer and
                keyed by node position and slot, so rebuilding the same graph each frame costs nothing, and switching a
                pass in or out only allocates the first time.
            </p>
            <Code
                code={`const graph = new RenderGraph();
const {noise} = graph.addPass(noisePass);         // ShaderPass<"noise">: outputs [{name: "noise", …}]
const {grain} = graph.addPass(grainPass);
graph.addPass(mixPass, {noise, grain}, {canvasSlot: "canvas"});

renderer.startAnimation(graph);`}
            />
        </section>
    );
}

export function MultipassNoise() {
    const colors = useSceneColors();
    const [dotSize, setDotSize] = useState(20);
    const live = useLatest(dotSize);
    return (
        <DemoStage
            controls={
                <ControlSlider
                    label="Dot size"
                    value={dotSize}
                    onChange={setDotSize}
                    min={6}
                    max={40}
                    step={2}
                    format={(v) => `${v}px`}
                />
            }
        >
            <GlazeCanvas
                label="A grid of dots in TermiColor hues blinking at different rates over the page background"
                maxPixelRatio={1}
                setup={() => {
                    // one pair of passes per dot size and theme (colors are baked in), built on first use
                    const cache = new Map<string, {noisePass: ShaderPass<"noise">; dotsPass: ShaderPass}>();
                    const passesFor = (size: number, c: SceneColors) => {
                        const key = `${size}:${c.background}:${c.accent}`;
                        let passes = cache.get(key);
                        if (!passes) {
                            passes = {
                                noisePass: new ShaderPass({
                                    fragmentShader: NOISE_FRAGMENT,
                                    outputs: [
                                        {
                                            name: "noise",
                                            spec: {format: "rgba8unorm", widthDivisor: size, heightDivisor: size},
                                        },
                                    ],
                                }),
                                dotsPass: new ShaderPass({
                                    fragmentShader: dotsFragment(size, c),
                                    inputs: [{name: "input0"}],
                                }),
                            };
                            cache.set(key, passes);
                        }
                        return passes;
                    };
                    return () => {
                        const {noisePass, dotsPass} = passesFor(live.current, colors.current);
                        const graph = new RenderGraph();
                        const {noise} = graph.addPass(noisePass);
                        graph.addPass(dotsPass, {input0: noise}, {canvasSlot: "canvas"});
                        return graph;
                    };
                }}
            />
        </DemoStage>
    );
}

/** Pass 1: one value-noise sample per dot cell (the texture is canvas / dotSize, so a texel is a dot). */
const NOISE_FRAGMENT = /* wgsl */ `
fn hash(p: vec2<f32>) -> f32 {
    return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453123);
}

fn valueNoise(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    return mix(
        mix(hash(i), hash(i + vec2<f32>(1.0, 0.0)), u.x),
        mix(hash(i + vec2<f32>(0.0, 1.0)), hash(i + vec2<f32>(1.0, 1.0)), u.x),
        u.y,
    );
}

@fragment
fn fs_main(in: QuadInput) -> @location(0) vec4<f32> {
    let cell = floor(in.pos.xy);
    let seed = globals.time * 0.12;
    let p = cell * 0.07;
    let n = valueNoise(p + seed) * 0.6
          + valueNoise(p * 2.1 + 5.3 + seed * 0.7) * 0.3
          + valueNoise(p * 4.7 + 11.1 + seed * 0.4) * 0.1;
    return vec4<f32>(n, n, n, 1.0);
}
`;

/** Pass 2: round dots that blink at a per-cell rate, colored along accent → cyan → purple by their noise texel. */
function dotsFragment(dotSize: number, c: SceneColors): string {
    return /* wgsl */ `
fn cellHash(p: vec2<f32>) -> f32 {
    return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453);
}

@fragment
fn fs_main(in: QuadInput) -> @location(0) vec4<f32> {
    let dotSize = ${dotSize}.0;
    let cellCoord = floor(in.pos.xy / dotSize);
    let localPx = fract(in.pos.xy / dotSize) * dotSize;
    let noiseUV = (cellCoord + 0.5) / ceil(globals.resolution / dotSize);
    let h = textureSample(input0, inputSampler, noiseUV).r;

    let d = length(localPx - vec2<f32>(dotSize * 0.5));
    let radius = dotSize * 0.40;
    let background = ${wgslColor(c.background)};
    if (d > radius) {
        return vec4<f32>(background, 1.0);
    }
    let rnd = cellHash(cellCoord);
    let blink = 0.5 + 0.5 * sin(globals.time * (0.5 + rnd * 3.5) + rnd * 6.283185);
    let bright = blink * (1.0 - smoothstep(radius * 0.60, radius, d));
    let hue = mix(mix(${wgslColor(c.accent)}, ${wgslColor(c.hues.cyan)}, smoothstep(0.2, 0.5, h)), ${wgslColor(c.hues.purple)}, smoothstep(0.5, 0.8, h));
    return vec4<f32>(mix(background, hue, bright), 1.0);
}
`;
}

export function FanIn() {
    const colors = useSceneColors();
    const [view, setView] = useState<FanInView>("mix");
    const live = useLatest(view);
    return (
        <DemoStage controls={<ControlSegmented label="Show" value={view} options={FAN_IN_VIEWS} onChange={setView} />}>
            <GlazeCanvas
                label="Rings in the site's accent and blue stripes, blended by a third pass"
                setup={() => {
                    // colors are baked into the WGSL, so the three passes are built once per theme
                    const passesFor = perTheme((c) => {
                        const rings = new ShaderPass({
                            fragmentShader: /* wgsl */ `
                            @fragment fn fs_main(in: QuadInput) -> @location(0) vec4<f32> {
                                let p = (in.uv - 0.5) * vec2<f32>(globals.resolution.x / globals.resolution.y, 1.0);
                                let v = 0.5 + 0.5 * sin(length(p) * 30.0 - globals.time * 2.0);
                                return vec4<f32>(mix(${wgslColor(c.background)}, ${wgslColor(c.accent)}, v), 1.0);
                            }`,
                            outputs: [{name: "rings", spec: {format: "rgba8unorm"}}],
                        });
                        const stripes = new ShaderPass({
                            fragmentShader: /* wgsl */ `
                            @fragment fn fs_main(in: QuadInput) -> @location(0) vec4<f32> {
                                let v = step(0.5, fract((in.uv.x + in.uv.y) * 12.0 + globals.time * 0.3));
                                return vec4<f32>(mix(${wgslColor(c.background)}, ${wgslColor(c.fill)}, v), 1.0);
                            }`,
                            outputs: [
                                {name: "stripes", spec: {format: "rgba8unorm", widthDivisor: 2, heightDivisor: 2}},
                            ],
                        });
                        const blend = (expr: string) =>
                            new ShaderPass({
                                fragmentShader: /* wgsl */ `
                                @fragment fn fs_main(in: QuadInput) -> @location(0) vec4<f32> {
                                    let a = textureSample(rings, inputSampler, in.uv).rgb;
                                    let b = textureSample(stripes, inputSampler, in.uv).rgb;
                                    return vec4<f32>(${expr}, 1.0);
                                }`,
                                inputs: [{name: "rings"}, {name: "stripes"}],
                            });
                        return {
                            rings,
                            stripes,
                            outputs: {mix: blend("mix(a, b, 0.45)"), rings: blend("a"), stripes: blend("b")},
                        };
                    });
                    return () => {
                        const {rings, stripes, outputs} = passesFor(colors.current);
                        const graph = new RenderGraph();
                        const r = graph.addPass(rings);
                        const s = graph.addPass(stripes);
                        graph.addPass(
                            outputs[live.current],
                            {rings: r.rings, stripes: s.stripes},
                            {canvasSlot: "canvas"},
                        );
                        return graph;
                    };
                }}
            />
        </DemoStage>
    );
}

type FanInView = "mix" | "rings" | "stripes";

const FAN_IN_VIEWS: {value: FanInView; label: string}[] = [
    {value: "mix", label: "Blend"},
    {value: "rings", label: "Rings"},
    {value: "stripes", label: "Stripes"},
];
