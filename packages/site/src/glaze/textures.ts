// Procedural PBR texture sets (albedo, normal, ORM, height), ported from the repraze.com Glaze lab
// (scene-material/demo-textures.ts).

// ─── Shared helpers ───────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
    return v < lo ? lo : v > hi ? hi : v;
}

// ORM: R=occlusion (direct, 1=no AO), G=roughness scale, B=metallic scale.
// Normal map: tangent-space, flat surface encodes as (128,128,255).
function normalsFromHeights(heights: Float32Array, size: number, scale: number): Uint8Array {
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const i = (y * size + x) * 4;
            const hL = heights[y * size + ((x - 1 + size) % size)]!;
            const hR = heights[y * size + ((x + 1) % size)]!;
            const hU = heights[((y - 1 + size) % size) * size + x]!;
            const hD = heights[((y + 1) % size) * size + x]!;
            let nx = (hL - hR) * scale;
            let ny = (hU - hD) * scale;
            let nz = 1;
            const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
            nx /= len;
            ny /= len;
            nz /= len;
            data[i] = Math.round(((nx + 1) / 2) * 255);
            data[i + 1] = Math.round(((ny + 1) / 2) * 255);
            data[i + 2] = Math.round(((nz + 1) / 2) * 255);
            data[i + 3] = 255;
        }
    }
    return data;
}

// ─── Brick ────────────────────────────────────────────────────────────────────
// Running bond brickwork, terracotta faces, beige mortar.

const BW = 64; // brick cell width
const BH = 32; // brick cell height
const MW = 4; // mortar half-thickness x
const MH = 3; // mortar half-thickness y

function brickHeight(x: number, y: number): number {
    const row = Math.floor(y / BH);
    const lx = (((x + (row & 1) * (BW >> 1)) % BW) + BW) % BW;
    const ly = y % BH;
    if (lx < MW || lx >= BW - MW || ly < MH || ly >= BH - MH) {
        return 0;
    }
    return Math.min(1, Math.min(Math.min(lx - MW, BW - MW - lx - 1) / MW, Math.min(ly - MH, BH - MH - ly - 1) / MH));
}

function brickId(x: number, y: number, size: number): number {
    const row = Math.floor(y / BH);
    const col = Math.floor((x + (row & 1) * (BW >> 1)) / BW) % (size / BW);
    return (row * 13 + col * 7) % 31;
}

export function makeBrickAlbedo(size: number): Uint8Array {
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const i = (y * size + x) * 4;
            const h = brickHeight(x, y);
            if (h <= 0) {
                data[i] = 178;
                data[i + 1] = 170;
                data[i + 2] = 156;
                data[i + 3] = 255;
            } else {
                const v = ((brickId(x, y, size) * 17) % 40) - 20;
                data[i] = clamp(158 + v, 100, 200);
                data[i + 1] = clamp(72 + (v >> 1), 40, 100);
                data[i + 2] = clamp(42 + (v >> 2), 20, 70);
                data[i + 3] = 255;
            }
        }
    }
    return data;
}

export function makeBrickNormals(size: number): Uint8Array {
    const h = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            h[y * size + x] = brickHeight(x, y);
        }
    }
    return normalsFromHeights(h, size, 4);
}

export function makeBrickOrm(size: number): Uint8Array {
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const i = (y * size + x) * 4;
            const h = brickHeight(x, y);
            data[i] = h <= 0 ? 155 : Math.round(185 + h * 70); // occlusion
            data[i + 1] = h <= 0 ? 145 : 230; // roughness scale
            data[i + 2] = 0;
            data[i + 3] = 255;
        }
    }
    return data;
}

export function makeBrickHeight(size: number): Uint8Array {
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const i = (y * size + x) * 4;
            const v = Math.round(brickHeight(x, y) * 255);
            data[i] = data[i + 1] = data[i + 2] = v;
            data[i + 3] = 255;
        }
    }
    return data;
}

// ─── Tiles ────────────────────────────────────────────────────────────────────
// Square ceramic floor tiles, glossy, with recessed grout lines.

const TW = 64; // tile cell width  (256/64 = 4 tiles — divides evenly)
const TH = 64; // tile cell height
const TG = 4; // grout half-thickness

function tileHeight(x: number, y: number): number {
    const lx = x % TW;
    const ly = y % TH;
    if (lx < TG || lx >= TW - TG || ly < TG || ly >= TH - TG) {
        return 0;
    }
    return Math.min(1, Math.min(Math.min(lx - TG, TW - TG - lx - 1) / TG, Math.min(ly - TG, TH - TG - ly - 1) / TG));
}

function tileId(x: number, y: number, size: number): number {
    const col = Math.floor(x / TW) % (size / TW);
    const row = Math.floor(y / TH);
    return (row * 7 + col * 11) % 13;
}

export function makeTilesAlbedo(size: number): Uint8Array {
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const i = (y * size + x) * 4;
            const h = tileHeight(x, y);
            if (h <= 0) {
                // Grout: warm gray
                data[i] = 135;
                data[i + 1] = 132;
                data[i + 2] = 128;
                data[i + 3] = 255;
            } else {
                const v = ((tileId(x, y, size) * 11) % 18) - 9;
                data[i] = clamp(238 + v, 210, 255);
                data[i + 1] = clamp(233 + v, 205, 252);
                data[i + 2] = clamp(224 + v, 196, 248);
                data[i + 3] = 255;
            }
        }
    }
    return data;
}

export function makeTilesNormals(size: number): Uint8Array {
    const h = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            h[y * size + x] = tileHeight(x, y);
        }
    }
    return normalsFromHeights(h, size, 3);
}

export function makeTilesOrm(size: number): Uint8Array {
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const i = (y * size + x) * 4;
            const h = tileHeight(x, y);
            data[i] = h <= 0 ? 155 : Math.round(195 + h * 60); // occlusion
            data[i + 1] = h <= 0 ? 190 : 55; // roughness: tile=glossy(55), grout=rough(190)
            data[i + 2] = 0;
            data[i + 3] = 255;
        }
    }
    return data;
}

export function makeTilesHeight(size: number): Uint8Array {
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const i = (y * size + x) * 4;
            const v = Math.round(tileHeight(x, y) * 255);
            data[i] = data[i + 1] = data[i + 2] = v;
            data[i + 3] = 255;
        }
    }
    return data;
}

// ─── Wood ─────────────────────────────────────────────────────────────────────
// Horizontal planks with wavy grain lines and slight bevel at plank edges.

const WPH = 64; // plank cell height (256/64 = 4 planks — divides evenly)
const WGAP = 3; // gap between planks

function woodGrainValue(x: number, y: number, size: number): number {
    // Frequencies are multiples of 2π/size so phase completes integer cycles at the texture boundary.
    const fx = (x / size) * 2 * Math.PI;
    const fy = (y / size) * 2 * Math.PI;
    const phase = fx * 5 + Math.sin(fy) * 3 + Math.sin(fy * 2 + 1.5) * 1.5;
    return (Math.sin(phase) + 1) / 2;
}

function woodPlanksHeight(x: number, y: number, size: number): number {
    const ly = y % WPH;
    if (ly >= WPH - WGAP) {
        return 0;
    }
    const bevel = Math.min(ly, WPH - WGAP - 1 - ly);
    return Math.min(1, bevel / 3) * (0.7 + woodGrainValue(x, y, size) * 0.3);
}

export function makeWoodAlbedo(size: number): Uint8Array {
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const i = (y * size + x) * 4;
            const ly = y % WPH;
            if (ly >= WPH - WGAP) {
                // Gap: very dark
                data[i] = 28;
                data[i + 1] = 17;
                data[i + 2] = 9;
                data[i + 3] = 255;
            } else {
                const gv = woodGrainValue(x, y, size);
                // Per-plank brightness nudge
                const pb = ((Math.floor(y / WPH) * 17) % 5) - 2;
                const br = 116 + pb * 4;
                const bg = 72 + pb * 3;
                const bb = 38 + pb * 2;
                // Darken at low gv (grain valleys), lighten at high gv (grain ridges)
                const dark = Math.max(0, 0.35 - gv) / 0.35;
                const light = Math.max(0, gv - 0.7) / 0.3;
                data[i] = clamp(Math.round(br - 32 * dark + 22 * light), 60, 165);
                data[i + 1] = clamp(Math.round(bg - 20 * dark + 14 * light), 40, 105);
                data[i + 2] = clamp(Math.round(bb - 11 * dark + 8 * light), 18, 60);
                data[i + 3] = 255;
            }
        }
    }
    return data;
}

export function makeWoodNormals(size: number): Uint8Array {
    const h = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            h[y * size + x] = woodPlanksHeight(x, y, size);
        }
    }
    return normalsFromHeights(h, size, 2.5);
}

export function makeWoodOrm(size: number): Uint8Array {
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const i = (y * size + x) * 4;
            const ly = y % WPH;
            if (ly >= WPH - WGAP) {
                data[i] = 120;
                data[i + 1] = 200;
                data[i + 2] = 0;
                data[i + 3] = 255;
            } else {
                const gv = woodGrainValue(x, y, size);
                data[i] = 210; // occlusion: even across plank
                data[i + 1] = Math.round(170 + gv * 45); // roughness scale: grain ridges = rougher
                data[i + 2] = 0;
                data[i + 3] = 255;
            }
        }
    }
    return data;
}

export function makeWoodHeight(size: number): Uint8Array {
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const i = (y * size + x) * 4;
            const v = Math.round(woodPlanksHeight(x, y, size) * 255);
            data[i] = data[i + 1] = data[i + 2] = v;
            data[i + 3] = 255;
        }
    }
    return data;
}

// ─── Tread plate ─────────────────────────────────────────────────────────────
// Offset diamond-shaped raised nubs on a flat metal surface.
// Pair with the metal/gold preset — ORM B=255 passes through mat.metallic.

const DPX = 20; // diamond cell width
const DPY = 12; // diamond cell height
const DRX = 7; // diamond half-width
const DRY = 4; // diamond half-height

function treadHeight(x: number, y: number): number {
    const row = Math.floor(y / DPY);
    const lx = (((x + (row & 1) * (DPX >> 1)) % DPX) + DPX) % DPX;
    const ly = y % DPY;
    // Diamond: |dx/rx| + |dy/ry| <= 1
    const d = Math.abs(lx - DPX / 2) / DRX + Math.abs(ly - DPY / 2) / DRY;
    if (d >= 1) {
        return 0;
    }
    const h = 1 - d;
    return h * h; // parabolic profile
}

export function makeTreadAlbedo(size: number): Uint8Array {
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const i = (y * size + x) * 4;
            const h = treadHeight(x, y);
            // Steel blue-gray, lighter on diamond tops
            const v = Math.round(h * 30);
            data[i] = clamp(158 + v, 140, 195);
            data[i + 1] = clamp(164 + v, 145, 200);
            data[i + 2] = clamp(172 + v, 155, 210);
            data[i + 3] = 255;
        }
    }
    return data;
}

export function makeTreadNormals(size: number): Uint8Array {
    const h = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            h[y * size + x] = treadHeight(x, y);
        }
    }
    return normalsFromHeights(h, size, 5);
}

export function makeTreadOrm(size: number): Uint8Array {
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const i = (y * size + x) * 4;
            const h = treadHeight(x, y);
            data[i] = Math.round(165 + h * 90); // occlusion: valleys darker
            data[i + 1] = Math.round(100 - h * 40); // roughness scale: tops smoother (60), base rougher (100)
            data[i + 2] = 255; // metallic scale: full passthrough
            data[i + 3] = 255;
        }
    }
    return data;
}

export function makeTreadHeight(size: number): Uint8Array {
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const i = (y * size + x) * 4;
            const v = Math.round(treadHeight(x, y) * 255);
            data[i] = data[i + 1] = data[i + 2] = v;
            data[i + 3] = 255;
        }
    }
    return data;
}
