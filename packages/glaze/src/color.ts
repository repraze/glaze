import type {vec3, vec4} from "gl-matrix";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ColorRgb = vec3; // [number, number, number] | IndexedCollection (e.g. Float32Array)
export type ColorRgba = vec4; // [number, number, number, number] | IndexedCollection
export type StrictColorRgb = [number, number, number];
export type StrictColorRgba = [number, number, number, number];

/**
 * What a texture's or a pass's values mean:
 *
 * - `"srgb"`: encoded, as stored in images and CSS. Equal steps look equal; what a screen expects.
 * - `"linear-srgb"`: linear light, sRGB primaries. Light adds and multiplies correctly here, so the scene pass
 *   lights in it, and something at the end of the frame (BlitPass) encodes it back to `"srgb"`.
 *
 * Colors you set on materials, lights and the scene (hex or 0-1 triples) are always `"srgb"`, the numbers a color
 * picker shows; the scene pass decodes them. Intensities and strengths are linear.
 */
export type ColorSpace = "linear-srgb" | "srgb";

// ─── Transfer function utilities ──────────────────────────────────────────────

/** sRGB channel → linear (IEC 61966 transfer function). */
export function srgbToLinear(c: number): number {
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Linear channel → sRGB (IEC 61966 transfer function). */
export function linearToSrgb(c: number): number {
    return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055;
}

/** Decodes an sRGB color (hex or 0-1 triple) to linear light, into `out`. */
export function srgbToLinearRgb(out: ColorRgb, input: string | ColorRgb): ColorRgb {
    setColorRgb(out, input);
    out[0] = srgbToLinear(out[0]);
    out[1] = srgbToLinear(out[1]);
    out[2] = srgbToLinear(out[2]);
    return out;
}

/** Encodes a linear-light color to sRGB, into `out`. */
export function linearToSrgbRgb(out: ColorRgb, input: ColorRgb): ColorRgb {
    out[0] = linearToSrgb(input[0]);
    out[1] = linearToSrgb(input[1]);
    out[2] = linearToSrgb(input[2]);
    return out;
}

/**
 * WGSL `srgbToLinear(c: vec3<f32>)` and `linearToSrgb(c: vec3<f32>)`, the same transfer functions on the GPU.
 * ShaderPass and EffectPass include them: a pass that reads the scene's linear color and writes to the canvas
 * ends with `linearToSrgb`.
 */
export const COLOR_WGSL = /* wgsl */ `
fn srgbToLinear(c: vec3<f32>) -> vec3<f32> {
    return select(pow((c + 0.055) / 1.055, vec3<f32>(2.4)), c / 12.92, c <= vec3<f32>(0.04045));
}
fn linearToSrgb(c: vec3<f32>) -> vec3<f32> {
    let x = max(c, vec3<f32>(0.0));
    return select(1.055 * pow(x, vec3<f32>(1.0 / 2.4)) - 0.055, x * 12.92, x <= vec3<f32>(0.0031308));
}
`;

// ─── Internal helpers ─────────────────────────────────────────────────────────

function parseHex(input: string): StrictColorRgba {
    const s = input.slice(1).toLowerCase();
    let r: number, g: number, b: number, a: number;

    if (s.length === 3 || s.length === 4) {
        r = parseInt(s[0]! + s[0], 16) / 255;
        g = parseInt(s[1]! + s[1], 16) / 255;
        b = parseInt(s[2]! + s[2], 16) / 255;
        a = s.length === 4 ? parseInt(s[3]! + s[3], 16) / 255 : 1;
    } else if (s.length === 6 || s.length === 8) {
        r = parseInt(s.slice(0, 2), 16) / 255;
        g = parseInt(s.slice(2, 4), 16) / 255;
        b = parseInt(s.slice(4, 6), 16) / 255;
        a = s.length === 8 ? parseInt(s.slice(6, 8), 16) / 255 : 1;
    } else {
        throw new Error(`Invalid hex color: "${input}"`);
    }

    if (isNaN(r) || isNaN(g) || isNaN(b) || isNaN(a)) {
        throw new Error(`Invalid hex color: "${input}"`);
    }

    return [r, g, b, a];
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Parse a CSS hex color string into a raw sRGB [r, g, b] tuple (each channel 0–1),
 * or pass through an existing ColorRgb (tuple or Float32Array) unchanged.
 *
 * Supports: #rgb  #rgba  #rrggbb  #rrggbbaa
 * The values stay sRGB (hex bytes ÷ 255): that is what materials, lights and the scene take. Use
 * {@link srgbToLinearRgb} for linear light, e.g. in your own shader's uniforms.
 */
export function colorRgb(input: string | ColorRgb): StrictColorRgb {
    if (typeof input === "string") {
        if (!input.startsWith("#")) {
            throw new Error(`Unsupported color format: "${input}"`);
        }
        const [r, g, b] = parseHex(input);
        return [r, g, b];
    }
    return [input[0], input[1], input[2]];
}

/**
 * Parse a CSS hex color string into a raw sRGB [r, g, b, a] tuple,
 * or pass through an existing ColorRgb/ColorRgba unchanged.
 *
 * The optional `alpha` parameter overrides the parsed or stored alpha.
 * For 3-component inputs the default alpha is 1.
 */
export function colorRgba(input: string | ColorRgb | ColorRgba, alpha?: number): StrictColorRgba {
    if (typeof input === "string") {
        if (!input.startsWith("#")) {
            throw new Error(`Unsupported color format: "${input}"`);
        }
        const parsed = parseHex(input);
        return [parsed[0], parsed[1], parsed[2], alpha ?? parsed[3]];
    }
    const r = input[0];
    const g = input[1];
    const b = input[2];
    if (input.length >= 4) {
        return [r, g, b, alpha ?? (input[3] as number)];
    }
    return [r, g, b, alpha ?? 1];
}

/**
 * Write a parsed sRGB color into an existing ColorRgb in place.
 * Zero-allocation alternative to `colorRgb()` for hot-path updates.
 */
export function setColorRgb(out: ColorRgb, input: string | ColorRgb): ColorRgb {
    if (typeof input === "string") {
        if (!input.startsWith("#")) {
            throw new Error(`Unsupported color format: "${input}"`);
        }
        const [r, g, b] = parseHex(input);
        out[0] = r;
        out[1] = g;
        out[2] = b;
        return out;
    }
    out[0] = input[0];
    out[1] = input[1];
    out[2] = input[2];
    return out;
}

/**
 * Write a parsed sRGB color into an existing ColorRgba in place.
 * Zero-allocation alternative to `colorRgba()` for hot-path updates.
 */
export function setColorRgba(out: ColorRgba, input: string | ColorRgb | ColorRgba, alpha?: number): ColorRgba {
    if (typeof input === "string") {
        if (!input.startsWith("#")) {
            throw new Error(`Unsupported color format: "${input}"`);
        }
        const parsed = parseHex(input);
        out[0] = parsed[0];
        out[1] = parsed[1];
        out[2] = parsed[2];
        out[3] = alpha ?? parsed[3];
        return out;
    }
    out[0] = input[0];
    out[1] = input[1];
    out[2] = input[2];
    if (input.length >= 4) {
        out[3] = alpha ?? (input[3] as number);
    } else {
        out[3] = alpha ?? 1;
    }
    return out;
}
