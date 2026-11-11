import {colorRgb, EffectPass, RenderGraph, TextureUniform, Uniform} from "@repraze/glaze";
import {useState} from "react";

import {ControlSegmented, ControlSelect, ControlSlider, DemoStage} from "@/glaze/demo-stage";
import {GlazeCanvas, useLatest} from "@/glaze/glaze-canvas";
import {HUE_OPTIONS, makePattern} from "@/glaze/helpers";
import {type Hue, useSceneColors} from "@/glaze/scene-colors";
import {Code, defineDoc} from "@/lib/doc-kit";

export const doc = defineDoc({
    title: "Uniforms & bindings",
    category: "Pipeline",
    description:
        "EffectPass is a ShaderPass with typed per-frame values. Declare uniforms and external textures by name: Glaze lays out the uniform buffer with WGSL alignment, generates the struct and bindings, and uploads the values every frame.",
    engineFile: "uniform.ts",
    order: 6,
    demos: [
        {
            title: "Uniform knobs",
            description:
                "Five uniforms (f32, f32, u32 and two vec3 colors from TermiColor) drive one fragment shader. The controls only set uniform.value; the pass uploads it on the next frame.",
            component: Knobs,
            layout: "full",
        },
        {
            title: "External texture",
            description:
                "A GPUTexture made outside the graph, bound by name as a TextureUniform with its own sampler. Switch the filter: the same 16×16 checker, sampled nearest or linear.",
            component: ExternalTexture,
            layout: "full",
        },
    ],
    notes: Notes,
    sections: [{id: "generated-wgsl", title: "Generated WGSL"}],
    props: [
        {
            component: "Uniform",
            rows: [
                {
                    name: "Uniform.f32 / i32 / u32",
                    type: "Uniform<number>",
                    description: "4-byte scalars (booleans: use u32 0/1).",
                },
                {name: "Uniform.vec2 / vec2i / vec2u", type: "Uniform<[n, n]>", description: "8-byte aligned."},
                {
                    name: "Uniform.vec3 / vec3i / vec3u",
                    type: "Uniform<[n, n, n]>",
                    description: "12 bytes, 16-byte aligned.",
                },
                {name: "Uniform.vec4 / vec4i / vec4u", type: "Uniform<[n, n, n, n]>", description: "16-byte aligned."},
                {name: "value", type: "T", description: "Set it any time; read at the next render."},
                {name: "wgslType / align / size", type: "string / number", description: "Layout info the pass uses."},
            ],
        },
        {
            component: "TextureUniform",
            rows: [
                {name: "filter", type: '"nearest" | "linear"', default: '"nearest"', description: "Sampler filtering."},
                {
                    name: "texture",
                    type: "GPUTexture | null",
                    default: "null",
                    description: "Set after loading; the pass skips drawing until every texture is set.",
                },
            ],
        },
        {
            component: "EffectPassOptions",
            rows: [
                {name: "fragmentShader", type: "string", description: "fs_main and helpers, as for ShaderPass."},
                {name: "uniforms", type: "Record<string, Uniform>", description: "Read in WGSL as effect.<name>."},
                {
                    name: "textures",
                    type: "Record<string, TextureUniform>",
                    description: "Read as <name> with <name>_sampler.",
                },
                {name: "inputs", type: "{name; depth?}[]", description: "Graph textures, with inputSampler."},
                {
                    name: "outputs",
                    type: "{name; spec}[]",
                    default: "[]",
                    description: "Empty: render to the canvasSlot.",
                },
                {
                    name: "clearColor",
                    type: "GPUColorDict",
                    default: "{0, 0, 0, 0}",
                    description: "Cleared before drawing.",
                },
                {
                    name: "inputFilter",
                    type: '"linear" | "nearest"',
                    default: '"linear"',
                    description: "Filter for graph inputs.",
                },
            ],
        },
    ],
});

function Notes() {
    return (
        <section id="generated-wgsl" className="flex scroll-mt-24 flex-col gap-3">
            <h2 className="font-mono text-xl font-semibold">Generated WGSL</h2>
            <p className="text-sm text-muted-foreground">
                For <code className="font-mono text-foreground">{"uniforms: {speed, tint}"}</code> and{" "}
                <code className="font-mono text-foreground">{"textures: {pattern}"}</code>, the pass prepends (group
                numbers are assigned in order, skipping kinds you don&apos;t use):
            </p>
            <Code
                language="wgsl"
                code={`@group(0) @binding(0) var<uniform> globals: GlobalsUniform; // time, resolution
struct EffectUniform {
    speed: f32,
    tint: vec3<f32>,
};
@group(1) @binding(0) var<uniform> effect: EffectUniform;
@group(2) @binding(0) var pattern_sampler: sampler;
@group(2) @binding(1) var pattern: texture_2d<f32>;`}
            />
        </section>
    );
}

export function Knobs() {
    const [speed, setSpeed] = useState(1);
    const [scale, setScale] = useState(8);
    const [bands, setBands] = useState(5);
    const [hue, setHue] = useState<Hue>("orange");
    const colors = useSceneColors();
    const live = useLatest({speed, scale, bands, hue});
    return (
        <DemoStage
            controls={
                <>
                    <ControlSlider label="speed (f32)" value={speed} onChange={setSpeed} min={0} max={4} step={0.1} />
                    <ControlSlider label="scale (f32)" value={scale} onChange={setScale} min={2} max={24} step={0.5} />
                    <ControlSlider label="bands (u32)" value={bands} onChange={setBands} min={2} max={12} step={1} />
                    <ControlSelect label="tint (vec3)" value={hue} options={HUE_OPTIONS} onChange={setHue} />
                </>
            }
        >
            <GlazeCanvas
                label="Banded contour lines of a moving wave field, in the chosen TermiColor hue"
                setup={() => {
                    const speed = Uniform.f32(1);
                    const scale = Uniform.f32(8);
                    const bands = Uniform.u32(5);
                    const tint = Uniform.vec3([1, 1, 1]);
                    const base = Uniform.vec3([0, 0, 0]);
                    const pass = new EffectPass({
                        fragmentShader: /* wgsl */ `
                            @fragment fn fs_main(in: QuadInput) -> @location(0) vec4<f32> {
                                let t = globals.time * effect.speed;
                                let p = in.uv * effect.scale;
                                let h = 0.5 + 0.25 * (sin(p.x + t) + cos(p.y * 1.3 - t * 0.7));
                                let n = f32(effect.bands);
                                let band = floor(h * n) / n;
                                let edge = 1.0 - smoothstep(0.0, 0.04, abs(fract(h * n) - 0.5) - 0.44);
                                return vec4<f32>(mix(effect.base, effect.tint, clamp(band + edge * 0.15, 0.0, 1.0)), 1.0);
                            }`,
                        uniforms: {speed, scale, bands, tint, base},
                    });
                    const graph = new RenderGraph();
                    graph.addPass(pass, {}, {canvasSlot: "canvas"});
                    return () => {
                        const cfg = live.current;
                        speed.value = cfg.speed;
                        scale.value = cfg.scale;
                        bands.value = cfg.bands;
                        // TermiColor, in the page's current mode
                        tint.value = colorRgb(colors.current.hues[cfg.hue]);
                        base.value = colorRgb(colors.current.background);
                        return graph;
                    };
                }}
            />
        </DemoStage>
    );
}

export function ExternalTexture() {
    const [filter, setFilter] = useState<"nearest" | "linear">("nearest");
    const colors = useSceneColors();
    const live = useLatest(filter);
    return (
        <DemoStage controls={<ControlSegmented label="filter" value={filter} options={FILTERS} onChange={setFilter} />}>
            <GlazeCanvas
                label="A small checkerboard texture, tinted with the site's accent, scrolling and swirling across the canvas"
                setup={({renderer}) => {
                    // a 16×16 checker uploaded once; one TextureUniform per filter mode shares it
                    const size = 16;
                    const texture = renderer.device.createTexture({
                        size: {width: size, height: size},
                        format: "rgba8unorm",
                        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
                    });
                    renderer.device.queue.writeTexture(
                        {texture},
                        makePattern("checker", size),
                        {bytesPerRow: size * 4},
                        {width: size, height: size},
                    );
                    const tint = Uniform.vec3([1, 1, 1]);
                    const base = Uniform.vec3([0, 0, 0]);
                    const passFor = (mode: "nearest" | "linear") =>
                        new EffectPass({
                            fragmentShader: /* wgsl */ `
                                @fragment fn fs_main(in: QuadInput) -> @location(0) vec4<f32> {
                                    let aspect = globals.resolution.x / globals.resolution.y;
                                    let p = (in.uv - 0.5) * vec2<f32>(aspect, 1.0);
                                    let swirl = p + 0.08 * vec2<f32>(sin(p.y * 6.0 + globals.time), cos(p.x * 6.0 + globals.time));
                                    let v = textureSample(pattern, pattern_sampler, fract(swirl * 0.35 + globals.time * 0.03)).r; // samplers clamp: wrap by hand
                                    return vec4<f32>(mix(effect.base, effect.tint, v), 1.0);
                                }`,
                            uniforms: {tint, base},
                            textures: {pattern: new TextureUniform(mode, texture)},
                        });
                    const passes = {nearest: passFor("nearest"), linear: passFor("linear")};
                    return () => {
                        tint.value = colorRgb(colors.current.accent);
                        base.value = colorRgb(colors.current.background);
                        const graph = new RenderGraph();
                        graph.addPass(passes[live.current], {}, {canvasSlot: "canvas"});
                        return graph;
                    };
                }}
            />
        </DemoStage>
    );
}

const FILTERS: {value: "nearest" | "linear"; label: string}[] = [
    {value: "nearest", label: "Nearest"},
    {value: "linear", label: "Linear"},
];
