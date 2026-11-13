import {type ReadonlyMat4, type ReadonlyVec3, vec3} from "gl-matrix";

/**
 * Bounding volumes, in gl-matrix's style: plain data, free functions, `out` first, aliasing allowed.
 *
 * ```ts
 * const box = box3.fromPositions(box3.create(), geometry.positions);
 * box3.transformMat4(box, box, mesh.worldMatrix); // world-space box
 * ```
 */

/** An axis-aligned box. Empty when any `min` component exceeds its `max` (the state `box3.create()` returns). */
export interface Box3 {
    min: vec3;
    max: vec3;
}

export type ReadonlyBox3 = {readonly min: ReadonlyVec3; readonly max: ReadonlyVec3};

/** A sphere. Empty when `radius` is negative (the state `sphere.create()` returns). */
export interface Sphere {
    center: vec3;
    radius: number;
}

export type ReadonlySphere = {readonly center: ReadonlyVec3; readonly radius: number};

export const box3 = {
    /** A new, empty box. */
    create(): Box3 {
        return {
            min: vec3.fromValues(Infinity, Infinity, Infinity),
            max: vec3.fromValues(-Infinity, -Infinity, -Infinity),
        };
    },

    fromValues(min: ReadonlyVec3, max: ReadonlyVec3): Box3 {
        return {min: vec3.clone(min), max: vec3.clone(max)};
    },

    clone(b: ReadonlyBox3): Box3 {
        return {min: vec3.clone(b.min), max: vec3.clone(b.max)};
    },

    copy(out: Box3, b: ReadonlyBox3): Box3 {
        vec3.copy(out.min, b.min);
        vec3.copy(out.max, b.max);
        return out;
    },

    makeEmpty(out: Box3): Box3 {
        vec3.set(out.min, Infinity, Infinity, Infinity);
        vec3.set(out.max, -Infinity, -Infinity, -Infinity);
        return out;
    },

    isEmpty(b: ReadonlyBox3): boolean {
        return b.max[0] < b.min[0] || b.max[1] < b.min[1] || b.max[2] < b.min[2];
    },

    /** The box around packed xyz positions (`stride` floats per vertex, xyz first). */
    fromPositions(out: Box3, positions: ArrayLike<number>, stride = 3): Box3 {
        box3.makeEmpty(out);
        const {min, max} = out;
        for (let i = 0; i + 2 < positions.length; i += stride) {
            const x = positions[i]!;
            const y = positions[i + 1]!;
            const z = positions[i + 2]!;
            if (x < min[0]) {
                min[0] = x;
            }
            if (y < min[1]) {
                min[1] = y;
            }
            if (z < min[2]) {
                min[2] = z;
            }
            if (x > max[0]) {
                max[0] = x;
            }
            if (y > max[1]) {
                max[1] = y;
            }
            if (z > max[2]) {
                max[2] = z;
            }
        }
        return out;
    },

    expandByPoint(out: Box3, b: ReadonlyBox3, p: ReadonlyVec3): Box3 {
        vec3.min(out.min, b.min, p);
        vec3.max(out.max, b.max, p);
        return out;
    },

    union(out: Box3, a: ReadonlyBox3, b: ReadonlyBox3): Box3 {
        vec3.min(out.min, a.min, b.min);
        vec3.max(out.max, a.max, b.max);
        return out;
    },

    getCenter(out: vec3, b: ReadonlyBox3): vec3 {
        return box3.isEmpty(b) ? vec3.set(out, 0, 0, 0) : vec3.lerp(out, b.min, b.max, 0.5);
    },

    getSize(out: vec3, b: ReadonlyBox3): vec3 {
        return box3.isEmpty(b) ? vec3.set(out, 0, 0, 0) : vec3.subtract(out, b.max, b.min);
    },

    containsPoint(b: ReadonlyBox3, p: ReadonlyVec3): boolean {
        return (
            p[0] >= b.min[0] &&
            p[0] <= b.max[0] &&
            p[1] >= b.min[1] &&
            p[1] <= b.max[1] &&
            p[2] >= b.min[2] &&
            p[2] <= b.max[2]
        );
    },

    intersectsBox(a: ReadonlyBox3, b: ReadonlyBox3): boolean {
        return (
            a.min[0] <= b.max[0] &&
            a.max[0] >= b.min[0] &&
            a.min[1] <= b.max[1] &&
            a.max[1] >= b.min[1] &&
            a.min[2] <= b.max[2] &&
            a.max[2] >= b.min[2]
        );
    },

    /** The axis-aligned box around `b` transformed by `m` (Arvo's method: exact for the 8 corners). */
    transformMat4(out: Box3, b: ReadonlyBox3, m: ReadonlyMat4): Box3 {
        if (box3.isEmpty(b)) {
            return box3.makeEmpty(out);
        }
        // Read the input first: `out` may be `b`.
        const lo3 = [b.min[0], b.min[1], b.min[2]];
        const hi3 = [b.max[0], b.max[1], b.max[2]];
        for (let i = 0; i < 3; i++) {
            // Row i of the column-major matrix is m[i], m[4 + i], m[8 + i]; translation m[12 + i].
            let lo = m[12 + i]!;
            let hi = lo;
            for (let j = 0; j < 3; j++) {
                const k = m[j * 4 + i]!;
                const e = k * lo3[j]!;
                const f = k * hi3[j]!;
                lo += e < f ? e : f;
                hi += e < f ? f : e;
            }
            out.min[i] = lo;
            out.max[i] = hi;
        }
        return out;
    },
};

export const sphere = {
    /** A new, empty sphere. */
    create(): Sphere {
        return {center: vec3.create(), radius: -1};
    },

    fromValues(center: ReadonlyVec3, radius: number): Sphere {
        return {center: vec3.clone(center), radius};
    },

    clone(s: ReadonlySphere): Sphere {
        return {center: vec3.clone(s.center), radius: s.radius};
    },

    copy(out: Sphere, s: ReadonlySphere): Sphere {
        vec3.copy(out.center, s.center);
        out.radius = s.radius;
        return out;
    },

    isEmpty(s: ReadonlySphere): boolean {
        return s.radius < 0;
    },

    /** A sphere around packed xyz positions, centred on their bounding box (tight enough for culling and picking). */
    fromPositions(out: Sphere, positions: ArrayLike<number>, stride = 3): Sphere {
        const box = box3.fromPositions(box3.create(), positions, stride);
        if (box3.isEmpty(box)) {
            vec3.set(out.center, 0, 0, 0);
            out.radius = -1;
            return out;
        }
        const c = box3.getCenter(out.center, box);
        let maxSq = 0;
        for (let i = 0; i + 2 < positions.length; i += stride) {
            const dx = positions[i]! - c[0];
            const dy = positions[i + 1]! - c[1];
            const dz = positions[i + 2]! - c[2];
            const d = dx * dx + dy * dy + dz * dz;
            if (d > maxSq) {
                maxSq = d;
            }
        }
        out.radius = Math.sqrt(maxSq);
        return out;
    },

    containsPoint(s: ReadonlySphere, p: ReadonlyVec3): boolean {
        return vec3.squaredDistance(s.center, p) <= s.radius * s.radius;
    },

    /** `s` transformed by `m`: the radius grows by the largest axis scale, so it stays a bound under non-uniform scale. */
    transformMat4(out: Sphere, s: ReadonlySphere, m: ReadonlyMat4): Sphere {
        if (sphere.isEmpty(s)) {
            out.radius = -1;
            return out;
        }
        vec3.transformMat4(out.center, s.center, m);
        const sx = m[0]! * m[0]! + m[1]! * m[1]! + m[2]! * m[2]!;
        const sy = m[4]! * m[4]! + m[5]! * m[5]! + m[6]! * m[6]!;
        const sz = m[8]! * m[8]! + m[9]! * m[9]! + m[10]! * m[10]!;
        out.radius = s.radius * Math.sqrt(Math.max(sx, sy, sz));
        return out;
    },
};
