import type {Entity} from "../scene/entity";
import {Mesh} from "../scene/mesh";
import {type AnimationClip, type AnimationTrack, sampleTrack, type TrackPath, trackStride} from "./clip";

/** What happens at the end of a clip: start over, stop on the last frame, or play back and forth. */
export type LoopMode = "repeat" | "once" | "pingpong";

/**
 * One clip playing on a mixer: its time, speed, loop and weight. Get it with `mixer.clipAction(clip)`; every
 * setter returns the action, so calls chain.
 */
export class AnimationAction {
    readonly clip: AnimationClip;
    /** Seconds into the clip. Set it to seek. */
    time = 0;
    /** 1 is real time, 2 twice as fast, negative plays backwards. */
    speed = 1;
    loop: LoopMode = "repeat";
    /** How much this action counts when several play at once (0..1). Faded by fadeIn / fadeOut. */
    weight = 1;
    /** Advancing in time. A paused action still holds its pose. */
    playing = false;
    /** Counted in the pose at all (stop() turns it off). */
    enabled = false;

    /** Key index per track, from the last sample: the next lookup starts there. */
    readonly hints: Int32Array;
    private fade: {from: number; to: number; elapsed: number; duration: number; stopAtEnd: boolean} | null = null;

    constructor(clip: AnimationClip) {
        this.clip = clip;
        this.hints = new Int32Array(clip.tracks.length);
    }

    /** Starts (or resumes) playing. */
    play(): this {
        this.enabled = true;
        this.playing = true;
        return this;
    }

    /** Stops advancing, holding the current pose. */
    pause(): this {
        this.playing = false;
        return this;
    }

    /** Stops and rewinds: the action no longer counts in the pose. */
    stop(): this {
        this.enabled = false;
        this.playing = false;
        this.time = 0;
        this.fade = null;
        return this;
    }

    /** True for a "once" action that reached its end (it holds the last frame). */
    get finished(): boolean {
        return this.loop === "once" && (this.speed >= 0 ? this.time >= this.clip.duration : this.time <= 0);
    }

    /** Plays, its weight rising from 0 to 1 over `duration` seconds. */
    fadeIn(duration: number): this {
        this.play();
        this.fade = {from: 0, to: 1, elapsed: 0, duration, stopAtEnd: false};
        this.weight = duration > 0 ? 0 : 1;
        return this;
    }

    /** Its weight falls to 0 over `duration` seconds, then it stops. */
    fadeOut(duration: number): this {
        this.fade = {from: this.weight, to: 0, elapsed: 0, duration, stopAtEnd: true};
        if (duration <= 0) {
            this.stop();
        }
        return this;
    }

    /** Fades this action out and `next` in over `duration` seconds: a smooth change of animation. */
    crossFadeTo(next: AnimationAction, duration: number): AnimationAction {
        this.fadeOut(duration);
        return next.fadeIn(duration);
    }

    /** The time sampled this frame: `time` wrapped or clamped by the loop mode. */
    sampleTime(): number {
        const d = this.clip.duration;
        if (d <= 0) {
            return 0;
        }
        if (this.loop === "pingpong") {
            const t = mod(this.time, 2 * d);
            return t <= d ? t : 2 * d - t;
        }
        return this.loop === "repeat" ? mod(this.time, d) : Math.min(Math.max(this.time, 0), d);
    }

    /** @internal Advances time and fades. */
    advance(delta: number): void {
        if (this.playing) {
            this.time += delta * this.speed;
            const d = this.clip.duration;
            if (this.loop === "once") {
                this.time = Math.min(Math.max(this.time, 0), d);
            } else if (this.loop === "repeat" && d > 0) {
                this.time = mod(this.time, d); // keeps precision on long runs
            }
        }
        const fade = this.fade;
        if (fade !== null) {
            fade.elapsed += delta;
            const f = fade.duration > 0 ? Math.min(fade.elapsed / fade.duration, 1) : 1;
            this.weight = fade.from + (fade.to - fade.from) * f;
            if (f >= 1) {
                this.fade = null;
                if (fade.stopAtEnd) {
                    this.stop();
                }
            }
        }
    }
}

function mod(a: number, n: number): number {
    return ((a % n) + n) % n;
}

/** Per animated property: its pose before animation, and this frame's weighted sum. */
interface Binding {
    readonly target: Entity;
    readonly path: TrackPath;
    /** Weights tracks: the meshes whose morphWeights they drive (the target, or the meshes under it). */
    readonly meshes: readonly Mesh[];
    readonly rest: Float32Array;
    readonly sum: Float32Array;
    weight: number;
}

/** Sampling scratch: room for a quaternion, or up to 256 morph target weights. */
const sample = new Float32Array(256);

/**
 * Plays animation clips on entities. Call `update(delta)` once per frame: each enabled action advances, and
 * the weighted blend of all of them is written to the entities' position, quaternion and scale. Where the
 * weights add up to less than 1, the rest pose (the transform before any animation touched it) fills in.
 *
 * ```ts
 * const mixer = new AnimationMixer();
 * const walk = mixer.clipAction(model.animations[0]!).play();
 * renderer.startAnimation(({delta}) => (mixer.update(delta), graph));
 * walk.crossFadeTo(mixer.clipAction(run), 0.3); // later
 * ```
 */
export class AnimationMixer {
    private readonly actions = new Map<AnimationClip, AnimationAction>();
    private readonly bindings = new Map<Entity, Map<TrackPath, Binding>>();
    /** Per action, its tracks' bindings (resolved once). */
    private readonly trackBindings = new Map<AnimationAction, Binding[]>();
    private readonly active: Binding[] = [];

    /** The action for a clip, created on first use (stopped). */
    clipAction(clip: AnimationClip): AnimationAction {
        let action = this.actions.get(clip);
        if (action === undefined) {
            action = new AnimationAction(clip);
            this.actions.set(clip, action);
            this.trackBindings.set(
                action,
                clip.tracks.map((track) => this.bind(track)),
            );
        }
        return action;
    }

    /** Every action created so far. */
    get allActions(): readonly AnimationAction[] {
        return [...this.actions.values()];
    }

    /** Stops every action (entities keep their last pose). */
    stopAll(): void {
        for (const action of this.actions.values()) {
            action.stop();
        }
    }

    /** Advances every enabled action by `delta` seconds and writes the blended pose. */
    update(delta: number): void {
        const active = this.active;
        active.length = 0;
        for (const [action, bindings] of this.trackBindings) {
            if (!action.enabled) {
                continue;
            }
            action.advance(delta);
            const weight = action.weight;
            if (!action.enabled || weight <= 0) {
                continue;
            }
            const time = action.sampleTime();
            const tracks = action.clip.tracks;
            for (let i = 0; i < tracks.length; i++) {
                const track = tracks[i]!;
                const binding = bindings[i]!;
                action.hints[i] = sampleTrack(track, time, sample, action.hints[i]);
                if (binding.weight === 0) {
                    binding.sum.fill(0);
                    active.push(binding);
                }
                accumulate(binding, sample, weight);
            }
        }
        for (const binding of active) {
            apply(binding);
            binding.weight = 0;
        }
    }

    private bind(track: AnimationTrack): Binding {
        const {target, path} = track;
        let byPath = this.bindings.get(target);
        if (byPath === undefined) {
            byPath = new Map();
            this.bindings.set(target, byPath);
        }
        let binding = byPath.get(path);
        if (binding === undefined) {
            const meshes =
                path === "weights"
                    ? target instanceof Mesh
                        ? [target]
                        : target.children.filter((c): c is Mesh => c instanceof Mesh)
                    : [];
            const n = Math.min(trackStride(track), sample.length);
            const source =
                path === "translation"
                    ? target.position
                    : path === "rotation"
                      ? target.quaternion
                      : path === "scale"
                        ? target.scale
                        : (meshes[0]?.morphWeights ?? new Float32Array(n));
            binding = {
                target,
                path,
                meshes,
                rest: Float32Array.from({length: n}, (_, k) => source[k] ?? 0),
                sum: new Float32Array(Math.max(n, 4)),
                weight: 0,
            };
            byPath.set(path, binding);
        }
        return binding;
    }
}

function accumulate(binding: Binding, value: Float32Array, weight: number): void {
    const sum = binding.sum;
    if (binding.path === "rotation") {
        // quaternions q and -q are the same rotation: add on the same hemisphere
        const dot = sum[0]! * value[0]! + sum[1]! * value[1]! + sum[2]! * value[2]! + sum[3]! * value[3]!;
        const w = binding.weight > 0 && dot < 0 ? -weight : weight;
        for (let k = 0; k < 4; k++) {
            sum[k] = sum[k]! + value[k]! * w;
        }
    } else {
        for (let k = 0; k < binding.rest.length; k++) {
            sum[k] = sum[k]! + value[k]! * weight;
        }
    }
    binding.weight += weight;
}

function apply(binding: Binding): void {
    const {sum, rest, path, target} = binding;
    const n = rest.length;
    const total = binding.weight;
    if (total < 1) {
        // the rest pose makes up the remaining weight
        const w = 1 - total;
        const flip =
            path === "rotation" &&
            sum[0]! * rest[0]! + sum[1]! * rest[1]! + sum[2]! * rest[2]! + sum[3]! * rest[3]! < 0;
        for (let k = 0; k < n; k++) {
            sum[k] = sum[k]! + rest[k]! * (flip ? -w : w);
        }
    } else if (path !== "rotation") {
        for (let k = 0; k < n; k++) {
            sum[k] = sum[k]! / total;
        }
    }
    if (path === "rotation") {
        const len = Math.hypot(sum[0]!, sum[1]!, sum[2]!, sum[3]!) || 1;
        target.quaternion[0] = sum[0]! / len;
        target.quaternion[1] = sum[1]! / len;
        target.quaternion[2] = sum[2]! / len;
        target.quaternion[3] = sum[3]! / len;
    } else if (path === "weights") {
        for (const mesh of binding.meshes) {
            const weights = mesh.morphWeights;
            for (let k = 0; k < Math.min(n, weights.length); k++) {
                weights[k] = sum[k]!;
            }
        }
    } else {
        const out = path === "translation" ? target.position : target.scale;
        out[0] = sum[0]!;
        out[1] = sum[1]!;
        out[2] = sum[2]!;
    }
}
