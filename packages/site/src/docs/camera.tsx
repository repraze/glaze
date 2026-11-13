import {
    BlitPass,
    createCube,
    createPlane,
    DeferredScenePass,
    DirectionalLight,
    Mesh,
    OrthographicCamera,
    PBRMaterial,
    PerspectiveCamera,
    RenderGraph,
    Scene,
} from "@repraze/glaze";
import {vec3} from "gl-matrix";
import {useState} from "react";

import {ControlSegmented, ControlSlider, DemoStage} from "@/glaze/demo-stage";
import {GlazeCanvas, useLatest} from "@/glaze/glaze-canvas";
import {orbit} from "@/glaze/helpers";
import {paletteBinder, useSceneColors} from "@/glaze/scene-colors";
import {Code, defineDoc} from "@/lib/doc-kit";

export const doc = defineDoc({
    title: "Camera",
    category: "Scene",
    description:
        "Cameras are entities: place and rotate them like any other, add them to the scene so their world matrix updates, and set scene.activeCamera. Perspective takes a vertical field of view, orthographic a view box.",
    engineFile: "scene/camera.ts",
    order: 1,
    demos: [
        {
            title: "Perspective and orthographic",
            description:
                "The same grid of pillars through both projections (ported from the dithering lab's camera switch). The orthographic box is sized to match the perspective view at the target's distance.",
            component: Projection,
            layout: "full",
        },
    ],
    notes: Notes,
    sections: [{id: "aiming", title: "Aiming"}],
    props: [
        {
            component: "PerspectiveCamera",
            rows: [
                {name: "fov", type: "number", default: "π / 3", description: "Vertical field of view, radians."},
                {name: "near", type: "number", default: "0.1"},
                {name: "far", type: "number", default: "1000"},
            ],
        },
        {
            component: "OrthographicCamera",
            rows: [
                {name: "left / right", type: "number", default: "-1 / 1", description: "View box in world units."},
                {name: "top / bottom", type: "number", default: "1 / -1"},
                {name: "near / far", type: "number", default: "0.1 / 1000"},
                {
                    name: "zoom",
                    type: "number",
                    default: "1",
                    description:
                        "Magnifies the box about its center (OrbitControls zooms it, within minZoom / maxZoom).",
                },
            ],
        },
        {
            component: "Camera",
            rows: [
                {
                    name: "getProjectionMatrix(aspect)",
                    type: "mat4",
                    description: "Aspect is width / height of the output.",
                },
                {name: "getViewMatrix()", type: "mat4", description: "Inverse of the world matrix."},
                {name: "getViewProjectionMatrix(aspect)", type: "mat4"},
                {
                    name: "getRay(out, ndcX, ndcY, aspect)",
                    type: "Ray",
                    description: "World ray through a screen point, for raycast.",
                },
                {
                    name: "visibleLayers",
                    type: "number",
                    default: "ALL_LAYERS",
                    description: "Renders meshes whose layers intersect it.",
                },
            ],
        },
    ],
});

function Notes() {
    return (
        <section id="aiming" className="flex scroll-mt-24 flex-col gap-3">
            <h2 className="font-mono text-xl font-semibold">Aiming</h2>
            <p className="text-sm text-muted-foreground">
                A camera looks down its local −Z. To orbit a target, put it on a sphere and turn it back toward the
                center with <code>lookAt</code>, which points −Z at a world-space target.
            </p>
            <Code
                code={`const camera = new PerspectiveCamera({fov: Math.PI / 4, near: 0.1, far: 100});
scene.add(camera); // in the tree, so its world matrix updates
scene.activeCamera = camera;

const el = elevation * (Math.PI / 180);
const az = azimuth * (Math.PI / 180);
vec3.set(camera.position, d * Math.cos(el) * Math.sin(az), d * Math.sin(el), d * Math.cos(el) * Math.cos(az));
camera.lookAt([0, 0, 0]);`}
            />
        </section>
    );
}

export function Projection() {
    const colors = useSceneColors();
    const [mode, setMode] = useState<"perspective" | "orthographic">("perspective");
    const [fov, setFov] = useState(50);
    const [elevation, setElevation] = useState(30);
    const live = useLatest({mode, fov, elevation});
    return (
        <DemoStage
            controls={
                <>
                    <ControlSegmented label="Projection" value={mode} options={MODES} onChange={setMode} />
                    <ControlSlider
                        label="Field of view"
                        value={fov}
                        onChange={setFov}
                        min={15}
                        max={110}
                        step={5}
                        format={(v) => `${v}°`}
                    />
                    <ControlSlider
                        label="Elevation"
                        value={elevation}
                        onChange={setElevation}
                        min={5}
                        max={85}
                        step={5}
                        format={(v) => `${v}°`}
                    />
                </>
            }
        >
            <GlazeCanvas
                label="A five by five grid of orange and grey pillars seen through the selected projection"
                setup={({canvas}) => {
                    const scene = new Scene();
                    const palette = paletteBinder(colors);
                    palette.scene(scene);
                    scene.add(
                        palette.light(
                            new DirectionalLight({direction: [-0.4, -1, -0.6], intensity: 3, castShadow: true}),
                            (c) => c.key,
                        ),
                    );
                    scene.add(
                        new Mesh(
                            createPlane({width: 12, height: 12}),
                            palette.material(new PBRMaterial({roughness: 0.9}), (c) => c.floor),
                        ),
                    );
                    const pillar = createCube({size: 0.6});
                    const orange = palette.material(new PBRMaterial({roughness: 0.4}), (c) => c.accent);
                    const grey = palette.material(new PBRMaterial({roughness: 0.5}), (c) => c.neutral);
                    for (let x = -2; x <= 2; x++) {
                        for (let z = -2; z <= 2; z++) {
                            const mesh = new Mesh(pillar, (x + z) % 2 === 0 ? orange : grey);
                            const h = 1 + ((x * 7 + z * 13 + 20) % 5) * 0.4;
                            vec3.set(mesh.scale, 1, h, 1);
                            vec3.set(mesh.position, x * 1.5, (0.6 * h) / 2, z * 1.5);
                            scene.add(mesh);
                        }
                    }

                    // both cameras live in the scene; activeCamera picks one
                    const perspective = new PerspectiveCamera({near: 0.1, far: 100});
                    const orthographic = new OrthographicCamera({near: 0.1, far: 100});
                    scene.add(perspective).add(orthographic);

                    const graph = new RenderGraph();
                    const {color} = graph.addPass(new DeferredScenePass({scene}));
                    graph.addPass(new BlitPass({toneMapping: "aces"}), {color}, {canvasSlot: "canvas"});

                    return ({time}) => {
                        palette.apply();
                        const cfg = live.current;
                        const distance = 12;
                        const view = {distance, elevation: cfg.elevation, azimuth: 30 + time * 6};
                        orbit(perspective, view);
                        orbit(orthographic, view);
                        perspective.fov = (cfg.fov * Math.PI) / 180;
                        const half = distance * Math.tan(perspective.fov / 2);
                        const aspect = canvas.width / canvas.height;
                        orthographic.left = -half * aspect;
                        orthographic.right = half * aspect;
                        orthographic.top = half;
                        orthographic.bottom = -half;
                        scene.activeCamera = cfg.mode === "perspective" ? perspective : orthographic;
                        return graph;
                    };
                }}
            />
        </DemoStage>
    );
}

const MODES: {value: "perspective" | "orthographic"; label: string}[] = [
    {value: "perspective", label: "Perspective"},
    {value: "orthographic", label: "Ortho"},
];
