import {mat4, type ReadonlyMat4, type ReadonlyVec3, vec3, vec4} from "gl-matrix";

/** Most cascades a directional light can split its shadow into. */
export const MAX_CASCADES = 4;

/** One slice of the camera's view, with the shadow map that covers it. GPU-free. */
export interface Cascade {
    /** World → shadow clip space (the light's orthographic view-projection for this slice). */
    readonly matrix: mat4;
    /** Camera view depth (along its forward axis) where this cascade ends. */
    far: number;
    /** World size of one shadow texel. */
    texel: number;
    /** World distance the shadow map's 0..1 depth spans. */
    depthRange: number;
    /** The slice's bounding sphere, in light view space (x, y snapped to the texel grid): for culling casters. */
    readonly center: vec3;
    radius: number;
}

export function createCascade(): Cascade {
    return {matrix: mat4.create(), far: 0, texel: 0, depthRange: 0, center: vec3.create(), radius: 0};
}

export interface CascadeFit {
    /** The camera's inverse view-projection (its frustum corners are unprojected from it). */
    invViewProjection: ReadonlyMat4;
    /** The camera's near and far planes (view depths). */
    near: number;
    far: number;
    /** Where the light travels, normalized. */
    lightDirection: ReadonlyVec3;
    cascades: number;
    /** Shadows end here (view depth), or at the camera's far plane if nearer. */
    maxDistance: number;
    /** 0: even splits, 1: logarithmic. */
    splitBalance: number;
    /** Shadow map texels per side. */
    mapSize: number;
    /**
     * The farthest-up-the-light point of anything casting a shadow: min over casters of dot(p, lightDirection).
     * Each cascade's depth range starts there, so a caster outside the view still shadows into it.
     */
    casterStart: number;
}

/**
 * Where each cascade ends, as camera view depths: the "practical split scheme", a blend of logarithmic splits
 * (even texel density on screen) and uniform ones by `balance`.
 */
export function cascadeSplits(near: number, far: number, count: number, balance: number): number[] {
    const splits: number[] = [];
    // logarithmic needs 0 < near < far: an orthographic camera may start at or behind 0 (and gains nothing from it)
    const logOk = near > 0 && far > near;
    far = Math.max(far, near + 1e-6);
    for (let i = 1; i <= count; i++) {
        const f = i / count;
        const log = logOk ? near * Math.pow(far / near, f) : near + (far - near) * f;
        const uniform = near + (far - near) * f;
        splits.push(balance * log + (1 - balance) * uniform);
    }
    return splits;
}

/** The light's view: a rotation looking along the light from the origin (its translation is applied per cascade). */
export function lightView(out: mat4, direction: ReadonlyVec3): mat4 {
    const up: ReadonlyVec3 = Math.abs(direction[1]) > 0.99 ? [1, 0, 0] : [0, 1, 0];
    return mat4.lookAt(out, [0, 0, 0], direction, up);
}

const ndcCorners: [number, number][] = [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
];
const nearCorners = Array.from({length: 4}, () => vec3.create());
/** Per corner ray: the world step per unit of view depth. */
const cornerSteps = Array.from({length: 4}, () => vec3.create());
const forward = vec3.create();
const edgeA = vec3.create();
const edgeB = vec3.create();
const slice = Array.from({length: 8}, () => vec3.create());
const tmp4 = vec4.create();
const view = mat4.create();
const proj = mat4.create();
const centroid = vec3.create();

function unproject(out: vec3, inv: ReadonlyMat4, x: number, y: number, z: number): vec3 {
    vec4.transformMat4(tmp4, vec4.set(tmp4, x, y, z, 1), inv);
    return vec3.set(out, tmp4[0] / tmp4[3], tmp4[1] / tmp4[3], tmp4[2] / tmp4[3]);
}

/**
 * Fits `fit.cascades` shadow maps to slices of the camera's view, into `out` (reused). Each covers its slice's
 * bounding sphere, whose radius depends only on the frustum's shape, and sits on the light's texel grid: the
 * shadow doesn't swim or shimmer as the camera turns or moves. Returns the number of cascades.
 */
export function fitCascades(out: Cascade[], fit: CascadeFit): number {
    const count = Math.max(1, Math.min(MAX_CASCADES, Math.round(fit.cascades)));
    const far = Math.min(fit.far, fit.maxDistance);
    const splits = cascadeSplits(fit.near, far, count, fit.splitBalance);
    for (let i = 0; i < 4; i++) {
        unproject(nearCorners[i]!, fit.invViewProjection, ndcCorners[i]![0], ndcCorners[i]![1], 0);
        // toward the far plane, kept homogeneous: with an infinite far plane its w is 0
        vec4.transformMat4(tmp4, vec4.set(tmp4, ndcCorners[i]![0], ndcCorners[i]![1], 1, 1), fit.invViewProjection);
        const n = nearCorners[i]!;
        vec3.set(cornerSteps[i]!, tmp4[0] - n[0] * tmp4[3], tmp4[1] - n[1] * tmp4[3], tmp4[2] - n[2] * tmp4[3]);
    }
    // the view axis: the near plane's normal, facing the way the corner rays go
    vec3.cross(
        forward,
        vec3.subtract(edgeA, nearCorners[1]!, nearCorners[0]!),
        vec3.subtract(edgeB, nearCorners[2]!, nearCorners[0]!),
    );
    vec3.normalize(forward, forward);
    if (vec3.dot(forward, cornerSteps[0]!) < 0) {
        vec3.negate(forward, forward);
    }
    for (const step of cornerSteps) {
        // view depth grows linearly along each corner ray: scale the step to one unit of it
        const perDepth = vec3.dot(step, forward);
        vec3.scale(step, step, perDepth > 0 ? 1 / perDepth : 0);
    }
    lightView(view, fit.lightDirection);

    for (let c = 0; c < count; c++) {
        const cascade = (out[c] ??= createCascade());
        const from = c === 0 ? fit.near : splits[c - 1]!;
        const to = splits[c]!;
        // the slice's 8 corners: view depth is linear along each corner ray, near plane to far plane
        for (let i = 0; i < 4; i++) {
            vec3.scaleAndAdd(slice[i]!, nearCorners[i]!, cornerSteps[i]!, from - fit.near);
            vec3.scaleAndAdd(slice[i + 4]!, nearCorners[i]!, cornerSteps[i]!, to - fit.near);
        }
        vec3.set(centroid, 0, 0, 0);
        for (const p of slice) {
            vec3.add(centroid, centroid, p);
        }
        vec3.scale(centroid, centroid, 1 / 8);
        let radius = 0;
        for (const p of slice) {
            radius = Math.max(radius, vec3.distance(p, centroid));
        }
        radius = Math.ceil(radius * 16) / 16; // no float jitter in the size

        // the center in light view space, snapped to whole texels
        const texel = (2 * radius) / fit.mapSize;
        const lc = vec3.transformMat4(cascade.center, centroid, view);
        lc[0] = Math.floor(lc[0] / texel) * texel;
        lc[1] = Math.floor(lc[1] / texel) * texel;

        // depth: from the first caster up the light to the far side of the slice (view distance = -z)
        const centerAlong = -lc[2];
        const near = Math.min(centerAlong - radius, fit.casterStart) - 0.5;
        const farAlong = centerAlong + radius + 0.5;
        mat4.orthoZO(proj, lc[0] - radius, lc[0] + radius, lc[1] - radius, lc[1] + radius, near, farAlong);
        mat4.multiply(cascade.matrix, proj, view);
        cascade.far = to;
        cascade.texel = texel;
        cascade.depthRange = farAlong - near;
        cascade.radius = radius;
    }
    return count;
}
