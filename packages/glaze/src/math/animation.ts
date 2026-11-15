// ── Easing ────────────────────────────────────────────────────────────────────

/** Linear interpolation between a and b. t is unclamped. */
export function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

/** Clamp v to [min, max]. */
export function clamp(v: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, v));
}

/** 0 at `edge0`, 1 at `edge1`, a smooth Hermite curve between (as WGSL's and GLSL's smoothstep). Clamped. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
    const c = clamp((x - edge0) / (edge1 - edge0), 0, 1);
    return c * c * (3 - 2 * c);
}

/** As {@link smoothstep}, with zero first and second derivatives at both edges (Perlin's). Clamped. */
export function smootherstep(edge0: number, edge1: number, x: number): number {
    const c = clamp((x - edge0) / (edge1 - edge0), 0, 1);
    return c * c * c * (c * (c * 6 - 15) + 10);
}

/** Power ease-in. exp defaults to 2 (quadratic). Clamps t to [0, 1]. */
export function easeIn(t: number, exp = 2): number {
    return Math.pow(clamp(t, 0, 1), exp);
}

/** Power ease-out. exp defaults to 2 (quadratic). Clamps t to [0, 1]. */
export function easeOut(t: number, exp = 2): number {
    return 1 - Math.pow(1 - clamp(t, 0, 1), exp);
}

/** Power ease-in then ease-out, meeting at 0.5. exp defaults to 3 (cubic). Clamps t to [0, 1]. */
export function easeInOut(t: number, exp = 3): number {
    const c = clamp(t, 0, 1);
    return c < 0.5 ? Math.pow(2 * c, exp) / 2 : 1 - Math.pow(2 - 2 * c, exp) / 2;
}

// ── Oscillation ───────────────────────────────────────────────────────────────

/**
 * Triangle wave — oscillates between 0 and 1 with a period of 2 time units.
 * pingpong(0)=0, pingpong(1)=1, pingpong(2)=0, pingpong(3)=1, …
 */
export function pingpong(t: number): number {
    return 1 - Math.abs((((t % 2) + 2) % 2) - 1);
}

/**
 * Sine-based oscillation. Returns values in [-1, 1].
 * freq is the angular frequency (radians per time unit).
 * oscillate(t, 1) = sin(t).
 */
export function oscillate(t: number, freq = 1): number {
    return Math.sin(t * freq);
}

/**
 * Absolute sine — returns values in [0, 1] with a bounce shape.
 * freq is the angular frequency (radians per time unit).
 */
export function bounce(t: number, freq = 1): number {
    return Math.abs(Math.sin(t * freq));
}
