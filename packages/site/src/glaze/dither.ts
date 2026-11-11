// Ordered-dithering post pass, ported from the repraze.com Glaze lab (scene-dithering/demo-shaders.ts).

export type ColorMethod = "mono" | "gray" | "rgb" | "gameboy";
export type DitherPattern = "bayer2" | "bayer4" | "bayer8" | "checker" | "halftone" | "noise" | "ign" | "line";

export const COLOR_METHODS: {value: ColorMethod; label: string}[] = [
    {value: "mono", label: "Monochrome"},
    {value: "gray", label: "Grayscale"},
    {value: "rgb", label: "Full color"},
    {value: "gameboy", label: "Game Boy"},
];

export const DITHER_PATTERNS: {value: DitherPattern; label: string}[] = [
    {value: "bayer2", label: "Bayer 2×2"},
    {value: "bayer4", label: "Bayer 4×4"},
    {value: "bayer8", label: "Bayer 8×8"},
    {value: "checker", label: "Checkerboard"},
    {value: "halftone", label: "Halftone"},
    {value: "noise", label: "White noise"},
    {value: "ign", label: "IGN"},
    {value: "line", label: "Line screen"},
];

// ─── Ordered-dithering threshold functions ────────────────────────────────────
// All named `bayer(p)` so the main fragment body is identical regardless of pattern.

const BAYER2_FN = /* wgsl */ `
fn bayer(p: vec2<u32>) -> f32 {
    let m = array<u32, 4>(0u, 2u, 3u, 1u);
    return f32(m[(p.y % 2u) * 2u + (p.x % 2u)]) / 4.0;
}
`;

const BAYER4_FN = /* wgsl */ `
fn bayer(p: vec2<u32>) -> f32 {
    let m = array<u32, 16>(
         0u,  8u,  2u, 10u,
        12u,  4u, 14u,  6u,
         3u, 11u,  1u,  9u,
        15u,  7u, 13u,  5u,
    );
    return f32(m[(p.y % 4u) * 4u + (p.x % 4u)]) / 16.0;
}
`;

const BAYER8_FN = /* wgsl */ `
fn bayer(p: vec2<u32>) -> f32 {
    let m = array<u32, 64>(
         0u, 32u,  8u, 40u,  2u, 34u, 10u, 42u,
        48u, 16u, 56u, 24u, 50u, 18u, 58u, 26u,
        12u, 44u,  4u, 36u, 14u, 46u,  6u, 38u,
        60u, 28u, 52u, 20u, 62u, 30u, 54u, 22u,
         3u, 35u, 11u, 43u,  1u, 33u,  9u, 41u,
        51u, 19u, 59u, 27u, 49u, 17u, 57u, 25u,
        15u, 47u,  7u, 39u, 13u, 45u,  5u, 37u,
        63u, 31u, 55u, 23u, 61u, 29u, 53u, 21u,
    );
    return f32(m[(p.y % 8u) * 8u + (p.x % 8u)]) / 64.0;
}
`;

const CHECKER_FN = /* wgsl */ `
fn bayer(p: vec2<u32>) -> f32 {
    return f32((p.x + p.y) % 2u) * 0.5;
}
`;

const HALFTONE_FN = /* wgsl */ `
fn bayer(p: vec2<u32>) -> f32 {
    let cell = p % 8u;
    let d = length(vec2<f32>(cell) - vec2<f32>(3.5, 3.5));
    return clamp(d / 4.95, 0.0, 1.0);
}
`;

// White noise — spatially uncorrelated hash, highest frequency noise.
const NOISE_FN = /* wgsl */ `
fn bayer(p: vec2<u32>) -> f32 {
    let fp = vec2<f32>(p);
    return fract(sin(dot(fp, vec2<f32>(127.1, 311.7))) * 43758.5453);
}
`;

// IGN (Interleaved Gradient Noise, Jimenez 2014) — better spectral distribution
// than white noise; visually similar to blue noise without the texture lookup.
const IGN_FN = /* wgsl */ `
fn bayer(p: vec2<u32>) -> f32 {
    let fp = vec2<f32>(p);
    return fract(52.9829189 * fract(dot(fp, vec2<f32>(0.06711056, 0.00583715))));
}
`;

// Horizontal scanlines — 4-level ramp cycling every 4 rows.
const LINE_FN = /* wgsl */ `
fn bayer(p: vec2<u32>) -> f32 {
    return f32(p.y % 4u) / 4.0;
}
`;

function bayerFn(pattern: DitherPattern): string {
    switch (pattern) {
        case "bayer2":
            return BAYER2_FN;
        case "bayer4":
            return BAYER4_FN;
        case "bayer8":
            return BAYER8_FN;
        case "checker":
            return CHECKER_FN;
        case "halftone":
            return HALFTONE_FN;
        case "noise":
            return NOISE_FN;
        case "ign":
            return IGN_FN;
        case "line":
            return LINE_FN;
    }
}

// ─── Image-adjustment WGSL snippet ───────────────────────────────────────────
// Baked as constants so the cache key fully describes the shader.
// Assumes the mutable `colour` variable is already declared.

function buildAdjustSnippet(brightness: number, contrast: number, invert: boolean): string {
    // contrast=0 → factor 1 (no change), contrast=1 → 4× (strong), contrast=-1 → 0.25× (flat).
    const contrastFactor = Math.pow(2, contrast * 2).toFixed(6);
    return [
        `colour = colour + vec3<f32>(${brightness.toFixed(6)});`,
        `colour = (colour - vec3<f32>(0.5)) * ${contrastFactor} + vec3<f32>(0.5);`,
        `colour = clamp(colour, vec3<f32>(0.0), vec3<f32>(1.0));`,
        invert ? `colour = vec3<f32>(1.0) - colour;` : ``,
    ]
        .filter(Boolean)
        .join("\n    ");
}

// ─── Unified post-processing pass builder ────────────────────────────────────

export function buildPostFragment(
    pixelSize: number,
    adjustEnabled: boolean,
    brightness: number,
    contrast: number,
    invert: boolean,
    ditherEnabled: boolean,
    colorMethod: ColorMethod,
    colorLevels: number,
    pattern: DitherPattern,
): string {
    const uvExpr =
        pixelSize > 1
            ? `floor(in.uv * globals.resolution / ${pixelSize.toFixed(1)}) * ${pixelSize.toFixed(1)} / globals.resolution`
            : `in.uv`;
    const pxExpr =
        pixelSize > 1
            ? `vec2<u32>(u32(in.pos.x) / ${pixelSize}u, u32(in.pos.y) / ${pixelSize}u)`
            : `vec2<u32>(u32(in.pos.x), u32(in.pos.y))`;

    const adjustSnippet = adjustEnabled ? buildAdjustSnippet(brightness, contrast, invert) : "";

    // ── Passthrough (scale + optional adjustments, no dithering) ─────────────
    if (!ditherEnabled) {
        return /* wgsl */ `
@fragment
fn fs_main(in: QuadInput) -> @location(0) vec4<f32> {
    let uv = ${uvExpr};
    var colour = textureSample(input0, inputSampler, uv).rgb;
    ${adjustSnippet}
    return vec4<f32>(colour, 1.0);
}
`;
    }

    // ── Dithering paths ───────────────────────────────────────────────────────
    const bFn = bayerFn(pattern);

    if (colorMethod === "mono") {
        return /* wgsl */ `
${bFn}
@fragment
fn fs_main(in: QuadInput) -> @location(0) vec4<f32> {
    let uv     = ${uvExpr};
    let px     = ${pxExpr};
    var colour = textureSample(input0, inputSampler, uv).rgb;
    ${adjustSnippet}
    let lum    = dot(colour, vec3<f32>(0.299, 0.587, 0.114));
    let dc     = select(0.0, 1.0, lum >= bayer(px));
    return vec4<f32>(dc, dc, dc, 1.0);
}
`;
    }

    if (colorMethod === "gray") {
        return /* wgsl */ `
${bFn}
@fragment
fn fs_main(in: QuadInput) -> @location(0) vec4<f32> {
    let uv     = ${uvExpr};
    let px     = ${pxExpr};
    var colour = textureSample(input0, inputSampler, uv).rgb;
    ${adjustSnippet}
    let lum    = dot(colour, vec3<f32>(0.299, 0.587, 0.114));
    let levels = ${colorLevels.toFixed(1)};
    let dc     = floor((lum + (bayer(px) - 0.5) / levels) * levels + 0.5) / levels;
    let g      = clamp(dc, 0.0, 1.0);
    return vec4<f32>(g, g, g, 1.0);
}
`;
    }

    if (colorMethod === "rgb") {
        return /* wgsl */ `
${bFn}
@fragment
fn fs_main(in: QuadInput) -> @location(0) vec4<f32> {
    let uv        = ${uvExpr};
    let px        = ${pxExpr};
    var colour    = textureSample(input0, inputSampler, uv).rgb;
    ${adjustSnippet}
    let threshold = bayer(px);
    let levels    = ${colorLevels.toFixed(1)};
    let dc        = floor((colour + (threshold - 0.5) / levels) * levels + 0.5) / levels;
    return vec4<f32>(clamp(dc, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}
`;
    }

    // colorMethod === "gameboy" — 4-shade palette (darkest → lightest). Deliberately not TermiColor: these
    // are the fixed greens of the original Game Boy screen, which is the point of this color method.
    return /* wgsl */ `
${bFn}
@fragment
fn fs_main(in: QuadInput) -> @location(0) vec4<f32> {
    let uv      = ${uvExpr};
    let px      = ${pxExpr};
    var colour  = textureSample(input0, inputSampler, uv).rgb;
    ${adjustSnippet}
    let lum     = dot(colour, vec3<f32>(0.299, 0.587, 0.114));
    let levels  = 4.0;
    let qi      = clamp(i32(floor((lum + (bayer(px) - 0.5) / levels) * levels + 0.5)), 0, 3);
    let palette = array<vec3<f32>, 4>(
        vec3<f32>(0.059, 0.220, 0.059),
        vec3<f32>(0.188, 0.384, 0.188),
        vec3<f32>(0.545, 0.675, 0.059),
        vec3<f32>(0.608, 0.737, 0.059),
    );
    return vec4<f32>(palette[qi], 1.0);
}
`;
}
