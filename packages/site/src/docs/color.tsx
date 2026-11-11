import {colorRgb, EffectPass, linearToSrgb, RenderGraph, ShaderPass, srgbToLinear, Uniform} from "@repraze/glaze";
import {useState} from "react";

import {ControlSegmented, ControlSelect, DemoStage} from "@/glaze/demo-stage";
import {GlazeCanvas, useLatest} from "@/glaze/glaze-canvas";
import {HUE_OPTIONS} from "@/glaze/helpers";
import {type Hue, useSceneColors} from "@/glaze/scene-colors";
import {Code, defineDoc} from "@/lib/doc-kit";

export const doc = defineDoc({
    title: "Color management",
    category: "Assets",
    description:
        "The renderer applies no gamma: what a pass writes is what the canvas shows. colorRgb turns CSS hex into 0-1 floats without conversion, so a ShaderPass color matches the same CSS color, and the transfer functions convert explicitly when you need linear light.",
    engineFile: "color.ts",
    order: 2,
    demos: [
        {
            title: "Same color, two renderers",
            description:
                "Left: a CSS background. Right: an EffectPass writing colorRgb(hex) to the canvas. With no conversion they match; convert, and you see what a misplaced transfer function does.",
            component: SideBySide,
            layout: "full",
        },
        {
            title: "Transfer functions",
            description:
                "A 0 → 1 ramp three times: as written, through srgbToLinear (darker mid-tones), and through linearToSrgb (lighter).",
            component: Ramps,
            layout: "full",
        },
    ],
    notes: Notes,
    sections: [{id: "in-the-scene-pass", title: "In the scene pass"}],
    props: [
        {
            component: "Color helpers",
            rows: [
                {
                    name: "colorRgb(hex | rgb)",
                    type: "[r, g, b]",
                    description: "#rgb, #rgba, #rrggbb, #rrggbbaa → 0-1, no gamma.",
                },
                {
                    name: "colorRgba(hex | rgb | rgba, alpha?)",
                    type: "[r, g, b, a]",
                    description: "alpha overrides the parsed one.",
                },
                {
                    name: "setColorRgb(out, hex | rgb)",
                    type: "ColorRgb",
                    description: "In place, no allocation: for per-frame updates.",
                },
                {name: "setColorRgba(out, hex | rgba, alpha?)", type: "ColorRgba"},
                {name: "srgbToLinear(c)", type: "number", description: "IEC 61966-2-1 decode, per channel."},
                {name: "linearToSrgb(c)", type: "number", description: "IEC 61966-2-1 encode, per channel."},
                {name: "ColorRgb / ColorRgba", type: "vec3 / vec4", description: "Tuples or Float32Arrays."},
            ],
        },
    ],
});

function Notes() {
    return (
        <section id="in-the-scene-pass" className="flex scroll-mt-24 flex-col gap-3">
            <h2 className="font-mono text-xl font-semibold">In the scene pass</h2>
            <p className="text-sm text-muted-foreground">
                DeferredScenePass lights in whatever space its inputs are in. Feeding it hex colors as-is looks right
                for most scenes; for physically correct light, convert albedo and light colors to linear and encode at
                the end (a ShaderPass, or tone mapping that outputs sRGB).
            </p>
            <Code
                code={`import {colorRgb, linearToSrgb, setColorRgb, srgbToLinear} from "@repraze/glaze";

const albedo = colorRgb("#ff9243").map(srgbToLinear) as [number, number, number];
const material = new PBRMaterial({color: albedo});

setColorRgb(scene.backgroundColor, "#0c0c10"); // per frame, no allocation`}
            />
        </section>
    );
}

export function SideBySide() {
    const [accent, setAccent] = useState<Hue>("orange");
    // Both halves take the same TermiColor hex on purpose: the point is that WebGPU output matches CSS.
    const colors = useSceneColors();
    const hex = colors.current.hues[accent];
    const [conversion, setConversion] = useState<Conversion>("none");
    const live = useLatest({accent, conversion});
    return (
        <DemoStage
            controls={
                <>
                    <ControlSelect label="Color" value={accent} options={HUE_OPTIONS} onChange={setAccent} />
                    <ControlSegmented
                        label="Conversion"
                        value={conversion}
                        options={CONVERSIONS}
                        onChange={setConversion}
                    />
                    <code className="font-mono text-xs text-muted-foreground">{hex}</code>
                </>
            }
        >
            <div className="grid size-full grid-cols-2">
                <div className="flex items-end p-3" style={{backgroundColor: hex}}>
                    <span className="rounded-md bg-background px-2 py-1 font-mono text-xs">CSS</span>
                </div>
                <div className="relative">
                    <GlazeCanvas
                        label="A flat swatch of the chosen color, drawn by WebGPU"
                        setup={() => {
                            const fill = Uniform.vec3([1, 1, 1]);
                            const pass = new EffectPass({
                                fragmentShader: /* wgsl */ `
                                    @fragment fn fs_main(in: QuadInput) -> @location(0) vec4<f32> {
                                        return vec4<f32>(effect.fill, 1.0);
                                    }`,
                                uniforms: {fill},
                            });
                            const graph = new RenderGraph();
                            graph.addPass(pass, {}, {canvasSlot: "canvas"});
                            return () => {
                                const rgb = colorRgb(colors.current.hues[live.current.accent]);
                                const convert = CONVERT[live.current.conversion];
                                fill.value = [convert(rgb[0]), convert(rgb[1]), convert(rgb[2])];
                                return graph;
                            };
                        }}
                    />
                    <span className="pointer-events-none absolute bottom-3 left-3 rounded-md bg-background px-2 py-1 font-mono text-xs">
                        WebGPU
                    </span>
                </div>
            </div>
        </DemoStage>
    );
}

type Conversion = "none" | "toLinear" | "toSrgb";

const CONVERSIONS: {value: Conversion; label: string}[] = [
    {value: "none", label: "None"},
    {value: "toLinear", label: "→ linear"},
    {value: "toSrgb", label: "→ sRGB"},
];

const CONVERT: Record<Conversion, (c: number) => number> = {
    none: (c) => c,
    toLinear: srgbToLinear,
    toSrgb: linearToSrgb,
};

export function Ramps() {
    return (
        <DemoStage>
            <GlazeCanvas
                label="Three grey ramps from black to white: as written, decoded to linear, and encoded to sRGB"
                setup={() => {
                    // Deliberately not TermiColor: a transfer function is only visible on a neutral 0 → 1 ramp.
                    const graph = new RenderGraph();
                    graph.addPass(
                        new ShaderPass({
                            fragmentShader: /* wgsl */ `
                                fn toLinear(c: f32) -> f32 {
                                    return select(pow((c + 0.055) / 1.055, 2.4), c / 12.92, c <= 0.04045);
                                }
                                fn toSrgb(c: f32) -> f32 {
                                    return select(1.055 * pow(c, 1.0 / 2.4) - 0.055, c * 12.92, c <= 0.0031308);
                                }
                                @fragment fn fs_main(in: QuadInput) -> @location(0) vec4<f32> {
                                    let x = floor(in.uv.x * 16.0) / 15.0;  // 16 steps
                                    let band = u32(in.uv.y * 3.0);
                                    var v = x;
                                    if (band == 1u) { v = toLinear(x); }
                                    if (band == 2u) { v = toSrgb(x); }
                                    let gap = step(0.02, fract(in.uv.y * 3.0));
                                    return vec4<f32>(vec3<f32>(v) * gap, 1.0);
                                }`,
                        }),
                        {},
                        {canvasSlot: "canvas"},
                    );
                    return () => graph;
                }}
            />
        </DemoStage>
    );
}
