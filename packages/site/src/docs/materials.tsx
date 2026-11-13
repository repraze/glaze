import {
    BlitPass,
    colorRgb,
    createSphere,
    DeferredScenePass,
    DirectionalLight,
    Mesh,
    PBRMaterial,
    PerspectiveCamera,
    RenderGraph,
    Scene,
} from "@repraze/glaze";
import {vec3} from "gl-matrix";
import {useState} from "react";

import {ControlGroup, ControlSelect, ControlSlider, DemoStage} from "@/glaze/demo-stage";
import {GlazeCanvas, useLatest} from "@/glaze/glaze-canvas";
import {
    type EnvironmentId,
    ENVIRONMENTS,
    makeEnvironments,
    makeShape,
    makeTextureSets,
    orbit,
    type ShapeKind,
    SHAPES,
    TEXTURE_SETS,
    type TextureSetId,
} from "@/glaze/helpers";
import {paletteBinder, type SceneColors, tint, useSceneColors} from "@/glaze/scene-colors";
import {Code, defineDoc} from "@/lib/doc-kit";

export const doc = defineDoc({
    title: "Materials & PBR",
    category: "Scene",
    description:
        "PBRMaterial is the metallic-roughness model: a base color, roughness, metallic and emission, each optionally driven by a texture, plus normal and parallax height maps. Meshes that share a material share its GPU buffer and bind group.",
    engineFile: "material/material.ts",
    order: 3,
    demos: [
        {
            title: "Material inspector",
            description:
                "Ported from the repraze.com lab: presets, live scalars, and procedural texture sets that fill the albedo, normal, ORM and height maps.",
            component: Inspector,
            layout: "full",
        },
        {
            title: "PBR grid",
            description:
                "Ported from the lab: metallic rises left to right, roughness top to bottom, under one key light and an environment map.",
            component: PbrGrid,
            layout: "full",
        },
    ],
    notes: Notes,
    sections: [{id: "updating", title: "Updating"}],
    props: [
        {
            component: "PBRMaterialOptions",
            rows: [
                {
                    name: "color",
                    type: "ColorRgb",
                    default: "[1, 1, 1]",
                    description: "Base color, multiplied by albedoMap.",
                },
                {
                    name: "roughness",
                    type: "number",
                    default: "0.5",
                    description: "0 mirror … 1 matte; × the metallic-roughness map's green.",
                },
                {
                    name: "metallic",
                    type: "number",
                    default: "0",
                    description: "0 dielectric … 1 metal; × the metallic-roughness map's blue.",
                },
                {
                    name: "emissive",
                    type: "ColorRgba",
                    default: "[0, 0, 0, 0]",
                    description: "rgb emission (HDR allowed); alpha is unused.",
                },
                {
                    name: "normalScale",
                    type: "number",
                    default: "1",
                    description: "Scales the normal map's xy (glTF normalTexture.scale).",
                },
                {
                    name: "occlusionStrength",
                    type: "number",
                    default: "1",
                    description: "0 ignores the occlusion map, 1 applies it fully.",
                },
            ],
        },
        {
            component: "PBRMaterial",
            rows: [
                {name: "albedoMap", type: "Texture | null", default: "null", description: "sRGB-looking base color."},
                {
                    name: "normalMap",
                    type: "Texture | null",
                    default: "null",
                    description: "Tangent space, +y toward the image's top (glTF), flat = (128, 128, 255).",
                },
                {
                    name: "ormMap",
                    type: "Texture | null",
                    default: "null",
                    description: "Packed: r occlusion, g roughness, b metallic.",
                },
                {
                    name: "metallicRoughnessMap",
                    type: "Texture | null",
                    default: "null",
                    description: "g roughness, b metallic (r ignored). Overrides ormMap's g and b.",
                },
                {
                    name: "occlusionMap",
                    type: "Texture | null",
                    default: "null",
                    description: "r occlusion. Overrides ormMap's r; none means no occlusion.",
                },
                {name: "emissiveMap", type: "Texture | null", default: "null", description: "Multiplies emissive."},
                {
                    name: "heightMap",
                    type: "Texture | null",
                    default: "null",
                    description: "r height, for parallax occlusion.",
                },
                {name: "heightScale", type: "number", default: "0", description: "Parallax depth; 0 disables it."},
                {name: "markDirty()", type: "void", description: "Upload changed scalars on the next frame."},
                {name: "destroy()", type: "void", description: "Free the uniform buffer."},
            ],
        },
    ],
});

function Notes() {
    return (
        <section id="updating" className="flex scroll-mt-24 flex-col gap-3">
            <h2 className="font-mono text-xl font-semibold">Updating</h2>
            <p className="text-sm text-muted-foreground">
                Scalars live in a uniform buffer: after changing them, call{" "}
                <code className="font-mono text-foreground">markDirty()</code>. Assigning a map rebuilds the bind group
                on its own. Each combination of normal and height maps compiles one G-buffer pipeline variant, shared by
                every material that uses it.
            </p>
            <Code
                code={`const gold = palette.material(new PBRMaterial({roughness: 0.1, metallic: 1}), (c) => c.hues.yellow);
gold.ormMap = Texture.fromPixels(device, ormPixels, 256, 256);

// later, per frame
gold.roughness = 0.1 + 0.4 * wear;
gold.markDirty();`}
            />
        </section>
    );
}

export function Inspector() {
    const colors = useSceneColors();
    const [preset, setPreset] = useState<PresetId>("plastic");
    const [roughness, setRoughness] = useState(PRESETS.plastic.roughness);
    const [metallic, setMetallic] = useState(PRESETS.plastic.metallic);
    const [emission, setEmission] = useState(0);
    const [textures, setTextures] = useState<TextureSetId>("none");
    const [heightScale, setHeightScale] = useState(0.04);
    const [shape, setShape] = useState<ShapeKind>("sphere");
    const [environment, setEnvironment] = useState<EnvironmentId>("city");
    const live = useLatest({preset, roughness, metallic, emission, textures, heightScale, shape, environment});
    const pick = (id: PresetId) => {
        const p = PRESETS[id];
        setPreset(id);
        setRoughness(p.roughness);
        setMetallic(p.metallic);
        setEmission(p.emission);
        setTextures(p.textures);
    };
    return (
        <DemoStage
            controls={
                <>
                    <ControlSelect label="Preset" value={preset} options={PRESET_OPTIONS} onChange={pick} />
                    <ControlGroup label="Scalars">
                        <ControlSlider label="Roughness" value={roughness} onChange={setRoughness} step={0.05} />
                        <ControlSlider label="Metallic" value={metallic} onChange={setMetallic} step={0.05} />
                        <ControlSlider
                            label="Emission"
                            value={emission}
                            onChange={setEmission}
                            min={0}
                            max={4}
                            step={0.1}
                        />
                    </ControlGroup>
                    <ControlGroup label="Maps">
                        <ControlSelect
                            label="Texture set"
                            value={textures}
                            options={TEXTURE_SETS}
                            onChange={setTextures}
                        />
                        <ControlSlider
                            label="Height scale"
                            value={heightScale}
                            onChange={setHeightScale}
                            min={0}
                            max={0.1}
                            step={0.005}
                        />
                    </ControlGroup>
                    <ControlGroup label="View">
                        <ControlSelect label="Shape" value={shape} options={SHAPES} onChange={setShape} />
                        <ControlSelect
                            label="Environment"
                            value={environment}
                            options={ENVIRONMENTS}
                            onChange={setEnvironment}
                        />
                    </ControlGroup>
                </>
            }
        >
            <GlazeCanvas
                label="A single shape with the chosen material, turning in front of an environment map"
                setup={({renderer}) => {
                    const sets = makeTextureSets(renderer.device);
                    const environments = makeEnvironments(renderer.device);
                    const scene = new Scene();
                    const palette = paletteBinder(colors);
                    palette.scene(scene);
                    const camera = new PerspectiveCamera({fov: Math.PI / 3});
                    orbit(camera, {distance: 3.4, elevation: 20});
                    scene.add(camera);
                    scene.activeCamera = camera;
                    scene.add(
                        palette.light(new DirectionalLight({direction: [0.4, -0.8, -0.5], intensity: 4}), (c) => c.key),
                    );
                    scene.add(
                        palette.light(
                            new DirectionalLight({direction: [-0.6, -0.3, 0.5], intensity: 1.6}),
                            (c) => c.fill,
                        ),
                    );

                    const material = new PBRMaterial();
                    let kind: ShapeKind | null = null;
                    let mesh: Mesh | null = null;

                    const graph = new RenderGraph();
                    const {color} = graph.addPass(new DeferredScenePass({scene}));
                    graph.addPass(new BlitPass({toneMapping: "aces"}), {color}, {canvasSlot: "canvas"});

                    return ({time}) => {
                        palette.apply();
                        const cfg = live.current;
                        if (cfg.shape !== kind) {
                            if (mesh) {
                                scene.remove(mesh);
                            }
                            kind = cfg.shape;
                            mesh = new Mesh(makeShape(kind), material);
                            scene.add(mesh);
                        }
                        mesh!.setEuler(0, time * 0.5, 0);

                        const preset = PRESETS[cfg.preset];
                        const c = colors.current;
                        tint(material, preset.color(c));
                        material.roughness = cfg.roughness;
                        material.metallic = cfg.metallic;
                        const [r, g, b] = colorRgb(preset.emissive(c));
                        material.emissive = [r * cfg.emission, g * cfg.emission, b * cfg.emission, 1];
                        const maps = sets.get(cfg.textures);
                        material.albedoMap = maps?.albedo ?? null;
                        material.normalMap = maps?.normal ?? null;
                        material.ormMap = maps?.orm ?? null;
                        material.heightMap = maps?.height ?? null;
                        material.heightScale = cfg.heightScale;
                        material.markDirty();

                        const env = environments.get(cfg.environment) ?? null;
                        scene.environmentMap = env;
                        scene.backgroundMap = env;
                        return graph;
                    };
                }}
            />
        </DemoStage>
    );
}

type PresetId = "plastic" | "metal" | "gold" | "rubber" | "ceramic" | "wood" | "emissive";

/** The lab's presets as TermiColor roles: base color, scalars, emission color, and the texture set that suits them. */
const PRESETS: Record<
    PresetId,
    {
        label: string;
        color: PresetColor;
        roughness: number;
        metallic: number;
        emissive: PresetColor;
        emission: number;
        textures: TextureSetId;
    }
> = {
    plastic: {
        label: "Plastic",
        color: (c) => c.hues.red,
        roughness: 0.3,
        metallic: 0,
        emissive: (c) => c.accentFill,
        emission: 0,
        textures: "none",
    },
    metal: {
        label: "Metal",
        color: (c) => c.neutral,
        roughness: 0.2,
        metallic: 1,
        emissive: (c) => c.accentFill,
        emission: 0,
        textures: "none",
    },
    gold: {
        label: "Gold",
        color: (c) => c.hues.yellow,
        roughness: 0.1,
        metallic: 1,
        emissive: (c) => c.accentFill,
        emission: 0,
        textures: "none",
    },
    rubber: {
        label: "Rubber",
        color: (c) => c.floor,
        roughness: 0.9,
        metallic: 0,
        emissive: (c) => c.accentFill,
        emission: 0,
        textures: "tread",
    },
    ceramic: {
        label: "Ceramic",
        color: (c) => c.key,
        roughness: 0.15,
        metallic: 0,
        emissive: (c) => c.accentFill,
        emission: 0,
        textures: "tiles",
    },
    wood: {
        label: "Wood",
        color: (c) => c.hues.orange,
        roughness: 0.8,
        metallic: 0,
        emissive: (c) => c.accentFill,
        emission: 0,
        textures: "wood",
    },
    emissive: {
        label: "Emissive",
        color: (c) => c.floor,
        roughness: 0.5,
        metallic: 0,
        emissive: (c) => c.hues.blue,
        emission: 3,
        textures: "none",
    },
};

type PresetColor = (colors: SceneColors) => string;

const PRESET_OPTIONS = (Object.keys(PRESETS) as PresetId[]).map((value) => ({value, label: PRESETS[value].label}));

export function PbrGrid() {
    const colors = useSceneColors();
    const [environment, setEnvironment] = useState<EnvironmentId>("city");
    const [envIntensity, setEnvIntensity] = useState(1);
    const [keyIntensity, setKeyIntensity] = useState(3);
    const live = useLatest({environment, envIntensity, keyIntensity});
    return (
        <DemoStage
            controls={
                <>
                    <ControlSelect
                        label="Environment"
                        value={environment}
                        options={ENVIRONMENTS}
                        onChange={setEnvironment}
                    />
                    <ControlSlider
                        label="Environment intensity"
                        value={envIntensity}
                        onChange={setEnvIntensity}
                        min={0}
                        max={2}
                        step={0.05}
                    />
                    <ControlSlider
                        label="Key light"
                        value={keyIntensity}
                        onChange={setKeyIntensity}
                        min={0}
                        max={8}
                        step={0.25}
                    />
                </>
            }
        >
            <GlazeCanvas
                label="Twenty-five grey spheres in a grid, from matte to mirror and from plastic to metal"
                setup={({renderer}) => {
                    const environments = makeEnvironments(renderer.device);
                    const scene = new Scene();
                    const palette = paletteBinder(colors);
                    palette.scene(scene);
                    const camera = new PerspectiveCamera({fov: Math.PI / 4});
                    orbit(camera, {distance: 13, elevation: 10, azimuth: 8});
                    scene.add(camera);
                    scene.activeCamera = camera;
                    const key = palette.light(
                        new DirectionalLight({direction: [-0.6, -0.8, -0.4], intensity: 3}),
                        (c) => c.key,
                    );
                    scene.add(key);

                    const sphere = createSphere({radius: 0.8, widthSegments: 32, heightSegments: 16});
                    for (let row = 0; row < 5; row++) {
                        for (let col = 0; col < 5; col++) {
                            const material = palette.material(
                                new PBRMaterial({roughness: row / 4, metallic: col / 4}),
                                (c) => c.neutral,
                            );
                            const mesh = new Mesh(sphere, material);
                            vec3.set(mesh.position, (col - 2) * 2, (2 - row) * 2, 0);
                            scene.add(mesh);
                        }
                    }

                    const graph = new RenderGraph();
                    const {color} = graph.addPass(new DeferredScenePass({scene}));
                    graph.addPass(new BlitPass({toneMapping: "aces"}), {color}, {canvasSlot: "canvas"});
                    return () => {
                        palette.apply();
                        const cfg = live.current;
                        const env = environments.get(cfg.environment) ?? null;
                        scene.environmentMap = env;
                        scene.backgroundMap = env;
                        vec3.set(scene.environmentColor, cfg.envIntensity, cfg.envIntensity, cfg.envIntensity);
                        key.intensity = cfg.keyIntensity;
                        return graph;
                    };
                }}
            />
        </DemoStage>
    );
}
