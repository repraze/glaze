import {
    BlitPass,
    createCube,
    DeferredScenePass,
    DirectionalLight,
    Mesh,
    PBRMaterial,
    PerspectiveCamera,
    RenderGraph,
    Scene,
    Texture,
} from "@repraze/glaze";
import {vec3} from "gl-matrix";
import {useState} from "react";

import {ControlSegmented, ControlSelect, DemoStage} from "@/glaze/demo-stage";
import {GlazeCanvas, useLatest} from "@/glaze/glaze-canvas";
import {type EnvironmentId, ENVIRONMENTS, makeEnvironments, makePattern, orbit, type PatternId} from "@/glaze/helpers";
import {paletteBinder, useSceneColors} from "@/glaze/scene-colors";
import {Code, defineDoc} from "@/lib/doc-kit";

export const doc = defineDoc({
    title: "Textures",
    category: "Assets",
    description:
        "Texture wraps an rgba8unorm GPU texture with its view: from raw pixels, an image URL or a Blob. Use one as a material map, or as the scene's equirectangular environment and background.",
    engineFile: "texture.ts",
    order: 0,
    demos: [
        {
            title: "From pixels",
            description:
                "Test patterns generated on the CPU (the dithering lab's) and uploaded with Texture.fromPixels, swapped in as the albedo map. The environments are pixel gradients too.",
            component: FromPixels,
            layout: "full",
        },
        {
            title: "From a canvas",
            description:
                "A 2D canvas drawn with the site's fonts, turned into a Blob and uploaded with Texture.fromBlob: any image the browser can decode works.",
            component: FromCanvas,
            layout: "full",
        },
    ],
    notes: Notes,
    sections: [{id: "environment-maps", title: "Environment maps"}],
    props: [
        {
            component: "Texture",
            rows: [
                {
                    name: "Texture.fromPixels(device, data, width, height)",
                    type: "Texture",
                    description: "Uint8Array of RGBA bytes, row by row.",
                },
                {
                    name: "Texture.fromURL(device, url)",
                    type: "Promise<Texture>",
                    description: "Fetch and decode an image.",
                },
                {
                    name: "Texture.fromBlob(device, blob)",
                    type: "Promise<Texture>",
                    description: "Decode with createImageBitmap.",
                },
                {name: "view", type: "GPUTextureView", description: "Bound by materials and the scene pass."},
                {name: "destroy()", type: "void", description: "Free the GPU texture."},
            ],
        },
    ],
});

function Notes() {
    return (
        <section id="environment-maps" className="flex scroll-mt-24 flex-col gap-3">
            <h2 className="font-mono text-xl font-semibold">Environment maps</h2>
            <p className="text-sm text-muted-foreground">
                The scene pass samples environment and background maps as equirectangular images (longitude across,
                latitude down, 2:1). The environment lights rough surfaces and shows in reflections; environmentColor
                scales it.
            </p>
            <Code
                code={`const sky = await Texture.fromURL(renderer.device, "/sky-2k.jpg");
scene.environmentMap = sky;
scene.backgroundMap = sky;
vec3.set(scene.environmentColor, 0.8, 0.8, 0.8);`}
            />
        </section>
    );
}

export function FromPixels() {
    const colors = useSceneColors();
    const [pattern, setPattern] = useState<PatternId>("checker");
    const [environment, setEnvironment] = useState<EnvironmentId>("sky");
    const live = useLatest({pattern, environment});
    return (
        <DemoStage
            controls={
                <>
                    <ControlSegmented label="Albedo map" value={pattern} options={PATTERNS} onChange={setPattern} />
                    <ControlSelect
                        label="Environment"
                        value={environment}
                        options={ENVIRONMENTS}
                        onChange={setEnvironment}
                    />
                </>
            }
        >
            <GlazeCanvas
                label="A cube wrapped in a greyscale pattern, in front of a gradient sky"
                setup={({renderer}) => {
                    const size = 128;
                    const patterns = new Map(
                        PATTERNS.map((p) => [
                            p.value,
                            Texture.fromPixels(renderer.device, makePattern(p.value, size), size, size),
                        ]),
                    );
                    const environments = makeEnvironments(renderer.device);

                    const scene = new Scene();

                    const palette = paletteBinder(colors);

                    palette.scene(scene);
                    const camera = new PerspectiveCamera({fov: Math.PI / 4});
                    orbit(camera, {distance: 4, elevation: 25});
                    scene.add(camera);
                    scene.activeCamera = camera;
                    scene.add(
                        palette.light(new DirectionalLight({direction: [-0.5, -1, -0.6], intensity: 3}), (c) => c.key),
                    );
                    const material = palette.material(new PBRMaterial({roughness: 0.5}), (c) => c.accentFill);
                    const cube = new Mesh(createCube({size: 1.3}), material);
                    scene.add(cube);

                    const graph = new RenderGraph();
                    const {color} = graph.addPass(new DeferredScenePass({scene}));
                    graph.addPass(new BlitPass({toneMapping: "aces"}), {color}, {canvasSlot: "canvas"});
                    return ({time}) => {
                        palette.apply();
                        material.albedoMap = patterns.get(live.current.pattern) ?? null;
                        const env = environments.get(live.current.environment) ?? null;
                        scene.environmentMap = env;
                        scene.backgroundMap = env;
                        vec3.set(cube.rotation, 0.3, time * 0.4, 0);
                        return graph;
                    };
                }}
            />
        </DemoStage>
    );
}

const PATTERNS: {value: PatternId; label: string}[] = [
    {value: "checker", label: "Checker"},
    {value: "grid", label: "Grid"},
    {value: "stripes", label: "Stripes"},
];

export function FromCanvas() {
    const colors = useSceneColors();
    return (
        <DemoStage>
            <GlazeCanvas
                label="A cube whose faces read Glaze in the site's accent color"
                setup={async ({renderer}) => {
                    // draw a label with the 2D API, then decode it into a GPU texture
                    const label = new OffscreenCanvas(256, 256);
                    const ctx = label.getContext("2d")!;
                    // the shape factories use GL-style UVs (v up) and images upload top row first: flip the label
                    ctx.translate(0, 256);
                    ctx.scale(1, -1);
                    // drawn once with the theme of the moment (a texture, not per-frame state)
                    const c = colors.current;
                    ctx.fillStyle = c.background;
                    ctx.fillRect(0, 0, 256, 256);
                    ctx.strokeStyle = c.accent;
                    ctx.lineWidth = 12;
                    ctx.strokeRect(16, 16, 224, 224);
                    ctx.fillStyle = c.accent;
                    ctx.font = "600 56px 'JetBrains Mono Variable', monospace";
                    ctx.textAlign = "center";
                    ctx.textBaseline = "middle";
                    ctx.fillText("Glaze", 128, 128);
                    const texture = await Texture.fromBlob(renderer.device, await label.convertToBlob());

                    const scene = new Scene();

                    const palette = paletteBinder(colors);

                    palette.scene(scene);
                    const camera = new PerspectiveCamera({fov: Math.PI / 4});
                    orbit(camera, {distance: 4, elevation: 20});
                    scene.add(camera);
                    scene.activeCamera = camera;
                    scene.add(
                        palette.light(
                            new DirectionalLight({direction: [-0.4, -0.6, -1], intensity: 2.5}),
                            (c) => c.key,
                        ),
                    );
                    const material = new PBRMaterial({roughness: 0.6}); // white base: the map is the color
                    material.albedoMap = texture;
                    const cube = new Mesh(createCube({size: 1.4}), material);
                    scene.add(cube);

                    const graph = new RenderGraph();
                    const {color} = graph.addPass(new DeferredScenePass({scene}));
                    graph.addPass(new BlitPass(), {color}, {canvasSlot: "canvas"});
                    return ({time}) => {
                        palette.apply();
                        vec3.set(cube.rotation, 0.25, time * 0.5, 0);
                        return graph;
                    };
                }}
            />
        </DemoStage>
    );
}
