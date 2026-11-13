import {
    BlitPass,
    box3,
    computeWorldBounds,
    DeferredScenePass,
    DirectionalLight,
    Entity,
    type GltfModel,
    loadGltf,
    loadOBJFromURL,
    Mesh,
    parseOBJ,
    PBRMaterial,
    PerspectiveCamera,
    RenderGraph,
    Scene,
    Texture,
} from "@repraze/glaze";
import {Badge} from "@repraze/kernelkit/components/badge";
import {Spinner} from "@repraze/kernelkit/components/spinner";
import {vec3} from "gl-matrix";
import {useState} from "react";

import {ControlSelect, ControlStats, DemoStage} from "@/glaze/demo-stage";
import {GlazeCanvas, useLatest} from "@/glaze/glaze-canvas";
import {makeEnvironments} from "@/glaze/helpers";
import {paletteBinder, useSceneColors} from "@/glaze/scene-colors";
import {Code, defineDoc} from "@/lib/doc-kit";

export const doc = defineDoc({
    title: "Loaders",
    category: "Assets",
    description:
        "loadGltf turns a glTF 2.0 file (.glb, or .gltf with its buffers and images) into an entity tree: named nodes with their transforms, shared geometry and materials, ready to add to a scene. OBJ and STL parse to Geometry; parseGLB flattens a GLB to primitives.",
    engineFile: "loaders/glb.ts",
    order: 1,
    demos: [
        {
            title: "glTF model viewer",
            description:
                "Khronos glTF sample models, shipped with this site, loaded as entity trees (the badge counts nodes, meshes and materials) and framed with computeWorldBounds, under an environment map.",
            component: ModelViewer,
            layout: "full",
        },
        {
            title: "OBJ from a file or text",
            description:
                "loadOBJFromURL on a shipped file, textured with Texture.fromURL: its labels read upright because OBJ's v-up texture coordinates are flipped on load. Or parseOBJ on an inline string: positions and faces only, so the parser computes flat normals and tangents.",
            component: ObjFromText,
            layout: "full",
        },
    ],
    notes: Notes,
    sections: [
        {id: "materials-from-gltf", title: "Materials from glTF"},
        {id: "sample-assets", title: "Sample assets"},
    ],
    props: [
        {
            component: "glTF",
            rows: [
                {
                    name: "loadGltf(device, url, {resolveUri?})",
                    type: "Promise<GltfModel>",
                    description: ".glb or .gltf; external URIs resolve against the model's URL.",
                },
                {name: "parseGltf(device, bytes, {resolveUri?})", type: "Promise<GltfModel>"},
                {
                    name: "GltfModel",
                    type: "{root, nodes, meshes, materials, textures, animations, skins, lights, destroy()}",
                    description:
                        "root is the default scene; nodes by glTF index; lights from KHR_lights_punctual, children of their nodes.",
                },
                {
                    name: "computeWorldBounds(entity)",
                    type: "Box3",
                    description: "World box around a subtree's meshes: frame or centre a model.",
                },
                {name: "entity.name / find(name) / traverse(fn)", type: "string / Entity | null / void"},
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
                        "Factors and maps from the descriptor: base color, normal (with scale), emissive, metallic-roughness, occlusion (with strength).",
                },
                {
                    name: "planGltfMaterial(descriptor)",
                    type: "GltfMaterialPlan",
                    description:
                        "The same mapping without a GPU: PBRMaterial options and which image goes in which map.",
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
        <>
            <MaterialsNotes />
            <SampleAssets />
        </>
    );
}

function MaterialsNotes() {
    return (
        <section id="materials-from-gltf" className="flex scroll-mt-24 flex-col gap-3">
            <h2 className="font-mono text-xl font-semibold">Materials from glTF</h2>
            <p className="text-sm text-muted-foreground">
                Parsing needs no GPU, so it can run in a worker or a test. Textures referenced by URI resolve against
                the model&apos;s folder through <code className="font-mono text-foreground">resolveUri</code>; embedded
                images decode from the binary chunk or a data URI. loadGltf keeps the node tree (names, translation,
                rotation, scale); a node whose mesh has one primitive is that Mesh, otherwise it holds one Mesh per
                primitive. parseGLB instead bakes the default scene&apos;s transforms into flat primitives.
            </p>
            <p className="text-sm text-muted-foreground">
                The metallic-roughness texture supplies roughness (green) and metallic (blue) only. Occlusion comes from
                the occlusion texture, scaled by its strength, and is 1 without one; when both are the same image
                (packed occlusion-roughness-metallic) it becomes the material&apos;s{" "}
                <code className="font-mono text-foreground">ormMap</code>. glTF factors are linear and are converted to
                the sRGB values Glaze works in. Each texture keeps its sampler (wrap, nearest or linear filtering), its
                UV set (TEXCOORD_0 or 1) and its KHR_texture_transform; vertex colors (COLOR_0) tint the material. Files
                that require an extension Glaze can&apos;t read (Draco, meshopt, KTX2) are refused with an error naming
                it.
            </p>
            <Code
                code={`const model = await loadGltf(renderer.device, "/models/donut/donut.glb");
scene.add(model.root);

model.root.find("Icing")!.enabled = false;         // nodes keep their glTF names
const box = computeWorldBounds(model.root);         // frame it
// later: scene.remove(model.root); model.destroy();`}
            />
        </section>
    );
}

export function ModelViewer() {
    const colors = useSceneColors();
    const [model, setModel] = useState(MODELS[0]!.value);
    const [status, setStatus] = useState<{state: "loading" | "ready" | "failed"; detail?: string; facts?: string[]}>({
        state: "loading",
    });
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
                        {status.state === "ready" ? <ControlStats facts={status.facts ?? []} /> : null}
                        {status.state === "failed" ? (
                            <Badge color="danger" variant="soft">
                                {status.detail}
                            </Badge>
                        ) : null}
                    </div>
                    <SampleCredit sample={MODELS.find((m) => m.value === model) ?? MODELS[0]!} />
                </>
            }
        >
            <GlazeCanvas
                label="A glTF sample model turning slowly under two lights"
                setup={({renderer, orbitControls}) => {
                    const scene = new Scene();
                    const palette = paletteBinder(colors);
                    palette.scene(scene);
                    const camera = new PerspectiveCamera({fov: Math.PI / 4, near: 0.01, far: 100});
                    orbitControls(camera, {distance: 4, elevation: 15});
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

                    let current: GltfModel | null = null;
                    const load = async (url: string) => {
                        const model = await loadGltf(renderer.device, url);
                        if (url !== requested) {
                            model.destroy();
                            return;
                        }
                        // frame it: centre the model's world bounds on the pivot and scale it to ~2 units
                        const next = new Entity();
                        next.add(model.root);
                        const bounds = computeWorldBounds(model.root);
                        const size = box3.getSize(vec3.create(), bounds);
                        const scale = 2 / (Math.max(size[0], size[1], size[2]) || 1);
                        const centre = box3.getCenter(vec3.create(), bounds);
                        vec3.set(next.scale, scale, scale, scale);
                        vec3.scale(next.position, centre, -scale);
                        if (fit) {
                            pivot.remove(fit);
                        }
                        current?.destroy();
                        current = model;
                        fit = next;
                        pivot.add(fit);
                        const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
                        setStatus({
                            state: "ready",
                            facts: [
                                plural(model.nodes.length, "node"),
                                plural(model.meshes.length, "mesh", "meshes"),
                                plural(model.materials.length, "material"),
                            ],
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
                        pivot.setEuler(0, time * 0.5, 0);
                        return graph;
                    };
                }}
            />
        </DemoStage>
    );
}

// ─── Sample assets ────────────────────────────────────────────────────────────

/** Shipped under public/models (each folder has the licence text and a README with source and commit). */
const MODELS_URL = `${import.meta.env.BASE_URL}models/`;
const KHRONOS_SAMPLES =
    "https://github.com/KhronosGroup/glTF-Sample-Assets/tree/8f492390ddc7a2ae221a1369ef560589cf8c70fb";

interface SampleModel {
    /** URL of the GLB, under the site's base path. */
    value: string;
    label: string;
    /** Folder under public/models. */
    folder: string;
    /** Model directory in glTF-Sample-Assets. */
    source: string;
    title: string;
    credit: string;
    licence: "CC0 1.0" | "CC BY 4.0";
    /** What the model exercises. */
    shows: string;
}

const sample = (folder: string, file: string, rest: Omit<SampleModel, "value" | "folder">): SampleModel => ({
    value: `${MODELS_URL}${folder}/${file}`,
    folder,
    ...rest,
});

const MODELS: SampleModel[] = [
    sample("avocado", "Avocado.glb", {
        label: "Avocado",
        source: "Avocado",
        title: "Avocado",
        credit: "Microsoft",
        licence: "CC0 1.0",
        shows: "base color, metallic-roughness and normal maps, supplied tangents, a node rotation",
    }),
    sample("clearcoat-wicker", "ClearcoatWicker.glb", {
        label: "Wicker",
        source: "ClearcoatWicker",
        title: "Clearcoat Wicker",
        credit: "Eric Chadwick",
        licence: "CC0 1.0",
        shows: "occlusion packed with metallic-roughness in one image, normal map, generated tangents",
    }),
    sample("carbon-fibre", "CarbonFibre.glb", {
        label: "Carbon fibre",
        source: "CarbonFibre",
        title: "Carbon Fibre",
        credit: "Eric Chadwick, © 2023 Wayfair",
        licence: "CC BY 4.0",
        shows: "a separate occlusion texture, normal map scale 2, factors without a metallic-roughness texture",
    }),
    sample("metal-rough-spheres", "MetalRoughSpheresNoTextures.glb", {
        label: "Metal-rough spheres",
        source: "MetalRoughSpheresNoTextures",
        title: "Metal Rough Spheres (no textures)",
        credit: "Krill Gavrilov",
        licence: "CC0 1.0",
        shows: "metallic and roughness factors only, no textures, one node transform per sphere",
    }),
    sample("texture-coordinate-test", "TextureCoordinateTest.glb", {
        label: "Texture coordinates",
        source: "TextureCoordinateTest",
        title: "Texture Coordinate Test",
        credit: "Ed Mackey, © 2017 Analytical Graphics, Inc.",
        licence: "CC0 1.0",
        shows: "texture orientation: each label sits in its own corner; base color factors tint one texture",
    }),
];

function LicenceLink({sample}: {sample: SampleModel}) {
    return (
        <a href={`${MODELS_URL}${sample.folder}/LICENSE.txt`} className="underline underline-offset-4">
            {sample.licence}
        </a>
    );
}

/** The credit line under the viewer, for the model on screen. */
function SampleCredit({sample}: {sample: SampleModel}) {
    return (
        <p className="text-xs text-muted-foreground">
            &ldquo;{sample.title}&rdquo; by {sample.credit}, <LicenceLink sample={sample} />, from the{" "}
            <a href={`${KHRONOS_SAMPLES}/Models/${sample.source}`} className="underline underline-offset-4">
                Khronos glTF Sample Assets
            </a>
            .
        </p>
    );
}

function SampleAssets() {
    return (
        <section id="sample-assets" className="flex scroll-mt-24 flex-col gap-3">
            <h2 className="font-mono text-xl font-semibold">Sample assets</h2>
            <p className="text-sm text-muted-foreground">
                The demos load models this site ships, from <code className="font-mono text-foreground">models/</code>{" "}
                under its base path: nothing is fetched from elsewhere. They come unmodified from the{" "}
                <a href={KHRONOS_SAMPLES} className="underline underline-offset-4">
                    Khronos glTF Sample Assets
                </a>{" "}
                (commit 8f49239); the OBJ and its image are converted from Texture Coordinate Test. Each folder holds
                the licence text and a README with the source.
            </p>
            <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground">
                {MODELS.map((m) => (
                    <li key={m.folder}>
                        <span className="text-foreground">{m.title}</span> by {m.credit}, <LicenceLink sample={m} />:{" "}
                        {m.shows}.
                    </li>
                ))}
            </ul>
        </section>
    );
}

const TEXTURE_COORDINATE_TEST = MODELS.find((m) => m.folder === "texture-coordinate-test")!;

const OBJ_SOURCES = [
    {value: "file", label: "UV test (file)"},
    {value: "text", label: "Gem (inline text)"},
] as const;
type ObjSource = (typeof OBJ_SOURCES)[number]["value"];

export function ObjFromText() {
    const colors = useSceneColors();
    const [source, setSource] = useState<ObjSource>("file");
    const live = useLatest(source);
    return (
        <DemoStage
            controls={
                <>
                    <ControlSelect label="Source" value={source} options={OBJ_SOURCES} onChange={setSource} />
                    {source === "file" ? <SampleCredit sample={TEXTURE_COORDINATE_TEST} /> : null}
                </>
            }
        >
            <GlazeCanvas
                label="An OBJ model turning slowly: four textured squares with corner labels, or a faceted gem"
                setup={async ({renderer, orbitControls}) => {
                    const folder = `${MODELS_URL}${TEXTURE_COORDINATE_TEST.folder}/`;
                    const [squares, texture] = await Promise.all([
                        loadOBJFromURL(`${folder}TextureCoordinateTest.obj`),
                        Texture.fromURL(renderer.device, `${folder}TextureCoordinateTest.png`),
                    ]);
                    const scene = new Scene();
                    const palette = paletteBinder(colors);
                    palette.scene(scene);
                    const camera = new PerspectiveCamera({fov: Math.PI / 4});
                    orbitControls(camera, {distance: 4.5, elevation: 20});
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
                        parseOBJ(GEM_OBJ),
                        palette.material(new PBRMaterial({roughness: 0.15, metallic: 0.3}), (c) => c.hues.purple),
                    );
                    const labelled = new PBRMaterial({roughness: 0.7}); // white base: the image is the color
                    labelled.albedoMap = texture;
                    const card = new Mesh(squares, labelled);
                    let shown: Mesh | null = null;

                    const graph = new RenderGraph();
                    const {color} = graph.addPass(new DeferredScenePass({scene}));
                    graph.addPass(new BlitPass({toneMapping: "aces"}), {color}, {canvasSlot: "canvas"});
                    return ({time}) => {
                        palette.apply();
                        const next = live.current === "file" ? card : gem;
                        if (next !== shown) {
                            if (shown) {
                                scene.remove(shown);
                            }
                            scene.add(next);
                            shown = next;
                        }
                        // the card sways to stay readable; the gem turns
                        if (next === card) {
                            card.setEuler(0, Math.sin(time * 0.6) * 0.5, 0);
                        } else {
                            gem.setEuler(0.2, time * 0.6, 0);
                        }
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
