import {
    DeferredScenePass,
    DirectionalLight,
    Mesh,
    PBRMaterial,
    PerspectiveCamera,
    RenderGraph,
    Scene,
    setColorRgb,
    ShaderPass,
} from "@repraze/glaze";
import {useState} from "react";

import {ControlGroup, ControlSelect, ControlSlider, ControlSwitch, DemoStage} from "@/glaze/demo-stage";
import {buildPostFragment, COLOR_METHODS, type ColorMethod, DITHER_PATTERNS, type DitherPattern} from "@/glaze/dither";
import {GlazeCanvas, useLatest} from "@/glaze/glaze-canvas";
import {makeShape, type ShapeKind, SHAPES} from "@/glaze/helpers";
import {paintScene, perTheme, type SceneColors, tint, useSceneColors, wgslColor} from "@/glaze/scene-colors";
import {Code, defineDoc} from "@/lib/doc-kit";

export const doc = defineDoc({
    title: "ShaderPass",
    category: "Pipeline",
    description:
        "A fullscreen triangle through your WGSL fragment shader. Glaze injects the vertex stage, a globals uniform (time, resolution), a sampler and one texture binding per input: you write fs_main.",
    engineFile: "passes/shader-pass.ts",
    order: 3,
    demos: [
        {
            title: "Fullscreen shader",
            description:
                "A generative pass straight to the canvas. Pick a shader: each is a few lines of WGSL using globals.",
            component: Fullscreen,
            layout: "full",
        },
        {
            title: "Post-processing: dithering",
            description:
                "Ported from the repraze.com lab. The deferred scene renders to an HDR texture; a ShaderPass reads it as input0, pixelates it and applies ordered dithering. Shader variants are built once per setting.",
            component: Dithering,
            layout: "full",
        },
    ],
    notes: Notes,
    sections: [{id: "injected-bindings", title: "Injected bindings"}],
    props: [
        {
            component: "ShaderPassOptions",
            rows: [
                {
                    name: "fragmentShader",
                    type: "string",
                    description: "WGSL with helpers and @fragment fn fs_main(in: QuadInput).",
                },
                {
                    name: "inputs",
                    type: "{name: string; depth?: boolean}[]",
                    default: "[]",
                    description: "Textures read by name; depth: true binds a texture_depth_2d.",
                },
                {
                    name: "outputs",
                    type: "{name: Out; spec: PassOutputSpec}[]",
                    default: "[]",
                    description:
                        "Textures written by name (several = multiple render targets). Empty: render to the canvasSlot.",
                },
            ],
        },
    ],
});

function Notes() {
    return (
        <section id="injected-bindings" className="flex scroll-mt-24 flex-col gap-3">
            <h2 className="font-mono text-xl font-semibold">Injected bindings</h2>
            <p className="text-sm text-muted-foreground">
                Don&apos;t redeclare these: they are prepended to your source. Inputs bind in declaration order.
            </p>
            <Code
                language="wgsl"
                code={`struct QuadInput {
    @builtin(position) pos: vec4<f32>,  // pixel coordinates
    @location(0) uv: vec2<f32>,         // 0,0 top-left → 1,1 bottom-right
};

struct GlobalsUniform { time: f32, _pad0: f32, resolution: vec2<f32> };
@group(0) @binding(0) var<uniform> globals: GlobalsUniform;

// with inputs: [{name: "input0"}, {name: "depth", depth: true}]
@group(1) @binding(0) var inputSampler: sampler;
@group(1) @binding(1) var input0: texture_2d<f32>;
@group(1) @binding(2) var depth: texture_depth_2d;`}
            />
            <p className="text-sm text-muted-foreground">
                <code className="font-mono text-foreground">globals.time</code> is the frame&apos;s time in seconds, the
                same for every pass (the renderer&apos;s clock, or the time given to renderFrame);{" "}
                <code className="font-mono text-foreground">globals.resolution</code> is the size of the pass&apos;s
                outputs. For your own uniforms, use an EffectPass.
            </p>
        </section>
    );
}

export function Fullscreen() {
    const [shader, setShader] = useState<ShaderId>("plasma");
    const colors = useSceneColors();
    const live = useLatest(shader);
    return (
        <DemoStage controls={<ControlSelect label="Shader" value={shader} options={SHADERS} onChange={setShader} />}>
            <GlazeCanvas
                label="A generative pattern in TermiColor colors, computed per pixel by a WGSL fragment shader"
                setup={() => {
                    // the palette is baked into each shader, so passes are built once per theme
                    const passesFor = perTheme(
                        (c) =>
                            Object.fromEntries(
                                SHADERS.map((s) => [s.value, new ShaderPass({fragmentShader: s.wgsl(c)})]),
                            ) as Record<ShaderId, ShaderPass>,
                    );
                    return () => {
                        const graph = new RenderGraph();
                        graph.addPass(passesFor(colors.current)[live.current], {}, {canvasSlot: "canvas"});
                        return graph;
                    };
                }}
            />
        </DemoStage>
    );
}

type ShaderId = "plasma" | "rings" | "grid";

const SHADERS: {value: ShaderId; label: string; wgsl: (c: SceneColors) => string}[] = [
    {
        value: "plasma",
        label: "Plasma",
        wgsl: (c) => /* wgsl */ `
            @fragment fn fs_main(in: QuadInput) -> @location(0) vec4<f32> {
                let p = in.uv * 6.0;
                let t = globals.time;
                let v = sin(p.x + t) + sin(p.y + t * 0.7) + sin(p.x + p.y + t * 0.5) + sin(length(p - 3.0) * 2.0 - t);
                let a = 0.5 + 0.5 * sin(v);
                let b = 0.5 + 0.5 * cos(v * 0.7);
                let hue = mix(${wgslColor(c.accent)}, ${wgslColor(c.hues.purple)}, a);
                return vec4<f32>(mix(${wgslColor(c.background)}, hue, b), 1.0);
            }`,
    },
    {
        value: "rings",
        label: "Rings",
        wgsl: (c) => /* wgsl */ `
            @fragment fn fs_main(in: QuadInput) -> @location(0) vec4<f32> {
                let p = (in.uv - 0.5) * vec2<f32>(globals.resolution.x / globals.resolution.y, 1.0);
                let d = length(p);
                let v = smoothstep(0.45, 0.5, fract(d * 10.0 - globals.time * 0.5));
                return vec4<f32>(mix(${wgslColor(c.background)}, ${wgslColor(c.accent)}, v * (1.0 - d)), 1.0);
            }`,
    },
    {
        value: "grid",
        label: "Scrolling grid",
        wgsl: (c) => /* wgsl */ `
            @fragment fn fs_main(in: QuadInput) -> @location(0) vec4<f32> {
                let px = in.pos.xy + vec2<f32>(globals.time * 40.0, 0.0);
                let g = fract(px / 32.0);
                let line = step(g.x, 0.04) + step(g.y, 0.04);
                return vec4<f32>(mix(${wgslColor(c.background)}, ${wgslColor(c.hues.cyan)}, clamp(line, 0.0, 1.0)), 1.0);
            }`,
    },
];

export function Dithering() {
    const colors = useSceneColors();
    const [shape, setShape] = useState<ShapeKind>("icosphere");
    const [pattern, setPattern] = useState<DitherPattern>("bayer4");
    const [method, setMethod] = useState<ColorMethod>("rgb");
    const [levels, setLevels] = useState(4);
    const [pixelSize, setPixelSize] = useState(3);
    const [dither, setDither] = useState(true);
    const live = useLatest({shape, pattern, method, levels, pixelSize, dither});
    return (
        <DemoStage
            controls={
                <>
                    <ControlSelect label="Shape" value={shape} options={SHAPES} onChange={setShape} />
                    <ControlGroup label="Post pass">
                        <ControlSwitch label="Dithering" checked={dither} onChange={setDither} />
                        <ControlSelect
                            label="Pattern"
                            value={pattern}
                            options={DITHER_PATTERNS}
                            onChange={setPattern}
                        />
                        <ControlSelect label="Colors" value={method} options={COLOR_METHODS} onChange={setMethod} />
                        <ControlSlider label="Levels" value={levels} onChange={setLevels} min={2} max={8} step={1} />
                        <ControlSlider
                            label="Pixel size"
                            value={pixelSize}
                            onChange={setPixelSize}
                            min={1}
                            max={8}
                            step={1}
                            format={(v) => `${v}px`}
                        />
                    </ControlGroup>
                </>
            }
        >
            <GlazeCanvas
                label="A faceted shape in the site's accent, pixelated and dithered by a post-processing shader"
                maxPixelRatio={1}
                pixelated
                setup={({orbitControls}) => {
                    const scene = new Scene();
                    const camera = new PerspectiveCamera({fov: Math.PI / 3});
                    orbitControls(camera, {distance: 4, elevation: 17});
                    scene.add(camera);
                    scene.activeCamera = camera;
                    const keyLight = new DirectionalLight({direction: [0.4, -0.8, -0.5], intensity: 4});
                    const fill = new DirectionalLight({direction: [-0.6, -0.3, 0.5], intensity: 1.6});
                    scene.add(keyLight).add(fill);

                    const material = new PBRMaterial({roughness: 0.4, metallic: 0.1});
                    let kind = live.current.shape;
                    let mesh = new Mesh(makeShape(kind, true), material);
                    scene.add(mesh);

                    const scenePass = new DeferredScenePass({scene});
                    const posts = new Map<string, ShaderPass>();

                    return ({time}) => {
                        const cfg = live.current;
                        const c = colors.current;
                        paintScene(scene, c);
                        setColorRgb(keyLight.color, c.key);
                        setColorRgb(fill.color, c.fill);
                        tint(material, c.accent);
                        if (cfg.shape !== kind) {
                            scene.remove(mesh);
                            kind = cfg.shape;
                            mesh = new Mesh(makeShape(kind, true), material);
                            scene.add(mesh);
                        }
                        mesh.setEuler(time * 0.3, time * 0.5, 0);

                        // one ShaderPass per combination of baked settings
                        const key = `${cfg.pixelSize}:${cfg.dither}:${cfg.method}:${cfg.levels}:${cfg.pattern}`;
                        let post = posts.get(key);
                        if (!post) {
                            post = new ShaderPass({
                                fragmentShader: buildPostFragment(
                                    cfg.pixelSize,
                                    false,
                                    0,
                                    0,
                                    false,
                                    cfg.dither,
                                    cfg.method,
                                    cfg.levels,
                                    cfg.pattern,
                                ),
                                inputs: [{name: "input0"}],
                            });
                            posts.set(key, post);
                        }

                        const graph = new RenderGraph();
                        const {color} = graph.addPass(scenePass);
                        graph.addPass(post, {input0: color}, {canvasSlot: "canvas"});
                        return graph;
                    };
                }}
            />
        </DemoStage>
    );
}
