import {
    BlitPass,
    createIcosphere,
    createSphere,
    createTorus,
    DeferredScenePass,
    DirectionalLight,
    Entity,
    Mesh,
    PBRMaterial,
    PerspectiveCamera,
    PointLight,
    RenderGraph,
    Scene,
} from "@repraze/glaze";
import {vec3} from "gl-matrix";
import {useState} from "react";

import {ControlSlider, ControlSwitch, DemoStage} from "@/glaze/demo-stage";
import {GlazeCanvas, useLatest} from "@/glaze/glaze-canvas";
import {orbit} from "@/glaze/helpers";
import {paletteBinder, useSceneColors} from "@/glaze/scene-colors";
import {Code, defineDoc} from "@/lib/doc-kit";

export const doc = defineDoc({
    title: "Scene graph",
    category: "Scene",
    description:
        "A Scene is a tree of entities. Every Entity has a position, a rotation quaternion and a scale; children inherit their parent's world transform. Meshes, cameras and lights are entities, so a light can ride on a moving mesh.",
    engineFile: "scene/scene.ts",
    order: 0,
    demos: [
        {
            title: "Hierarchy",
            description:
                "A sun, a planet that orbits it, a moon that orbits the planet: each rotation is set on one entity, the tree composes them. Toggle a branch with enabled.",
            component: Hierarchy,
            layout: "full",
        },
    ],
    notes: Notes,
    sections: [{id: "transforms", title: "Transforms"}],
    props: [
        {
            component: "Scene",
            rows: [
                {name: "root", type: "Entity", description: "The tree's root; add() appends to it."},
                {
                    name: "activeCamera",
                    type: "Camera | null",
                    default: "null",
                    description: "The camera the scene pass renders from.",
                },
                {
                    name: "backgroundColor",
                    type: "vec3",
                    default: "[0, 0, 0]",
                    description: "Clear color behind the scene.",
                },
                {name: "ambientColor", type: "vec3", default: "[0.05, 0.05, 0.05]", description: "Flat ambient light."},
                {
                    name: "environmentMap",
                    type: "Texture | null",
                    default: "null",
                    description: "Equirectangular map for image-based light.",
                },
                {
                    name: "backgroundMap",
                    type: "Texture | null",
                    default: "null",
                    description: "Equirectangular map drawn behind.",
                },
                {
                    name: "environmentColor",
                    type: "vec3",
                    default: "[1, 1, 1]",
                    description: "Tint and strength of the environment.",
                },
                {name: "add(entity) / remove(entity)", type: "this", description: "Chainable."},
            ],
        },
        {
            component: "Entity",
            rows: [
                {name: "position", type: "vec3", default: "[0, 0, 0]"},
                {
                    name: "quaternion",
                    type: "quat",
                    default: "[0, 0, 0, 1]",
                    description: "Local rotation. Set from angles with setEuler.",
                },
                {name: "scale", type: "vec3", default: "[1, 1, 1]"},
                {
                    name: "enabled",
                    type: "boolean",
                    default: "true",
                    description: "False hides the entity and its subtree.",
                },
                {name: "children / parent", type: "Entity[] / Entity | null"},
                {name: "add(child) / remove(child)", type: "this"},
                {name: "setEuler(x, y, z)", type: "this", description: "Rotation from Euler angles in radians."},
                {name: "rotateX / rotateY / rotateZ(rad)", type: "this", description: "Rotate about a local axis."},
                {name: "lookAt(target, up?)", type: "this", description: "Point −Z at a world-space target."},
                {name: "lookAlong(direction, up?)", type: "this", description: "Point −Z along a world direction."},
                {
                    name: "getWorldPosition / Quaternion / Scale / Direction()",
                    type: "vec3 | quat",
                    description: "Computed now from the parent chain.",
                },
                {name: "worldMatrix", type: "mat4", description: "Updated each frame by the scene pass."},
            ],
        },
        {
            component: "Mesh",
            rows: [
                {
                    name: "new Mesh(geometry, material)",
                    type: "Mesh",
                    description: "An entity that draws geometry with a material.",
                },
                {name: "castShadow", type: "boolean", default: "true"},
                {name: "receiveShadow", type: "boolean", default: "true"},
            ],
        },
    ],
});

function Notes() {
    return (
        <section id="transforms" className="flex scroll-mt-24 flex-col gap-3">
            <h2 className="font-mono text-xl font-semibold">Transforms</h2>
            <p className="text-sm text-muted-foreground">
                Transforms are gl-matrix vectors: mutate them in place each frame. Group things under a plain Entity to
                move them together. Math helpers (lerp, smoothstep, oscillate, bounce…) ship with the engine for
                animation.
            </p>
            <Code
                code={`import {Entity, Mesh, oscillate} from "@repraze/glaze";
import {vec3} from "gl-matrix";

const pivot = new Entity();
const moon = new Mesh(sphere, rock);
vec3.set(moon.position, 1.5, 0, 0);   // relative to the pivot
pivot.add(moon);
scene.add(pivot);

// per frame
pivot.setEuler(0, time, 0);              // the moon orbits
moon.position[1] = oscillate(time) * 0.2;`}
            />
        </section>
    );
}

export function Hierarchy() {
    const colors = useSceneColors();
    const [speed, setSpeed] = useState(1);
    const [moons, setMoons] = useState(true);
    const live = useLatest({speed, moons});
    return (
        <DemoStage
            controls={
                <>
                    <ControlSlider label="Speed" value={speed} onChange={setSpeed} min={0} max={3} step={0.1} />
                    <ControlSwitch label="Moon branch" checked={moons} onChange={setMoons} />
                </>
            }
        >
            <GlazeCanvas
                label="A glowing sun with a ringed planet orbiting it and a small moon orbiting the planet"
                setup={() => {
                    const scene = new Scene();
                    const palette = paletteBinder(colors);
                    palette.scene(scene);
                    const camera = new PerspectiveCamera({fov: Math.PI / 4});
                    orbit(camera, {distance: 9, elevation: 35});
                    scene.add(camera);
                    scene.activeCamera = camera;
                    scene.add(
                        palette.light(new DirectionalLight({direction: [0, -1, 0.2], intensity: 0.4}), (c) => c.key),
                    );

                    // sun: an emissive sphere with a point light as its child
                    const sun = new Mesh(
                        createSphere({radius: 0.8, widthSegments: 32, heightSegments: 16}),
                        // black albedo on purpose: the sun only emits (× 1.2), in the accent's fill tier
                        palette.emissive(new PBRMaterial({color: [0, 0, 0]}), (c) => c.accentFill, 1.2),
                    );
                    sun.castShadow = false;
                    sun.add(palette.light(new PointLight({intensity: 30, range: 12}), (c) => c.accentFill));
                    scene.add(sun);

                    // planet pivot rotates around the sun; the planet sits at its edge
                    const planetPivot = new Entity();
                    sun.add(planetPivot);
                    const planet = new Mesh(
                        createIcosphere({radius: 0.4, subdivisions: 3}),
                        palette.material(new PBRMaterial({roughness: 0.6}), (c) => c.hues.cyan),
                    );
                    vec3.set(planet.position, 3, 0, 0);
                    planetPivot.add(planet);
                    const ring = new Mesh(
                        createTorus({radius: 0.65, tube: 0.04, radialSegments: 8, tubularSegments: 64}),
                        palette.material(new PBRMaterial({roughness: 0.3}), (c) => c.hues.purple),
                    );
                    ring.setEuler(Math.PI / 2.4, 0, 0);
                    planet.add(ring);

                    // moon pivot rotates around the planet
                    const moonPivot = new Entity();
                    planet.add(moonPivot);
                    const moon = new Mesh(
                        createIcosphere({radius: 0.15, subdivisions: 2}),
                        palette.material(new PBRMaterial({roughness: 0.9}), (c) => c.neutral),
                    );
                    vec3.set(moon.position, 1.1, 0.2, 0);
                    moonPivot.add(moon);

                    let t = 0;
                    const graph = new RenderGraph();
                    const {color} = graph.addPass(new DeferredScenePass({scene}));
                    graph.addPass(new BlitPass({toneMapping: "aces"}), {color}, {canvasSlot: "canvas"});
                    return ({delta}) => {
                        palette.apply();
                        t += delta * live.current.speed;
                        sun.setEuler(0, t * 0.2, 0);
                        planetPivot.setEuler(0, t * 0.5, 0);
                        moonPivot.setEuler(0, t * 2, 0);
                        moonPivot.enabled = live.current.moons;
                        return graph;
                    };
                }}
            />
        </DemoStage>
    );
}
