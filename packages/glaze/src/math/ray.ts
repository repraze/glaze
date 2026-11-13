import type {mat4} from "gl-matrix";
import {type ReadonlyMat4, type ReadonlyVec3, vec3, vec4} from "gl-matrix";

import {box3, type ReadonlyBox3, type ReadonlySphere} from "./bounds";

/**
 * A ray, `origin + t * direction` for t ≥ 0, in gl-matrix's style: plain data, free functions, `out` first.
 *
 * `direction` need not be unit length. Transforming a ray into an object's local space with `transformMat4` keeps
 * its direction unnormalised, so a `t` found in local space is the same `t` in world space: hits from different
 * objects compare directly.
 */
export interface Ray {
    origin: vec3;
    direction: vec3;
}

export type ReadonlyRay = {readonly origin: ReadonlyVec3; readonly direction: ReadonlyVec3};

const tmp4 = vec4.create();
const tmpA = vec3.create();
const tmpE1 = vec3.create();
const tmpE2 = vec3.create();
const tmpP = vec3.create();
const tmpQ = vec3.create();
const tmpS = vec3.create();

export const ray = {
    /** A ray from the origin down -Z. */
    create(): Ray {
        return {origin: vec3.create(), direction: vec3.fromValues(0, 0, -1)};
    },

    fromValues(origin: ReadonlyVec3, direction: ReadonlyVec3): Ray {
        return {origin: vec3.clone(origin), direction: vec3.clone(direction)};
    },

    clone(r: ReadonlyRay): Ray {
        return {origin: vec3.clone(r.origin), direction: vec3.clone(r.direction)};
    },

    copy(out: Ray, r: ReadonlyRay): Ray {
        vec3.copy(out.origin, r.origin);
        vec3.copy(out.direction, r.direction);
        return out;
    },

    /** The point at `t` along the ray. */
    at(out: vec3, r: ReadonlyRay, t: number): vec3 {
        return vec3.scaleAndAdd(out, r.origin, r.direction, t);
    },

    /** The ray transformed by `m`; the direction is not renormalised (see the module note). */
    transformMat4(out: Ray, r: ReadonlyRay, m: ReadonlyMat4): Ray {
        const dx = r.direction[0], dy = r.direction[1], dz = r.direction[2]; // prettier-ignore
        vec3.transformMat4(out.origin, r.origin, m);
        out.direction[0] = m[0]! * dx + m[4]! * dy + m[8]! * dz;
        out.direction[1] = m[1]! * dx + m[5]! * dy + m[9]! * dz;
        out.direction[2] = m[2]! * dx + m[6]! * dy + m[10]! * dz;
        return out;
    },

    /**
     * The ray through normalised device coordinates (x right, y up, both -1..1) for a camera whose
     * view-projection inverse is `invViewProjection`. It starts on the near plane and has a unit direction.
     * Works for perspective and orthographic projections with WebGPU's 0..1 depth.
     */
    fromNdc(out: Ray, invViewProjection: ReadonlyMat4, ndcX: number, ndcY: number): Ray {
        unproject(tmpA, invViewProjection, ndcX, ndcY, 0);
        vec3.copy(out.origin, tmpA);
        // The far point stays homogeneous: with a huge (or infinite) far plane its w is 0 or rounds to it, and
        // dividing would give infinities. b.xyz - near·b.w is (far - near)·b.w, or the direction at infinity.
        vec4.transformMat4(tmp4, vec4.set(tmp4, ndcX, ndcY, 1, 1), invViewProjection as mat4);
        vec3.set(out.direction, tmp4[0] - tmpA[0] * tmp4[3], tmp4[1] - tmpA[1] * tmp4[3], tmp4[2] - tmpA[2] * tmp4[3]);
        vec3.normalize(out.direction, out.direction);
        return out;
    },

    /** Distance along the ray to the box (0 when the origin is inside it), or null on a miss. Slab method. */
    intersectBox(r: ReadonlyRay, b: ReadonlyBox3): number | null {
        if (box3.isEmpty(b)) {
            return null; // min > max: the slabs below would never reject a ray with no zero component
        }
        let tmin = 0;
        let tmax = Infinity;
        for (let i = 0; i < 3; i++) {
            const o = r.origin[i]!;
            const d = r.direction[i]!;
            const lo = b.min[i]!;
            const hi = b.max[i]!;
            if (d === 0) {
                if (o < lo || o > hi) {
                    return null;
                }
                continue;
            }
            let t0 = (lo - o) / d;
            let t1 = (hi - o) / d;
            if (t0 > t1) {
                const s = t0;
                t0 = t1;
                t1 = s;
            }
            if (t0 > tmin) {
                tmin = t0;
            }
            if (t1 < tmax) {
                tmax = t1;
            }
            if (tmin > tmax) {
                return null;
            }
        }
        return tmin;
    },

    /** Distance along the ray to the sphere (0 when the origin is inside it), or null on a miss. */
    intersectSphere(r: ReadonlyRay, s: ReadonlySphere): number | null {
        if (s.radius < 0) {
            return null;
        }
        const oc = vec3.subtract(tmpA, r.origin, s.center);
        const a = vec3.dot(r.direction, r.direction);
        const halfB = vec3.dot(oc, r.direction);
        const c = vec3.dot(oc, oc) - s.radius * s.radius;
        if (c <= 0) {
            return 0;
        }
        const disc = halfB * halfB - a * c;
        if (disc < 0 || a === 0) {
            return null;
        }
        const t = (-halfB - Math.sqrt(disc)) / a;
        return t >= 0 ? t : null;
    },

    /**
     * Distance along the ray to the plane through `point` with normal `normal` (either side), or null when the ray
     * is parallel to it or points away. Handy for dragging on a ground plane.
     */
    intersectPlane(r: ReadonlyRay, point: ReadonlyVec3, normal: ReadonlyVec3): number | null {
        const denom = vec3.dot(normal, r.direction);
        if (Math.abs(denom) < 1e-12) {
            return null;
        }
        const t = vec3.dot(vec3.subtract(tmpA, point, r.origin), normal) / denom;
        return t >= 0 ? t : null;
    },

    /**
     * Distance along the ray to triangle (a, b, c), or null on a miss (Möller–Trumbore). Counter-clockwise triangles
     * face the viewer; with `cullBackFace`, triangles seen from behind miss. When given, `barycentric` receives the
     * weights of (a, b, c) at the hit.
     */
    intersectTriangle(
        r: ReadonlyRay,
        a: ReadonlyVec3,
        b: ReadonlyVec3,
        c: ReadonlyVec3,
        cullBackFace = false,
        barycentric?: vec3,
    ): number | null {
        const e1 = vec3.subtract(tmpE1, b, a);
        const e2 = vec3.subtract(tmpE2, c, a);
        const p = vec3.cross(tmpP, r.direction, e2);
        const det = vec3.dot(e1, p);
        if (cullBackFace ? det <= 1e-12 : Math.abs(det) <= 1e-12) {
            return null;
        }
        const inv = 1 / det;
        const s = vec3.subtract(tmpS, r.origin, a);
        const u = vec3.dot(s, p) * inv;
        if (u < 0 || u > 1) {
            return null;
        }
        const q = vec3.cross(tmpQ, s, e1);
        const v = vec3.dot(r.direction, q) * inv;
        if (v < 0 || u + v > 1) {
            return null;
        }
        const t = vec3.dot(e2, q) * inv;
        if (t < 0) {
            return null;
        }
        if (barycentric) {
            vec3.set(barycentric, 1 - u - v, u, v);
        }
        return t;
    },
};

function unproject(out: vec3, inv: ReadonlyMat4, x: number, y: number, z: number): vec3 {
    vec4.transformMat4(tmp4, vec4.set(tmp4, x, y, z, 1), inv as mat4);
    return vec3.set(out, tmp4[0] / tmp4[3], tmp4[1] / tmp4[3], tmp4[2] / tmp4[3]);
}
