// Equirectangular environment maps, ported from the repraze.com Glaze lab (scene-material/demo-env-textures.ts).
// Deliberately not TermiColor: these stand in for photographed surroundings (sky, field, city) that metals
// reflect and rough surfaces pick up as ambient light, so they keep physical sky and ground colors.

// Equirectangular environment map pixel generators (horizontally uniform gradients).
//
// UV mapping used by the shader:
//   u = atan2(z,x)/(2π)+0.5   (longitude)
//   v = 0.5 - asin(y)/π       (latitude: 0=zenith, 0.5=horizon, 1=nadir)
//
// Since every preset is radially symmetric, each row shares one color.
// t parameter: 0=nadir (y=-1), 0.5=horizon (y=0), 1=zenith (y=+1).

type Rgb = [number, number, number];

function lerp3(a: Rgb, b: Rgb, t: number): Rgb {
    const s = t < 0 ? 0 : t > 1 ? 1 : t;
    return [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s];
}

function gradient(stops: [number, Rgb][], t: number): Rgb {
    if (t <= stops[0]![0]) {
        return stops[0]![1];
    }
    for (let i = 1; i < stops.length; i++) {
        const [t0, c0] = stops[i - 1]!;
        const [t1, c1] = stops[i]!;
        if (t <= t1) {
            return lerp3(c0, c1, (t - t0) / (t1 - t0));
        }
    }
    return stops[stops.length - 1]![1];
}

function makeEnvPixels(w: number, h: number, fn: (t: number) => Rgb): Uint8Array {
    const data = new Uint8Array(w * h * 4);
    for (let py = 0; py < h; py++) {
        const v = (py + 0.5) / h;
        const theta = (0.5 - v) * Math.PI; // π/2 at top → -π/2 at bottom
        const t = (Math.sin(theta) + 1) / 2; // 1=zenith, 0=nadir
        const [r, g, b] = fn(t);
        const ri = (r * 255 + 0.5) | 0;
        const gi = (g * 255 + 0.5) | 0;
        const bi = (b * 255 + 0.5) | 0;
        for (let px = 0; px < w; px++) {
            const i = (py * w + px) * 4;
            data[i] = ri;
            data[i + 1] = gi;
            data[i + 2] = bi;
            data[i + 3] = 255;
        }
    }
    return data;
}

// ─── sky ─────────────────────────────────────────────────────────────────────
// Pure gradient sky — deep blue zenith, warm hazy horizon, dark navy underside.

const SKY_STOPS: [number, Rgb][] = [
    [0.0, [0.07, 0.1, 0.22]], // nadir: dark navy
    [0.44, [0.44, 0.58, 0.88]], // low atmosphere
    [0.5, [0.64, 0.77, 0.98]], // horizon haze
    [0.58, [0.2, 0.46, 0.88]], // lower sky
    [1.0, [0.04, 0.09, 0.52]], // zenith: deep blue
];

export function makeEnvSky(w: number, h: number): Uint8Array {
    return makeEnvPixels(w, h, (t) => gradient(SKY_STOPS, t));
}

// ─── plane ───────────────────────────────────────────────────────────────────
// Open field: blue sky above horizon, green ground below.

const PLANE_STOPS: [number, Rgb][] = [
    [0.0, [0.04, 0.14, 0.02]], // nadir: deep grass
    [0.46, [0.2, 0.44, 0.08]], // ground near horizon
    [0.5, [0.6, 0.78, 0.95]], // horizon sky
    [0.58, [0.2, 0.46, 0.88]], // lower sky
    [1.0, [0.05, 0.12, 0.54]], // zenith: deep blue
];

export function makeEnvPlane(w: number, h: number): Uint8Array {
    return makeEnvPixels(w, h, (t) => gradient(PLANE_STOPS, t));
}

// ─── city ─────────────────────────────────────────────────────────────────────
// Urban: blue sky above horizon, grey concrete below.

const CITY_STOPS: [number, Rgb][] = [
    [0.0, [0.05, 0.05, 0.06]], // nadir: near black asphalt
    [0.46, [0.28, 0.28, 0.32]], // street / building facades
    [0.5, [0.54, 0.66, 0.88]], // horizon glow
    [0.58, [0.2, 0.44, 0.86]], // lower sky
    [1.0, [0.05, 0.12, 0.52]], // zenith: deep blue
];

export function makeEnvCity(w: number, h: number): Uint8Array {
    return makeEnvPixels(w, h, (t) => gradient(CITY_STOPS, t));
}
