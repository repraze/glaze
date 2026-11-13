import {
    BlitPass,
    createCube,
    createIcosphere,
    createPlane,
    createTorus,
    DeferredScenePass,
    DirectionalLight,
    Entity,
    Mesh,
    OrbitControls,
    PBRMaterial,
    PerspectiveCamera,
    PointerInput,
    ray,
    RenderGraph,
    Scene,
    setColorRgb,
    sphereCollider,
} from "@repraze/glaze";
import {vec3} from "gl-matrix";
import {useState} from "react";

import {ControlSwitch, DemoStage} from "@/glaze/demo-stage";
import {GlazeCanvas, useLatest} from "@/glaze/glaze-canvas";
import {paletteBinder, useSceneColors} from "@/glaze/scene-colors";
import {Code, defineDoc} from "@/lib/doc-kit";

export const doc = defineDoc({
    title: "Interaction",
    category: "Scene",
    description:
        "Pointer input for a canvas: rays through the pointer, raycast hits on colliders, handlers on any entity, and camera controls that share gestures with them. Mouse, touch and pen alike.",
    engineFile: "input/pointer-input.ts",
    order: 5,
    demos: [
        {
            title: "Pick, drag, orbit",
            description:
                "Hover lights an object, a click selects it, a drag slides it on the floor (it captures the gesture). Dragging empty space orbits; wheel or pinch zooms; right-drag or two fingers pan. The tiny gem can wear an invisible hitbox.",
            component: PickDragOrbit,
            layout: "full",
        },
    ],
    notes: Notes,
    sections: [
        {id: "picking", title: "Picking"},
        {id: "events", title: "Events"},
        {id: "gestures", title: "Gestures and controls"},
    ],
    props: [
        {
            component: "PointerInput",
            rows: [
                {name: "new PointerInput(canvas, {scene, camera?, layers?, filter?})", type: "PointerInput"},
                {
                    name: "on(entity, type, handler)",
                    type: "() => void",
                    description: "pointerdown / move / up, click, pointerenter / leave. Returns an unsubscribe.",
                },
                {
                    name: "addConsumer(consumer, priority?)",
                    type: "() => void",
                    description: "Joins gesture arbitration; picking sits at 100.",
                },
                {name: "layers / filter", type: "number / (e) => boolean", description: "What can be hit."},
                {name: "clickThreshold", type: "number", default: "4", description: "CSS px before a press drags."},
                {
                    name: "update()",
                    type: "void",
                    description:
                        "Per frame in an animated scene: re-picks a still pointer so enter / leave follow what moves under it. Free when nothing hovers.",
                },
                {name: "dispose()", type: "void"},
            ],
        },
        {
            component: "ScenePointerEvent",
            rows: [
                {name: "ray", type: "Ray", description: "World ray under the pointer."},
                {name: "hits / hit", type: "RaycastHit[] / RaycastHit | null", description: "All hits; this one."},
                {name: "target / currentTarget", type: "Entity", description: "Hit entity; handler's entity."},
                {name: "stopPropagation()", type: "void", description: "No more ancestors, no hits behind."},
                {name: "capture()", type: "void", description: "On pointerdown: own the gesture (drag)."},
            ],
        },
        {
            component: "OrbitControls",
            rows: [
                {
                    name: "new OrbitControls(camera, options?)",
                    type: "OrbitControls",
                    description: "Reads its orbit from the camera.",
                },
                {name: "attach(input) / detach()", type: "this"},
                {name: "update(delta?)", type: "boolean", description: "Every frame; true while moving."},
                {name: "target", type: "vec3", default: "[0, 0, 0]"},
                {name: "damping", type: "number", default: "0.15", description: "Share eased per 1/60 s; 0 snaps."},
                {name: "minDistance / maxDistance", type: "number", default: "0.01 / ∞"},
                {name: "minPolarAngle / maxPolarAngle", type: "number", default: "0.01 / π − 0.01"},
                {name: "rotateSpeed / zoomSpeed / panSpeed", type: "number", default: "1"},
                {name: "enableRotate / enableZoom / enablePan", type: "boolean", default: "true"},
                {
                    name: "trackpadGestures",
                    type: "boolean",
                    default: "true",
                    description: "Pinch zooms, two-finger swipe rotates, Shift + swipe pans.",
                },
                {
                    name: "autoRotate / autoRotateDelay",
                    type: "number",
                    default: "0 / 2",
                    description: "Rad/s idle spin; resume delay.",
                },
                {
                    name: "captureScroll",
                    type: "boolean",
                    default: "true",
                    description: "False: the page keeps the wheel until the canvas is pressed.",
                },
                {
                    name: "touchAction",
                    type: "string",
                    default: '"none"',
                    description: '"pan-y" lets one finger scroll the page.',
                },
            ],
        },
    ],
});

function Notes() {
    return (
        <>
            <section id="picking" className="flex scroll-mt-24 flex-col gap-3">
                <h2 className="font-mono text-xl font-semibold">Picking</h2>
                <p className="text-sm text-muted-foreground">
                    A ray from the camera through the pointer meets colliders, not meshes: any entity can carry one,
                    meshes start with their own triangles, and collider = null opts out. raycast returns every hit,
                    nearest first, so you can take the one behind or the first that passes a test. One layers mask per
                    entity decides what a query (and a camera) sees.
                </p>
                <Code
                    code={`const r = camera.getRay(ray.create(), ndcX, ndcY, width / height);
const hits = raycast(scene, r, {layers: layer(0)}); // [{entity, distance, point, normal, faceIndex, uv}, …]

const hitbox = new Entity();          // invisible: no mesh, just a shape to hit
hitbox.collider = sphereCollider(0.4);
gem.add(hitbox);                      // hits report the hitbox; events bubble to the gem`}
                />
            </section>
            <section id="events" className="flex scroll-mt-24 flex-col gap-3">
                <h2 className="font-mono text-xl font-semibold">Events</h2>
                <p className="text-sm text-muted-foreground">
                    Handlers live on the input, keyed by entity, not on meshes. An event goes to the entity hit, then up
                    its ancestors, then on to the next hit behind; each entity hears it once. stopPropagation ends it
                    there. A click is a press and release that moved less than clickThreshold.
                </p>
                <Code
                    code={`const input = new PointerInput(canvas, {scene});
input.on(car, "click", (e) => select(car));               // a hit on a wheel bubbles up to the car
input.on(car, "pointerenter", () => (canvas.style.cursor = "pointer"));
input.on(glass, "click", (e) => e.stopPropagation());     // nothing behind the glass hears it

// an animated scene: objects move under a still mouse, so re-pick each frame (enter / leave only)
renderer.startAnimation(() => (input.update(), graph));`}
                />
            </section>
            <section id="gestures" className="flex scroll-mt-24 flex-col gap-3">
                <h2 className="font-mono text-xl font-semibold">Gestures and controls</h2>
                <p className="text-sm text-muted-foreground">
                    Each press is offered to consumers by priority until one claims it; the claimer alone gets its
                    moves. Picking sits at 100 and claims when a handler calls capture(), so dragging an object never
                    orbits the camera; OrbitControls sit at 0 and take what is left. Taps still click while controls are
                    attached.
                </p>
                <Code
                    code={`const controls = new OrbitControls(camera, {target: [0, 0.4, 0]}).attach(input);

let offset = vec3.create();
input.on(box, "pointerdown", (e) => {
    e.capture();                                           // the drag is ours: the camera stays put
    vec3.subtract(offset, box.position, e.hit!.point);
});
input.on(box, "pointermove", (e) => {
    const t = ray.intersectPlane(e.ray, [0, e.hit?.point[1] ?? 0, 0], [0, 1, 0]);
    if (t !== null) vec3.add(box.position, ray.at(vec3.create(), e.ray, t), offset);
});

renderer.startAnimation(({delta}) => (controls.update(delta), graph));`}
                />
            </section>
        </>
    );
}

interface Pickable {
    name: string;
    mesh: Mesh;
    material: PBRMaterial;
}

export function PickDragOrbit() {
    const colors = useSceneColors();
    const [hitbox, setHitbox] = useState(true);
    const [damping, setDamping] = useState(true);
    const [selected, setSelected] = useState<string | null>(null);
    const live = useLatest({hitbox, damping});
    return (
        <DemoStage
            controls={
                <>
                    <ControlSwitch label="Hitbox on the gem" checked={hitbox} onChange={setHitbox} />
                    <ControlSwitch label="Orbit damping" checked={damping} onChange={setDamping} />
                    <p className="text-sm text-muted-foreground" aria-live="polite">
                        Selected: <span className="font-mono text-foreground">{selected ?? "none"}</span>
                    </p>
                </>
            }
        >
            <GlazeCanvas
                label="A cube, a sphere, a torus and a tiny gem on a floor: hover, click, drag them, and orbit the camera"
                setup={({canvas}) => {
                    const scene = new Scene();
                    const palette = paletteBinder(colors);
                    palette.scene(scene);
                    scene.add(
                        palette.light(
                            new DirectionalLight({direction: [-0.4, -1, -0.5], intensity: 3, castShadow: true}),
                            (c) => c.key,
                        ),
                    );
                    const floor = new Mesh(
                        createPlane({width: 10, height: 10}),
                        palette.material(new PBRMaterial({roughness: 0.9}), (c) => c.floor),
                    );
                    floor.castShadow = false;
                    scene.add(floor);

                    const make = (
                        name: string,
                        mesh: Mesh,
                        x: number,
                        z: number,
                        pick: Parameters<typeof palette.material>[1],
                    ): Pickable => {
                        const material = palette.material(mesh.material as PBRMaterial, pick);
                        vec3.set(mesh.position, x, mesh.position[1], z);
                        scene.add(mesh);
                        return {name, mesh, material};
                    };
                    const items = [
                        make(
                            "Cube",
                            lift(new Mesh(createCube({size: 0.9}), new PBRMaterial({roughness: 0.4})), 0.45),
                            -1.6,
                            0.3,
                            (c) => c.accent,
                        ),
                        make(
                            "Sphere",
                            lift(
                                new Mesh(
                                    createIcosphere({radius: 0.55, subdivisions: 3}),
                                    new PBRMaterial({roughness: 0.2, metallic: 0.6}),
                                ),
                                0.55,
                            ),
                            0,
                            -0.6,
                            (c) => c.neutral,
                        ),
                        make(
                            "Torus",
                            lift(
                                new Mesh(createTorus({radius: 0.45, tube: 0.18}), new PBRMaterial({roughness: 0.3})),
                                0.63,
                            ),
                            1.6,
                            0.4,
                            (c) => c.hues.purple,
                        ),
                        make(
                            "Gem",
                            lift(
                                new Mesh(
                                    createIcosphere({radius: 0.08, subdivisions: 0, flat: true}),
                                    new PBRMaterial({roughness: 0.1, metallic: 0.8}),
                                ),
                                0.08,
                            ),
                            0.2,
                            1.4,
                            (c) => c.hues.cyan,
                        ),
                    ];
                    items[2]!.mesh.setEuler(Math.PI / 2, 0, 0);
                    const gem = items[3]!.mesh;
                    const gemHitbox = new Entity();
                    const gemShape = sphereCollider(0.35);
                    gemHitbox.collider = gemShape;
                    gem.add(gemHitbox);

                    const camera = new PerspectiveCamera({fov: Math.PI / 4, near: 0.1, far: 100});
                    vec3.set(camera.position, 4, 4, 6);
                    scene.add(camera);
                    scene.activeCamera = camera;

                    const input = new PointerInput(canvas, {scene});
                    const controls = new OrbitControls(camera, {
                        target: [0, 0.3, 0],
                        minDistance: 3,
                        maxDistance: 16,
                        maxPolarAngle: Math.PI / 2 - 0.05,
                        captureScroll: false, // the page scrolls until you press in the canvas
                        touchAction: "pan-y",
                    }).attach(input);

                    let hovered: Pickable | null = null;
                    let chosen: Pickable | null = null;
                    let dragging: {item: Pickable; offset: vec3; height: number} | null = null;
                    const cursor = () => {
                        canvas.style.cursor = dragging ? "grabbing" : hovered ? "grab" : "";
                    };
                    for (const item of items) {
                        input.on(item.mesh, "pointerenter", () => {
                            hovered = item;
                            cursor();
                        });
                        input.on(item.mesh, "pointerleave", () => {
                            if (hovered === item) {
                                hovered = null;
                            }
                            cursor();
                        });
                        input.on(item.mesh, "click", (e) => {
                            chosen = item;
                            setSelected(item.name);
                            e.stopPropagation(); // the floor behind shouldn't deselect it
                        });
                        input.on(item.mesh, "pointerdown", (e) => {
                            if (e.hit === null) {
                                return;
                            }
                            e.capture();
                            e.stopPropagation();
                            const height = e.hit.point[1];
                            dragging = {
                                item,
                                offset: vec3.subtract(vec3.create(), item.mesh.position, e.hit.point),
                                height,
                            };
                            cursor();
                        });
                        input.on(item.mesh, "pointermove", (e) => {
                            if (dragging?.item !== item) {
                                return;
                            }
                            const t = ray.intersectPlane(e.ray, [0, dragging.height, 0], [0, 1, 0]);
                            if (t === null) {
                                return;
                            }
                            const p = vec3.add(vec3.create(), ray.at(vec3.create(), e.ray, t), dragging.offset);
                            item.mesh.position[0] = Math.max(-4.5, Math.min(4.5, p[0]));
                            item.mesh.position[2] = Math.max(-4.5, Math.min(4.5, p[2]));
                        });
                        input.on(item.mesh, "pointerup", () => {
                            dragging = null;
                            cursor();
                        });
                    }
                    input.on(floor, "click", () => {
                        chosen = null;
                        setSelected(null);
                    });

                    const graph = new RenderGraph();
                    const {color} = graph.addPass(new DeferredScenePass({scene}));
                    graph.addPass(new BlitPass({toneMapping: "aces"}), {color}, {canvasSlot: "canvas"});

                    const glow = (item: Pickable): number =>
                        item === chosen ? 0.55 : item === hovered || dragging?.item === item ? 0.35 : 0;
                    const shown = new Map<Pickable, string>();
                    return ({delta}) => {
                        palette.apply();
                        const cfg = live.current;
                        gemHitbox.collider = cfg.hitbox ? gemShape : null;
                        controls.damping = cfg.damping ? 0.15 : 0;
                        controls.update(delta);
                        input.update(); // the camera glides under a still mouse: keep hover in step
                        for (const item of items) {
                            const k = glow(item);
                            const key = `${k}:${colors.current.accentFill}`;
                            if (shown.get(item) !== key) {
                                setColorRgb(item.material.emissive, colors.current.accentFill);
                                item.material.emissiveIntensity = k;
                                item.material.markDirty();
                                shown.set(item, key);
                            }
                        }
                        return graph;
                    };
                }}
            />
        </DemoStage>
    );
}

/** Rests a mesh on the floor: its centre `y` above the ground. */
function lift(mesh: Mesh, y: number): Mesh {
    mesh.position[1] = y;
    return mesh;
}
