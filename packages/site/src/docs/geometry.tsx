import {
    BlitPass,
    DeferredScenePass,
    DirectionalLight,
    Geometry,
    Mesh,
    PBRMaterial,
    PerspectiveCamera,
    RenderGraph,
    Scene,
} from "@repraze/glaze";
import {vec3} from "gl-matrix";
import {useState} from "react";

import {ControlSelect, ControlStats, ControlSwitch, DemoStage} from "@/glaze/demo-stage";
import {GlazeCanvas, useLatest} from "@/glaze/glaze-canvas";
import {makeShape, type ShapeKind, SHAPES} from "@/glaze/helpers";
import {paletteBinder, useSceneColors} from "@/glaze/scene-colors";
import {Code, defineDoc} from "@/lib/doc-kit";

export const doc = defineDoc({
    title: "Geometry & shapes",
    category: "Scene",
    description:
        "Geometry holds indexed triangles: positions, normals, UVs and optional tangents. Factories build the common shapes, smooth or flat shaded; build your own from typed arrays.",
    engineFile: "geometry/shapes.ts",
    order: 4,
    demos: [
        {
            title: "Shape factories",
            description:
                "Every factory with flat: true expands to unshared triangles with per-face normals, which is what faceted shading needs.",
            component: Shapes,
            layout: "full",
        },
        {
            title: "Custom geometry",
            description: "A Geometry from four typed arrays: a tetrahedron with flat normals, built by hand.",
            component: Custom,
            layout: "full",
        },
    ],
    notes: Notes,
    sections: [{id: "vertex-layout", title: "Vertex layout"}],
    props: [
        {
            component: "Shape factories",
            rows: [
                {name: "createCube", type: "size, widthSegments, heightSegments, depthSegments", default: "1, 1, 1, 1"},
                {
                    name: "createPlane",
                    type: "width, height, widthSegments, heightSegments",
                    default: "1, 1, 1, 1",
                    description: "Lies in XZ, facing +Y.",
                },
                {name: "createQuad", type: "width, height", default: "1, 1"},
                {name: "createSphere", type: "radius, widthSegments, heightSegments", default: "1, …"},
                {
                    name: "createIcosphere",
                    type: "radius, subdivisions",
                    default: "1, 2",
                    description: "Even triangles, no poles.",
                },
                {
                    name: "createCylinder",
                    type: "radiusTop, radiusBottom, height, radialSegments, heightSegments, openEnded",
                },
                {name: "createCone", type: "radius, height, radialSegments, heightSegments, openEnded"},
                {
                    name: "createTorus",
                    type: "radius, tube, radialSegments, tubularSegments, arc",
                    default: "1, 0.4, 16, 32, 2π",
                },
                {name: "flat", type: "boolean", default: "false", description: "Every factory: per-face normals."},
            ],
        },
        {
            component: "Geometry",
            rows: [
                {name: "positions", type: "Float32Array", description: "3 floats per vertex."},
                {name: "normals", type: "Float32Array", description: "3 floats per vertex."},
                {
                    name: "uvs",
                    type: "Float32Array",
                    description: "2 floats per vertex; (0, 0) is the image's top-left, v runs down (as in glTF).",
                },
                {name: "indices", type: "Uint32Array", description: "3 per triangle, counter-clockwise front faces."},
                {
                    name: "tangents",
                    type: "Float32Array?",
                    description: "4 per vertex (xyz + handedness), for normal maps.",
                },
                {
                    name: "computeTangents(positions, normals, uvs, indices, vertexCount)",
                    type: "Float32Array",
                    description: "Builds tangents (the OBJ loader does it for you).",
                },
            ],
        },
    ],
});

function Notes() {
    return (
        <section id="vertex-layout" className="flex scroll-mt-24 flex-col gap-3">
            <h2 className="font-mono text-xl font-semibold">Vertex layout</h2>
            <p className="text-sm text-muted-foreground">
                The scene pass interleaves each geometry once, on first use: position, normal, UV and tangent, 48 bytes
                per vertex. Share one Geometry between many meshes; it is uploaded once.
            </p>
            <Code
                code={`import {computeTangents, Geometry} from "@repraze/glaze";

const geometry = new Geometry({positions, normals, uvs, indices});
// with a normal map, give it tangents
const tangents = computeTangents(positions, normals, uvs, indices, positions.length / 3);
const mapped = new Geometry({positions, normals, uvs, indices, tangents});`}
            />
        </section>
    );
}

export function Shapes() {
    const colors = useSceneColors();
    const [shape, setShape] = useState<ShapeKind>("torus");
    const [flat, setFlat] = useState(false);
    const [stats, setStats] = useState({vertices: 0, triangles: 0});
    const live = useLatest({shape, flat});
    return (
        <DemoStage
            controls={
                <>
                    <ControlSelect label="Factory" value={shape} options={SHAPES} onChange={setShape} />
                    <ControlSwitch label="Flat shading" checked={flat} onChange={setFlat} />
                    <ControlStats facts={[`${stats.vertices} vertices`, `${stats.triangles} triangles`]} />
                </>
            }
        >
            <GlazeCanvas
                label="The chosen shape in orange, turning slowly"
                setup={({orbitControls}) => {
                    const scene = new Scene();
                    const palette = paletteBinder(colors);
                    palette.scene(scene);
                    const camera = new PerspectiveCamera({fov: Math.PI / 4});
                    orbitControls(camera, {distance: 4.2, elevation: 25});
                    scene.add(camera);
                    scene.activeCamera = camera;
                    scene.add(
                        palette.light(new DirectionalLight({direction: [-0.5, -1, -0.6], intensity: 3}), (c) => c.key),
                    );
                    scene.add(
                        palette.light(
                            new DirectionalLight({direction: [0.7, -0.2, 0.5], intensity: 0.8}),
                            (c) => c.fill,
                        ),
                    );

                    const material = palette.material(new PBRMaterial({roughness: 0.35}), (c) => c.accent);
                    const cache = new Map<string, Mesh>();
                    let shown: Mesh | null = null;

                    const graph = new RenderGraph();
                    const {color} = graph.addPass(new DeferredScenePass({scene}));
                    graph.addPass(new BlitPass({toneMapping: "aces"}), {color}, {canvasSlot: "canvas"});

                    return ({time}) => {
                        palette.apply();
                        const key = `${live.current.shape}:${live.current.flat}`;
                        let mesh = cache.get(key);
                        if (!mesh) {
                            mesh = new Mesh(makeShape(live.current.shape, live.current.flat), material);
                            cache.set(key, mesh);
                        }
                        if (mesh !== shown) {
                            if (shown) {
                                scene.remove(shown);
                            }
                            scene.add(mesh);
                            shown = mesh;
                            setStats({vertices: mesh.geometry.vertexCount, triangles: mesh.geometry.indexCount / 3});
                        }
                        mesh.setEuler(0.4, time * 0.4, 0);
                        return graph;
                    };
                }}
            />
        </DemoStage>
    );
}

export function Custom() {
    const colors = useSceneColors();
    return (
        <DemoStage>
            <GlazeCanvas
                label="A faceted tetrahedron with four differently lit faces, spinning"
                setup={({orbitControls}) => {
                    // four corners, then one triangle per face with its own vertices (flat normals)
                    const c = [
                        [1, 1, 1],
                        [-1, -1, 1],
                        [-1, 1, -1],
                        [1, -1, -1],
                    ] as const;
                    const faces = [
                        [0, 1, 3],
                        [0, 2, 1],
                        [0, 3, 2],
                        [1, 2, 3],
                    ] as const;
                    const positions: number[] = [];
                    const normals: number[] = [];
                    const uvs: number[] = [];
                    for (const [a, b, d] of faces) {
                        const [pa, pb, pd] = [vec3.clone(c[a]), vec3.clone(c[b]), vec3.clone(c[d])];
                        const n = vec3.normalize(
                            vec3.create(),
                            vec3.cross(vec3.create(), vec3.sub(vec3.create(), pb, pa), vec3.sub(vec3.create(), pd, pa)),
                        );
                        for (const p of [pa, pb, pd]) {
                            positions.push(...p);
                            normals.push(...n);
                        }
                        uvs.push(0, 0, 1, 0, 0.5, 1);
                    }
                    const geometry = new Geometry({
                        positions: new Float32Array(positions),
                        normals: new Float32Array(normals),
                        uvs: new Float32Array(uvs),
                        indices: new Uint32Array(positions.length / 3).map((_, i) => i),
                    });

                    const scene = new Scene();

                    const palette = paletteBinder(colors);

                    palette.scene(scene);
                    const camera = new PerspectiveCamera({fov: Math.PI / 4});
                    orbitControls(camera, {distance: 5, elevation: 20});
                    scene.add(camera);
                    scene.activeCamera = camera;
                    scene.add(
                        palette.light(new DirectionalLight({direction: [-0.5, -1, -0.6], intensity: 3}), (c) => c.key),
                    );
                    const mesh = new Mesh(
                        geometry,
                        palette.material(new PBRMaterial({roughness: 0.4}), (c) => c.hues.cyan),
                    );
                    scene.add(mesh);

                    const graph = new RenderGraph();
                    const {color} = graph.addPass(new DeferredScenePass({scene}));
                    graph.addPass(new BlitPass({toneMapping: "aces"}), {color}, {canvasSlot: "canvas"});
                    return ({time}) => {
                        palette.apply();
                        mesh.setEuler(time * 0.5, time * 0.7, 0);
                        return graph;
                    };
                }}
            />
        </DemoStage>
    );
}
