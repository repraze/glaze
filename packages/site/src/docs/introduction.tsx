import {
    BlitPass,
    createTorus,
    DeferredScenePass,
    DirectionalLight,
    Mesh,
    PBRMaterial,
    PerspectiveCamera,
    RenderGraph,
    Scene,
    setColorRgb,
} from "@repraze/glaze";
import {
    CardAction,
    CardDescription,
    CardHeader,
    CardTitle,
    LinkCard,
    LinkCardArrow,
} from "@repraze/kernelkit/components/card";
import {Link} from "@tanstack/react-router";
import {vec3} from "gl-matrix";

import {PipelineDiagram} from "@/components/pipeline-diagram";
import {DemoStage} from "@/glaze/demo-stage";
import {GlazeCanvas} from "@/glaze/glaze-canvas";
import {orbit} from "@/glaze/helpers";
import {paintScene, tint, useSceneColors} from "@/glaze/scene-colors";
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
            description: "A torus, two lights and the deferred scene pass, tone mapped to the canvas by a BlitPass.",
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

export function Glance() {
    const colors = useSceneColors();
    return (
        <DemoStage>
            <GlazeCanvas
                label="A torus in the site's accent color turning under a key light"
                setup={() => {
                    const scene = new Scene();
                    vec3.set(scene.environmentColor, 0.25, 0.25, 0.3);

                    const camera = new PerspectiveCamera({fov: Math.PI / 4});
                    orbit(camera, {distance: 4.5, elevation: 25});
                    scene.add(camera);
                    scene.activeCamera = camera;

                    const key = new DirectionalLight({direction: [-0.5, -1, -0.6], intensity: 3});
                    const fill = new DirectionalLight({direction: [0.8, -0.2, 0.4]});
                    scene.add(key).add(fill);

                    const glaze = new PBRMaterial({roughness: 0.25, metallic: 0.1});
                    const donut = new Mesh(
                        createTorus({radius: 0.8, tube: 0.34, radialSegments: 48, tubularSegments: 96}),
                        glaze,
                    );
                    scene.add(donut);

                    const graph = new RenderGraph();
                    const {color} = graph.addPass(new DeferredScenePass({scene}));
                    graph.addPass(new BlitPass(), {color}, {canvasSlot: "canvas"});

                    return ({time}) => {
                        // TermiColor, read every frame: the scene follows the page's mode and accent
                        const c = colors.current;
                        paintScene(scene, c);
                        setColorRgb(key.color, c.key);
                        setColorRgb(fill.color, c.fill);
                        tint(glaze, c.accent);
                        vec3.set(donut.rotation, 0.9 + Math.sin(time * 0.6) * 0.2, time * 0.5, 0);
                        return graph;
                    };
                }}
            />
        </DemoStage>
    );
}
