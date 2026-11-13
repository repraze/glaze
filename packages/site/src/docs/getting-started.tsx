import {
    BlitPass,
    createCube,
    createPlane,
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
import {vec3} from "gl-matrix";

import {DemoStage} from "@/glaze/demo-stage";
import {GlazeCanvas} from "@/glaze/glaze-canvas";
import {paintScene, tint, useSceneColors, wgslColor} from "@/glaze/scene-colors";
import {Code, defineDoc} from "@/lib/doc-kit";

export const doc = defineDoc({
    title: "Getting started",
    category: "Foundations",
    description:
        "From a canvas to an animated, lit scene: initialise the renderer, describe a scene, build a render graph and start the loop.",
    order: 2,
    demos: [
        {
            title: "First frame",
            description: "One ShaderPass straight to the canvas: a fullscreen WGSL fragment, animated by globals.time.",
            component: FirstFrame,
            layout: "full",
        },
        {
            title: "First scene",
            description: "A camera, a light, two meshes and the deferred pass, with a BlitPass to the canvas.",
            component: FirstScene,
            layout: "full",
        },
    ],
    notes: Notes,
    sections: [
        {id: "step-by-step", title: "Step by step"},
        {id: "in-react", title: "In React"},
    ],
});

function Notes() {
    return (
        <div className="flex flex-col gap-8">
            <section id="step-by-step" className="flex scroll-mt-24 flex-col gap-3">
                <h2 className="font-mono text-xl font-semibold">Step by step</h2>
                <p className="text-sm text-muted-foreground">
                    Size the canvas&apos;s drawing buffer, then let{" "}
                    <code className="font-mono text-foreground">Renderer.init</code> request the adapter and device and
                    configure the context:
                </p>
                <Code
                    code={`import {BlitPass, DeferredScenePass, Renderer, RenderGraph, Scene} from "@repraze/glaze";

const canvas = document.querySelector("canvas")!;
canvas.width = canvas.clientWidth * devicePixelRatio;
canvas.height = canvas.clientHeight * devicePixelRatio;

const renderer = await Renderer.init(canvas);`}
                />
                <p className="text-sm text-muted-foreground">
                    Describe the scene, add passes to a graph, and start the loop. The callback form runs before every
                    frame, which is where animation goes:
                </p>
                <Code
                    code={`const graph = new RenderGraph();
const {color} = graph.addPass(new DeferredScenePass({scene}));
graph.addPass(new BlitPass(), {color}, {canvasSlot: "canvas"});

const stop = renderer.startAnimation(() => {
    cube.setEuler(0, performance.now() / 1000, 0);
    return graph;
});`}
                />
                <p className="text-sm text-muted-foreground">
                    Follow the element&apos;s size with a ResizeObserver, and release the device when you are done:
                </p>
                <Code
                    code={`new ResizeObserver(() => {
    canvas.width = canvas.clientWidth * devicePixelRatio;
    canvas.height = canvas.clientHeight * devicePixelRatio;
    renderer.resize(canvas.width, canvas.height);
}).observe(canvas);

// later
stop();
renderer.destroy();`}
                />
            </section>
            <section id="in-react" className="flex scroll-mt-24 flex-col gap-3">
                <h2 className="font-mono text-xl font-semibold">In React</h2>
                <p className="text-sm text-muted-foreground">
                    Initialisation is async, so guard against unmounting before it resolves (StrictMode mounts twice in
                    development). Read changing props through a ref inside the frame callback rather than rebuilding the
                    scene:
                </p>
                <Code
                    code={`function Viewport({speed}: {speed: number}) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const speedRef = useRef(speed);
    speedRef.current = speed;

    useEffect(() => {
        const canvas = canvasRef.current!;
        let renderer: Renderer | undefined;
        let stop: (() => void) | undefined;
        let disposed = false;

        Renderer.init(canvas).then((created) => {
            if (disposed) {
                created.destroy();
                return;
            }
            renderer = created;
            const {scene, cube} = buildScene();
            const graph = new RenderGraph();
            const {color} = graph.addPass(new DeferredScenePass({scene}));
            graph.addPass(new BlitPass(), {color}, {canvasSlot: "canvas"});
            stop = renderer.startAnimation(() => {
                cube.rotateY(0.01 * speedRef.current);
                return graph;
            });
        });

        return () => {
            disposed = true;
            stop?.();
            renderer?.destroy();
        };
    }, []);

    return <canvas ref={canvasRef} className="size-full" />;
}`}
                />
            </section>
        </div>
    );
}

export function FirstFrame() {
    const colors = useSceneColors();
    return (
        <DemoStage>
            <GlazeCanvas
                label="A slow gradient of the site's accent sweeping across the background color"
                setup={() => {
                    // a ShaderPass has no uniforms: bake the palette into the WGSL, one pass per theme
                    const passes = new Map<string, ShaderPass>();
                    const passFor = (background: string, accent: string) => {
                        const key = background + accent;
                        let pass = passes.get(key);
                        if (!pass) {
                            pass = new ShaderPass({
                                fragmentShader: /* wgsl */ `
                                    @fragment
                                    fn fs_main(in: QuadInput) -> @location(0) vec4<f32> {
                                        let t = globals.time * 0.5;
                                        let wave = 0.5 + 0.5 * sin(in.uv.x * 6.0 + t) * cos(in.uv.y * 4.0 - t);
                                        let base = ${wgslColor(background)};
                                        let accent = ${wgslColor(accent)};
                                        return vec4<f32>(mix(base, accent, wave * in.uv.y), 1.0);
                                    }
                                `,
                            });
                            passes.set(key, pass);
                        }
                        return pass;
                    };
                    return () => {
                        const graph = new RenderGraph();
                        graph.addPass(
                            passFor(colors.current.background, colors.current.accent),
                            {},
                            {canvasSlot: "canvas"},
                        );
                        return graph;
                    };
                }}
            />
        </DemoStage>
    );
}

export function FirstScene() {
    const colors = useSceneColors();
    return (
        <DemoStage>
            <GlazeCanvas
                label="A cube in the site's accent color spinning above a floor, casting a shadow"
                setup={({orbitControls}) => {
                    // 1. the scene and a camera
                    const scene = new Scene();
                    const camera = new PerspectiveCamera({fov: Math.PI / 4});
                    orbitControls(camera, {distance: 6, elevation: 30, target: [0, 0.5, 0]});
                    scene.add(camera);
                    scene.activeCamera = camera;

                    // 2. a light that casts shadows
                    const sun = new DirectionalLight({direction: [-0.4, -1, -0.3], intensity: 3, castShadow: true});
                    scene.add(sun);

                    // 3. meshes: geometry + material
                    const ground = new PBRMaterial({roughness: 0.9});
                    scene.add(new Mesh(createPlane({width: 8, height: 8}), ground));
                    const paint = new PBRMaterial({roughness: 0.35});
                    const cube = new Mesh(createCube({size: 1}), paint);
                    vec3.set(cube.position, 0, 1, 0);
                    scene.add(cube);

                    // 4. the graph: render the scene, then tone map it onto the canvas
                    const graph = new RenderGraph();
                    const {color} = graph.addPass(new DeferredScenePass({scene}));
                    graph.addPass(new BlitPass({toneMapping: "aces"}), {color}, {canvasSlot: "canvas"});

                    // 5. per frame: colors from the TermiColor palette, motion, then the graph
                    return ({time}) => {
                        const c = colors.current;
                        paintScene(scene, c);
                        setColorRgb(sun.color, c.key);
                        tint(ground, c.floor);
                        tint(paint, c.accent);
                        cube.setEuler(time * 0.4, time * 0.7, 0);
                        cube.position[1] = 1 + Math.sin(time * 1.5) * 0.25;
                        return graph;
                    };
                }}
            />
        </DemoStage>
    );
}
