import {quat, type ReadonlyVec3, vec3} from "gl-matrix";

import type {InputPointer, InputWheel, PointerConsumer, PointerInput} from "../input/pointer-input";
import {type Camera, OrthographicCamera, PerspectiveCamera} from "../scene/camera";

export interface OrbitControlsOptions {
    /** The point orbited and looked at. Default: the origin. */
    target?: ReadonlyVec3;
    /** Distance limits from the target. Defaults: 0.01 and Infinity. */
    minDistance?: number;
    maxDistance?: number;
    /** Angle from straight up (+Y), radians. Defaults keep just off the poles: 0.01 and π - 0.01. */
    minPolarAngle?: number;
    maxPolarAngle?: number;
    /** Multipliers on the default gesture speeds. Default 1. */
    rotateSpeed?: number;
    zoomSpeed?: number;
    panSpeed?: number;
    enableRotate?: boolean;
    enableZoom?: boolean;
    enablePan?: boolean;
    /**
     * Ease toward each gesture instead of jumping: the share of the remaining motion applied per 1/60 s, 0..1.
     * 0 (or 1) applies gestures at once. Default 0.15.
     */
    damping?: number;
    /**
     * Trackpad gestures from wheel events: pinch zooms, a two-finger swipe rotates (pans with Shift). A mouse wheel
     * still zooms. Off: every wheel event zooms. Default true.
     */
    trackpadGestures?: boolean;
    /** Spin around the target at this many radians per second while idle (negative: the other way). Default 0. */
    autoRotate?: number;
    /** Seconds after the last gesture before auto-rotation resumes. Default 2. */
    autoRotateDelay?: number;
    /**
     * CSS touch-action set on the canvas while attached. "none" (default) gives every touch to the controls;
     * "pan-y" leaves one-finger vertical swipes to scroll the page (horizontal drags and two fingers still orbit).
     */
    touchAction?: string;
    /**
     * Take plain wheel and two-finger scrolling at all times (default true). False suits a canvas in a scrolling
     * page: the page keeps the scroll until the user presses inside the canvas, and again once the pointer leaves
     * it. Pinch always zooms the scene.
     */
    captureScroll?: boolean;
}

const TAU = Math.PI * 2;
const EPSILON = 1e-6;
const tmpOffset = vec3.create();
const tmpRight = vec3.create();
const tmpUp = vec3.create();
const tmpYaw = quat.create();
/** A burst of wheel events closer than this (ms) keeps the mouse-or-trackpad call of its first event. */
const WHEEL_BURST_MS = 250;

/**
 * Orbits a camera around a target: drag to rotate, wheel or pinch to zoom, right-drag, shift-drag or two-finger
 * drag to pan. A `PointerInput` consumer at priority 0, so gestures picking claims (an entity's `capture()`) never
 * reach it. Call `update(delta)` every frame; the camera keeps looking at the target.
 *
 * ```ts
 * const controls = new OrbitControls(camera, {target: [0, 0.5, 0]}).attach(input);
 * renderer.startAnimation(({delta}) => (controls.update(delta), graph));
 * ```
 *
 * Trackpads: pinch zooms, two-finger swipe rotates, Shift + swipe pans (`trackpadGestures`). Attaching sets the
 * canvas's touch-action (`touchAction`, default "none") so touch gestures orbit instead of scrolling the page. The
 * camera's parent should be untransformed (a direct child of the scene): target and camera are in world space, and
 * the camera's rotation is built from the orbit angles (no roll, steady through the poles).
 */
export class OrbitControls implements PointerConsumer {
    camera: Camera;
    readonly target: vec3;
    enabled = true;
    minDistance: number;
    maxDistance: number;
    minPolarAngle: number;
    maxPolarAngle: number;
    rotateSpeed: number;
    zoomSpeed: number;
    panSpeed: number;
    enableRotate: boolean;
    enableZoom: boolean;
    enablePan: boolean;
    damping: number;
    trackpadGestures: boolean;
    autoRotate: number;
    autoRotateDelay: number;
    touchAction: string;
    captureScroll: boolean;

    /** Current orbit, in spherical coordinates around the target (azimuth 0 looks from +Z, π/2 from +X). */
    distance = 1;
    azimuth = 0;
    polar = Math.PI / 2;

    // Motion still to apply (eased by damping).
    private pendingAzimuth = 0;
    private pendingPolar = 0;
    private pendingZoom = 1; // distance multiplier
    private readonly pendingPan = vec3.create();

    private readonly pointers = new Map<number, {x: number; y: number; mode: "rotate" | "pan" | "dolly"}>();
    private pinch: {distance: number; cx: number; cy: number} | null = null;
    private input: PointerInput | null = null;
    private detachConsumer: (() => void) | null = null;
    private previousTouchAction = "";
    /** Seconds since the user last touched the controls (auto-rotation waits for autoRotateDelay). */
    private idle = Infinity;
    private wheelBurst: {mouse: boolean; at: number} | null = null;
    /** With captureScroll off: whether the user engaged the canvas (pressed in it, pointer still inside). */
    private engaged = false;

    constructor(camera: Camera, options: OrbitControlsOptions = {}) {
        this.camera = camera;
        this.target = vec3.clone(options.target ?? [0, 0, 0]);
        this.minDistance = options.minDistance ?? 0.01;
        this.maxDistance = options.maxDistance ?? Infinity;
        this.minPolarAngle = options.minPolarAngle ?? 0.01;
        this.maxPolarAngle = options.maxPolarAngle ?? Math.PI - 0.01;
        this.rotateSpeed = options.rotateSpeed ?? 1;
        this.zoomSpeed = options.zoomSpeed ?? 1;
        this.panSpeed = options.panSpeed ?? 1;
        this.enableRotate = options.enableRotate ?? true;
        this.enableZoom = options.enableZoom ?? true;
        this.enablePan = options.enablePan ?? true;
        this.damping = options.damping ?? 0.15;
        this.trackpadGestures = options.trackpadGestures ?? true;
        this.autoRotate = options.autoRotate ?? 0;
        this.autoRotateDelay = options.autoRotateDelay ?? 2;
        this.touchAction = options.touchAction ?? "none";
        this.captureScroll = options.captureScroll ?? true;
        this.syncFromCamera();
    }

    /** Re-reads distance and angles from the camera's position around the target (after moving either by hand). */
    syncFromCamera(): this {
        const offset = vec3.subtract(tmpOffset, this.camera.getWorldPosition(), this.target);
        this.distance = Math.max(vec3.length(offset), EPSILON);
        this.azimuth = Math.atan2(offset[0], offset[2]);
        this.polar = Math.acos(Math.min(1, Math.max(-1, offset[1] / this.distance)));
        this.stop();
        this.apply();
        return this;
    }

    /** Places the camera on the orbit now: `distance` from the target at the given angles (radians). */
    setOrbit(distance: number, azimuth: number, polar: number): this {
        this.distance = distance;
        this.azimuth = azimuth;
        this.polar = polar;
        this.stop();
        this.apply();
        return this;
    }

    /** Drops any motion still easing out. */
    stop(): this {
        this.pendingAzimuth = 0;
        this.pendingPolar = 0;
        this.pendingZoom = 1;
        vec3.set(this.pendingPan, 0, 0, 0);
        return this;
    }

    /** Queues a rotation (radians), eased by damping. */
    rotate(dAzimuth: number, dPolar: number): this {
        this.pendingAzimuth += dAzimuth;
        this.pendingPolar += dPolar;
        return this;
    }

    /** Queues a zoom: `scale` < 1 moves closer. */
    zoom(scale: number): this {
        this.pendingZoom *= scale;
        return this;
    }

    /** Queues a pan of the target, in world units along the camera's right and up. */
    pan(right: number, up: number): this {
        const m = this.camera.computeWorldMatrix();
        vec3.set(tmpRight, m[0]!, m[1]!, m[2]!);
        vec3.set(tmpUp, m[4]!, m[5]!, m[6]!);
        vec3.normalize(tmpRight, tmpRight);
        vec3.normalize(tmpUp, tmpUp);
        vec3.scaleAndAdd(this.pendingPan, this.pendingPan, tmpRight, right);
        vec3.scaleAndAdd(this.pendingPan, this.pendingPan, tmpUp, up);
        return this;
    }

    /**
     * Advances eased motion by `delta` seconds and places the camera. Call once per frame. Returns whether the
     * camera moved.
     */
    update(delta = 1 / 60): boolean {
        this.idle += Math.max(delta, 0);
        if (this.autoRotate !== 0 && this.pointers.size === 0 && this.idle >= this.autoRotateDelay) {
            this.azimuth += this.autoRotate * delta;
        }
        const eased = this.damping > 0 && this.damping < 1;
        // Share of the pending motion to apply this frame, independent of frame rate.
        const k = eased ? 1 - Math.pow(1 - this.damping, Math.max(delta, 0) * 60) : 1;

        const dAz = this.pendingAzimuth * k;
        const dPolar = this.pendingPolar * k;
        const zoom = Math.pow(this.pendingZoom, k);
        const moving =
            Math.abs(dAz) > EPSILON ||
            Math.abs(dPolar) > EPSILON ||
            Math.abs(zoom - 1) > EPSILON ||
            vec3.squaredLength(this.pendingPan) > EPSILON * EPSILON;

        this.azimuth = (this.azimuth + dAz) % TAU;
        this.polar = clamp(this.polar + dPolar, this.minPolarAngle, this.maxPolarAngle);
        this.applyZoom(zoom);
        vec3.scaleAndAdd(this.target, this.target, this.pendingPan, k);

        this.pendingAzimuth -= dAz;
        this.pendingPolar -= dPolar;
        this.pendingZoom /= zoom;
        vec3.scale(this.pendingPan, this.pendingPan, 1 - k);
        if (!moving) {
            this.stop();
        }
        this.apply();
        return moving || (this.autoRotate !== 0 && this.idle >= this.autoRotateDelay);
    }

    /** Starts taking gestures from `input` (at priority 0, below scene picking). */
    attach(input: PointerInput, priority = 0): this {
        this.detach();
        this.input = input;
        this.detachConsumer = input.addConsumer(this, priority);
        this.previousTouchAction = input.element.style.touchAction;
        input.element.style.touchAction = this.touchAction;
        return this;
    }

    detach(): this {
        this.detachConsumer?.();
        this.detachConsumer = null;
        if (this.input !== null) {
            this.input.element.style.touchAction = this.previousTouchAction;
            this.input = null;
        }
        this.pointers.clear();
        this.pinch = null;
        return this;
    }

    // ─── PointerConsumer ──────────────────────────────────────────────────────

    pointerDown(p: InputPointer): boolean {
        if (!this.enabled) {
            return false;
        }
        const mode =
            p.pointerType === "touch"
                ? "rotate"
                : p.button === 2 || (p.button === 0 && (p.shiftKey || p.ctrlKey || p.metaKey))
                  ? "pan"
                  : p.button === 1
                    ? "dolly"
                    : p.button === 0
                      ? "rotate"
                      : null;
        if (mode === null || !this.allowed(mode)) {
            return false;
        }
        this.pointers.set(p.pointerId, {x: p.x, y: p.y, mode});
        this.idle = 0;
        this.engaged = true;
        if (this.pointers.size === 2) {
            this.pinch = this.pinchState();
        }
        return true;
    }

    pointerMove(p: InputPointer): void {
        const state = this.pointers.get(p.pointerId);
        if (state === undefined || !this.enabled) {
            return;
        }
        this.idle = 0;
        const dx = p.x - state.x;
        const dy = p.y - state.y;
        state.x = p.x;
        state.y = p.y;

        if (this.pointers.size >= 2) {
            // Two fingers: spread to zoom, move the midpoint to pan.
            const next = this.pinchState();
            if (this.pinch !== null && next !== null) {
                if (this.enableZoom && next.distance > 0) {
                    this.zoom(Math.pow(this.pinch.distance / next.distance, this.zoomSpeed));
                }
                if (this.enablePan) {
                    this.panPixels(next.cx - this.pinch.cx, next.cy - this.pinch.cy, p.height);
                }
            }
            this.pinch = next;
            return;
        }

        switch (state.mode) {
            case "rotate":
                // A drag across the canvas's height turns a full circle (at rotateSpeed 1).
                this.rotate((-TAU * dx * this.rotateSpeed) / p.height, (-TAU * dy * this.rotateSpeed) / p.height);
                break;
            case "pan":
                this.panPixels(dx, dy, p.height);
                break;
            case "dolly":
                this.zoom(Math.exp((dy / p.height) * 4 * this.zoomSpeed));
                break;
        }
    }

    hover(_p: InputPointer, inside: boolean): void {
        if (!inside) {
            this.engaged = false;
        }
    }

    pointerUp(p: InputPointer): void {
        this.pointers.delete(p.pointerId);
        this.pinch = this.pointers.size >= 2 ? this.pinchState() : null;
    }

    wheel(w: InputWheel): boolean {
        if (!this.enabled) {
            return false;
        }
        if (w.ctrlKey) {
            // A trackpad pinch (browsers send it as ctrl + wheel): small deltas, so a stronger factor. A mouse
            // wheel with Control held keeps the mouse rate (the pinch one would be ×2.7 per notch).
            if (!this.enableZoom) {
                return false;
            }
            this.idle = 0;
            const rate = this.isMouseWheel(w) ? 0.001 : 0.01;
            this.zoom(Math.exp(w.deltaY * rate * this.zoomSpeed));
            return true;
        }
        if (!this.captureScroll && !this.engaged) {
            return false; // the page scrolls
        }
        if (!this.trackpadGestures || this.isMouseWheel(w)) {
            if (!this.enableZoom) {
                return false;
            }
            this.idle = 0;
            // About 10% per notch (100 px) at zoomSpeed 1.
            this.zoom(Math.exp(w.deltaY * 0.001 * this.zoomSpeed));
            return true;
        }
        // A two-finger swipe: move as a drag would, the content following the fingers.
        if (w.shiftKey ? !this.enablePan : !this.enableRotate) {
            return false;
        }
        this.idle = 0;
        if (w.shiftKey) {
            this.panPixels(-w.deltaX, -w.deltaY, w.height);
        } else {
            const k = (TAU * this.rotateSpeed) / w.height;
            this.rotate(w.deltaX * k, w.deltaY * k);
        }
        return true;
    }

    /**
     * Mouse wheel or trackpad scroll? Line or page deltas, or a vertical-only notch of 120 (wheelDeltaY), mean a
     * mouse. A burst of events keeps its first call, so a swipe doesn't flip mid-way.
     */
    private isMouseWheel(w: InputWheel): boolean {
        const now = typeof performance === "undefined" ? Date.now() : performance.now();
        if (this.wheelBurst !== null && now - this.wheelBurst.at < WHEEL_BURST_MS) {
            this.wheelBurst.at = now;
            return this.wheelBurst.mouse;
        }
        const mouse = w.discrete || (w.deltaX === 0 && w.legacyDeltaY !== 0 && Math.abs(w.legacyDeltaY) % 120 === 0);
        this.wheelBurst = {mouse, at: now};
        return mouse;
    }

    // ─── Internals ────────────────────────────────────────────────────────────

    private allowed(mode: "rotate" | "pan" | "dolly"): boolean {
        return mode === "rotate" ? this.enableRotate : mode === "pan" ? this.enablePan : this.enableZoom;
    }

    private pinchState(): {distance: number; cx: number; cy: number} | null {
        const [a, b] = [...this.pointers.values()];
        if (a === undefined || b === undefined) {
            return null;
        }
        return {distance: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2};
    }

    /** Pans so the point under the pointer follows it: pixels to world units at the target's depth. */
    private panPixels(dx: number, dy: number, height: number): void {
        let worldPerPixel: number;
        if (this.camera instanceof PerspectiveCamera) {
            worldPerPixel = (2 * this.distance * Math.tan(this.camera.fov / 2)) / height;
        } else if (this.camera instanceof OrthographicCamera) {
            worldPerPixel = (this.camera.top - this.camera.bottom) / height;
        } else {
            worldPerPixel = this.distance / height;
        }
        this.pan(-dx * worldPerPixel * this.panSpeed, dy * worldPerPixel * this.panSpeed);
    }

    private applyZoom(scale: number): void {
        if (this.camera instanceof OrthographicCamera) {
            // An orthographic view doesn't change with distance: scale its box instead.
            const cam = this.camera;
            const cx = (cam.left + cam.right) / 2;
            const cy = (cam.top + cam.bottom) / 2;
            const hw = ((cam.right - cam.left) / 2) * scale;
            const hh = ((cam.top - cam.bottom) / 2) * scale;
            cam.left = cx - hw;
            cam.right = cx + hw;
            cam.top = cy + hh;
            cam.bottom = cy - hh;
            return;
        }
        this.distance = clamp(this.distance * scale, this.minDistance, this.maxDistance);
    }

    /** Places the camera from the spherical state. Positions are world space: keep the camera's parent untransformed. */
    private apply(): void {
        const s = Math.sin(this.polar);
        vec3.set(
            this.camera.position,
            this.target[0] + this.distance * s * Math.sin(this.azimuth),
            this.target[1] + this.distance * Math.cos(this.polar),
            this.target[2] + this.distance * s * Math.cos(this.azimuth),
        );
        // Yaw about world Y, then pitch about the camera's X: no roll, and no flip at the poles (lookAt with a fixed
        // up vector has to swap axes there).
        quat.setAxisAngle(tmpYaw, [0, 1, 0], this.azimuth);
        quat.rotateX(this.camera.quaternion, tmpYaw, this.polar - Math.PI / 2);
    }
}

function clamp(v: number, lo: number, hi: number): number {
    return v < lo ? lo : v > hi ? hi : v;
}
