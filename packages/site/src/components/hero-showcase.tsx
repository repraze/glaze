import {
    BlitPass,
    createSphere,
    DeferredScenePass,
    DirectionalLight,
    Mesh,
    oscillate,
    PBRMaterial,
    PerspectiveCamera,
    PointLight,
    RenderGraph,
    Scene,
    ShaderPass,
    SplitViewPass,
} from "@repraze/glaze";
import {Card, CardContent, CardDescription, CardHeader, CardTitle} from "@repraze/kernelkit/components/card";
import {Carousel, CarouselContent, CarouselDots, CarouselItem} from "@repraze/kernelkit/components/carousel";
import {Grid2x2Icon, LayersIcon, LightbulbIcon, type LucideIcon, PaletteIcon, WorkflowIcon} from "lucide-react";
import type {ReactNode} from "react";

import {buildPostFragment} from "@/glaze/dither";
import {GlazeCanvas, type GlazeSetup} from "@/glaze/glaze-canvas";
import {makeEnvironments, makeShape, orbit} from "@/glaze/helpers";
import {paletteBinder, perTheme, useSceneColors, wgslColor} from "@/glaze/scene-colors";

/** Every slide is the same height, so the hero keeps one size while it plays (and matches the suite's). */
const SLIDE = "h-88";

/** The hero's right column: live Glaze scenes, each a different part of the pipeline, in TermiColor. */
export function GlazeShowcase() {
    return (
        <Carousel autoplay={7000} opts={{loop: true}} aria-label="GlazeEngine showcase">
            <CarouselContent>
                <CarouselItem>
                    <GraphSlide />
                </CarouselItem>
                <CarouselItem>
                    <MaterialsSlide />
                </CarouselItem>
                <CarouselItem>
                    <LightsSlide />
                </CarouselItem>
                <CarouselItem>
                    <GBufferSlide />
                </CarouselItem>
                <CarouselItem>
                    <DitherSlide />
                </CarouselItem>
            </CarouselContent>
            <CarouselDots />
        </Carousel>
    );
}

function Slide({
    icon: Icon,
    title,
    description,
    children,
}: {
    icon: LucideIcon;
    title: string;
    description: string;
    children: ReactNode;
}) {
    return (
        <Card className={SLIDE}>
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <Icon className="size-4 text-primary-text" /> {title}
                </CardTitle>
                <CardDescription>{description}</CardDescription>
            </CardHeader>
            <CardContent className="min-h-0 flex-1">
                <div className="relative h-full overflow-hidden rounded-lg border border-border bg-background">
                    {children}
                </div>
            </CardContent>
        </Card>
    );
}

/** The render graph docs' multipass noise: a noise texture at 1/14 of the canvas, read back as blinking dots. */
function GraphSlide() {
    const colors = useSceneColors();
    const setup: GlazeSetup = () => {
        const noise = new ShaderPass({
            fragmentShader: /* wgsl */ `
                fn hash(p: vec2<f32>) -> f32 { return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453); }
                @fragment fn fs_main(in: QuadInput) -> @location(0) vec4<f32> {
                    let p = floor(in.pos.xy) * 0.09 + globals.time * 0.1;
                    let i = floor(p);
                    let f = fract(p);
                    let u = f * f * (3.0 - 2.0 * f);
                    let n = mix(mix(hash(i), hash(i + vec2<f32>(1.0, 0.0)), u.x),
                                mix(hash(i + vec2<f32>(0.0, 1.0)), hash(i + vec2<f32>(1.0, 1.0)), u.x), u.y);
                    return vec4<f32>(n, n, n, 1.0);
                }`,
            outputs: [{name: "noise", spec: {format: "rgba8unorm", widthDivisor: 14, heightDivisor: 14}}],
        });
        const dots = perTheme(
            (c) =>
                new ShaderPass({
                    // Each dot blinks at a fixed rate from a hash of its cell. Taking the rate from the noise (which
                    // drifts with time) made sin(time * rate(time)) speed up the longer the page stayed open.
                    fragmentShader: /* wgsl */ `
                        fn cellHash(p: vec2<f32>) -> f32 { return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453); }
                        @fragment fn fs_main(in: QuadInput) -> @location(0) vec4<f32> {
                            let cell = floor(in.pos.xy / 14.0);
                            let h = textureSample(input0, inputSampler, (cell + 0.5) / ceil(globals.resolution / 14.0)).r;
                            let d = length(fract(in.pos.xy / 14.0) - 0.5) * 14.0;
                            let rnd = cellHash(cell);
                            let blink = 0.5 + 0.5 * sin(globals.time * (1.0 + rnd * 3.0) + rnd * 6.283185);
                            let dot = (1.0 - smoothstep(3.5, 5.5, d)) * blink;
                            let hue = mix(${wgslColor(c.accent)}, ${wgslColor(c.hues.purple)}, h);
                            return vec4<f32>(mix(${wgslColor(c.background)}, hue, dot), 1.0);
                        }`,
                    inputs: [{name: "input0"}],
                }),
        );
        return () => {
            const graph = new RenderGraph();
            const {noise: field} = graph.addPass(noise);
            graph.addPass(dots(colors.current), {input0: field}, {canvasSlot: "canvas"});
            return graph;
        };
    };
    return (
        <Slide
            icon={WorkflowIcon}
            title="A render graph"
            description="Pass one writes a small noise texture, pass two reads it."
        >
            <GlazeCanvas
                label="A grid of dots in the site's accent and purple, blinking over the page background"
                maxPixelRatio={1}
                setup={setup}
            />
        </Slide>
    );
}

function MaterialsSlide() {
    const colors = useSceneColors();
    const setup: GlazeSetup = ({renderer}) => {
        const environments = makeEnvironments(renderer.device);
        const scene = new Scene();
        const palette = paletteBinder(colors);
        palette.scene(scene);
        scene.environmentMap = environments.get("city") ?? null;
        scene.backgroundMap = scene.environmentMap;
        const camera = new PerspectiveCamera({fov: Math.PI / 5});
        scene.add(camera);
        scene.activeCamera = camera;
        scene.add(palette.light(new DirectionalLight({direction: [-0.6, -0.8, -0.4], intensity: 3}), (c) => c.key));
        const sphere = createSphere({radius: 0.6, widthSegments: 48, heightSegments: 24});
        const looks = [
            {pick: (c: typeof colors.current) => c.accent, roughness: 0.25, metallic: 0},
            {pick: (c: typeof colors.current) => c.hues.yellow, roughness: 0.1, metallic: 1},
            {pick: (c: typeof colors.current) => c.neutral, roughness: 0.45, metallic: 1},
        ];
        const balls = looks.map(({pick, ...look}, i) => {
            const ball = new Mesh(sphere, palette.material(new PBRMaterial(look), pick));
            ball.position[0] = (i - 1) * 1.45;
            scene.add(ball);
            return ball;
        });
        const graph = new RenderGraph();
        const {color} = graph.addPass(new DeferredScenePass({scene}));
        graph.addPass(new BlitPass({toneMapping: "aces"}), {color}, {canvasSlot: "canvas"});
        return ({time}) => {
            palette.apply();
            balls.forEach((ball, i) => (ball.position[1] = oscillate(time + i * 0.7) * 0.12));
            orbit(camera, {distance: 7, elevation: 8, azimuth: Math.sin(time * 0.3) * 20});
            return graph;
        };
    };
    return (
        <Slide icon={PaletteIcon} title="PBR materials" description="Plastic, gold and steel under an environment map.">
            <GlazeCanvas
                label="A plastic ball in the site's accent, a gold ball and a steel ball reflecting a city sky"
                setup={setup}
            />
        </Slide>
    );
}

function LightsSlide() {
    const colors = useSceneColors();
    const setup: GlazeSetup = () => {
        const scene = new Scene();
        const palette = paletteBinder(colors);
        palette.scene(scene);
        const camera = new PerspectiveCamera({fov: Math.PI / 3});
        orbit(camera, {distance: 5.5, elevation: 32, target: [0, 0.6, 0]});
        scene.add(camera);
        scene.activeCamera = camera;
        const floor = new Mesh(
            makeShape("plane"),
            palette.material(new PBRMaterial({roughness: 0.9}), (c) => c.floor),
        );
        floor.scale[0] = floor.scale[2] = 6;
        scene.add(floor);
        const torus = new Mesh(
            makeShape("torus"),
            palette.material(new PBRMaterial({roughness: 0.25, metallic: 0.6}), (c) => c.neutral),
        );
        torus.position[1] = 1.1;
        torus.setEuler(Math.PI / 2, 0, 0);
        scene.add(torus);
        const bulbs = (["red", "green", "blue"] as const).map((hue) => {
            const light = palette.light(
                new PointLight({intensity: 16, range: 7, castShadow: true}),
                (c) => c.hues[hue],
            );
            scene.add(light);
            return light;
        });
        const graph = new RenderGraph();
        const {color} = graph.addPass(new DeferredScenePass({scene}));
        graph.addPass(new BlitPass(), {color}, {canvasSlot: "canvas"});
        return ({time}) => {
            palette.apply();
            torus.setEuler(Math.PI / 2, 0, time * 0.3);
            bulbs.forEach((bulb, i) => {
                const a = time * (0.9 + i * 0.25) + (i * Math.PI * 2) / 3;
                bulb.position[0] = Math.cos(a) * 2;
                bulb.position[1] = 1.8 + Math.sin(time + i) * 0.4;
                bulb.position[2] = Math.sin(a) * 2;
            });
            return graph;
        };
    };
    return (
        <Slide
            icon={LightbulbIcon}
            title="Lights and shadows"
            description="Three point lights, each with its own shadow map."
        >
            <GlazeCanvas
                label="Red, green and blue lights circling a metal torus and casting colored shadows"
                setup={setup}
            />
        </Slide>
    );
}

function GBufferSlide() {
    const colors = useSceneColors();
    const setup: GlazeSetup = () => {
        const scene = new Scene();
        const palette = paletteBinder(colors);
        palette.scene(scene);
        const camera = new PerspectiveCamera({fov: Math.PI / 3});
        scene.add(camera);
        scene.activeCamera = camera;
        scene.add(palette.light(new DirectionalLight({direction: [-0.5, -0.8, -0.3], intensity: 4}), (c) => c.key));
        const mesh = new Mesh(
            makeShape("torus"),
            palette.emissive(
                palette.material(new PBRMaterial({roughness: 0.4, metallic: 0.3}), (c) => c.accent),
                (c) => c.hues.purple,
                0.4,
            ),
        );
        scene.add(mesh);
        const graph = new RenderGraph();
        const {albedo, normal, worldPos, emissive} = graph.addPass(new DeferredScenePass({scene}));
        const split = new SplitViewPass({
            slots: [
                {input: "albedo", rect: {x: 0, y: 0, w: 0.5, h: 0.5}, colorSpace: "linear-srgb"},
                {input: "normal", rect: {x: 0.5, y: 0, w: 0.5, h: 0.5}},
                {input: "worldPos", rect: {x: 0, y: 0.5, w: 0.5, h: 0.5}},
                {input: "emissive", rect: {x: 0.5, y: 0.5, w: 0.5, h: 0.5}, colorSpace: "linear-srgb"},
            ],
        });
        graph.addPass(split, {albedo, normal, worldPos, emissive}, {canvasSlot: "canvas"});
        return ({time}) => {
            palette.apply();
            orbit(camera, {distance: 3.4, elevation: 25, azimuth: time * 20});
            mesh.setEuler(time * 0.4, 0, 0);
            return graph;
        };
    };
    return (
        <Slide
            icon={Grid2x2Icon}
            title="The G-buffer"
            description="Albedo, normals, positions and emission, as outputs."
        >
            <GlazeCanvas
                label="Four views of a torus: base color, normals, world positions and emission"
                setup={setup}
            />
        </Slide>
    );
}

function DitherSlide() {
    const colors = useSceneColors();
    const setup: GlazeSetup = () => {
        const scene = new Scene();
        const palette = paletteBinder(colors);
        palette.scene(scene);
        const camera = new PerspectiveCamera({fov: Math.PI / 3});
        orbit(camera, {distance: 3.6, elevation: 17});
        scene.add(camera);
        scene.activeCamera = camera;
        scene.add(palette.light(new DirectionalLight({direction: [0.4, -0.8, -0.5], intensity: 4}), (c) => c.key));
        scene.add(palette.light(new DirectionalLight({direction: [-0.6, -0.3, 0.5], intensity: 1.6}), (c) => c.fill));
        const mesh = new Mesh(
            makeShape("icosphere", true),
            palette.material(new PBRMaterial({roughness: 0.4}), (c) => c.accent),
        );
        scene.add(mesh);
        const post = new ShaderPass({
            fragmentShader: buildPostFragment(3, false, 0, 0, false, true, "rgb", 4, "bayer4"),
            inputs: [{name: "input0"}],
        });
        const graph = new RenderGraph();
        const {color} = graph.addPass(new DeferredScenePass({scene}));
        graph.addPass(post, {input0: color}, {canvasSlot: "canvas"});
        return ({time}) => {
            palette.apply();
            mesh.setEuler(time * 0.3, time * 0.5, 0);
            return graph;
        };
    };
    return (
        <Slide icon={LayersIcon} title="Post-processing" description="A ShaderPass dithers the scene, 4×4 Bayer.">
            <GlazeCanvas
                label="A faceted ball in the site's accent, pixelated and dithered"
                maxPixelRatio={1}
                pixelated
                setup={setup}
            />
        </Slide>
    );
}
