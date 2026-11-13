import {type Ray, ray, type ReadonlyRay} from "../math/ray";
import type {Camera} from "../scene/camera";
import type {Entity} from "../scene/entity";
import {raycast, type RaycastHit, type RaycastOptions} from "../scene/raycast";
import type {Scene} from "../scene/scene";

/** A pointer as consumers see it: canvas-relative CSS pixels and normalised device coordinates. */
export interface InputPointer {
    readonly native: PointerEvent;
    readonly pointerId: number;
    readonly pointerType: string;
    /** Button that changed (pointerdown / pointerup), as `PointerEvent.button`. */
    readonly button: number;
    /** Buttons held, as `PointerEvent.buttons`. */
    readonly buttons: number;
    /** CSS pixels from the canvas's top-left corner. */
    readonly x: number;
    readonly y: number;
    /** Normalised device coordinates: x right, y up, -1..1 across the canvas. */
    readonly ndcX: number;
    readonly ndcY: number;
    /** The canvas's CSS size. */
    readonly width: number;
    readonly height: number;
    readonly shiftKey: boolean;
    readonly ctrlKey: boolean;
    readonly altKey: boolean;
    readonly metaKey: boolean;
}

/**
 * A wheel step. Trackpads send their gestures as wheel events too: a two-finger swipe scrolls (deltaX and deltaY),
 * a pinch arrives with `ctrlKey` set (Safari's gesture events are translated to the same).
 */
export interface InputWheel {
    /** The DOM event: a WheelEvent, or Safari's GestureEvent for a pinch. */
    readonly native: Event;
    /** Scroll in pixels (lines and pages converted). */
    readonly deltaX: number;
    readonly deltaY: number;
    /** True when the event came in lines or pages (a mouse wheel on some systems). */
    readonly discrete: boolean;
    /** As `WheelEvent.wheelDeltaY` where the browser has it (mouse notches are multiples of 120), else 0. */
    readonly legacyDeltaY: number;
    /** Pinch zoom on a trackpad sets it, as does a held Control key. */
    readonly ctrlKey: boolean;
    readonly shiftKey: boolean;
    readonly altKey: boolean;
    readonly metaKey: boolean;
    readonly x: number;
    readonly y: number;
    readonly ndcX: number;
    readonly ndcY: number;
    readonly width: number;
    readonly height: number;
}

/**
 * Something that takes part in pointer gestures: picking (the scene's handlers), camera controls, a gizmo.
 *
 * - `pointerDown` is offered to consumers from the highest priority down until one returns true: that consumer
 *   **claims** the pointer, and alone receives its `pointerMove`s until it is released.
 * - `pointerUp` (also sent on cancel, with `cancelled`) goes to every consumer the pointerdown was offered to, so a
 *   consumer that declined still learns the gesture ended (picking uses it for clicks).
 * - `hover` receives moves of pointers no consumer claimed (a mouse gliding over the canvas), and `inside: false`
 *   when the pointer leaves the canvas.
 * - `wheel` is offered from the highest priority down until one returns true.
 */
export interface PointerConsumer {
    pointerDown?(pointer: InputPointer): boolean;
    pointerMove?(pointer: InputPointer): void;
    pointerUp?(pointer: InputPointer, cancelled: boolean): void;
    hover?(pointer: InputPointer, inside: boolean): void;
    wheel?(wheel: InputWheel): boolean;
}

/** What scene handlers can listen to with `input.on(entity, type, handler)`. */
export type ScenePointerEventType =
    "pointerdown" | "pointermove" | "pointerup" | "click" | "pointerenter" | "pointerleave";

export type ScenePointerHandler = (event: ScenePointerEvent) => void;

/** The event a scene handler receives. */
export interface ScenePointerEvent {
    readonly type: ScenePointerEventType;
    readonly pointer: InputPointer;
    /** The world-space ray under the pointer. */
    readonly ray: ReadonlyRay;
    /** Every hit under the pointer, nearest first (raycast on first read). */
    readonly hits: readonly RaycastHit[];
    /** The hit this dispatch is for; null for events of a captured pointer, and for pointerleave. */
    readonly hit: RaycastHit | null;
    /** The entity whose collider was hit (or the capturing entity). */
    readonly target: Entity;
    /** The entity whose handler is running (the target or one of its ancestors). */
    readonly currentTarget: Entity;
    /**
     * Stops the event here: no further ancestors, and no hits further back. Without it an event bubbles to every
     * ancestor and then passes through to the next hit, each entity's handlers running at most once.
     */
    stopPropagation(): void;
    /**
     * On pointerdown: claim this pointer's gesture for `currentTarget`. Its moves and the final pointerup (and
     * click) go to that entity and its ancestors whatever is under the pointer, and lower-priority consumers such
     * as camera controls never see the gesture. Use it to drag an object.
     */
    capture(): void;
}

export interface PointerInputOptions {
    /** The scene whose entities' handlers receive events; set later with `input.scene`. */
    scene?: Scene | null;
    /** The camera rays are cast from. Default: the scene's activeCamera. */
    camera?: Camera | null;
    /** Which entities can be hit: as raycast's `layers` and `filter`. */
    layers?: number;
    filter?: RaycastOptions["filter"];
    /** Movement (CSS px) past which a press is a drag, not a click. Default 4. */
    clickThreshold?: number;
}

/** Priority of the built-in scene picking consumer. Gizmos go above, camera controls below (0). */
export const SCENE_PICKING_PRIORITY = 100;

const LINE_HEIGHT = 16;

/**
 * Pointer input for one canvas: turns DOM pointer events into rays, hits and per-entity handlers, and arbitrates
 * gestures between consumers (picking, camera controls, …) so a drag on an object doesn't also orbit the camera.
 *
 * ```ts
 * const input = new PointerInput(canvas, {scene});
 * input.on(button, "click", (e) => toggle());
 * const controls = new OrbitControls(camera).attach(input);
 * // later: input.dispose()
 * ```
 *
 * Handlers attach to any entity (meshes, groups, invisible colliders): a hit bubbles from the entity hit up its
 * ancestors. It uses the browser's Pointer Events, so mouse, touch and pen behave alike.
 */
export class PointerInput {
    readonly element: HTMLElement;
    scene: Scene | null;
    camera: Camera | null;
    layers: number | undefined;
    filter: RaycastOptions["filter"];
    clickThreshold: number;

    private readonly consumers: {consumer: PointerConsumer; priority: number}[] = [];
    /** Per active pointer: who claimed it, and who it was offered to. */
    private readonly gestures = new Map<number, {claimer: PointerConsumer | null; offered: PointerConsumer[]}>();
    private readonly picking: ScenePicking;
    private readonly listeners: [string, EventListener, AddEventListenerOptions?][] = [];
    private suppressContextMenu = false;

    constructor(element: HTMLElement, options: PointerInputOptions = {}) {
        this.element = element;
        this.scene = options.scene ?? null;
        this.camera = options.camera ?? null;
        this.layers = options.layers;
        this.filter = options.filter;
        this.clickThreshold = options.clickThreshold ?? 4;
        this.picking = new ScenePicking(this);
        this.addConsumer(this.picking, SCENE_PICKING_PRIORITY);

        this.listen("pointerdown", (e) => this.onPointerDown(e as PointerEvent));
        this.listen("pointermove", (e) => this.onPointerMove(e as PointerEvent));
        this.listen("pointerup", (e) => this.onPointerEnd(e as PointerEvent, false));
        this.listen("pointercancel", (e) => this.onPointerEnd(e as PointerEvent, true));
        this.listen("pointerleave", (e) => this.onPointerLeave(e as PointerEvent));
        this.listen("wheel", (e) => this.onWheel(e as WheelEvent), {passive: false});
        // Safari reports trackpad pinches as gesture events (others send ctrl + wheel): translate them.
        this.listen("gesturestart", (e) => this.onGesture(e as GestureLike, true), {passive: false});
        this.listen("gesturechange", (e) => this.onGesture(e as GestureLike, false), {passive: false});
        this.listen("contextmenu", (e) => {
            if (this.suppressContextMenu) {
                e.preventDefault();
                this.suppressContextMenu = false;
            }
        });
    }

    /** Adds a consumer; higher priorities are offered gestures first. Returns a function that removes it. */
    addConsumer(consumer: PointerConsumer, priority = 0): () => void {
        this.consumers.push({consumer, priority});
        this.consumers.sort((a, b) => b.priority - a.priority);
        return () => this.removeConsumer(consumer);
    }

    removeConsumer(consumer: PointerConsumer): void {
        const i = this.consumers.findIndex((c) => c.consumer === consumer);
        if (i !== -1) {
            this.consumers.splice(i, 1);
        }
        for (const gesture of this.gestures.values()) {
            if (gesture.claimer === consumer) {
                gesture.claimer = null;
            }
            gesture.offered = gesture.offered.filter((c) => c !== consumer);
        }
    }

    /** Listens to pointer events on an entity (and, through bubbling, its descendants). Returns an unsubscribe. */
    on(entity: Entity, type: ScenePointerEventType, handler: ScenePointerHandler): () => void {
        return this.picking.on(entity, type, handler);
    }

    off(entity: Entity, type: ScenePointerEventType, handler: ScenePointerHandler): void {
        this.picking.off(entity, type, handler);
    }

    /** The world ray through a pointer, from the input's camera; null without a camera. */
    getRay(out: Ray, pointer: {ndcX: number; ndcY: number; width: number; height: number}): Ray | null {
        const camera = this.camera ?? this.scene?.activeCamera ?? null;
        if (camera === null) {
            return null;
        }
        return camera.getRay(out, pointer.ndcX, pointer.ndcY, pointer.width / Math.max(pointer.height, 1));
    }

    /** Removes the DOM listeners and every consumer and handler. */
    dispose(): void {
        for (const [type, listener, options] of this.listeners) {
            this.element.removeEventListener(type, listener, options);
        }
        this.listeners.length = 0;
        this.consumers.length = 0;
        this.gestures.clear();
        this.picking.clear();
    }

    // ─── DOM ──────────────────────────────────────────────────────────────────

    private listen(type: string, listener: EventListener, options?: AddEventListenerOptions): void {
        this.element.addEventListener(type, listener, options);
        this.listeners.push([type, listener, options]);
    }

    private toPointer(e: PointerEvent): InputPointer {
        const rect = this.element.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const width = Math.max(rect.width, 1);
        const height = Math.max(rect.height, 1);
        return {
            native: e,
            pointerId: e.pointerId,
            pointerType: e.pointerType,
            button: e.button,
            buttons: e.buttons,
            x,
            y,
            ndcX: (x / width) * 2 - 1,
            ndcY: 1 - (y / height) * 2,
            width,
            height,
            shiftKey: e.shiftKey,
            ctrlKey: e.ctrlKey,
            altKey: e.altKey,
            metaKey: e.metaKey,
        };
    }

    private onPointerDown(e: PointerEvent): void {
        const pointer = this.toPointer(e);
        const offered: PointerConsumer[] = [];
        let claimer: PointerConsumer | null = null;
        for (const {consumer} of [...this.consumers]) {
            offered.push(consumer);
            if (consumer.pointerDown?.(pointer) === true) {
                claimer = consumer;
                break;
            }
        }
        this.gestures.set(e.pointerId, {claimer, offered});
        if (claimer !== null) {
            // Keep receiving this pointer's moves when it leaves the canvas mid-drag.
            this.element.setPointerCapture?.(e.pointerId);
            if (e.button === 2) {
                this.suppressContextMenu = true;
            }
            if (e.pointerType !== "touch") {
                e.preventDefault(); // no text selection while dragging
            }
        }
    }

    private onPointerMove(e: PointerEvent): void {
        const pointer = this.toPointer(e);
        const claimer = this.gestures.get(e.pointerId)?.claimer ?? null;
        if (claimer !== null) {
            claimer.pointerMove?.(pointer);
            return;
        }
        for (const {consumer} of [...this.consumers]) {
            consumer.hover?.(pointer, true);
        }
    }

    private onPointerEnd(e: PointerEvent, cancelled: boolean): void {
        const gesture = this.gestures.get(e.pointerId);
        if (gesture === undefined) {
            return;
        }
        this.gestures.delete(e.pointerId);
        if (this.element.hasPointerCapture?.(e.pointerId)) {
            this.element.releasePointerCapture(e.pointerId);
        }
        const pointer = this.toPointer(e);
        for (const consumer of gesture.offered) {
            consumer.pointerUp?.(pointer, cancelled);
        }
    }

    private onPointerLeave(e: PointerEvent): void {
        if ((this.gestures.get(e.pointerId)?.claimer ?? null) === null) {
            const pointer = this.toPointer(e);
            for (const {consumer} of [...this.consumers]) {
                consumer.hover?.(pointer, false);
            }
        }
    }

    private onWheel(e: WheelEvent): void {
        const height = Math.max(this.element.getBoundingClientRect().height, 1);
        const scale = e.deltaMode === 1 ? LINE_HEIGHT : e.deltaMode === 2 ? height : 1;
        const legacy = (e as WheelEvent & {wheelDeltaY?: number}).wheelDeltaY;
        this.offerWheel(e, e.clientX, e.clientY, {
            deltaX: e.deltaX * scale,
            deltaY: e.deltaY * scale,
            discrete: e.deltaMode !== 0,
            legacyDeltaY: typeof legacy === "number" ? legacy : 0,
            ctrlKey: e.ctrlKey,
            shiftKey: e.shiftKey,
            altKey: e.altKey,
            metaKey: e.metaKey,
        });
    }

    private gestureScale = 1;

    private onGesture(e: GestureLike, start: boolean): void {
        e.preventDefault(); // no page zoom
        if (start) {
            this.gestureScale = 1;
            return;
        }
        const ratio = e.scale / this.gestureScale;
        this.gestureScale = e.scale;
        if (!(ratio > 0)) {
            return;
        }
        // As ctrl + wheel: spreading the fingers (ratio > 1) is a negative deltaY, 100 per factor of e.
        this.offerWheel(e, e.clientX, e.clientY, {
            deltaX: 0,
            deltaY: -Math.log(ratio) * 100,
            discrete: false,
            legacyDeltaY: 0,
            ctrlKey: true,
            shiftKey: false,
            altKey: false,
            metaKey: false,
        });
    }

    private offerWheel(
        native: Event,
        clientX: number,
        clientY: number,
        fields: Omit<InputWheel, "native" | "x" | "y" | "ndcX" | "ndcY" | "width" | "height">,
    ): void {
        const rect = this.element.getBoundingClientRect();
        const x = clientX - rect.left;
        const y = clientY - rect.top;
        const width = Math.max(rect.width, 1);
        const height = Math.max(rect.height, 1);
        const wheel: InputWheel = {
            native,
            ...fields,
            x,
            y,
            ndcX: (x / width) * 2 - 1,
            ndcY: 1 - (y / height) * 2,
            width,
            height,
        };
        for (const {consumer} of [...this.consumers]) {
            if (consumer.wheel?.(wheel) === true) {
                native.preventDefault();
                return;
            }
        }
    }
}

/** Safari's GestureEvent (not in the DOM typings). */
interface GestureLike extends UIEvent {
    readonly scale: number;
    readonly clientX: number;
    readonly clientY: number;
}

// ─── Scene picking: the built-in consumer behind input.on(...) ───────────────

class ScenePicking implements PointerConsumer {
    private readonly handlers = new Map<Entity, Map<ScenePointerEventType, Set<ScenePointerHandler>>>();
    /** Per pointer down: the capturing entity (if any) and where it went down, for clicks. */
    private readonly presses = new Map<number, {captured: Entity | null; x: number; y: number}>();
    /** The entities under the hovering pointer: the nearest hit and its ancestors. */
    private hovered: Entity[] = [];

    constructor(private readonly input: PointerInput) {}

    on(entity: Entity, type: ScenePointerEventType, handler: ScenePointerHandler): () => void {
        let byType = this.handlers.get(entity);
        if (byType === undefined) {
            byType = new Map();
            this.handlers.set(entity, byType);
        }
        let set = byType.get(type);
        if (set === undefined) {
            set = new Set();
            byType.set(type, set);
        }
        set.add(handler);
        return () => this.off(entity, type, handler);
    }

    off(entity: Entity, type: ScenePointerEventType, handler: ScenePointerHandler): void {
        const byType = this.handlers.get(entity);
        byType?.get(type)?.delete(handler);
        if (byType?.get(type)?.size === 0) {
            byType.delete(type);
        }
        if (byType?.size === 0) {
            this.handlers.delete(entity);
        }
    }

    clear(): void {
        this.handlers.clear();
        this.presses.clear();
        this.hovered = [];
    }

    pointerDown(pointer: InputPointer): boolean {
        const query = this.query(pointer);
        if (query === null) {
            return false;
        }
        const press = {captured: null as Entity | null, x: pointer.x, y: pointer.y};
        this.presses.set(pointer.pointerId, press);
        this.dispatch("pointerdown", pointer, query, (entity) => {
            press.captured ??= entity;
        });
        return press.captured !== null;
    }

    pointerMove(pointer: InputPointer): void {
        // Only called for pointers this consumer claimed, i.e. captured by an entity.
        const press = this.presses.get(pointer.pointerId);
        const query = this.query(pointer);
        if (press?.captured != null && query !== null) {
            this.dispatchTo("pointermove", press.captured, pointer, query);
        }
    }

    pointerUp(pointer: InputPointer, cancelled: boolean): void {
        const press = this.presses.get(pointer.pointerId);
        this.presses.delete(pointer.pointerId);
        const query = this.query(pointer);
        if (press === undefined || query === null) {
            return;
        }
        const moved = Math.hypot(pointer.x - press.x, pointer.y - press.y);
        const isClick = !cancelled && moved <= this.input.clickThreshold;
        if (press.captured !== null) {
            this.dispatchTo("pointerup", press.captured, pointer, query);
            if (isClick) {
                this.dispatchTo("click", press.captured, pointer, query);
            }
            return;
        }
        if (!cancelled) {
            this.dispatch("pointerup", pointer, query);
        }
        if (isClick) {
            this.dispatch("click", pointer, query);
        }
    }

    hover(pointer: InputPointer, inside: boolean): void {
        const query = this.query(pointer);
        if (query === null) {
            return;
        }
        const top = inside ? (query.hits()[0] ?? null) : null;
        const path: Entity[] = [];
        for (let e: Entity | null = top?.entity ?? null; e !== null; e = e.parent) {
            path.push(e);
        }
        const previous = this.hovered;
        this.hovered = path;
        for (const entity of previous) {
            if (!path.includes(entity)) {
                this.call(entity, "pointerleave", pointer, query, null, entity);
            }
        }
        for (const entity of [...path].reverse()) {
            if (!previous.includes(entity)) {
                this.call(entity, "pointerenter", pointer, query, top, top!.entity);
            }
        }
        if (inside) {
            this.dispatch("pointermove", pointer, query);
        }
    }

    // ─── Dispatch ─────────────────────────────────────────────────────────────

    private query(pointer: InputPointer): Query | null {
        const scene = this.input.scene;
        const r = this.input.getRay(ray.create(), pointer);
        if (scene === null || r === null) {
            return null;
        }
        let hits: RaycastHit[] | null = null;
        return {
            ray: r,
            hits: () => (hits ??= raycast(scene, r, {layers: this.input.layers, filter: this.input.filter})),
        };
    }

    /** Through every hit, nearest first, bubbling each to its ancestors; each entity's handlers run once. */
    private dispatch(
        type: ScenePointerEventType,
        pointer: InputPointer,
        query: Query,
        onCapture?: (entity: Entity) => void,
    ): void {
        if (this.handlers.size === 0) {
            return;
        }
        const visited = new Set<Entity>();
        for (const hit of query.hits()) {
            for (let entity: Entity | null = hit.entity; entity !== null; entity = entity.parent) {
                if (visited.has(entity)) {
                    continue;
                }
                visited.add(entity);
                if (this.call(entity, type, pointer, query, hit, hit.entity, onCapture)) {
                    return;
                }
            }
        }
    }

    /** To a capturing entity and its ancestors, whatever is under the pointer. */
    private dispatchTo(type: ScenePointerEventType, target: Entity, pointer: InputPointer, query: Query): void {
        for (let entity: Entity | null = target; entity !== null; entity = entity.parent) {
            if (this.call(entity, type, pointer, query, null, target)) {
                return;
            }
        }
    }

    /** Runs an entity's handlers for `type`; returns true when one stopped propagation. */
    private call(
        entity: Entity,
        type: ScenePointerEventType,
        pointer: InputPointer,
        query: Query,
        hit: RaycastHit | null,
        target: Entity,
        onCapture?: (entity: Entity) => void,
    ): boolean {
        const handlers = this.handlers.get(entity)?.get(type);
        if (handlers === undefined || handlers.size === 0) {
            return false;
        }
        let stopped = false;
        const event: ScenePointerEvent = {
            type,
            pointer,
            ray: query.ray,
            get hits() {
                return query.hits();
            },
            hit,
            target,
            currentTarget: entity,
            stopPropagation: () => {
                stopped = true;
            },
            capture: () => {
                if (type === "pointerdown") {
                    onCapture?.(entity);
                }
            },
        };
        for (const handler of [...handlers]) {
            handler(event);
        }
        return stopped;
    }
}

interface Query {
    ray: Ray;
    hits(): RaycastHit[];
}
