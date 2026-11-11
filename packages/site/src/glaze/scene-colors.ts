import {type ColorRgb, colorRgb, type PBRMaterial, type Scene, setColorRgb} from "@repraze/glaze";
import {type ThemeContextValue, useTheme} from "@repraze/kernelkit/provider";
import {type AccentName, allModes, createPalette} from "@repraze/termicolor";

import {useLatest} from "./glaze-canvas";

export type Hue = AccentName;

/**
 * The colors every demo scene draws with, all from TermiColor (CSS hex, ready for the engine's colorRgb):
 * the page's own mode, contrast and accent, so a scene matches the page in light and dark and follows the
 * ThemeMenu. The engine itself stays palette-free; this mapping lives in the site.
 */
export interface SceneColors {
    dark: boolean;
    /** The page background (roles.bg): the clear color behind scenes. */
    background: string;
    /** A flat ambient term: a dark neutral in dark mode, a mid neutral in light mode. */
    ambient: string;
    /** Floors and pedestals: a neutral a few steps off the background. */
    floor: string;
    /** Neutral props (metals, grey spheres). */
    neutral: string;
    /** The key light: the palette's near-white. */
    key: string;
    /** The cool fill light: the palette's blue. */
    fill: string;
    /** The site accent, text tier (roles.accent): albedos. */
    accent: string;
    /** The site accent, fill tier (roles.accentFill): emission and highlights. */
    accentFill: string;
    /** Every TermiColor hue in this mode. */
    hues: Record<Hue, string>;
}

const cache = new Map<string, SceneColors>();

export function sceneColors(theme: Pick<ThemeContextValue, "resolvedMode" | "contrast" | "accent">): SceneColors {
    const id = `${theme.resolvedMode}${theme.contrast === "high" ? "-hc" : ""}`;
    const key = `${id}:${theme.accent}`;
    let colors = cache.get(key);
    if (!colors) {
        const modes = allModes(createPalette({accent: theme.accent}));
        const mode = modes.find((m) => m.id === id) ?? modes[0]!;
        const n = mode.neutrals;
        const dark = mode.type === "dark";
        colors = {
            dark,
            background: mode.roles.bg,
            ambient: dark ? n[800] : n[400],
            floor: dark ? n[800] : n[200],
            neutral: dark ? n[300] : n[400],
            key: dark ? n[50] : n[0],
            fill: mode.accents.blue,
            accent: mode.roles.accent,
            accentFill: mode.roles.accentFill,
            hues: mode.accents,
        };
        cache.set(key, colors);
    }
    return colors;
}

/** The current scene colors in a ref, for frame callbacks: re-read every frame, so theme changes apply live. */
export function useSceneColors() {
    const theme = useTheme();
    return useLatest(sceneColors(theme));
}

/** Background and ambient from the palette. Call it every frame: it allocates nothing. */
export function paintScene(scene: Scene, colors: SceneColors): void {
    setColorRgb(scene.backgroundColor, colors.background);
    setColorRgb(scene.ambientColor, colors.ambient);
}

/** Set a material's base color from a hex and flag it for upload. */
export function tint(material: PBRMaterial, hex: string): void {
    setColorRgb(material.color as ColorRgb, hex);
    material.markDirty();
}

/** A palette hex as a WGSL vec3 literal, to bake into a ShaderPass (which has no uniforms). */
export function wgslColor(hex: string): string {
    const n = parseInt(hex.slice(1, 7), 16);
    const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => (v / 255).toFixed(4));
    return `vec3<f32>(${c.join(", ")})`;
}

/**
 * Memoise something built from the palette (a ShaderPass with baked colors, say) per theme: sceneColors
 * returns the same object for the same mode, contrast and accent.
 */
export function perTheme<T>(build: (colors: SceneColors) => T): (colors: SceneColors) => T {
    const built = new Map<SceneColors, T>();
    return (colors) => {
        let value = built.get(colors);
        if (value === undefined) {
            value = build(colors);
            built.set(colors, value);
        }
        return value;
    };
}

type ColorPick = (colors: SceneColors) => string;

/**
 * Ties scene objects to palette roles once, then `apply()` (per frame) writes the current theme's colors:
 *
 *     const palette = paletteBinder(colors);
 *     palette.scene(scene);                                  // background + ambient
 *     palette.light(sun, (c) => c.key);                      // light color
 *     palette.material(paint, (c) => c.accent);              // base color
 *     palette.emissive(glow, (c) => c.accentFill, 2);        // emission × intensity
 *     return () => { palette.apply(); return graph; };
 */
export function paletteBinder(colors: {current: SceneColors}) {
    const writes: ((c: SceneColors) => void)[] = [];
    return {
        scene<S extends Scene>(scene: S): S {
            writes.push((c) => paintScene(scene, c));
            return scene;
        },
        light<L extends {color: ColorRgb}>(light: L, pick: ColorPick): L {
            writes.push((c) => setColorRgb(light.color, pick(c)));
            return light;
        },
        material<M extends PBRMaterial>(material: M, pick: ColorPick): M {
            writes.push((c) => tint(material, pick(c)));
            return material;
        },
        emissive<M extends PBRMaterial>(material: M, pick: ColorPick, intensity = 1): M {
            writes.push((c) => {
                const [r, g, b] = colorRgb(pick(c));
                material.emissive = [r * intensity, g * intensity, b * intensity, 1];
                material.markDirty();
            });
            return material;
        },
        apply(): void {
            const c = colors.current;
            for (const write of writes) {
                write(c);
            }
        },
    };
}
