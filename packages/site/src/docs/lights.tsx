import {
    BlitPass,
    type CascadeBlend,
    createCone,
    createCube,
    createIcosphere,
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

import {ControlGroup, ControlSegmented, ControlSlider, ControlSwitch, DemoStage} from "@/glaze/demo-stage";
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
        {
            title: "Sun shadows",
            description:
                "A field of pillars under the sun. Its shadow is split into cascades fitted to the view, sharp up close and coarser far off: show them to see the splits. Softness is the sun's size in degrees, so shadows stay hard where things touch the ground and blur further out. Orbit and zoom to compare.",
            component: SunShadows,
            layout: "full",
        },
    ],
    notes: Notes,
    sections: [
        {id: "falloff-and-shadows", title: "Falloff and shadows"},
        {id: "shadow-settings", title: "Shadow settings"},
    ],
    props: [
        {
            component: "Light (all)",
            rows: [
                {name: "color", type: "ColorRgb", default: "[1, 1, 1]", description: "sRGB 0-1, as picked."},
                {name: "intensity", type: "number", default: "1"},
                {
                    name: "castShadow",
                    type: "boolean",
                    default: "false",
                    description: "Renders a shadow map each frame.",
                },
                {name: "enabled", type: "boolean", default: "true", description: "From Entity: off removes the light."},
                {
                    name: "shadow.softness",
                    type: "number",
                    default: "0.05 (point, spot) · 1 (sun)",
                    description:
                        "The light's size: its radius in world units, or the sun's angular diameter in degrees. Shadows harden at contact and blur with distance. 0: hard.",
                },
                {
                    name: "shadow.samples",
                    type: "number",
                    default: "16",
                    description: "Filter taps per lookup: smoother soft edges for more work.",
                },
                {
                    name: "shadow.normalBias / bias",
                    type: "number",
                    default: "1.5 / 0.5",
                    description:
                        "Lookup offsets in shadow texels: along the normal (at grazing light) and toward the light.",
                },
                {
                    name: "shadow.intensity",
                    type: "number",
                    default: "1",
                    description: "How dark the shadow gets: 0.5 lets half the light through.",
                },
                {
                    name: "shadow.near",
                    type: "number",
                    default: "0.1",
                    description: "Point and spot lights: where the shadow map starts; nearer casters cast nothing.",
                },
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
                {
                    name: "shadow.cascades",
                    type: "1-4",
                    default: "4",
                    description: "Shadow maps splitting the view in depth, each fitted to its slice.",
                },
                {
                    name: "shadow.maxDistance",
                    type: "number",
                    default: "40",
                    description: "Shadows end this far from the camera, fading over the last tenth.",
                },
                {
                    name: "shadow.splitBalance",
                    type: "0-1",
                    default: "0.6",
                    description: "0: even splits. 1: logarithmic, finer near the camera.",
                },
                {
                    name: "shadow.cascadeBlend",
                    type: '"dither" | "smooth" | "none"',
                    default: '"dither"',
                    description:
                        "Hand-over between cascades: a fixed per-pixel dither (one lookup, no flicker), a cross-fade (two), or a hard switch.",
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
        <>
            <section id="falloff-and-shadows" className="flex scroll-mt-24 flex-col gap-3">
                <h2 className="font-mono text-xl font-semibold">Falloff and shadows</h2>
                <p className="text-sm text-muted-foreground">
                    Point and spot lights fade smoothly to zero at their range, so a light only touches what is near it.
                    Each frame the pass renders a shadow map per light with castShadow (six for a point light) from
                    every mesh with castShadow; meshes opt out of receiving with receiveShadow. Up to 4 directional, 8
                    point and 4 spot lights are lit at once.
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
            <section id="shadow-settings" className="flex scroll-mt-24 flex-col gap-3">
                <h2 className="font-mono text-xl font-semibold">Shadow settings</h2>
                <p className="text-sm text-muted-foreground">
                    The defaults suit most scenes; each light carries its settings in{" "}
                    <code className="font-mono text-foreground">light.shadow</code>, read every frame. A directional
                    light splits its shadow into cascades fitted to the camera: the nearest covers a few metres at full
                    resolution, the last reaches maxDistance. Each sits on the light&apos;s texel grid with a size that
                    only depends on the view&apos;s shape, so shadows don&apos;t shimmer as the camera moves. Softness
                    finds the blockers between a point and the light and widens the filter with their distance: shadows
                    are crisp where an object touches the ground.
                </p>
                <p className="text-sm text-muted-foreground">
                    The cost scales with samples, cascades and lights: a lookup reads up to <em>samples</em> texels to
                    find blockers and as many to filter, in one cascade (two where they blend). Map resolution is a pass
                    option: <code className="font-mono text-foreground">shadowMapSize</code> (default 1024, per cascade
                    and spot light) and <code className="font-mono text-foreground">pointShadowMapSize</code> (512).
                </p>
                <Code
                    code={`const sun = new DirectionalLight({
    direction: [-0.5, -0.6, -0.4],
    castShadow: true,
    shadow: {cascades: 4, maxDistance: 60, softness: 1.5}, // the rest keep their defaults
});
sun.shadow.samples = 8; // any time: cheaper soft edges

const pass = new DeferredScenePass({scene, shadowMapSize: 2048});
pass.debugCascades = true; // tint each cascade: red, green, blue, yellow`}
                />
            </section>
        </>
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

const CASCADE_OPTIONS = [
    {value: "1", label: "1"},
    {value: "2", label: "2"},
    {value: "3", label: "3"},
    {value: "4", label: "4"},
] as const;
const BLEND_OPTIONS: {value: CascadeBlend; label: string}[] = [
    {value: "dither", label: "Dither"},
    {value: "smooth", label: "Smooth"},
    {value: "none", label: "None"},
];
const SAMPLE_OPTIONS = [
    {value: "4", label: "4"},
    {value: "8", label: "8"},
    {value: "16", label: "16"},
    {value: "32", label: "32"},
] as const;

export function SunShadows() {
    const colors = useSceneColors();
    const [cascades, setCascades] = useState<(typeof CASCADE_OPTIONS)[number]["value"]>("4");
    const [softness, setSoftness] = useState(1);
    const [samples, setSamples] = useState<(typeof SAMPLE_OPTIONS)[number]["value"]>("16");
    const [maxDistance, setMaxDistance] = useState(40);
    const [show, setShow] = useState(false);
    const [blend, setBlend] = useState<CascadeBlend>("dither");
    const live = useLatest({cascades, softness, samples, maxDistance, show, blend});
    return (
        <DemoStage
            controls={
                <>
                    <ControlSwitch label="Show cascades" checked={show} onChange={setShow} />
                    <ControlSegmented
                        label="Cascades"
                        value={cascades}
                        options={CASCADE_OPTIONS}
                        onChange={setCascades}
                    />
                    <ControlSlider
                        label="Softness"
                        value={softness}
                        onChange={setSoftness}
                        min={0}
                        max={6}
                        step={0.25}
                        format={(v) => (v === 0 ? "hard" : `${v}°`)}
                    />
                    <ControlSegmented label="Samples" value={samples} options={SAMPLE_OPTIONS} onChange={setSamples} />
                    <ControlSegmented label="Cascade blend" value={blend} options={BLEND_OPTIONS} onChange={setBlend} />
                    <ControlSlider
                        label="Max distance"
                        value={maxDistance}
                        onChange={setMaxDistance}
                        min={5}
                        max={80}
                        step={5}
                    />
                </>
            }
        >
            <GlazeCanvas
                label="Rows of pillars and spheres on a long floor under a low sun, casting long shadows into the distance"
                setup={({orbitControls}) => {
                    const scene = new Scene();
                    const palette = paletteBinder(colors);
                    palette.scene(scene);
                    const camera = new PerspectiveCamera({fov: Math.PI / 4, near: 0.1, far: 200});
                    orbitControls(camera, {distance: 9, elevation: 24, azimuth: 15, target: [0, 1, -2], spin: 4});
                    scene.add(camera);
                    scene.activeCamera = camera;
                    const sun = palette.light(
                        new DirectionalLight({direction: [-0.55, -0.5, -0.45], intensity: 3, castShadow: true}),
                        (c) => c.key,
                    );
                    scene.add(sun);
                    scene.add(
                        new Mesh(
                            createPlane({width: 140, height: 140}),
                            palette.material(new PBRMaterial({roughness: 0.9}), (c) => c.neutral),
                        ),
                    );
                    const pillar = createCube({size: 1});
                    const ball = createIcosphere({radius: 0.5, subdivisions: 2});
                    const stone = palette.material(new PBRMaterial({roughness: 0.6}), (c) => c.accent);
                    const glass = palette.material(new PBRMaterial({roughness: 0.3}), (c) => c.hues.blue);
                    for (let z = 6; z > -60; z -= 3.5) {
                        for (let x = -10; x <= 10; x += 5) {
                            const p = new Mesh(pillar, stone);
                            vec3.set(p.scale, 0.6, 2.5, 0.6);
                            vec3.set(p.position, x + ((z * 7) % 2), 1.25, z);
                            scene.add(p);
                            const b = new Mesh(ball, glass);
                            vec3.set(b.position, x + 2.2, 0.5, z + 1.2);
                            scene.add(b);
                        }
                    }
                    // a thin rail near the camera: detail only the first cascade can hold
                    const rail = new Mesh(pillar, stone);
                    vec3.set(rail.scale, 0.04, 1.6, 0.04);
                    vec3.set(rail.position, 1.2, 0.8, 3);
                    scene.add(rail);

                    const pass = new DeferredScenePass({scene});
                    const graph = new RenderGraph();
                    const {color} = graph.addPass(pass);
                    graph.addPass(new BlitPass({toneMapping: "agx"}), {color}, {canvasSlot: "canvas"});
                    return () => {
                        palette.apply();
                        const cfg = live.current;
                        sun.shadow.cascades = Number(cfg.cascades);
                        sun.shadow.softness = cfg.softness;
                        sun.shadow.samples = Number(cfg.samples);
                        sun.shadow.maxDistance = cfg.maxDistance;
                        sun.shadow.cascadeBlend = cfg.blend;
                        pass.debugCascades = cfg.show;
                        return graph;
                    };
                }}
            />
        </DemoStage>
    );
}
