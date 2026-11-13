import {
    type AnimationAction,
    AnimationMixer,
    BlitPass,
    DeferredScenePass,
    DirectionalLight,
    loadGltf,
    type LoopMode,
    PerspectiveCamera,
    RenderGraph,
    Scene,
} from "@repraze/glaze";
import {Spinner} from "@repraze/kernelkit/components/spinner";
import {useState} from "react";

import {ControlSegmented, ControlSlider, ControlStats, ControlSwitch, DemoStage} from "@/glaze/demo-stage";
import {GlazeCanvas, useLatest} from "@/glaze/glaze-canvas";
import {makeEnvironments} from "@/glaze/helpers";
import {paletteBinder, useSceneColors} from "@/glaze/scene-colors";
import {Code, defineDoc} from "@/lib/doc-kit";

export const doc = defineDoc({
    title: "Animation",
    category: "Scene",
    description:
        "glTF animations load as clips: keyframe tracks on the model's entities. An AnimationMixer plays them through actions, with speed, looping and weights, and crossfades from one to another. Skinned meshes bend with their skeleton's joints; morph targets blend shapes by weight.",
    engineFile: "animation/mixer.ts",
    order: 6,
    demos: [
        {
            title: "Clockwork",
            description:
                "One glTF file, two clips over the same nodes. Run swings the pendulum (linear rotation), bounces the ball (cubic spline) and squashes it (linear scale), turns the gears, blinks the lamp (step), waves the stalk (a skinned tube on four bones) and swells its bulb's ridges (a morph target). Switch to Idle: the mixer crossfades between them.",
            component: Clockwork,
            layout: "full",
        },
    ],
    notes: Notes,
    sections: [
        {id: "clips-and-actions", title: "Clips and actions"},
        {id: "blending", title: "Blending"},
        {id: "skinning", title: "Skinning"},
        {id: "morph-targets", title: "Morph targets"},
    ],
    props: [
        {
            component: "AnimationMixer",
            rows: [
                {name: "clipAction(clip)", type: "AnimationAction", description: "The clip's action, created stopped."},
                {
                    name: "update(delta)",
                    type: "void",
                    description: "Per frame: advances enabled actions and writes the blended pose.",
                },
                {name: "stopAll()", type: "void", description: "Entities keep their last pose."},
            ],
        },
        {
            component: "AnimationAction",
            rows: [
                {
                    name: "play() / pause() / stop()",
                    type: "this",
                    description: "Pause holds the pose; stop rewinds and lets go.",
                },
                {name: "time", type: "number", description: "Seconds into the clip: set it to seek."},
                {name: "speed", type: "number", default: "1", description: "Negative plays backwards."},
                {name: "loop", type: '"repeat" | "once" | "pingpong"', default: '"repeat"'},
                {name: "weight", type: "number", default: "1", description: "Share of the pose when several play."},
                {
                    name: "fadeIn(s) / fadeOut(s) / crossFadeTo(next, s)",
                    type: "this / next",
                    description: "Weight ramps; fadeOut stops at the end.",
                },
                {name: "finished", type: "boolean", description: 'A "once" action at its end.'},
            ],
        },
        {
            component: "SkinnedMesh",
            rows: [
                {
                    name: "new SkinnedMesh(geometry, material, skin?)",
                    type: "SkinnedMesh",
                    description: "Geometry with joints and weights.",
                },
                {name: "skin", type: "Skin | null", description: "Its skeleton; loadGltf sets it."},
                {
                    name: "collider",
                    type: "Collider | null",
                    default: "null",
                    description: "Its triangles move: put colliders on the joints to pick it.",
                },
            ],
        },
        {
            component: "Mesh (morph targets)",
            rows: [
                {
                    name: "morphWeights",
                    type: "Float32Array",
                    description: "One weight per morph target of its geometry; only non-zero ones cost anything.",
                },
                {
                    name: "geometry.morphTargets",
                    type: "{positions, normals?}[]",
                    description: "Per-vertex deltas at weight 1.",
                },
            ],
        },
        {
            component: "Skin",
            rows: [
                {name: "joints", type: "Entity[]", description: "Animate them (or let clips do it) to bend the mesh."},
                {
                    name: "inverseBindMatrices",
                    type: "Float32Array",
                    description: "16 floats a joint: its bind pose, inverted.",
                },
            ],
        },
        {
            component: "AnimationClip",
            rows: [
                {name: "name", type: "string", description: "The glTF animation's name."},
                {name: "duration", type: "number", description: "Seconds, the last key of any track."},
                {
                    name: "tracks",
                    type: "AnimationTrack[]",
                    description: "target entity, path (translation, rotation, scale), times, values, interpolation.",
                },
            ],
        },
    ],
});

function Notes() {
    return (
        <div className="flex flex-col gap-8">
            <section id="clips-and-actions" className="flex scroll-mt-24 flex-col gap-3">
                <h2 className="font-mono text-xl font-semibold">Clips and actions</h2>
                <p className="text-sm text-muted-foreground">
                    <code className="font-mono text-foreground">loadGltf</code> returns the file&apos;s animations as{" "}
                    <code className="font-mono text-foreground">model.animations</code>: one clip per glTF animation,
                    one track per channel, aimed at the entities in{" "}
                    <code className="font-mono text-foreground">model.nodes</code>. Linear, step and cubic-spline keys
                    are all sampled as glTF defines them; rotations take the shortest arc. A mixer turns clips into
                    actions you play, pause, seek and loop; call its update once a frame. Sampling allocates nothing and
                    starts its key search where the last frame stopped.
                </p>
                <Code
                    code={`const model = await loadGltf(renderer.device, "/models/clockwork/clockwork.glb");
scene.add(model.root);

const mixer = new AnimationMixer();
const run = mixer.clipAction(model.animations.find((c) => c.name === "Run")!).play();
run.speed = 1.5;

renderer.startAnimation(({delta}) => {
    mixer.update(delta);
    return graph;
});`}
                />
            </section>
            <section id="blending" className="flex scroll-mt-24 flex-col gap-3">
                <h2 className="font-mono text-xl font-semibold">Blending</h2>
                <p className="text-sm text-muted-foreground">
                    Every enabled action adds its pose with its weight: positions and scales are averaged, rotations
                    blended on the same hemisphere. Where the weights add up to less than 1, the rest pose (the
                    transform before any clip touched it) fills in, so a fading action eases back to it. crossFadeTo
                    ramps one action down and the next up over the same time.
                </p>
                <Code
                    code={`const idle = mixer.clipAction(idleClip);
run.crossFadeTo(idle, 0.6); // run fades out and stops, idle fades in and plays

action.loop = "once";       // stop on the last frame: action.finished turns true
action.weight = 0.5;        // half this clip, half whatever else plays (or the rest pose)`}
                />
            </section>
            <section id="skinning" className="flex scroll-mt-24 flex-col gap-3">
                <h2 className="font-mono text-xl font-semibold">Skinning</h2>
                <p className="text-sm text-muted-foreground">
                    A glTF node with a skin loads as a <code className="font-mono text-foreground">SkinnedMesh</code>:
                    each vertex follows up to four joints by its weights. Joints are ordinary entities, so clips animate
                    them like anything else and you can parent things to them, like the bulb on the stalk. Each frame
                    the pass uploads the joint matrices and the vertex shader blends them: the G-buffer, shadows and
                    see-through meshes all bend alike.
                </p>
                <p className="text-sm text-muted-foreground">
                    The geometry stays in its bind pose on the CPU, so a skinned mesh has no collider by default: hang
                    colliders on the joints to pick it. Shadow culling and sorting use a sphere around its joints.
                </p>
                <Code
                    code={`const head = model.root.find("Head")!;      // a joint
head.collider = sphereCollider(0.15);       // picks follow the animation
input.on(head, "click", () => wave.play());`}
                />
            </section>
            <section id="morph-targets" className="flex scroll-mt-24 flex-col gap-3">
                <h2 className="font-mono text-xl font-semibold">Morph targets</h2>
                <p className="text-sm text-muted-foreground">
                    A morph target is a shape the mesh can blend toward: per-vertex position (and normal) deltas, added
                    by <code className="font-mono text-foreground">mesh.morphWeights</code>. glTF meshes bring their
                    targets (sparse accessors included) and default weights; weights channels animate them like any
                    track, and they blend before skinning, as the spec says. The deltas live on the GPU once per
                    geometry, so a weight change costs a few floats.
                </p>
                <Code
                    code={`const face = model.root.find("Face") as Mesh;
face.morphWeights[0] = 0.8; // smile, by hand: no clip needed`}
                />
            </section>
        </div>
    );
}

const CLOCKWORK_URL = `${import.meta.env.BASE_URL}models/clockwork/clockwork.glb`;

type ClipName = "Run" | "Idle";
const CLIPS: {value: ClipName; label: string}[] = [
    {value: "Run", label: "Run"},
    {value: "Idle", label: "Idle"},
];
const LOOPS: {value: LoopMode; label: string}[] = [
    {value: "repeat", label: "Repeat"},
    {value: "pingpong", label: "Ping-pong"},
    {value: "once", label: "Once"},
];

export function Clockwork() {
    const colors = useSceneColors();
    const [clip, setClip] = useState<ClipName>("Run");
    const [playing, setPlaying] = useState(true);
    const [speed, setSpeed] = useState(1);
    const [loop, setLoop] = useState<LoopMode>("repeat");
    const [fade, setFade] = useState(0.6);
    const [status, setStatus] = useState<string[] | null>(null);
    const live = useLatest({clip, playing, speed, loop, fade});
    return (
        <DemoStage
            controls={
                <>
                    <ControlSegmented label="Clip" value={clip} options={CLIPS} onChange={setClip} />
                    <ControlSlider
                        label="Crossfade"
                        value={fade}
                        onChange={setFade}
                        min={0}
                        max={2}
                        step={0.1}
                        format={(v) => `${v.toFixed(1)} s`}
                    />
                    <ControlSwitch label="Playing" checked={playing} onChange={setPlaying} />
                    <ControlSlider
                        label="Speed"
                        value={speed}
                        onChange={setSpeed}
                        min={-2}
                        max={2}
                        step={0.25}
                        format={(v) => `${v}×`}
                    />
                    <ControlSegmented label="Loop" value={loop} options={LOOPS} onChange={setLoop} />
                    <ControlStats facts={status} pending={<Spinner />} />
                </>
            }
        >
            <GlazeCanvas
                label="A wooden desk toy with a swinging brass pendulum, turning gears, a bouncing red ball and a blinking lamp"
                setup={async ({renderer, orbitControls}) => {
                    const scene = new Scene();
                    const palette = paletteBinder(colors);
                    palette.scene(scene);
                    scene.environmentMap = makeEnvironments(renderer.device).get("studio") ?? null;
                    const camera = new PerspectiveCamera({fov: Math.PI / 4, near: 0.05, far: 60});
                    orbitControls(camera, {distance: 6.5, elevation: 18, azimuth: 20, target: [0, 1.1, 0]});
                    scene.add(camera);
                    scene.activeCamera = camera;
                    scene.add(
                        palette.light(
                            new DirectionalLight({
                                direction: [-0.4, -0.9, -0.5],
                                intensity: 3,
                                castShadow: true,
                                shadow: {softness: 2},
                            }),
                            (c) => c.key,
                        ),
                    );

                    // a soft fill from the camera side: the gears' flat brass faces look at it
                    scene.add(
                        palette.light(new DirectionalLight({direction: [0.3, -0.3, -1], intensity: 0.8}), (c) => c.key),
                    );

                    const model = await loadGltf(renderer.device, CLOCKWORK_URL);
                    scene.add(model.root);
                    const mixer = new AnimationMixer();
                    const actions = new Map<ClipName, AnimationAction>(
                        model.animations.map((c) => [c.name as ClipName, mixer.clipAction(c)]),
                    );
                    let current = actions.get(live.current.clip)!.play();
                    setStatus(
                        model.animations.map((c) => `${c.name} ${c.duration.toFixed(1)} s · ${c.tracks.length} tracks`),
                    );

                    const graph = new RenderGraph();
                    const {color} = graph.addPass(new DeferredScenePass({scene}));
                    graph.addPass(new BlitPass({toneMapping: "agx"}), {color}, {canvasSlot: "canvas"});
                    return ({delta}) => {
                        palette.apply();
                        const cfg = live.current;
                        const wanted = actions.get(cfg.clip)!;
                        if (wanted !== current) {
                            wanted.time = 0;
                            current = current.crossFadeTo(wanted, cfg.fade);
                        }
                        for (const action of actions.values()) {
                            action.speed = cfg.speed;
                            action.loop = cfg.loop;
                            action.playing = action.enabled && cfg.playing;
                        }
                        mixer.update(delta);
                        return graph;
                    };
                }}
            />
        </DemoStage>
    );
}
