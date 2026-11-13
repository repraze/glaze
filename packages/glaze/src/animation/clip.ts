import {quat} from "gl-matrix";

import type {Entity} from "../scene/entity";

/** What a track animates: an entity's position, rotation quaternion or scale (glTF's channel paths). */
export type TrackPath = "translation" | "rotation" | "scale";

/**
 * How values change between keyframes (glTF's interpolation modes):
 * - `"LINEAR"`: straight lines; rotations take the shortest arc (slerp).
 * - `"STEP"`: hold each key until the next.
 * - `"CUBICSPLINE"`: Hermite curves; each key stores in-tangent, value, out-tangent.
 */
export type Interpolation = "LINEAR" | "STEP" | "CUBICSPLINE";

/** Keyframes for one property of one entity. */
export interface AnimationTrack {
    readonly target: Entity;
    readonly path: TrackPath;
    /** Key times in seconds, increasing. */
    readonly times: Float32Array;
    /** Values, flat: 3 per key (translation, scale) or 4 (rotation), ×3 for CUBICSPLINE (in, value, out). */
    readonly values: Float32Array;
    readonly interpolation: Interpolation;
}

/** A named set of tracks played together, like a glTF animation ("Walk", "Open"). */
export class AnimationClip {
    readonly name: string;
    readonly tracks: readonly AnimationTrack[];
    /** The last key time of any track, in seconds. */
    readonly duration: number;

    constructor(name: string, tracks: readonly AnimationTrack[], duration?: number) {
        this.name = name;
        this.tracks = tracks;
        this.duration = duration ?? tracks.reduce((d, t) => Math.max(d, t.times[t.times.length - 1] ?? 0), 0);
    }
}

/** Components per value for a path. */
export function trackStride(path: TrackPath): number {
    return path === "rotation" ? 4 : 3;
}

/**
 * The key interval containing `time`: index i with times[i] <= time < times[i + 1] (clamped to the ends).
 * `hint` is the previous result: playback moves forward a little each frame, so it is usually right or one off.
 */
export function findKey(times: Float32Array, time: number, hint = 0): number {
    const last = times.length - 1;
    if (last <= 0 || time <= times[0]!) {
        return 0;
    }
    if (time >= times[last]!) {
        return last;
    }
    let i = Math.min(Math.max(hint, 0), last - 1);
    if (times[i]! <= time && time < times[i + 1]!) {
        return i;
    }
    if (i + 2 <= last && times[i + 1]! <= time && time < times[i + 2]!) {
        return i + 1;
    }
    // binary search
    let lo = 0;
    let hi = last;
    while (hi - lo > 1) {
        i = (lo + hi) >> 1;
        if (times[i]! <= time) {
            lo = i;
        } else {
            hi = i;
        }
    }
    return lo;
}

const qa = quat.create();
const qb = quat.create();

/**
 * Samples a track at `time` into `out` (3 or 4 components), and returns the key index for the next call's
 * hint. Rotations come out normalized.
 */
export function sampleTrack(track: AnimationTrack, time: number, out: Float32Array | number[], hint = 0): number {
    const {times, values, interpolation} = track;
    const n = trackStride(track.path);
    const cubic = interpolation === "CUBICSPLINE";
    const keyStride = cubic ? n * 3 : n;
    const valueAt = cubic ? n : 0; // a cubic key is [in-tangent, value, out-tangent]
    const i = findKey(times, time, hint);
    const last = times.length - 1;
    const t0 = times[i]!;

    if (i >= last || time <= t0 || interpolation === "STEP") {
        const at = i * keyStride + valueAt;
        for (let k = 0; k < n; k++) {
            out[k] = values[at + k]!;
        }
        if (n === 4) {
            normalize4(out);
        }
        return i;
    }

    const t1 = times[i + 1]!;
    const dt = t1 - t0;
    const s = (time - t0) / dt;

    if (interpolation === "LINEAR") {
        const a = i * keyStride;
        const b = (i + 1) * keyStride;
        if (n === 4) {
            quat.set(qa, values[a]!, values[a + 1]!, values[a + 2]!, values[a + 3]!);
            quat.set(qb, values[b]!, values[b + 1]!, values[b + 2]!, values[b + 3]!);
            quat.slerp(qa, qa, qb, s);
            out[0] = qa[0];
            out[1] = qa[1];
            out[2] = qa[2];
            out[3] = qa[3];
            normalize4(out);
        } else {
            for (let k = 0; k < n; k++) {
                out[k] = values[a + k]! + (values[b + k]! - values[a + k]!) * s;
            }
        }
        return i;
    }

    // CUBICSPLINE (glTF spec, appendix C): Hermite with tangents scaled by the interval
    const s2 = s * s;
    const s3 = s2 * s;
    const h00 = 2 * s3 - 3 * s2 + 1;
    const h10 = s3 - 2 * s2 + s;
    const h01 = -2 * s3 + 3 * s2;
    const h11 = s3 - s2;
    const a = i * keyStride; // key i: [in, value, out]
    const b = (i + 1) * keyStride;
    for (let k = 0; k < n; k++) {
        const p0 = values[a + n + k]!;
        const m0 = values[a + 2 * n + k]! * dt; // out-tangent of key i
        const p1 = values[b + n + k]!;
        const m1 = values[b + k]! * dt; // in-tangent of key i + 1
        out[k] = h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1;
    }
    if (n === 4) {
        normalize4(out);
    }
    return i;
}

function normalize4(v: Float32Array | number[]): void {
    const len = Math.hypot(v[0]!, v[1]!, v[2]!, v[3]!) || 1;
    for (let k = 0; k < 4; k++) {
        v[k] = v[k]! / len;
    }
}
