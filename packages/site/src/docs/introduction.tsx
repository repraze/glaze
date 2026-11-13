import {
    BlitPass,
    DeferredScenePass,
    DirectionalLight,
    type Entity,
    loadGltf,
    Mesh,
    PerspectiveCamera,
    PointerInput,
    RenderGraph,
    Scene,
    SpotLight,
} from "@repraze/glaze";
import {Badge} from "@repraze/kernelkit/components/badge";
import {
    CardAction,
    CardDescription,
    CardHeader,
    CardTitle,
    LinkCard,
    LinkCardArrow,
} from "@repraze/kernelkit/components/card";
import {Spinner} from "@repraze/kernelkit/components/spinner";
import {Link} from "@tanstack/react-router";
import {vec3} from "gl-matrix";
import {useState} from "react";

import {PipelineDiagram} from "@/components/pipeline-diagram";
import {ControlSwitch, DemoStage} from "@/glaze/demo-stage";
import {GlazeCanvas, useLatest} from "@/glaze/glaze-canvas";
import {makeEnvironments} from "@/glaze/helpers";
import {paletteBinder, useSceneColors} from "@/glaze/scene-colors";
import {Code, defineDoc} from "@/lib/doc-kit";

export const doc = defineDoc({
    title: "Introduction",
    category: "Foundations",
    description:
        "GlazeEngine is a WebGPU-only rendering engine: a renderer, a graph of composable render passes, a deferred PBR scene pass, lights with shadows, materials, geometry and loaders. Typed classes and WGSL, no WebGL path.",
    order: 0,
    demos: [
        {
            title: "At a glance",
            description:
                "A donut loaded from one glTF file: named nodes, 140 sprinkles sharing one geometry, a baked dough texture and a lace doily cut by an alpha mask. Toggle parts by name, flick sprinkles off with a click, drag to orbit.",
            component: Glance,
            layout: "full",
        },
    ],
    notes: Notes,
    sections: [
        {id: "the-frame", title: "The frame"},
        {id: "principles", title: "Principles"},
        {id: "where-next", title: "Where next"},
    ],
});

const NEXT = [
    {slug: "installation", title: "Installation", description: "The package, its types and the browsers that run it."},
    {slug: "getting-started", title: "Getting started", description: "From a canvas to a lit, animated scene."},
    {slug: "pass-chain", title: "Pass chain", description: "How passes read and write textures, frame by frame."},
    {slug: "deferred-scene-pass", title: "DeferredScenePass", description: "The 3D renderer: G-buffer, shadows, PBR."},
] as const;

function Notes() {
    return (
        <div className="flex flex-col gap-8">
            <section id="the-frame" className="flex scroll-mt-24 flex-col gap-3">
                <h2 className="font-mono text-xl font-semibold">The frame</h2>
                <p className="text-sm text-muted-foreground">
                    Every frame, the <code className="font-mono text-foreground">Renderer</code> runs a{" "}
                    <code className="font-mono text-foreground">RenderGraph</code>: passes in the order they were added,
                    each reading named textures from the passes before it and writing its own. The renderer creates,
                    sizes and wires those textures; a pass only declares what it reads and writes.
                </p>
                <PipelineDiagram />
                <Code
                    code={`const renderer = await Renderer.init(canvas);

const graph = new RenderGraph();
const {color} = graph.addPass(new DeferredScenePass({scene}));
graph.addPass(new BlitPass({toneMapping: "aces"}), {color}, {canvasSlot: "canvas"});

const stop = renderer.startAnimation(graph);`}
                />
            </section>
            <section id="principles" className="flex scroll-mt-24 flex-col gap-3">
                <h2 className="font-mono text-xl font-semibold">Principles</h2>
                <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-muted-foreground">
                    <li>
                        WebGPU only: WGSL shaders, bind groups and render passes, with no WebGL path to keep in step.
                    </li>
                    <li>Composable passes: a pass is a class with named inputs and outputs; the graph wires them.</li>
                    <li>Deferred PBR for 3D: one G-buffer, many lights, shadows, image-based ambient.</li>
                    <li>Neutral color: what you write is what the canvas shows, conversions are explicit.</li>
                    <li>Plain classes and gl-matrix vectors: mutate a property, the next frame uses it.</li>
                </ul>
            </section>
            <section id="where-next" className="flex scroll-mt-24 flex-col gap-3">
                <h2 className="font-mono text-xl font-semibold">Where next</h2>
                <div className="grid gap-4 sm:grid-cols-2">
                    {NEXT.map((item) => (
                        <LinkCard
                            key={item.slug}
                            render={<Link to="/docs/$slug" params={{slug: item.slug}} />}
                            className="h-full"
                        >
                            <CardHeader>
                                <CardTitle>{item.title}</CardTitle>
                                <CardDescription>{item.description}</CardDescription>
                                <CardAction>
                                    <LinkCardArrow />
                                </CardAction>
                            </CardHeader>
                        </LinkCard>
                    ))}
                </div>
            </section>
        </div>
    );
}

const DONUT_URL = `${import.meta.env.BASE_URL}models/donut/donut.glb`;

const PARTS = ["Icing", "Sprinkles", "Doily"] as const;

export function Glance() {
    const colors = useSceneColors();
    const [parts, setParts] = useState<Record<(typeof PARTS)[number], boolean>>({
        Icing: true,
        Sprinkles: true,
        Doily: true,
    });
    const [status, setStatus] = useState<string[] | null>(null);
    const [flicked, setFlicked] = useState(0);
    const live = useLatest(parts);
    return (
        <DemoStage
            controls={
                <>
                    {PARTS.map((name) => (
                        <ControlSwitch
                            key={name}
                            label={name}
                            checked={parts[name]}
                            onChange={(on) => setParts((p) => ({...p, [name]: on}))}
                        />
                    ))}
                    <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                        {status === null ? (
                            <Spinner />
                        ) : (
                            status.map((fact) => (
                                <Badge key={fact} variant="outline">
                                    {fact}
                                </Badge>
                            ))
                        )}
                    </div>
                    <p className="text-sm text-muted-foreground" aria-live="polite">
                        {flicked === 0
                            ? "Click a sprinkle to flick it off."
                            : `${flicked} sprinkle${flicked === 1 ? "" : "s"} flicked.`}
                    </p>
                </>
            }
        >
            <GlazeCanvas
                label="A glazed donut with pink icing and sprinkles on a lace doily, loaded from a glTF file"
                setup={async ({renderer, canvas, orbitControls}) => {
                    const started = performance.now();
                    const scene = new Scene();
                    const palette = paletteBinder(colors);
                    palette.scene(scene);
                    // reflections for the glossy icing (the sky isn't shown: the page's background stays)
                    scene.environmentMap = makeEnvironments(renderer.device).get("sky") ?? null;
                    vec3.set(scene.environmentColor, 0.55, 0.55, 0.6);

                    const camera = new PerspectiveCamera({fov: Math.PI / 4, near: 0.05, far: 50});
                    scene.add(camera);
                    scene.activeCamera = camera;
                    orbitControls(camera, {distance: 3.6, elevation: 38, target: [0, 0.2, 0], spin: 9});

                    // a spot light for crisp shadows: sprinkles on the icing, the donut on the lace
                    const key = palette.light(
                        new SpotLight({
                            intensity: 14,
                            range: 14,
                            outerAngle: Math.PI / 7,
                            innerAngle: Math.PI / 12,
                            castShadow: true,
                        }),
                        (c) => c.key,
                    );
                    vec3.set(key.position, 2.2, 4.2, 1.6);
                    key.lookAt([0, 0, 0]);
                    const fill = palette.light(
                        new DirectionalLight({direction: [0.7, -0.4, -0.6], intensity: 0.8}),
                        (c) => c.fill,
                    );
                    scene.add(key).add(fill);

                    const model = await loadGltf(renderer.device, DONUT_URL);
                    scene.add(model.root);
                    const doily = model.root.find("Doily");
                    if (doily instanceof Mesh) {
                        doily.castShadow = false; // flat under everything: nothing to shade
                    }
                    const loadMs = Math.round(performance.now() - started);
                    setStatus([
                        `${model.nodes.length} nodes`,
                        `${model.meshes.length} meshes`,
                        `${model.materials.length} materials`,
                        `${loadMs} ms`,
                    ]);

                    // flick sprinkles: picking works on loaded meshes like any other
                    const input = new PointerInput(canvas, {scene});
                    const flying: {mesh: Entity; velocity: vec3; spin: number}[] = [];
                    const sprinkles = model.root.find("Sprinkles")!;
                    for (const sprinkle of sprinkles.children) {
                        input.on(sprinkle, "pointerenter", () => (canvas.style.cursor = "pointer"));
                        input.on(sprinkle, "pointerleave", () => (canvas.style.cursor = ""));
                        input.on(sprinkle, "click", (e) => {
                            e.stopPropagation();
                            sprinkle.collider = null; // can't be clicked twice
                            const out = e.hit?.normal ?? vec3.fromValues(0, 1, 0);
                            flying.push({
                                mesh: sprinkle,
                                velocity: vec3.fromValues(out[0] * 1.5, 2.2, out[2] * 1.5),
                                spin: 12 + Math.random() * 10,
                            });
                            setFlicked((n) => n + 1);
                        });
                    }

                    const graph = new RenderGraph();
                    const {color} = graph.addPass(new DeferredScenePass({scene}));
                    graph.addPass(new BlitPass({toneMapping: "aces"}), {color}, {canvasSlot: "canvas"});

                    return ({delta}) => {
                        palette.apply();
                        for (const name of PARTS) {
                            model.root.find(name)!.enabled = live.current[name];
                        }
                        for (let i = flying.length - 1; i >= 0; i--) {
                            const f = flying[i]!;
                            f.velocity[1] -= 9.8 * delta;
                            vec3.scaleAndAdd(f.mesh.position, f.mesh.position, f.velocity, delta);
                            f.mesh.rotateZ(f.spin * delta);
                            if (f.mesh.position[1] < -3) {
                                f.mesh.enabled = false;
                                flying.splice(i, 1);
                            }
                        }
                        return graph;
                    };
                }}
            />
        </DemoStage>
    );
}
