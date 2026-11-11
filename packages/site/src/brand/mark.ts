/**
 * Glaze brand mark: a glazed donut seen from the top, with an orange glaze round the hole whose edge flows
 * into the grey dough as one smooth eight-wave sine, and eight white pill sprinkles scattered over it, drawn
 * as one silhouette with a 2-unit orange outline (the suite's mark style, shared with KernelKit's monitor and
 * TermiColor's skull).
 *
 * Grid: a 32-unit viewBox. The frame is true circles on even centres and radii: a 14-unit silhouette, a dough
 * band from 12 units in, and a 4-unit hole. The glaze edge is r(θ) = 8.5 + cos 8θ (troughs at 7.5, crests at
 * 9.5), drawn as cubic Béziers from its exact tangents, four per wave, so it is smooth and the same under every
 * eighth of a turn; a wave cannot sit on the even grid, so only it and the sprinkles use fractional units.
 * The glaze is the silhouette showing through inside the dough, so the orange edge runs unbroken from the
 * outline round to the hole. The hole cuts through the silhouette, so it is transparent.
 * Every color is resolved from TermiColor's dark mode and the orange accent; nothing is hardcoded.
 */
import {palette} from "@repraze/termicolor";

const dark = palette.modes.dark;
const n = dark.neutrals;

export const MARK_COLORS = {
    outline: dark.accents.orange,
    dough: n[700],
    /** The glaze is the outline showing through the dough, so it shares the outline's orange. */
    glaze: dark.accents.orange,
    sprinkle: n[50],
} as const;

/** A circle as two half arcs; counter-clockwise when it cuts a hole in the shape it follows. */
const circle = (cx: number, cy: number, r: number, ccw = false) => {
    const s = ccw ? 0 : 1;
    return `M${cx - r} ${cy}A${r} ${r} 0 0 ${s} ${cx + r} ${cy}A${r} ${r} 0 0 ${s} ${cx - r} ${cy}Z`;
};

/** A coordinate to two decimals, without trailing zeros. */
const num = (v: number) => {
    const s = (Math.round(v * 100) / 100).toFixed(2).replace(/\.?0+$/, "");
    return s === "-0" ? "0" : s;
};

/**
 * The glaze edge: r(θ) = 8.5 + cos 8θ, θ clockwise from 12 o'clock, so a crest points straight up. Drawn
 * counter-clockwise (it cuts the glaze out of the dough) as 32 cubic Béziers, each from the Hermite tangents
 * at its ends, with a joint at every crest, trough and midpoint.
 */
const glazeEdge = () => {
    const waves = 8;
    const segments = waves * 4;
    const pt = (t: number) => {
        const r = 8.5 + Math.cos(waves * t);
        return [16 + r * Math.sin(t), 16 - r * Math.cos(t)] as const;
    };
    const tangent = (t: number) => {
        const r = 8.5 + Math.cos(waves * t);
        const dr = -waves * Math.sin(waves * t);
        return [dr * Math.sin(t) + r * Math.cos(t), -dr * Math.cos(t) + r * Math.sin(t)] as const;
    };
    const p = (x: number, y: number) => `${num(x)} ${num(y)}`;
    let d = `M${p(...pt(0))}`;
    for (let i = 0; i < segments; i++) {
        const t0 = (-2 * Math.PI * i) / segments;
        const t1 = (-2 * Math.PI * (i + 1)) / segments;
        const k = (t1 - t0) / 3;
        const [x0, y0] = pt(t0);
        const [x1, y1] = pt(t1);
        const [dx0, dy0] = tangent(t0);
        const [dx1, dy1] = tangent(t1);
        d += `C${p(x0 + dx0 * k, y0 + dy0 * k)} ${p(x1 - dx1 * k, y1 - dy1 * k)} ${p(x1, y1)}`;
    }
    return `${d}Z`;
};

/**
 * Eight sprinkles, one on each crest: 2-unit-wide stadium pills (1-unit round caps), alternating a 4-unit pill
 * tilted 20° back from the tangent and a 3.5-unit pill tilted 55° toward the radius, so they read as thrown
 * rather than placed while the set stays the same under every quarter turn. Each sits where it clears both
 * the hole and the wave edge by the most.
 */
const SPRINKLES = [
    "M14.72 10.45L16.6 11.13A1 1 0 0 0 17.28 9.25L15.4 8.57A1 1 0 0 0 14.72 10.45Z",
    "M20.07 12.48L21.54 12.22A1 1 0 0 0 21.2 10.25L19.72 10.51A1 1 0 0 0 20.07 12.48Z",
    "M21.55 14.72L20.87 16.6A1 1 0 0 0 22.75 17.28L23.43 15.4A1 1 0 0 0 21.55 14.72Z",
    "M19.52 20.07L19.78 21.54A1 1 0 0 0 21.75 21.2L21.49 19.72A1 1 0 0 0 19.52 20.07Z",
    "M17.28 21.55L15.4 20.87A1 1 0 0 0 14.72 22.75L16.6 23.43A1 1 0 0 0 17.28 21.55Z",
    "M11.93 19.52L10.46 19.78A1 1 0 0 0 10.8 21.75L12.28 21.49A1 1 0 0 0 11.93 19.52Z",
    "M10.45 17.28L11.13 15.4A1 1 0 0 0 9.25 14.72L8.57 16.6A1 1 0 0 0 10.45 17.28Z",
    "M12.48 11.93L12.22 10.46A1 1 0 0 0 10.25 10.8L10.51 12.28A1 1 0 0 0 12.48 11.93Z",
];

/** Each shape: a path and the color key it fills with, back to front. */
export const MARK_SHAPES: readonly {d: string; fill: keyof typeof MARK_COLORS}[] = [
    // silhouette: a 14-unit circle minus the 4-unit hole; inside the dough it reads as the glaze
    {d: circle(16, 16, 14) + circle(16, 16, 4, true), fill: "outline"},
    // the dough: a 12-unit circle with the wavy glaze cut out of it
    {d: circle(16, 16, 12) + glazeEdge(), fill: "dough"},
    // the scattered pill sprinkles, as one path
    {d: SPRINKLES.join(""), fill: "sprinkle"},
];

/** The mark as SVG markup. `size` sets width/height in px (omit to let CSS size it). */
export function markSvg({size}: {size?: number} = {}): string {
    const dims = size ? ` width="${size}" height="${size}"` : "";
    const paths = MARK_SHAPES.map((s) => `<path d="${s.d}" fill="${MARK_COLORS[s.fill]}"/>`).join("");
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"${dims}>${paths}</svg>`;
}
