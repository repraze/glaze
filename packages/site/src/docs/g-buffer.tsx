import {
    BlitPass,
    DeferredScenePass,
    DirectionalLight,
    Mesh,
    PBRMaterial,
    PerspectiveCamera,
    RenderGraph,
    Scene,
    SplitViewPass,
} from "@repraze/glaze";
import {vec3} from "gl-matrix";
import {useState} from "react";

import {ControlSegmented, ControlSelect, ControlSwitch, DemoStage} from "@/glaze/demo-stage";
import {GlazeCanvas, useLatest} from "@/glaze/glaze-canvas";
import {makeShape, type ShapeKind, SHAPES} from "@/glaze/helpers";
import {paletteBinder, useSceneColors} from "@/glaze/scene-colors";
import {Code, defineDoc} from "@/lib/doc-kit";

export const doc = defineDoc({
    title: "G-buffer",
    category: "Pipeline",
    description:
        "The deferred pass first writes what every pixel is made of (base color, normal, position, emission, material scalars, depth) into textures, then lights from those. Each texture is an output slot: read it for debugging, SSAO, outlines or any effect of your own.",
    engineFile: "passes/deferred-scene-pass.ts",
    order: 5,
    demos: [
        {
            title: "G-buffer viewer",
            description:
                "Ported from the repraze.com lab: SplitViewPass draws four G-buffer outputs into the four quarters of the canvas (albedo, normal, world position, emission).",
            component: Viewer,
            layout: "full",
        },
        {
            title: "One channel",
            description:
                "A BlitPass whose input slot is wired to the chosen output: the graph decides what reaches the canvas.",
            component: OneChannel,
            layout: "full",
        },
    ],
    notes: Notes,
    sections: [{id: "reading-the-g-buffer", title: "Reading the G-buffer"}],
    props: [
        {
            component: "G-buffer layout",
            rows: [
                {
                    name: "albedo",
                    type: "rgba8unorm",
                    description: "rgb: base color × albedo map · a: ambient occlusion (ORM r).",
                },
                {
                    name: "normal",
                    type: "rgba16float",
                    description: "rgb: world-space normal (normal map applied) · a: roughness.",
                },
                {name: "worldPos", type: "rgba16float", description: "rgb: world-space position · a: metallic."},
                {
                    name: "emissive",
                    type: "rgba16float",
                    description: "rgb: emission × intensity · a: receives shadow (0/1).",
                },
                {name: "depth", type: "depth24plus", description: "Hardware depth; sample it as texture_depth_2d."},
            ],
        },
        {
            component: "SplitViewPassOptions",
            rows: [
                {
                    name: "slots",
                    type: "{input: string; rect: ViewportRect}[]",
                    description: "Each slot draws one input texture into a rectangle of the canvas.",
                },
                {
                    name: "rect",
                    type: "{x, y, w, h}",
                    description: "Normalised 0-1, from the top-left corner (Unity's Camera.rect convention).",
                },
            ],
        },
    ],
});

function Notes() {
    return (
        <section id="reading-the-g-buffer" className="flex scroll-mt-24 flex-col gap-3">
            <h2 className="font-mono text-xl font-semibold">Reading the G-buffer</h2>
            <p className="text-sm text-muted-foreground">
                The outputs are ordinary handles. A ShaderPass that needs normals and depth just declares them:
            </p>
            <Code
                code={`const {color, normal, depth} = graph.addPass(scenePass);
const outline = new ShaderPass({
    fragmentShader: OUTLINE_WGSL, // samples color, normal and depth
    inputs: [{name: "color"}, {name: "normal"}, {name: "depth", depth: true}],
});
graph.addPass(outline, {color, normal, depth}, {canvasSlot: "canvas"});`}
            />
        </section>
    );
}

export function Viewer() {
    const colors = useSceneColors();
    const [shape, setShape] = useState<ShapeKind>("torus");
    const [flat, setFlat] = useState(false);
    const live = useLatest({shape, flat});
    return (
        <DemoStage
            controls={
                <>
                    <ControlSelect label="Shape" value={shape} options={SHAPES} onChange={setShape} />
                    <ControlSwitch label="Flat shading" checked={flat} onChange={setFlat} />
                </>
            }
        >
            <GlazeCanvas
                label="Four views of one shape: its base color, its normals, its world positions and its emission"
                setup={({orbitControls}) => {
                    const scene = new Scene();
                    const palette = paletteBinder(colors);
                    palette.scene(scene);
                    vec3.set(scene.environmentColor, 0, 0, 0);
                    const camera = new PerspectiveCamera({fov: Math.PI / 3});
                    scene.add(camera);
                    scene.activeCamera = camera;
                    orbitControls(camera, {distance: 4, elevation: 20, spin: 17});
                    scene.add(
                        palette.light(
                            new DirectionalLight({direction: [-0.5, -0.8, -0.3], intensity: 4}),
                            (c) => c.key,
                        ),
                    );

                    const material = palette.emissive(
                        palette.material(new PBRMaterial({roughness: 0.4, metallic: 0.3}), (c) => c.hues.red),
                        (c) => c.hues.purple,
                        0.4,
                    );
                    let key = "";
                    let mesh: Mesh | null = null;

                    const scenePass = new DeferredScenePass({scene});
                    const split = new SplitViewPass({
                        slots: [
                            // albedo and emissive are light (encoded for the screen), normals and positions data
                            {input: "albedo", rect: {x: 0, y: 0, w: 0.5, h: 0.5}, colorSpace: "linear-srgb"},
                            {input: "normal", rect: {x: 0.5, y: 0, w: 0.5, h: 0.5}},
                            {input: "worldPos", rect: {x: 0, y: 0.5, w: 0.5, h: 0.5}},
                            {input: "emissive", rect: {x: 0.5, y: 0.5, w: 0.5, h: 0.5}, colorSpace: "linear-srgb"},
                        ],
                    });
                    const graph = new RenderGraph();
                    const {albedo, normal, worldPos, emissive} = graph.addPass(scenePass);
                    graph.addPass(split, {albedo, normal, worldPos, emissive}, {canvasSlot: "canvas"});

                    return ({time}) => {
                        palette.apply();
                        const {shape, flat} = live.current;
                        if (`${shape}:${flat}` !== key) {
                            if (mesh) {
                                scene.remove(mesh);
                            }
                            mesh = new Mesh(makeShape(shape, flat), material);
                            scene.add(mesh);
                            key = `${shape}:${flat}`;
                        }
                        mesh!.setEuler(0, time * 0.5, 0);
                        return graph;
                    };
                }}
            />
        </DemoStage>
    );
}

export function OneChannel() {
    const colors = useSceneColors();
    const [channel, setChannel] = useState<Channel>("normal");
    const live = useLatest(channel);
    return (
        <DemoStage
            controls={<ControlSegmented label="Output" value={channel} options={CHANNELS} onChange={setChannel} />}
        >
            <GlazeCanvas
                label="One G-buffer output of a rotating shape, shown full size"
                setup={({orbitControls}) => {
                    const scene = new Scene();
                    const palette = paletteBinder(colors);
                    palette.scene(scene);
                    const camera = new PerspectiveCamera({fov: Math.PI / 3});
                    orbitControls(camera, {distance: 3.6, elevation: 25});
                    scene.add(camera);
                    scene.activeCamera = camera;
                    scene.add(
                        palette.light(
                            new DirectionalLight({direction: [-0.5, -0.8, -0.3], intensity: 3}),
                            (c) => c.key,
                        ),
                    );
                    const mesh = new Mesh(
                        makeShape("icosphere", true),
                        palette.emissive(
                            palette.material(new PBRMaterial({roughness: 0.6}), (c) => c.accent),
                            (c) => c.accentFill,
                            0.3,
                        ),
                    );
                    scene.add(mesh);

                    const scenePass = new DeferredScenePass({scene});
                    // light is tone mapped and encoded; normals and positions are shown as stored
                    const lightBlit = new BlitPass({input: "source", toneMapping: "aces"});
                    const dataBlit = new BlitPass({input: "source", inputColorSpace: "srgb"});
                    return ({time}) => {
                        palette.apply();
                        mesh.setEuler(time * 0.3, time * 0.5, 0);
                        const graph = new RenderGraph();
                        const outputs = graph.addPass(scenePass);
                        const data = live.current === "normal" || live.current === "worldPos";
                        graph.addPass(
                            data ? dataBlit : lightBlit,
                            {source: outputs[live.current]},
                            {canvasSlot: "canvas"},
                        );
                        return graph;
                    };
                }}
            />
        </DemoStage>
    );
}

type Channel = "color" | "albedo" | "normal" | "worldPos";

const CHANNELS: {value: Channel; label: string}[] = [
    {value: "color", label: "Lit"},
    {value: "albedo", label: "Albedo"},
    {value: "normal", label: "Normal"},
    {value: "worldPos", label: "Position"},
];
