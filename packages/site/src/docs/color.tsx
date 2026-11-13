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
        "Colors go in as sRGB, the numbers a color picker shows. The scene pass decodes them and lights in linear light, where light adds up correctly; BlitPass tone maps and encodes back to sRGB for the screen. 2D passes write sRGB straight to the canvas.",
    engineFile: "color.ts",
    order: 2,
    demos: [
        {
            title: "Same color, two renderers",
            description:
                "Left: a CSS background. Right: an EffectPass writing colorRgb(hex) to the canvas. A 2D pass's output is already sRGB, so they match; convert, and you see what a misplaced transfer function does.",
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
    sections: [
        {id: "in-the-scene-pass", title: "In the scene pass"},
        {id: "your-own-passes", title: "Your own passes"},
    ],
    props: [
        {
            component: "Color helpers",
            rows: [
                {
                    name: "colorRgb(hex | rgb)",
                    type: "[r, g, b]",
                    description: "#rgb, #rgba, #rrggbb, #rrggbbaa → 0-1, still sRGB.",
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
                {name: "srgbToLinearRgb(out, hex | rgb)", type: "ColorRgb", description: "A whole color, in place."},
                {name: "linearToSrgbRgb(out, rgb)", type: "ColorRgb", description: "A whole color, in place."},
                {
                    name: "COLOR_WGSL",
                    type: "string",
                    description:
                        "srgbToLinear / linearToSrgb on vec3<f32>, for your WGSL. ShaderPass and EffectPass include them.",
                },
                {
                    name: "ColorSpace",
                    type: '"srgb" | "linear-srgb"',
                    description:
                        "Encoded for the screen, or linear light. Textures, BlitPass and the scene pass take one.",
                },
                {name: "ColorRgb / ColorRgba", type: "vec3 / vec4", description: "Tuples or Float32Arrays."},
            ],
        },
    ],
});

function Notes() {
    return (
        <div className="flex flex-col gap-8">
            <section id="in-the-scene-pass" className="flex scroll-mt-24 flex-col gap-3">
                <h2 className="font-mono text-xl font-semibold">In the scene pass</h2>
                <p className="text-sm text-muted-foreground">
                    Lighting happens in linear light: twice the light is twice the number, and a half-lit grey is not a
                    dark one. Everything you set is decoded on the way in, nothing needs converting by hand:
                </p>
                <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-muted-foreground">
                    <li>
                        Colors on materials, lights and the scene (hex or 0-1 triples) are sRGB. Intensities, strengths,
                        roughness and metallic are plain numbers.
                    </li>
                    <li>
                        Albedo, emissive and environment textures are sampled through{" "}
                        <code className="font-mono text-foreground">texture.srgbView</code>, which decodes as it reads.
                        Normal, roughness / metallic, occlusion and height maps are data, read as stored. glTF models
                        are loaded this way.
                    </li>
                    <li>
                        The <code className="font-mono text-foreground">color</code> output is linear and HDR. BlitPass
                        tone maps it, then encodes to sRGB. With tone mapping{" "}
                        <code className="font-mono text-foreground">&quot;none&quot;</code>, an unlit color comes out as
                        exactly the hex you wrote: the page background behind a scene matches the page.
                    </li>
                </ul>
                <Code
                    code={`const material = new PBRMaterial({color: colorRgb("#ff9243")}); // as picked
setColorRgb(scene.backgroundColor, "#0c0c10");                      // per frame, no allocation
const brick = await Texture.fromURL(device, "/brick.jpg");           // color: sRGB (default)
const normals = await Texture.fromURL(device, "/brick-n.png", {colorSpace: "linear-srgb"}); // data

graph.addPass(new BlitPass({toneMapping: "aces"}), {color}, {canvasSlot: "canvas"}); // tone map, encode`}
                />
            </section>
            <section id="your-own-passes" className="flex scroll-mt-24 flex-col gap-3">
                <h2 className="font-mono text-xl font-semibold">Your own passes</h2>
                <p className="text-sm text-muted-foreground">
                    A 2D pass that draws to the canvas writes sRGB, as on this page. A pass that reads the scene&apos;s
                    color gets linear light: keep it linear and leave the encode to BlitPass, or, when it writes to the
                    canvas itself, end with <code className="font-mono text-foreground">linearToSrgb</code>. Quantizing
                    effects (dithering, posterizing) should encode first, so their steps look even.
                </p>
                <Code
                    code={`new ShaderPass({
    inputs: [{name: "input0"}],
    fragmentShader: /* wgsl */ \`
        @fragment fn fs_main(in: QuadInput) -> @location(0) vec4<f32> {
            let lit = textureSample(input0, inputSampler, in.uv).rgb; // linear
            return vec4<f32>(linearToSrgb(lit), 1.0);                // for the screen
        }\`,
});`}
                />
            </section>
        </div>
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
