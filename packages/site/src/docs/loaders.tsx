import {
    BlitPass,
    createPBRMaterialFromGltf,
    DeferredScenePass,
    DirectionalLight,
    Entity,
    loadGLBFromURL,
    Mesh,
    parseOBJ,
    PBRMaterial,
    PerspectiveCamera,
    RenderGraph,
    Scene,
} from "@repraze/glaze";
import {Badge} from "@repraze/kernelkit/components/badge";
import {Spinner} from "@repraze/kernelkit/components/spinner";
import {vec3} from "gl-matrix";
import {useState} from "react";

import {ControlSelect, DemoStage} from "@/glaze/demo-stage";
import {GlazeCanvas, useLatest} from "@/glaze/glaze-canvas";
import {makeEnvironments, orbit} from "@/glaze/helpers";
import {paletteBinder, useSceneColors} from "@/glaze/scene-colors";
import {Code, defineDoc} from "@/lib/doc-kit";

export const doc = defineDoc({
    title: "Loaders",
    category: "Assets",
    description:
        "Parsers for binary glTF (GLB), OBJ and STL that return Geometry, plus URL helpers. GLB primitives come with a GPU-free material descriptor, which createPBRMaterialFromGltf turns into a PBRMaterial with its textures.",
    engineFile: "loaders/glb.ts",
    order: 1,
    demos: [
        {
            title: "GLB model viewer",
            description:
                "Ported from the repraze.com lab: Khronos glTF sample models fetched from GitHub, parsed, given their PBR materials and fitted to the view, under an environment map. Needs network access.",
            component: ModelViewer,
            layout: "full",
        },
        {
            title: "OBJ from text",
            description:
                "parseOBJ on an inline string: positions and faces only, so the parser computes flat normals and tangents.",
            component: ObjFromText,
            layout: "full",
        },
    ],
    notes: Notes,
    sections: [{id: "materials-from-gltf", title: "Materials from glTF"}],
    props: [
        {
            component: "GLB",
            rows: [
                {name: "parseGLB(buffer)", type: "GLBPrimitive[]", description: "One entry per mesh primitive."},
                {
                    name: "loadGLBFromURL(url)",
                    type: "Promise<GLBPrimitive[]>",
                    description: "fetch + parseGLB; throws on HTTP errors.",
                },
                {
                    name: "createPBRMaterialFromGltf(device, descriptor, resolveUri?)",
                    type: "Promise<PBRMaterial>",
                    description:
                        "Factors and maps (base color, normal, emissive, metallic-roughness) from the descriptor.",
                },
                {name: "GLBPrimitive", type: "{geometry; material: GltfMaterialDescriptor | null}"},
            ],
        },
        {
            component: "OBJ and STL",
            rows: [
                {
                    name: "parseOBJ(text)",
                    type: "Geometry",
                    description: "v, vt, vn, f; polygons fan-triangulated; tangents computed.",
                },
                {name: "loadOBJFromURL(url)", type: "Promise<Geometry>"},
                {name: "parseSTL(buffer)", type: "Geometry", description: "Binary or ASCII; face normals, no UVs."},
                {name: "loadSTLFromURL(url)", type: "Promise<Geometry>"},
            ],
        },
    ],
});

function Notes() {
    return (
        <section id="materials-from-gltf" className="flex scroll-mt-24 flex-col gap-3">
            <h2 className="font-mono text-xl font-semibold">Materials from glTF</h2>
            <p className="text-sm text-muted-foreground">
                Parsing needs no GPU, so it can run in a worker or a test. Textures referenced by URI resolve against
                the model&apos;s folder through <code className="font-mono text-foreground">resolveUri</code>; embedded
                images decode from the binary chunk.
            </p>
            <Code
                code={`const primitives = await loadGLBFromURL(url);
const base = url.slice(0, url.lastIndexOf("/") + 1);
for (const {geometry, material} of primitives) {
    const pbr = material
        ? await createPBRMaterialFromGltf(renderer.device, material, (uri) => base + uri)
        : new PBRMaterial();
    scene.add(new Mesh(geometry, pbr));
}`}
            />
        </section>
    );
}

export function ModelViewer() {
    const colors = useSceneColors();
    const [model, setModel] = useState(MODELS[0]!.value);
    const [status, setStatus] = useState<{state: "loading" | "ready" | "failed"; detail?: string}>({state: "loading"});
    const live = useLatest(model);
    return (
        <DemoStage
            controls={
                <>
                    <ControlSelect
                        label="Model"
                        value={model}
                        options={MODELS}
                        onChange={(next) => {
                            setModel(next);
                            setStatus({state: "loading"});
                        }}
                    />
                    <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                        {status.state === "loading" ? <Spinner /> : null}
                        {status.state === "ready" ? <Badge variant="outline">{status.detail}</Badge> : null}
                        {status.state === "failed" ? (
                            <Badge color="danger" variant="soft">
                                {status.detail}
                            </Badge>
                        ) : null}
                    </div>
                    <p className="text-xs text-muted-foreground">
                        Khronos glTF-Sample-Assets (CC0 / CC BY 4.0 / SCEA, see their repository).
                    </p>
                </>
            }
        >
            <GlazeCanvas
                label="A glTF sample model turning slowly under two lights"
                setup={({renderer}) => {
                    const scene = new Scene();
                    const palette = paletteBinder(colors);
                    palette.scene(scene);
                    const camera = new PerspectiveCamera({fov: Math.PI / 4, near: 0.01, far: 100});
                    orbit(camera, {distance: 4, elevation: 15});
                    scene.add(camera);
                    scene.activeCamera = camera;
                    scene.add(
                        palette.light(
                            new DirectionalLight({direction: [-0.5, -0.8, -0.3], intensity: 4}),
                            (c) => c.key,
                        ),
                    );
                    scene.add(
                        palette.light(
                            new DirectionalLight({direction: [0.6, -0.2, 0.7], intensity: 1.2}),
                            (c) => c.fill,
                        ),
                    );

                    // metals reflect their surroundings: without an environment they render nearly black
                    const city = makeEnvironments(renderer.device).get("city") ?? null;
                    scene.environmentMap = city;
                    scene.backgroundMap = city;

                    // the model hangs off a pivot that turns; a fit entity centers and scales it to ~2 units
                    const pivot = new Entity();
                    scene.add(pivot);
                    let fit: Entity | null = null;
                    let requested = "";

                    const load = async (url: string) => {
                        const primitives = await loadGLBFromURL(url);
                        const base = url.slice(0, url.lastIndexOf("/") + 1);
                        const materials = await Promise.all(
                            primitives.map(({material}) =>
                                material
                                    ? createPBRMaterialFromGltf(renderer.device, material, (uri) => base + uri)
                                    : palette.material(new PBRMaterial(), (c) => c.neutral),
                            ),
                        );
                        if (url !== requested) {
                            return;
                        }
                        const min = [Infinity, Infinity, Infinity];
                        const max = [-Infinity, -Infinity, -Infinity];
                        const next = new Entity();
                        primitives.forEach(({geometry}, i) => {
                            for (let v = 0; v < geometry.positions.length; v += 3) {
                                for (let axis = 0; axis < 3; axis++) {
                                    min[axis] = Math.min(min[axis]!, geometry.positions[v + axis]!);
                                    max[axis] = Math.max(max[axis]!, geometry.positions[v + axis]!);
                                }
                            }
                            next.add(new Mesh(geometry, materials[i]!));
                        });
                        const size = Math.max(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!) || 1;
                        const scale = 2 / size;
                        vec3.set(next.scale, scale, scale, scale);
                        vec3.set(
                            next.position,
                            (-(min[0]! + max[0]!) / 2) * scale,
                            (-(min[1]! + max[1]!) / 2) * scale,
                            (-(min[2]! + max[2]!) / 2) * scale,
                        );
                        if (fit) {
                            pivot.remove(fit);
                        }
                        fit = next;
                        pivot.add(fit);
                        setStatus({
                            state: "ready",
                            detail: `${primitives.length} primitive${primitives.length > 1 ? "s" : ""}`,
                        });
                    };

                    const graph = new RenderGraph();
                    const {color} = graph.addPass(new DeferredScenePass({scene}));
                    graph.addPass(new BlitPass({toneMapping: "aces"}), {color}, {canvasSlot: "canvas"});
                    return ({time}) => {
                        palette.apply();
                        if (live.current !== requested) {
                            requested = live.current;
                            load(requested).catch((error: unknown) => {
                                setStatus({
                                    state: "failed",
                                    detail: error instanceof Error ? error.message : String(error),
                                });
                            });
                        }
                        pivot.rotation[1] = time * 0.5;
                        return graph;
                    };
                }}
            />
        </DemoStage>
    );
}

const SAMPLES = "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models";

/**
 * Base-color-only samples. Models with a glTF metallicRoughness texture (Damaged Helmet, Avocado) render dark:
 * createPBRMaterialFromGltf binds that texture as the ORM map, whose red channel the scene pass reads as
 * * occlusion, and glTF leaves that channel unspecified.
 */
const MODELS = [
    {value: `${SAMPLES}/Duck/glTF-Binary/Duck.glb`, label: "Duck"},
    {value: `${SAMPLES}/BoxTextured/glTF-Binary/BoxTextured.glb`, label: "Textured box"},
    {value: `${SAMPLES}/Box/glTF-Binary/Box.glb`, label: "Box"},
];

export function ObjFromText() {
    const colors = useSceneColors();
    return (
        <DemoStage>
            <GlazeCanvas
                label="A small faceted gem, parsed from OBJ text, turning slowly"
                setup={() => {
                    const geometry = parseOBJ(GEM_OBJ);
                    const scene = new Scene();
                    const palette = paletteBinder(colors);
                    palette.scene(scene);
                    const camera = new PerspectiveCamera({fov: Math.PI / 4});
                    orbit(camera, {distance: 4.5, elevation: 20});
                    scene.add(camera);
                    scene.activeCamera = camera;
                    scene.add(
                        palette.light(new DirectionalLight({direction: [-0.5, -1, -0.6], intensity: 3}), (c) => c.key),
                    );
                    scene.add(
                        palette.light(
                            new DirectionalLight({direction: [0.7, 0.2, 0.5], intensity: 1.5}),
                            (c) => c.accent,
                        ),
                    );
                    const gem = new Mesh(
                        geometry,
                        palette.material(new PBRMaterial({roughness: 0.15, metallic: 0.3}), (c) => c.hues.purple),
                    );
                    scene.add(gem);

                    const graph = new RenderGraph();
                    const {color} = graph.addPass(new DeferredScenePass({scene}));
                    graph.addPass(new BlitPass({toneMapping: "aces"}), {color}, {canvasSlot: "canvas"});
                    return ({time}) => {
                        palette.apply();
                        vec3.set(gem.rotation, 0.2, time * 0.6, 0);
                        return graph;
                    };
                }}
            />
        </DemoStage>
    );
}

/** An octagonal gem: a crown ring, a girdle ring, a table and a culet point. */
const GEM_OBJ = (() => {
    const lines = ["o gem", "v 0 -1.1 0"]; // 1: culet
    for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        lines.push(`v ${Math.cos(a).toFixed(4)} 0.2 ${Math.sin(a).toFixed(4)}`); // 2..9: girdle
    }
    for (let i = 0; i < 8; i++) {
        const a = ((i + 0.5) / 8) * Math.PI * 2;
        lines.push(`v ${(Math.cos(a) * 0.6).toFixed(4)} 0.6 ${(Math.sin(a) * 0.6).toFixed(4)}`); // 10..17: table
    }
    for (let i = 0; i < 8; i++) {
        const g = 2 + i;
        const gn = 2 + ((i + 1) % 8);
        const t = 10 + i;
        const tp = 10 + ((i + 7) % 8);
        lines.push(`f 1 ${g} ${gn}`); // pavilion
        lines.push(`f ${g} ${t} ${gn}`, `f ${g} ${tp} ${t}`); // crown
    }
    lines.push(`f ${Array.from({length: 8}, (_, i) => 17 - i).join(" ")}`); // table, fan-triangulated
    return lines.join("\n");
})();
