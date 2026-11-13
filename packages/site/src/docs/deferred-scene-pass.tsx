import {
    BlitPass,
    createCone,
    createCube,
    createPlane,
    createSphere,
    createTorus,
    DeferredScenePass,
    DirectionalLight,
    Mesh,
    PBRMaterial,
    PerspectiveCamera,
    PointLight,
    RenderGraph,
    Scene,
} from "@repraze/glaze";
import {vec3} from "gl-matrix";
import {useState} from "react";

import {PipelineDiagram} from "@/components/pipeline-diagram";
import {ControlSelect, ControlSlider, ControlSwitch, DemoStage} from "@/glaze/demo-stage";
import {GlazeCanvas, useLatest} from "@/glaze/glaze-canvas";
import {type EnvironmentId, ENVIRONMENTS, makeEnvironments, orbit} from "@/glaze/helpers";
import {paletteBinder, useSceneColors} from "@/glaze/scene-colors";
import {Code, defineDoc} from "@/lib/doc-kit";

export const doc = defineDoc({
    title: "DeferredScenePass",
    category: "Pipeline",
    description:
        "The 3D renderer. It draws the scene's meshes into a G-buffer, renders shadow maps for lights that cast them, then shades every pixel once with all lights, image-based ambient and emission. Its lit color and its G-buffer are outputs any later pass can read.",
    engineFile: "passes/deferred-scene-pass.ts",
    order: 4,
    demos: [
        {
            title: "Lit scene",
            description:
                "A sun with shadows, two point lights, an environment map for ambient and reflections, then ACES tone mapping. Every control is a property the pass reads on the next frame.",
            component: LitScene,
            layout: "full",
        },
        {
            title: "Straight to the canvas",
            description:
                "With colorFormat set to the canvas format and canvasSlot 'color', the pass is the whole graph: no blit, no tone mapping (values above 1 clip).",
            component: Direct,
            layout: "full",
        },
    ],
    notes: Notes,
    sections: [
        {id: "stages", title: "Stages"},
        {id: "scene-inputs", title: "Scene inputs"},
    ],
    props: [
        {
            component: "DeferredScenePassOptions",
            rows: [
                {name: "scene", type: "Scene", description: "Read every frame: meshes, lights, camera, colors, maps."},
                {
                    name: "colorFormat",
                    type: "GPUTextureFormat",
                    default: '"rgba16float"',
                    description:
                        "Format of the 'color' output. Use renderer.format to render it straight to the canvas.",
                },
            ],
        },
        {
            component: "Outputs",
            rows: [
                {name: "color", type: "colorFormat", description: "The lit scene (HDR by default)."},
                {name: "albedo", type: "rgba8unorm", description: "rgb base color, a ambient occlusion."},
                {name: "normal", type: "rgba16float", description: "rgb world normal, a roughness."},
                {name: "worldPos", type: "rgba16float", description: "rgb world position, a metallic."},
                {name: "emissive", type: "rgba16float", description: "rgb emission, a receives shadow."},
                {name: "depth", type: "depth24plus", description: "Bind with {depth: true} in a ShaderPass input."},
            ],
        },
        {
            component: "Limits",
            rows: [
                {
                    name: "DirectionalLight",
                    type: "4",
                    description: "Shadow maps: 1024², orthographic ±12 units around the origin.",
                },
                {name: "PointLight", type: "8", description: "Shadows render six faces per light."},
                {name: "SpotLight", type: "4", description: "One perspective shadow map per light."},
            ],
        },
    ],
});

function Notes() {
    return (
        <div className="flex flex-col gap-8">
            <section id="stages" className="flex scroll-mt-24 flex-col gap-3">
                <h2 className="font-mono text-xl font-semibold">Stages</h2>
                <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm text-muted-foreground">
                    <li>Shadow maps for every light with castShadow, from meshes with castShadow.</li>
                    <li>
                        G-buffer: each mesh writes albedo, normal, position, emission and material scalars. Normal maps
                        and parallax occlusion pick a compiled pipeline variant per material.
                    </li>
                    <li>
                        Lighting: one fullscreen pass reads the G-buffer and sums Cook-Torrance BRDF contributions from
                        every light, plus the environment for ambient and specular reflection.
                    </li>
                </ol>
                <PipelineDiagram highlight="deferred" />
            </section>
            <section id="scene-inputs" className="flex scroll-mt-24 flex-col gap-3">
                <h2 className="font-mono text-xl font-semibold">Scene inputs</h2>
                <Code
                    code={`setColorRgb(scene.backgroundColor, "#0c0c10"); // behind everything (without backgroundMap)
setColorRgb(scene.ambientColor, "#202024");    // flat ambient term
scene.environmentMap = sky;                     // equirectangular Texture: reflections and ambient
scene.backgroundMap = sky;                      // drawn behind the scene
vec3.set(scene.environmentColor, 1, 1, 1);      // environment tint and intensity
scene.activeCamera = camera;`}
                />
            </section>
        </div>
    );
}

export function LitScene() {
    const colors = useSceneColors();
    const [shadows, setShadows] = useState(true);
    const [points, setPoints] = useState(true);
    const [environment, setEnvironment] = useState<EnvironmentId>("city");
    const [envIntensity, setEnvIntensity] = useState(0.6);
    const live = useLatest({shadows, points, environment, envIntensity});
    return (
        <DemoStage
            controls={
                <>
                    <ControlSwitch label="Sun shadows" checked={shadows} onChange={setShadows} />
                    <ControlSwitch label="Point lights" checked={points} onChange={setPoints} />
                    <ControlSelect
                        label="Environment"
                        value={environment}
                        options={ENVIRONMENTS}
                        onChange={setEnvironment}
                    />
                    <ControlSlider
                        label="Environment intensity"
                        value={envIntensity}
                        onChange={setEnvIntensity}
                        min={0}
                        max={2}
                        step={0.05}
                    />
                </>
            }
        >
            <GlazeCanvas
                label="A small still life of a torus, a cube, a cone and a sphere on a floor, lit by a sun and two colored lights"
                setup={({renderer}) => {
                    const environments = makeEnvironments(renderer.device);
                    const scene = new Scene();
                    const palette = paletteBinder(colors);
                    palette.scene(scene);
                    const camera = new PerspectiveCamera({fov: Math.PI / 4});
                    scene.add(camera);
                    scene.activeCamera = camera;

                    const sun = palette.light(
                        new DirectionalLight({direction: [-0.6, -1, -0.5], intensity: 3}),
                        (c) => c.key,
                    );
                    scene.add(sun);
                    const warm = palette.light(new PointLight({intensity: 6, range: 6}), (c) => c.accent);
                    const cool = palette.light(new PointLight({intensity: 6, range: 6}), (c) => c.hues.cyan);
                    scene.add(warm).add(cool);

                    const floor = new Mesh(
                        createPlane({width: 12, height: 12}),
                        palette.material(new PBRMaterial({roughness: 0.85}), (c) => c.floor),
                    );
                    floor.castShadow = false;
                    scene.add(floor);
                    const props: [Mesh, [number, number, number]][] = [
                        [
                            new Mesh(
                                createTorus({radius: 0.55, tube: 0.22, radialSegments: 32, tubularSegments: 64}),
                                palette.material(new PBRMaterial({roughness: 0.25}), (c) => c.accent),
                            ),
                            [-1.4, 0.75, 0],
                        ],
                        [
                            new Mesh(
                                createCube({size: 1}),
                                palette.material(new PBRMaterial({roughness: 0.15, metallic: 1}), (c) => c.neutral),
                            ),
                            [0, 0.5, -0.8],
                        ],
                        [
                            new Mesh(
                                createCone({radius: 0.5, height: 1.2, radialSegments: 32}),
                                palette.material(new PBRMaterial({roughness: 0.5}), (c) => c.hues.purple),
                            ),
                            [1.4, 0.6, 0],
                        ],
                        [
                            new Mesh(
                                createSphere({radius: 0.45, widthSegments: 32, heightSegments: 16}),
                                palette.material(new PBRMaterial({roughness: 0.1, metallic: 1}), (c) => c.hues.yellow),
                            ),
                            [0.2, 0.45, 1],
                        ],
                    ];
                    for (const [mesh, [x, y, z]] of props) {
                        vec3.set(mesh.position, x, y, z);
                        scene.add(mesh);
                    }

                    const graph = new RenderGraph();
                    const {color} = graph.addPass(new DeferredScenePass({scene}));
                    graph.addPass(new BlitPass({toneMapping: "aces"}), {color}, {canvasSlot: "canvas"});

                    return ({time}) => {
                        palette.apply();
                        const cfg = live.current;
                        orbit(camera, {distance: 6.5, elevation: 28, azimuth: time * 8, target: [0, 0.4, 0]});
                        sun.castShadow = cfg.shadows;
                        warm.enabled = cool.enabled = cfg.points;
                        vec3.set(warm.position, Math.cos(time) * 2.2, 1.2, Math.sin(time) * 2.2);
                        vec3.set(cool.position, Math.cos(time + Math.PI) * 2.2, 1.6, Math.sin(time + Math.PI) * 2.2);
                        const env = environments.get(cfg.environment) ?? null;
                        scene.environmentMap = env;
                        scene.backgroundMap = env;
                        vec3.set(scene.environmentColor, cfg.envIntensity, cfg.envIntensity, cfg.envIntensity);
                        props[0]![0].setEuler(0, time * 0.6, 0);
                        return graph;
                    };
                }}
            />
        </DemoStage>
    );
}

export function Direct() {
    const colors = useSceneColors();
    return (
        <DemoStage>
            <GlazeCanvas
                label="A metallic orange torus on a dark background, rendered without tone mapping"
                setup={({renderer}) => {
                    const scene = new Scene();
                    const palette = paletteBinder(colors);
                    palette.scene(scene);
                    const camera = new PerspectiveCamera({fov: Math.PI / 4});
                    orbit(camera, {distance: 4, elevation: 20});
                    scene.add(camera);
                    scene.activeCamera = camera;
                    scene.add(
                        palette.light(
                            new DirectionalLight({direction: [-0.5, -1, -0.6], intensity: 2.5}),
                            (c) => c.key,
                        ),
                    );
                    const torus = new Mesh(
                        createTorus({radius: 0.8, tube: 0.3, radialSegments: 48, tubularSegments: 96}),
                        palette.material(new PBRMaterial({roughness: 0.3, metallic: 0.6}), (c) => c.accent),
                    );
                    scene.add(torus);

                    const graph = new RenderGraph();
                    graph.addPass(
                        new DeferredScenePass({scene, colorFormat: renderer.format}),
                        {},
                        {canvasSlot: "color"},
                    );
                    return ({time}) => {
                        palette.apply();
                        torus.setEuler(time * 0.4, time * 0.6, 0);
                        return graph;
                    };
                }}
            />
        </DemoStage>
    );
}
