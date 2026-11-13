import {
    BlitPass,
    createCone,
    createPlane,
    createSphere,
    createTorus,
    DeferredScenePass,
    DirectionalLight,
    Mesh,
    oscillate,
    PBRMaterial,
    PerspectiveCamera,
    PointLight,
    RenderGraph,
    Scene,
    SpotLight,
} from "@repraze/glaze";
import {vec3} from "gl-matrix";
import {useState} from "react";

import {ControlGroup, ControlSlider, ControlSwitch, DemoStage} from "@/glaze/demo-stage";
import {GlazeCanvas, useLatest} from "@/glaze/glaze-canvas";
import {paletteBinder, useSceneColors} from "@/glaze/scene-colors";
import {Code, defineDoc} from "@/lib/doc-kit";

export const doc = defineDoc({
    title: "Lights",
    category: "Scene",
    description:
        "Directional, point and spot lights, accumulated by the deferred pass in one fullscreen lighting step. Any of them can cast shadows. Lights are entities: move them, parent them, or switch them off with enabled.",
    engineFile: "scene/light.ts",
    order: 2,
    demos: [
        {
            title: "Moving lights",
            description:
                "Ported from the repraze.com lab: three orbiting point lights (red, green, blue) over a metal torus, a warm sun and an overhead spot, each with its own shadow switch.",
            component: MovingLights,
            layout: "full",
        },
    ],
    notes: Notes,
    sections: [{id: "falloff-and-shadows", title: "Falloff and shadows"}],
    props: [
        {
            component: "Light (all)",
            rows: [
                {name: "color", type: "ColorRgb", default: "[1, 1, 1]", description: "Linear 0-1 RGB."},
                {name: "intensity", type: "number", default: "1"},
                {
                    name: "castShadow",
                    type: "boolean",
                    default: "false",
                    description: "Renders a shadow map each frame.",
                },
                {name: "enabled", type: "boolean", default: "true", description: "From Entity: off removes the light."},
            ],
        },
        {
            component: "DirectionalLight",
            rows: [
                {
                    name: "direction (option)",
                    type: "[x, y, z]",
                    default: "[0, -1, 0]",
                    description: "Initial aim: the light travels along its −Z. Re-aim with lookAt / lookAlong.",
                },
            ],
        },
        {
            component: "PointLight",
            rows: [
                {name: "range", type: "number", default: "10", description: "Distance where the light reaches zero."},
            ],
        },
        {
            component: "SpotLight",
            rows: [
                {
                    name: "direction (option)",
                    type: "[x, y, z]",
                    default: "[0, -1, 0]",
                    description: "Initial aim of the cone (its −Z). Re-aim with lookAt / lookAlong.",
                },
                {
                    name: "innerAngle",
                    type: "number",
                    default: "π / 8",
                    description: "Full intensity inside this half-angle.",
                },
                {name: "outerAngle", type: "number", default: "π / 4", description: "Zero outside; smooth in between."},
                {name: "range", type: "number", default: "10"},
            ],
        },
    ],
});

function Notes() {
    return (
        <section id="falloff-and-shadows" className="flex scroll-mt-24 flex-col gap-3">
            <h2 className="font-mono text-xl font-semibold">Falloff and shadows</h2>
            <p className="text-sm text-muted-foreground">
                Point and spot lights fade smoothly to zero at their range, so a light only touches what is near it.
                Each frame the pass renders a shadow map per light with castShadow (six for a point light) from every
                mesh with castShadow; meshes opt out of receiving with receiveShadow. Up to 4 directional, 8 point and 4
                spot lights are lit at once.
            </p>
            <Code
                code={`const sun = palette.light(new DirectionalLight({direction: [1, -2, 0.5], intensity: 1.2}), (c) => c.key);
const bulb = palette.light(new PointLight({intensity: 8, range: 8, castShadow: true}), (c) => c.hues.red);
const spot = new SpotLight({direction: [0, -1, 0], innerAngle: Math.PI / 12, outerAngle: Math.PI / 6, range: 10});
vec3.set(spot.position, 0, 5, 0);
spot.lookAt([0, 0, 0]); // lights are entities: aim them, or parent them to something that moves
scene.add(sun).add(bulb).add(spot);

bulb.add(new Mesh(smallSphere, glowMaterial)); // a marker that follows the light`}
            />
        </section>
    );
}

export function MovingLights() {
    const colors = useSceneColors();
    const [speed, setSpeed] = useState(1);
    const [intensity, setIntensity] = useState(8);
    const [range, setRange] = useState(8);
    const [points, setPoints] = useState(true);
    const [pointShadows, setPointShadows] = useState(true);
    const [sun, setSun] = useState(true);
    const [spot, setSpot] = useState(true);
    const live = useLatest({speed, intensity, range, points, pointShadows, sun, spot});
    return (
        <DemoStage
            controls={
                <>
                    <ControlGroup label="Point lights">
                        <ControlSwitch label="Enabled" checked={points} onChange={setPoints} />
                        <ControlSwitch label="Cast shadows" checked={pointShadows} onChange={setPointShadows} />
                        <ControlSlider label="Speed" value={speed} onChange={setSpeed} min={0} max={3} step={0.1} />
                        <ControlSlider
                            label="Intensity"
                            value={intensity}
                            onChange={setIntensity}
                            min={0}
                            max={20}
                            step={0.5}
                        />
                        <ControlSlider label="Range" value={range} onChange={setRange} min={1} max={15} step={0.5} />
                    </ControlGroup>
                    <ControlGroup label="Other lights">
                        <ControlSwitch label="Sun" checked={sun} onChange={setSun} />
                        <ControlSwitch label="Spot" checked={spot} onChange={setSpot} />
                    </ControlGroup>
                </>
            }
        >
            <GlazeCanvas
                label="Red, green and blue lights circling a metal torus on a floor, casting colored shadows"
                setup={({orbitControls}) => {
                    const scene = new Scene();
                    const palette = paletteBinder(colors);
                    palette.scene(scene);
                    vec3.set(scene.environmentColor, 0, 0, 0);
                    const camera = new PerspectiveCamera({fov: Math.PI / 3, near: 0.1, far: 200});
                    scene.add(camera);
                    scene.activeCamera = camera;
                    orbitControls(camera, {distance: 7, elevation: 30, target: [0, 0.6, 0], spin: 7});

                    const floor = new Mesh(
                        createPlane({width: 40, height: 40, widthSegments: 10, heightSegments: 10}),
                        palette.material(new PBRMaterial({roughness: 0.9}), (c) => c.floor),
                    );
                    floor.castShadow = false;
                    scene.add(floor);
                    const torus = new Mesh(
                        createTorus({radius: 0.8, tube: 0.25, radialSegments: 16, tubularSegments: 64}),
                        palette.material(new PBRMaterial({roughness: 0.25, metallic: 0.6}), (c) => c.neutral),
                    );
                    vec3.set(torus.position, 0, 1.2, 0);
                    torus.setEuler(Math.PI / 2, 0, 0);
                    scene.add(torus);

                    const sunLight = palette.light(
                        new DirectionalLight({direction: [1, -2, 0.5], intensity: 1.2}),
                        (c) => c.key,
                    );
                    const spotLight = palette.light(
                        new SpotLight({
                            direction: [0, -1, 0],
                            intensity: 12,
                            range: 10,
                            innerAngle: Math.PI / 12,
                            outerAngle: Math.PI / 6,
                        }),
                        (c) => c.key,
                    );
                    vec3.set(spotLight.position, 0, 5, 0);
                    scene.add(sunLight).add(spotLight);

                    // three point lights in TermiColor's red, green and blue, each carrying a small glowing marker
                    // (black albedo on purpose: a marker only emits)
                    const marker = createSphere({radius: 0.08, widthSegments: 8, heightSegments: 6});
                    const hues = ["red", "green", "blue"] as const;
                    const bulbs = hues.map((hue) => {
                        const light = palette.light(new PointLight({intensity: 8, range: 8}), (c) => c.hues[hue]);
                        const dot = new Mesh(
                            marker,
                            palette.emissive(new PBRMaterial({color: [0, 0, 0]}), (c) => c.hues[hue]),
                        );
                        dot.castShadow = dot.receiveShadow = false;
                        light.add(dot);
                        scene.add(light);
                        return light;
                    });
                    // the spot's cone, tip at the light
                    const cone = new Mesh(
                        createCone({
                            radius: Math.tan(Math.PI / 6) * 0.5,
                            height: 0.5,
                            radialSegments: 16,
                            openEnded: true,
                        }),
                        palette.emissive(new PBRMaterial({color: [0, 0, 0]}), (c) => c.key),
                    );
                    cone.castShadow = cone.receiveShadow = false;
                    vec3.set(cone.position, 0, -0.25, 0);
                    spotLight.add(cone);

                    const graph = new RenderGraph();
                    const {color} = graph.addPass(new DeferredScenePass({scene}));
                    graph.addPass(new BlitPass(), {color}, {canvasSlot: "canvas"});

                    let t = 0;
                    return ({delta}) => {
                        palette.apply();
                        const cfg = live.current;
                        t += delta * cfg.speed;
                        sunLight.enabled = cfg.sun;
                        spotLight.enabled = cfg.spot;
                        const [red, green, blue] = bulbs as [PointLight, PointLight, PointLight];
                        vec3.set(
                            red.position,
                            2.5 * oscillate(t, 1.2),
                            2 + 0.8 * oscillate(t, 0.8),
                            2.5 * Math.cos(t * 1.2),
                        );
                        vec3.set(green.position, 1.8 * oscillate(t * 0.7 + 2.09), 2, 1.8 * Math.cos(t * 0.7 + 2.09));
                        vec3.set(
                            blue.position,
                            2 * oscillate(t * 0.5 + 4.19),
                            2 + 2 * oscillate(t, 0.6 + Math.PI),
                            2 * Math.cos(t * 0.5 + 4.19),
                        );
                        for (const bulb of bulbs) {
                            bulb.enabled = cfg.points;
                            bulb.castShadow = cfg.pointShadows;
                            bulb.intensity = cfg.intensity;
                            bulb.range = cfg.range;
                        }
                        return graph;
                    };
                }}
            />
        </DemoStage>
    );
}
