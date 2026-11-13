import {
    BlitPass,
    colorRgb,
    createIcosphere,
    createPlane,
    DeferredScenePass,
    DirectionalLight,
    Mesh,
    Pass,
    type PassInputSlot,
    type PassOutputSlot,
    type PassRenderContext,
    PBRMaterial,
    PerspectiveCamera,
    RenderGraph,
    Scene,
    setColorRgb,
    ShaderPass,
    type StrictColorRgb,
    type ToneMapping,
} from "@repraze/glaze";
import {vec3} from "gl-matrix";
import {useState} from "react";

import {PipelineDiagram} from "@/components/pipeline-diagram";
import {ControlSelect, DemoStage} from "@/glaze/demo-stage";
import {GlazeCanvas, useLatest} from "@/glaze/glaze-canvas";
import {paintScene, tint, useSceneColors} from "@/glaze/scene-colors";
import {Code, defineDoc} from "@/lib/doc-kit";

export const doc = defineDoc({
    title: "Pass chain",
    category: "Pipeline",
    description:
        "A pass is one step of the frame: it declares the textures it reads and writes, and encodes its GPU work. Chain a DeferredScenePass into ShaderPasses and a BlitPass, or write your own.",
    engineFile: "pass.ts",
    order: 1,
    demos: [
        {
            title: "Scene into post passes",
            description:
                "DeferredScenePass renders to an HDR texture, an optional ShaderPass post-processes it, a BlitPass tone maps the result onto the canvas. Change the chain: the graph is rebuilt every frame.",
            component: ChainDemo,
            layout: "full",
        },
        {
            title: "A custom pass",
            description:
                "Extend Pass: declare slots, build GPU state in initialize, encode work in render. This one clears its output to a color that cycles over time; a ShaderPass then vignettes it.",
            component: CustomPassDemo,
            layout: "full",
        },
    ],
    notes: Notes,
    sections: [
        {id: "the-chain", title: "The chain"},
        {id: "built-in-passes", title: "Built-in passes"},
    ],
    props: [
        {
            component: "Pass",
            rows: [
                {
                    name: "inputSlots",
                    type: "PassInputSlot[]",
                    description: "Named textures this pass reads ({name, optional?}).",
                },
                {
                    name: "outputSlots",
                    type: "PassOutputSlot<Out>[]",
                    description:
                        "Named textures it writes ({name, spec}); the names type RenderGraph.addPass's handles.",
                },
                {
                    name: "initialize(device, canvasFormat)",
                    type: "void",
                    description: "Once, when a renderer first runs the pass.",
                },
                {name: "resize(width, height)", type: "void", description: "After init and on every canvas resize."},
                {name: "render(ctx)", type: "void", description: "Encode the frame's commands with ctx.encoder."},
                {name: "destroy()", type: "void", description: "Release GPU resources (optional)."},
            ],
        },
        {
            component: "PassOutputSpec",
            rows: [
                {name: "format", type: "GPUTextureFormat", description: "rgba8unorm, rgba16float, depth24plus…"},
                {name: "width / height", type: "number", description: "Fixed size; omit both to follow the canvas."},
                {
                    name: "widthDivisor / heightDivisor",
                    type: "number",
                    default: "1",
                    description: "Canvas size divided (rounded up): downsampled buffers with the canvas's aspect.",
                },
            ],
        },
        {
            component: "PassRenderContext",
            rows: [
                {name: "device", type: "GPUDevice"},
                {name: "encoder", type: "GPUCommandEncoder", description: "Shared by every pass of the frame."},
                {
                    name: "inputs",
                    type: "Record<string, GPUTextureView>",
                    description: "Views of the wired inputs (depth-only for depth formats).",
                },
                {
                    name: "outputs",
                    type: "Record<string, GPUTextureView>",
                    description: "Attachments; the canvasSlot maps to the swap chain.",
                },
                {name: "width / height", type: "number", description: "Size of this pass's outputs."},
                {name: "time", type: "number", description: "The frame's time in seconds, shared by every pass."},
            ],
        },
        {
            component: "BlitPass",
            rows: [
                {name: "input", type: "string", default: '"color"', description: "Name of the input slot to copy."},
                {
                    name: "toneMapping",
                    type: '"none" | "neutral" | "agx" | "aces" | "reinhard"',
                    default: '"none"',
                    description: "How light above 1 reaches the screen; a property, change it any frame.",
                },
                {
                    name: "exposure",
                    type: "number",
                    default: "0",
                    description: "Stops before tone mapping: +1 doubles the light. A property too.",
                },
                {
                    name: "dither",
                    type: "boolean",
                    default: "true",
                    description:
                        "A touch of noise after the sRGB encode, so smooth gradients don't band. A property too.",
                },
                {
                    name: "inputColorSpace",
                    type: '"linear-srgb" | "srgb"',
                    default: '"linear-srgb"',
                    description:
                        "Linear light (the scene's color) is tone mapped then encoded to sRGB; 'srgb' input (a 2D pass's output) is copied as is.",
                },
            ],
        },
    ],
});

function Notes() {
    return (
        <div className="flex flex-col gap-8">
            <section id="the-chain" className="flex scroll-mt-24 flex-col gap-3">
                <h2 className="font-mono text-xl font-semibold">The chain</h2>
                <p className="text-sm text-muted-foreground">
                    Passes run in the order they are added. Each output slot becomes a texture the renderer owns; the
                    handle <code className="font-mono text-foreground">addPass</code> returns for it can be wired into
                    any later pass. The last pass writes to the canvas through{" "}
                    <code className="font-mono text-foreground">canvasSlot</code>.
                </p>
                <PipelineDiagram highlight="post" />
                <Code
                    code={`const graph = new RenderGraph();
const {color} = graph.addPass(scenePass);                   // HDR rgba16float
const {output} = graph.addPass(grayscale, {input0: color}); // a ShaderPass with an "output" slot
graph.addPass(new BlitPass({input: "output", toneMapping: "aces"}), {output}, {canvasSlot: "canvas"});`}
                />
            </section>
            <section id="built-in-passes" className="flex scroll-mt-24 flex-col gap-3">
                <h2 className="font-mono text-xl font-semibold">Built-in passes</h2>
                <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-muted-foreground">
                    <li>
                        <code className="font-mono text-foreground">ShaderPass</code>: a fullscreen WGSL fragment with
                        textures in and out.
                    </li>
                    <li>
                        <code className="font-mono text-foreground">EffectPass</code>: a ShaderPass with typed uniforms
                        and external textures.
                    </li>
                    <li>
                        <code className="font-mono text-foreground">DeferredScenePass</code>: the 3D renderer, with its
                        G-buffer as outputs.
                    </li>
                    <li>
                        <code className="font-mono text-foreground">BlitPass</code>: one texture to the canvas, tone
                        mapped.
                    </li>
                    <li>
                        <code className="font-mono text-foreground">SplitViewPass</code>: several textures in viewport
                        rectangles of the canvas.
                    </li>
                </ul>
            </section>
        </div>
    );
}

export function ChainDemo() {
    const colors = useSceneColors();
    const [post, setPost] = useState<PostId>("none");
    const [toneMapping, setToneMapping] = useState<ToneMapping>("aces");
    const live = useLatest({post, toneMapping});
    return (
        <DemoStage
            controls={
                <>
                    <ControlSelect label="Post pass" value={post} options={POSTS} onChange={setPost} />
                    <ControlSelect
                        label="Tone mapping"
                        value={toneMapping}
                        options={TONE_MAPPINGS}
                        onChange={setToneMapping}
                    />
                </>
            }
        >
            <GlazeCanvas
                label="Three faceted spheres in TermiColor hues on a floor, rendered then post-processed by the chosen pass"
                setup={({orbitControls}) => {
                    const scene = new Scene();
                    const camera = new PerspectiveCamera({fov: Math.PI / 4});
                    orbitControls(camera, {distance: 7, elevation: 28, azimuth: 20, target: [0, 0.6, 0]});
                    scene.add(camera);
                    scene.activeCamera = camera;
                    const sun = new DirectionalLight({direction: [-0.5, -1, -0.4], intensity: 4, castShadow: true});
                    scene.add(sun);
                    const ground = new PBRMaterial({roughness: 0.9});
                    scene.add(new Mesh(createPlane({width: 10, height: 10}), ground));
                    const paints = [
                        new PBRMaterial({roughness: 0.4}),
                        new PBRMaterial({roughness: 0.4}),
                        new PBRMaterial({roughness: 0.4}),
                    ];
                    const balls = paints.map((paint, i) => {
                        const ball = new Mesh(createIcosphere({radius: 0.6, subdivisions: 1, flat: true}), paint);
                        vec3.set(ball.position, (i - 1) * 1.6, 0.8, 0);
                        scene.add(ball);
                        return ball;
                    });

                    // created once: the graph below only wires them
                    const scenePass = new DeferredScenePass({scene});
                    const postPasses = Object.fromEntries(
                        Object.entries(POST_SHADERS).map(([id, fragmentShader]) => [
                            id,
                            new ShaderPass({
                                fragmentShader,
                                inputs: [{name: "input0"}],
                                outputs: [{name: "output", spec: {format: "rgba16float"}}],
                            }),
                        ]),
                    );
                    // one blit per input name; tone mapping can change every frame
                    const blitColor = new BlitPass({input: "color"});
                    const blitOutput = new BlitPass({input: "output"});

                    return ({time}) => {
                        const c = colors.current;
                        paintScene(scene, c);
                        setColorRgb(sun.color, c.key);
                        tint(ground, c.floor);
                        [c.accent, c.hues.cyan, c.hues.purple].forEach((hex, i) => tint(paints[i]!, hex));
                        balls.forEach((ball, i) => ball.setEuler(time * 0.3, time * (0.4 + i * 0.2), 0));
                        const {post, toneMapping} = live.current;
                        blitColor.toneMapping = toneMapping;
                        blitOutput.toneMapping = toneMapping;
                        const graph = new RenderGraph();
                        const {color} = graph.addPass(scenePass);
                        const postPass = postPasses[post];
                        if (postPass) {
                            const {output} = graph.addPass(postPass, {input0: color});
                            graph.addPass(blitOutput, {output}, {canvasSlot: "canvas"});
                        } else {
                            graph.addPass(blitColor, {color}, {canvasSlot: "canvas"});
                        }
                        return graph;
                    };
                }}
            />
        </DemoStage>
    );
}

type PostId = "none" | "grayscale" | "pixelate" | "scanlines" | "invert";

const POSTS: {value: PostId; label: string}[] = [
    {value: "none", label: "None (scene → blit)"},
    {value: "grayscale", label: "Grayscale"},
    {value: "pixelate", label: "Pixelate"},
    {value: "scanlines", label: "Scanlines"},
    {value: "invert", label: "Invert"},
];

const TONE_MAPPINGS: {value: ToneMapping; label: string}[] = [
    {value: "aces", label: "ACES"},
    {value: "agx", label: "AgX"},
    {value: "neutral", label: "Neutral"},
    {value: "reinhard", label: "Reinhard"},
    {value: "none", label: "None (clip)"},
];

const POST_SHADERS: Record<Exclude<PostId, "none">, string> = {
    grayscale: /* wgsl */ `
        @fragment fn fs_main(in: QuadInput) -> @location(0) vec4<f32> {
            let c = textureSample(input0, inputSampler, in.uv).rgb;
            return vec4<f32>(vec3<f32>(dot(c, vec3<f32>(0.2126, 0.7152, 0.0722))), 1.0);
        }`,
    pixelate: /* wgsl */ `
        @fragment fn fs_main(in: QuadInput) -> @location(0) vec4<f32> {
            let cell = 8.0 / globals.resolution;
            return vec4<f32>(textureSample(input0, inputSampler, (floor(in.uv / cell) + 0.5) * cell).rgb, 1.0);
        }`,
    scanlines: /* wgsl */ `
        @fragment fn fs_main(in: QuadInput) -> @location(0) vec4<f32> {
            let c = textureSample(input0, inputSampler, in.uv).rgb;
            let line = 0.65 + 0.35 * step(0.5, fract(in.pos.y / 4.0));
            return vec4<f32>(c * line, 1.0);
        }`,
    invert: /* wgsl */ `
        @fragment fn fs_main(in: QuadInput) -> @location(0) vec4<f32> {
            let c = textureSample(input0, inputSampler, in.uv).rgb;
            return vec4<f32>(vec3<f32>(1.0) - clamp(c, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
        }`,
};

export function CustomPassDemo() {
    const colors = useSceneColors();
    return (
        <DemoStage>
            <GlazeCanvas
                label="A full canvas color that slowly swings between the site's accent and blue, darkened toward the corners"
                setup={() => {
                    const pulse = new PulsePass();
                    const vignette = new ShaderPass({
                        fragmentShader: /* wgsl */ `
                            @fragment fn fs_main(in: QuadInput) -> @location(0) vec4<f32> {
                                let c = textureSample(pulse, inputSampler, in.uv).rgb;
                                let d = distance(in.uv, vec2<f32>(0.5));
                                return vec4<f32>(c * smoothstep(0.75, 0.2, d), 1.0);
                            }`,
                        inputs: [{name: "pulse"}],
                    });
                    const graph = new RenderGraph();
                    const {pulse: texture} = graph.addPass(pulse);
                    graph.addPass(vignette, {pulse: texture}, {canvasSlot: "canvas"});
                    return ({time}) => {
                        pulse.time = time;
                        pulse.from = colorRgb(colors.current.accent);
                        pulse.to = colorRgb(colors.current.fill);
                        return graph;
                    };
                }}
            />
        </DemoStage>
    );
}

/** No pipeline at all: clearing the attachment is the whole pass (to a blend of two colors over time). */
class PulsePass extends Pass<"pulse"> {
    readonly inputSlots: PassInputSlot[] = [];
    readonly outputSlots: PassOutputSlot<"pulse">[] = [
        {name: "pulse", spec: {format: "rgba8unorm", widthDivisor: 4, heightDivisor: 4}},
    ];
    time = 0;
    from: StrictColorRgb = [1, 1, 1];
    to: StrictColorRgb = [0, 0, 0];

    initialize(): void {}

    resize(): void {}

    render(ctx: PassRenderContext): void {
        const k = 0.5 + 0.5 * Math.sin(this.time);
        const [r, g, b] = [0, 1, 2].map((i) => this.from[i]! + (this.to[i]! - this.from[i]!) * k) as StrictColorRgb;
        const pass = ctx.encoder.beginRenderPass({
            colorAttachments: [
                {
                    view: ctx.outputs.pulse!,
                    clearValue: {r, g, b, a: 1},
                    loadOp: "clear",
                    storeOp: "store",
                },
            ],
        });
        pass.end();
    }
}
